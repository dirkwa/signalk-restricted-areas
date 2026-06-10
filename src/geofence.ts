/**
 * Server-side geofencing. Watches the vessel's own position/COG/SOG, asks the
 * spatial index which restricted zones contain (or lie just ahead of) the
 * vessel, and emits per-zone Signal K notifications.
 *
 * The throttle is clock-free and the heavy lifting lives in `evaluate()` so
 * tests can drive the state machine with synthetic fixes instead of timers.
 */

import { v5 as uuidv5 } from 'uuid'
import { zoneSeverity, type Activity, type Level, type RestrictedZoneProps } from './schema.js'

/** Notification value shape we emit (Signal K v1 notifications.* path). */
interface NotificationValue {
  state: 'normal' | 'alert' | 'warn' | 'alarm'
  method: ('visual' | 'sound')[]
  message: string
}

/** The subset of the zone record geofencing needs from a query result. */
export type ZoneHit = Pick<RestrictedZoneProps, 'siteId' | 'name' | 'restrictions'>

/** The spatial index dependency. queryPoint resolves inside-polygon hits. */
export interface ZoneIndex {
  queryPoint(lon: number, lat: number): ZoneHit[]
  queryBbox(minLon: number, minLat: number, maxLon: number, maxLat: number): ZoneHit[]
}

/** The 'app' subset geofencing touches. */
export interface GeofenceApp {
  handleMessage(
    pluginId: string,
    msg: { updates: { values: { path: string; value: NotificationValue }[] }[] }
  ): void
  debug(msg: unknown, ...args: unknown[]): void
}

export interface GeofenceConfig {
  enabled: boolean
  alertOn: Activity[]
  /** Radius (m) around the lookahead point used to bracket approach candidates. */
  approachDistanceM: number
  /** Seconds projected along COG to test for upcoming entry. */
  lookaheadSeconds: number
  /** Exit buffer (m): must clear the zone by this much before a zone is dropped. */
  hysteresisM: number
  /** Minimum seconds between evaluations (used by the live throttle, not evaluate). */
  evalIntervalSeconds: number
  /** Minimum movement (m) between evaluations (used by the live throttle). */
  minMoveM: number
}

export interface GeofenceDeps {
  app: GeofenceApp
  pluginId: string
  index: ZoneIndex
  config: GeofenceConfig
}

export interface Position {
  longitude: number
  latitude: number
}

/** Course/speed for the current fix. COG radians, SOG m/s (Signal K SI). */
export interface Motion {
  cog: number | null
  sog: number | null
}

/** Fixed namespace so each siteId maps to a stable notification UUID across restarts. */
const NOTIFICATION_NAMESPACE = 'b6f1d3c0-2e44-4a1d-9d8e-7c1f0a5b9e21'

/** Below this SOG (m/s, ~0.5 kn) heading is noise — skip the approach projection. */
const MIN_SOG_FOR_LOOKAHEAD = 0.25

const EARTH_RADIUS_M = 6_371_008.8

type ZoneState = 'approaching' | 'inside'

function notificationPath(siteId: string): string {
  return `notifications.navigation.restrictedArea.${uuidv5(siteId, NOTIFICATION_NAMESPACE)}`
}

/** Equirectangular approximation — adequate for the metre-scale ranges here. */
function distanceM(a: Position, b: Position): number {
  const latRad = ((a.latitude + b.latitude) / 2) * (Math.PI / 180)
  const dLat = (b.latitude - a.latitude) * (Math.PI / 180)
  const dLon = (b.longitude - a.longitude) * (Math.PI / 180) * Math.cos(latRad)
  return Math.hypot(dLat, dLon) * EARTH_RADIUS_M
}

/** Project a position `distance` metres along `cog` (radians from true north). */
function project(pos: Position, cog: number, distance: number): Position {
  const dNorth = distance * Math.cos(cog)
  const dEast = distance * Math.sin(cog)
  const latRad = pos.latitude * (Math.PI / 180)
  return {
    latitude: pos.latitude + (dNorth / EARTH_RADIUS_M) * (180 / Math.PI),
    longitude: pos.longitude + (dEast / (EARTH_RADIUS_M * Math.cos(latRad))) * (180 / Math.PI)
  }
}

/** Activities that breach a zone, worded for the notification message. */
function reasonFor(zone: ZoneHit, alertOn: readonly Activity[]): string {
  const hit = (want: Level): Activity[] => alertOn.filter((a) => zone.restrictions[a] === want)
  const phrases = [
    ...hit('prohibited').map((a) => `${a} prohibited`),
    ...hit('restricted').map((a) => `${a} restricted`)
  ]
  return phrases.length > 0 ? phrases.join(', ') : 'restricted area'
}

export class GeofenceEngine {
  private readonly app: GeofenceApp
  private readonly pluginId: string
  private readonly index: ZoneIndex
  private readonly config: GeofenceConfig

  /** Per-zone last emitted state, keyed by siteId. Absence = cleared/untracked. */
  private readonly active = new Map<string, ZoneState>()
  /** Names cached so stop()/exit can build messages without re-querying. */
  private readonly zoneNames = new Map<string, string>()

  private readonly unsubs: (() => void)[] = []
  private lastEvalPos: Position | null = null
  private lastEvalAt = 0
  private cog: number | null = null
  private sog: number | null = null

  constructor(deps: GeofenceDeps) {
    this.app = deps.app
    this.pluginId = deps.pluginId
    this.index = deps.index
    this.config = deps.config
  }

  /**
   * Wire up the self-position/COG/SOG streams. `streambundle` is reached via the
   * full ServerAPI; we accept it loosely so the engine stays test-driveable
   * through evaluate() without a Bacon bus.
   */
  start(streambundle: {
    getSelfBus(path: string): { onValue(cb: (v: { value: unknown }) => void): () => void }
  }): void {
    if (!this.config.enabled) return

    this.unsubs.push(
      streambundle.getSelfBus('navigation.courseOverGroundTrue').onValue((v) => {
        this.cog = typeof v.value === 'number' ? v.value : null
      })
    )
    this.unsubs.push(
      streambundle.getSelfBus('navigation.speedOverGround').onValue((v) => {
        this.sog = typeof v.value === 'number' ? v.value : null
      })
    )
    this.unsubs.push(
      streambundle.getSelfBus('navigation.position').onValue((v) => {
        const pos = v.value
        if (!isPosition(pos)) return
        if (this.shouldEvaluate(pos, Date.now())) {
          this.evaluate(pos, { cog: this.cog, sog: this.sog })
        }
      })
    )
  }

  /** Throttle gate kept separate so evaluate() itself is always deterministic. */
  private shouldEvaluate(pos: Position, nowMs: number): boolean {
    if (this.lastEvalPos === null) return true
    const movedEnough = distanceM(this.lastEvalPos, pos) >= this.config.minMoveM
    const elapsedEnough = nowMs - this.lastEvalAt >= this.config.evalIntervalSeconds * 1000
    if (movedEnough && elapsedEnough) {
      this.lastEvalPos = pos
      this.lastEvalAt = nowMs
      return true
    }
    return false
  }

  /**
   * The deterministic core: reconcile every tracked/visible zone against the
   * current fix and emit only on transitions.
   */
  evaluate(pos: Position, motion: Motion): void {
    if (!this.config.enabled) return
    this.lastEvalPos = pos

    const inside = new Map<string, ZoneHit>()
    for (const z of this.index.queryPoint(pos.longitude, pos.latitude)) {
      inside.set(z.siteId, z)
    }

    const approaching = new Map<string, ZoneHit>()
    for (const z of this.lookaheadHits(pos, motion)) {
      if (!inside.has(z.siteId)) approaching.set(z.siteId, z)
    }

    for (const [siteId, zone] of inside) this.enterInside(siteId, zone)
    for (const [siteId, zone] of approaching) this.enterApproaching(siteId, zone)

    for (const siteId of [...this.active.keys()]) {
      if (inside.has(siteId) || approaching.has(siteId)) continue
      if (this.clearedWithBuffer(siteId, pos)) this.exit(siteId)
    }
  }

  /**
   * Zones reachable within lookaheadSeconds at the current SOG. We test the
   * projected lookahead point directly (geometry-free), bracketed by a bbox so
   * the index can pre-filter candidates.
   */
  private lookaheadHits(pos: Position, motion: Motion): ZoneHit[] {
    const { cog, sog } = motion
    if (cog === null || sog === null || sog < MIN_SOG_FOR_LOOKAHEAD) return []

    const reach = Math.max(sog * this.config.lookaheadSeconds, this.config.approachDistanceM)
    const ahead = project(pos, cog, reach)

    // Coarse bbox pre-filter around the lookahead point; queryPoint confirms.
    const r = this.config.approachDistanceM
    const dLat = (r / EARTH_RADIUS_M) * (180 / Math.PI)
    const dLon = dLat / Math.max(Math.cos(ahead.latitude * (Math.PI / 180)), 1e-6)
    const candidates = this.index.queryBbox(
      ahead.longitude - dLon,
      ahead.latitude - dLat,
      ahead.longitude + dLon,
      ahead.latitude + dLat
    )
    if (candidates.length === 0) return []

    const containing = new Set(
      this.index.queryPoint(ahead.longitude, ahead.latitude).map((z) => z.siteId)
    )
    return candidates.filter((z) => containing.has(z.siteId))
  }

  private enterInside(siteId: string, zone: ZoneHit): void {
    this.zoneNames.set(siteId, zone.name)
    if (this.active.get(siteId) === 'inside') return
    this.active.set(siteId, 'inside')

    const severity = zoneSeverity(zone, this.config.alertOn)
    const reason = reasonFor(zone, this.config.alertOn)
    const value: NotificationValue =
      severity === 'prohibited'
        ? {
            state: 'alarm',
            method: ['visual', 'sound'],
            message: `Inside ${zone.name} — ${reason}`
          }
        : severity === 'restricted'
          ? { state: 'warn', method: ['visual'], message: `Inside ${zone.name} — ${reason}` }
          : { state: 'alert', method: ['visual'], message: `Inside ${zone.name} — ${reason}` }
    this.emit(siteId, value)
  }

  private enterApproaching(siteId: string, zone: ZoneHit): void {
    this.zoneNames.set(siteId, zone.name)
    // Don't downgrade an inside-zone to approaching on a noisy fix.
    if (this.active.get(siteId) === 'inside') return
    if (this.active.get(siteId) === 'approaching') return
    this.active.set(siteId, 'approaching')

    this.emit(siteId, {
      state: 'alert',
      method: ['visual'],
      message: `Approaching ${zone.name} — ${reasonFor(zone, this.config.alertOn)}`
    })
  }

  /**
   * Hysteresis: only clear once the vessel is outside the zone AND beyond the
   * exit buffer. queryPoint at a point pushed hysteresisM further out along the
   * exit bearing must also miss the zone.
   */
  private clearedWithBuffer(siteId: string, pos: Position): boolean {
    if (this.config.hysteresisM <= 0) return true
    // Sample a ring of points hysteresisM out; if any still hits the zone we are
    // within the buffer and must not clear yet (prevents boundary flapping).
    for (let bearing = 0; bearing < Math.PI * 2; bearing += Math.PI / 4) {
      const probe = project(pos, bearing, this.config.hysteresisM)
      const hit = this.index
        .queryPoint(probe.longitude, probe.latitude)
        .some((z) => z.siteId === siteId)
      if (hit) return false
    }
    return true
  }

  private exit(siteId: string): void {
    const name = this.zoneNames.get(siteId) ?? 'restricted area'
    this.emit(siteId, { state: 'normal', method: ['visual'], message: `Cleared ${name}` })
    this.active.delete(siteId)
    this.zoneNames.delete(siteId)
  }

  private emit(siteId: string, value: NotificationValue): void {
    this.app.debug('geofence %s -> %s', siteId, value.state)
    this.app.handleMessage(this.pluginId, {
      updates: [{ values: [{ path: notificationPath(siteId), value }] }]
    })
  }

  /** Unsubscribe and clear every still-active zone (the always-clear invariant). */
  stop(): void {
    for (const unsub of this.unsubs.splice(0)) unsub()
    for (const siteId of [...this.active.keys()]) this.exit(siteId)
    this.active.clear()
    this.zoneNames.clear()
    this.lastEvalPos = null
    this.lastEvalAt = 0
  }
}

function isPosition(v: unknown): v is Position {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Position).longitude === 'number' &&
    typeof (v as Position).latitude === 'number'
  )
}

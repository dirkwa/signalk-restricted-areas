import { describe, it, expect, beforeEach } from 'vitest'
import { v5 as uuidv5 } from 'uuid'
import {
  GeofenceEngine,
  type ZoneHit,
  type GeofenceConfig,
  type ZoneIndex
} from '../src/geofence.js'
import type { Activity, Level } from '../src/schema.js'

const NS = 'b6f1d3c0-2e44-4a1d-9d8e-7c1f0a5b9e21'

interface Emitted {
  path: string
  state: string
  method: string[]
  message: string
}

function fakeApp() {
  const emitted: Emitted[] = []
  return {
    emitted,
    handleMessage(
      _pluginId: string,
      msg: { updates: { values: { path: string; value: Emitted }[] }[] }
    ) {
      for (const u of msg.updates) {
        for (const v of u.values) {
          emitted.push({
            path: v.path,
            state: v.value.state,
            method: v.value.method,
            message: v.value.message
          })
        }
      }
    },
    debug() {
      /* swallow */
    }
  }
}

/**
 * Fake index over axis-aligned lon/lat boxes. queryPoint = point-in-box,
 * queryBbox = box overlap. Lets the test place a vessel inside/near a zone
 * without real GeoJSON.
 */
interface BoxZone {
  zone: ZoneHit
  minLon: number
  minLat: number
  maxLon: number
  maxLat: number
}

function boxIndex(zones: BoxZone[]): ZoneIndex {
  const contains = (z: BoxZone, lon: number, lat: number) =>
    lon >= z.minLon && lon <= z.maxLon && lat >= z.minLat && lat <= z.maxLat
  return {
    queryPoint(lon, lat) {
      return zones.filter((z) => contains(z, lon, lat)).map((z) => z.zone)
    },
    queryBbox(minLon, minLat, maxLon, maxLat) {
      return zones
        .filter(
          (z) =>
            z.minLon <= maxLon && z.maxLon >= minLon && z.minLat <= maxLat && z.maxLat >= minLat
        )
        .map((z) => z.zone)
    }
  }
}

function zone(
  siteId: string,
  name: string,
  restrictions: Partial<Record<Activity, Level>>
): ZoneHit {
  return { siteId, name, restrictions }
}

function config(over: Partial<GeofenceConfig> = {}): GeofenceConfig {
  return {
    enabled: true,
    alertOn: ['anchoring'],
    approachDistanceM: 1852,
    lookaheadSeconds: 600,
    hysteresisM: 200,
    evalIntervalSeconds: 10,
    minMoveM: 20,
    ...over
  }
}

const pathFor = (siteId: string) => `notifications.navigation.restrictedArea.${uuidv5(siteId, NS)}`

// A 0.01°-wide box (~1.1 km) centred on the equator near 0°,0°. Easy to reason
// about: 1° lat ≈ 111 km, so the lookahead projection lands in degrees we can
// compute by eye.
const ZONE_BOX = { minLon: 0.0, minLat: 0.0, maxLon: 0.01, maxLat: 0.01 }
const CENTER = { longitude: 0.005, latitude: 0.005 }

describe('GeofenceEngine — approach → inside → exit lifecycle', () => {
  let app: ReturnType<typeof fakeApp>

  beforeEach(() => {
    app = fakeApp()
  })

  it('emits alert → warn/alarm → normal on the deterministic per-zone path', () => {
    const z = zone('SITE1', 'Reef Reserve', { anchoring: 'prohibited' })
    const index = boxIndex([{ zone: z, ...ZONE_BOX }])
    const eng = new GeofenceEngine({ app, pluginId: 'p', index, config: config() })

    const path = pathFor('SITE1')

    // (1) Far south of the box, heading due north (cog 0), ~5 m/s. lookahead
    // 600 s * 5 = 3000 m north reaches the box -> approaching, not inside.
    eng.evaluate({ longitude: 0.005, latitude: -0.02 }, { cog: 0, sog: 5 })
    expect(app.emitted.map((e) => e.state)).toEqual(['alert'])
    expect(app.emitted[0].path).toBe(path)
    expect(app.emitted[0].message).toContain('Approaching Reef Reserve')

    // (2) Now inside the box, prohibited -> alarm with sound.
    eng.evaluate(CENTER, { cog: 0, sog: 5 })
    expect(app.emitted.at(-1)?.state).toBe('alarm')
    expect(app.emitted.at(-1)?.method).toEqual(['visual', 'sound'])
    expect(app.emitted.at(-1)?.path).toBe(path)

    // (3) Far away, beyond hysteresis -> normal (cleared).
    eng.evaluate({ longitude: 0.005, latitude: 0.05 }, { cog: 0, sog: 5 })
    expect(app.emitted.at(-1)?.state).toBe('normal')
    expect(app.emitted.at(-1)?.path).toBe(path)

    expect(app.emitted.map((e) => e.state)).toEqual(['alert', 'alarm', 'normal'])
  })

  it('restricted (not prohibited) zone inside -> warn, visual only', () => {
    const z = zone('SITE2', 'Slow Zone', { anchoring: 'restricted' })
    const index = boxIndex([{ zone: z, ...ZONE_BOX }])
    const eng = new GeofenceEngine({ app, pluginId: 'p', index, config: config() })

    eng.evaluate(CENTER, { cog: null, sog: null })
    expect(app.emitted.at(-1)?.state).toBe('warn')
    expect(app.emitted.at(-1)?.method).toEqual(['visual'])
  })
})

describe('GeofenceEngine — prohibited alarm', () => {
  it('inside a prohibited zone yields alarm with sound and a reason', () => {
    const app = fakeApp()
    const z = zone('SITE3', 'No Anchor Bay', { anchoring: 'prohibited', mooring: 'prohibited' })
    const index = boxIndex([{ zone: z, ...ZONE_BOX }])
    const eng = new GeofenceEngine({
      app,
      pluginId: 'p',
      index,
      config: config({ alertOn: ['anchoring', 'mooring'] })
    })

    eng.evaluate(CENTER, { cog: null, sog: null })
    const last = app.emitted.at(-1)
    expect(last?.state).toBe('alarm')
    expect(last?.method).toContain('sound')
    expect(last?.message).toContain('anchoring prohibited')
  })
})

describe('GeofenceEngine — hysteresis (no boundary flapping)', () => {
  it('oscillating right at the boundary does not churn alarm/normal', () => {
    const app = fakeApp()
    const z = zone('SITE4', 'Edge Park', { anchoring: 'prohibited' })
    const index = boxIndex([{ zone: z, ...ZONE_BOX }])
    const eng = new GeofenceEngine({
      app,
      pluginId: 'p',
      index,
      config: config({ hysteresisM: 200 })
    })

    // Enter the zone -> single alarm.
    eng.evaluate(CENTER, { cog: null, sog: null })
    expect(app.emitted.filter((e) => e.state === 'alarm')).toHaveLength(1)

    // Step just OUTSIDE the box (lat 0.0105, ~55 m past the 0.01 edge) but well
    // within the 200 m exit buffer. The hysteresis probe ring still hits the
    // zone, so we must NOT clear and must NOT re-alarm.
    for (let i = 0; i < 5; i++) {
      eng.evaluate({ longitude: 0.005, latitude: 0.0105 }, { cog: null, sog: null })
      eng.evaluate(CENTER, { cog: null, sog: null })
    }

    expect(app.emitted.filter((e) => e.state === 'normal')).toHaveLength(0)
    // Still exactly one alarm — no re-entry churn.
    expect(app.emitted.filter((e) => e.state === 'alarm')).toHaveLength(1)
  })
})

describe('GeofenceEngine — stop()', () => {
  it('clears every active zone with normal and unsubscribes', () => {
    const app = fakeApp()
    const z = zone('SITE5', 'Closing Zone', { anchoring: 'prohibited' })
    const index = boxIndex([{ zone: z, ...ZONE_BOX }])
    const eng = new GeofenceEngine({ app, pluginId: 'p', index, config: config() })

    let unsubbed = 0
    const bus = { onValue: () => () => unsubbed++ }
    eng.start({ getSelfBus: () => bus })

    eng.evaluate(CENTER, { cog: null, sog: null })
    expect(app.emitted.at(-1)?.state).toBe('alarm')

    eng.stop()
    const last = app.emitted.at(-1)
    expect(last?.state).toBe('normal')
    expect(last?.path).toBe(pathFor('SITE5'))
    // position + cog + sog subscriptions all released.
    expect(unsubbed).toBe(3)

    // A second stop() is a no-op (nothing active, nothing to unsubscribe).
    const before = app.emitted.length
    eng.stop()
    expect(app.emitted).toHaveLength(before)
  })
})

describe('GeofenceEngine — alertOn gating', () => {
  it('does not raise severity for an activity outside alertOn, but a hit still notifies', () => {
    const app = fakeApp()
    // Zone prohibits fishing only; user monitors anchoring only.
    const z = zone('SITE6', 'Fishing Closure', { fishing: 'prohibited' })
    const index = boxIndex([{ zone: z, ...ZONE_BOX }])
    const eng = new GeofenceEngine({
      app,
      pluginId: 'p',
      index,
      config: config({ alertOn: ['anchoring'] })
    })

    eng.evaluate(CENTER, { cog: null, sog: null })
    const last = app.emitted.at(-1)
    // zoneSeverity -> 'info' because the prohibition isn't in alertOn -> alert, no sound.
    expect(last?.state).toBe('alert')
    expect(last?.method).toEqual(['visual'])
    expect(last?.message).toContain('restricted area')
  })

  it('is fully disabled when config.enabled is false', () => {
    const app = fakeApp()
    const z = zone('SITE7', 'Quiet Park', { anchoring: 'prohibited' })
    const index = boxIndex([{ zone: z, ...ZONE_BOX }])
    const eng = new GeofenceEngine({
      app,
      pluginId: 'p',
      index,
      config: config({ enabled: false })
    })

    eng.evaluate(CENTER, { cog: null, sog: null })
    expect(app.emitted).toHaveLength(0)
  })
})

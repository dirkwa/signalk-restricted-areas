/**
 * Read-only Signal K Resources API provider that shapes ProtectedSeas Navigator
 * zones into Freeboard-SK ResourceSets.
 *
 * Freeboard groups a ResourceSet's features under one style; it has no per-feature
 * styling beyond a `styleRef` into the set's `styles` map. So the default listing
 * splits all zones into three severity buckets (prohibited / restricted / info),
 * one ResourceSet each, so a bucket's colour communicates its risk. A `bbox` query
 * collapses to a single set (Freeboard fetches the viewport that way).
 */

import { v5 as uuidv5 } from 'uuid'
import type { Feature, FeatureCollection, Geometry } from 'geojson'
import type { ResourceProviderMethods } from '@signalk/server-api'
import {
  type Activity,
  type Level,
  type Severity,
  zoneSeverity,
  type RestrictedZoneProps
} from './schema.js'

export const RESOURCE_TYPE = 'restricted-areas'

/** Human labels for the coarse activities, for popup text. */
const ACTIVITY_LABELS: Record<Activity, string> = {
  anchoring: 'anchoring',
  mooring: 'mooring',
  entry: 'entry/transit',
  speed: 'speed',
  diving: 'diving',
  discharge: 'discharge',
  dredging: 'dredging',
  removalOfArtifacts: 'removal of artifacts',
  fishingRecreational: 'recreational fishing',
  fishingCommercial: 'commercial fishing',
  fishingArtisanal: 'artisanal fishing',
  fishing: 'fishing'
}

/** Fixed namespace so a zone's resource id is stable across restarts/hosts. */
const ID_NAMESPACE = 'b9f4d6e2-7c3a-4f1b-9e2d-5a8c1f0b3e7a'

/** Stable resource id for a zone (UUIDv5 of its Navigator siteId). */
export function zoneId(siteId: string): string {
  return uuidv5(siteId, ID_NAMESPACE)
}

/** A bounding box in [minLon, minLat, maxLon, maxLat] order (WGS84). */
export type Bbox = [number, number, number, number]

/** One indexed zone: normalized display props plus its display geometry. */
export interface IndexedZone {
  props: RestrictedZoneProps
  geometry: Geometry
}

/**
 * The spatial index surface this provider reads. Implemented by the RBush-backed
 * index; kept narrow so tests can supply a fake.
 */
export interface RestrictedAreasIndex {
  allZones(): readonly IndexedZone[]
  getFeature(siteId: string): IndexedZone | undefined
  queryBbox(bbox: Bbox): readonly IndexedZone[]
}

export interface ResourceProviderDeps {
  index: RestrictedAreasIndex
  /**
   * Activities exposed as individual toggleable ResourceSet layers (one set per
   * activity). A zone appears in an activity's layer when it restricts/prohibits
   * that activity. Lets a user hide, e.g., commercial fishing in Freeboard's
   * layer list without affecting the others.
   */
  displayActivities: readonly Activity[]
  /** Attribution + disclaimer block appended to every ResourceSet description. */
  attribution: string
}

/** Freeboard polygon style. Keys are the ones OpenLayers/Freeboard understands. */
interface FreeboardStyle {
  stroke: string
  fill: string
  width: number
  lineDash?: number[]
}

type FreeboardStyleMap = Readonly<Record<string, Readonly<FreeboardStyle>>>

const STYLES: Record<Severity, Readonly<FreeboardStyle>> = {
  prohibited: Object.freeze({ stroke: '#E03030', fill: 'rgba(224,48,48,0.25)', width: 2 }),
  restricted: Object.freeze({ stroke: '#FFA500', fill: 'rgba(255,165,0,0.20)', width: 2 }),
  info: Object.freeze({ stroke: '#C8B400', fill: 'rgba(200,180,0,0.12)', width: 1 })
}

/** Title-case label for an activity's ResourceSet name. */
const ACTIVITY_SET_LABEL: Record<Activity, string> = {
  anchoring: 'Anchoring',
  mooring: 'Mooring',
  entry: 'Entry / Transit',
  speed: 'Speed',
  diving: 'Diving',
  discharge: 'Discharge',
  dredging: 'Dredging',
  removalOfArtifacts: 'Removal of Artifacts',
  fishingRecreational: 'Recreational Fishing',
  fishingCommercial: 'Commercial Fishing',
  fishingArtisanal: 'Artisanal Fishing',
  fishing: 'Fishing (any gear)'
}

/** The set id for one activity's layer (the suffix Freeboard shows in its layer list). */
function activitySetId(activity: Activity): string {
  return `restricted-areas-${activity}`
}

/** The catch-all informational set: zones with no displayed prohibition/restriction. */
const INFO_SET_ID = 'restricted-areas-info'

/**
 * The level at which a zone restricts an activity, as a severity for styling —
 * or null if that activity is allowed/unknown/na (the zone is NOT in this layer).
 */
function levelForActivity(zone: RestrictedZoneProps, activity: Activity): Severity | null {
  const level = zone.restrictions[activity]
  if (level === 'prohibited') return 'prohibited'
  if (level === 'restricted') return 'restricted'
  return null
}

/** Activities listed at a given level, formatted for a human-readable line. */
function activitiesAtLevel(
  restrictions: RestrictedZoneProps['restrictions'],
  level: Level
): string[] {
  return (Object.keys(restrictions) as Activity[])
    .filter((a) => restrictions[a] === level)
    .map((a) => ACTIVITY_LABELS[a])
}

/**
 * A readable popup body. Freeboard renders `properties.description` in the
 * feature popup, so the salient facts go there (name/restrictions/authority);
 * the structured fields stay alongside for programmatic clients.
 */
function featureDescription(zone: RestrictedZoneProps): string {
  const lines: string[] = []
  const prohibited = activitiesAtLevel(zone.restrictions, 'prohibited')
  const restricted = activitiesAtLevel(zone.restrictions, 'restricted')
  if (prohibited.length > 0) lines.push(`Prohibited: ${prohibited.join(', ')}.`)
  if (restricted.length > 0) lines.push(`Restricted: ${restricted.join(', ')}.`)
  if (zone.summary) lines.push(zone.summary)
  const meta = [zone.authority, zone.country].filter(Boolean).join(', ')
  if (meta) lines.push(meta)
  if (zone.lfp !== null) lines.push(`Level of Fishing Protection: ${zone.lfp}/5.`)
  if (zone.sourceUrls.length > 0) lines.push(`Source: ${zone.sourceUrls[0]}`)
  return lines.join('\n')
}

/**
 * The subset of display props Freeboard surfaces in a feature popup. The popup
 * `description` is derived from the zone (not the layer), so callers pass it in
 * — it is computed once per zone even when the zone spans several layers.
 */
function featureProps(
  zone: RestrictedZoneProps,
  styleRef: Severity,
  description: string
): Record<string, unknown> {
  return {
    styleRef,
    name: zone.name,
    description,
    summary: zone.summary,
    sourceUrls: zone.sourceUrls,
    country: zone.country,
    authority: zone.authority,
    lfp: zone.lfp,
    restrictions: zone.restrictions
  }
}

function toFeature(zone: IndexedZone, styleRef: Severity, description: string): Feature {
  return {
    type: 'Feature',
    id: zoneId(zone.props.siteId),
    geometry: zone.geometry,
    properties: featureProps(zone.props, styleRef, description)
  }
}

/**
 * Shared across every ResourceSet — the style map never varies. Frozen (and its
 * styles with it) so one response cannot mutate the map every later response holds.
 */
const STYLE_MAP: FreeboardStyleMap = Object.freeze({
  default: STYLES.info,
  prohibited: STYLES.prohibited,
  restricted: STYLES.restricted,
  info: STYLES.info
})

interface ResourceSet {
  type: 'ResourceSet'
  name: string
  description: string
  styles: FreeboardStyleMap
  values: FeatureCollection
}

function resourceSet(
  name: string,
  blurb: string,
  features: Feature[],
  attribution: string
): ResourceSet {
  return {
    type: 'ResourceSet',
    name,
    // Spec: the attribution/disclaimer block must terminate the description.
    description: `${blurb} ${attribution}`,
    styles: STYLE_MAP,
    values: { type: 'FeatureCollection', features }
  }
}

/**
 * Build per-activity ResourceSets from a set of zones. Each configured activity
 * becomes its own set (toggleable layer in Freeboard); a zone joins a set when it
 * restricts/prohibits that activity, styled by that activity's level. A final
 * `info` set holds zones that restrict none of the displayed activities so they
 * are still visible (LFP/conservation-only areas).
 */
function activitySets(
  zones: readonly IndexedZone[],
  deps: ResourceProviderDeps
): Record<string, ResourceSet> {
  const perActivity = new Map<Activity, Feature[]>()
  for (const activity of deps.displayActivities) perActivity.set(activity, [])
  const info: Feature[] = []

  for (const zone of zones) {
    const description = featureDescription(zone.props)
    let placed = false
    for (const activity of deps.displayActivities) {
      const severity = levelForActivity(zone.props, activity)
      if (severity !== null) {
        perActivity.get(activity)?.push(toFeature(zone, severity, description))
        placed = true
      }
    }
    if (!placed) info.push(toFeature(zone, 'info', description))
  }

  const out: Record<string, ResourceSet> = {}
  for (const activity of deps.displayActivities) {
    out[activitySetId(activity)] = resourceSet(
      `Restricted Areas — ${ACTIVITY_SET_LABEL[activity]}`,
      `Areas restricting ${ACTIVITY_SET_LABEL[activity].toLowerCase()}.`,
      perActivity.get(activity) ?? [],
      deps.attribution
    )
  }
  out[INFO_SET_ID] = resourceSet(
    'Restricted Areas — Other',
    'Conservation/management areas with no restriction on the displayed activities.',
    info,
    deps.attribution
  )
  return out
}

function bucketSets(deps: ResourceProviderDeps): Record<string, ResourceSet> {
  return activitySets(deps.index.allZones(), deps)
}

function parseBbox(value: unknown): Bbox | null {
  if (typeof value !== 'string') return null
  const parts = value.split(',').map((p) => Number(p.trim()))
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  return parts as Bbox
}

function bboxSet(deps: ResourceProviderDeps, bbox: Bbox): Record<string, ResourceSet> {
  return activitySets(deps.index.queryBbox(bbox), deps)
}

/** Resolve a dotted path against an object without pulling in lodash. */
function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const key of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

export function makeResourceProvider(deps: ResourceProviderDeps): {
  type: string
  methods: ResourceProviderMethods
} {
  const readOnly = (): Promise<never> => Promise.reject(new Error('restricted-areas is read-only'))

  const methods: ResourceProviderMethods = {
    listResources(query: Record<string, unknown>): Promise<Record<string, unknown>> {
      const bbox = parseBbox(query.bbox)
      return Promise.resolve(bbox ? bboxSet(deps, bbox) : bucketSets(deps))
    },

    getResource(id: string, property?: string): Promise<object> {
      const zone = findById(deps.index, id)
      if (!zone) return Promise.reject(new Error(`restricted area not found: ${id}`))
      const feature = toFeature(
        zone,
        zoneSeverity(zone.props, deps.displayActivities),
        featureDescription(zone.props)
      )
      if (property === undefined) return Promise.resolve(feature)
      const value = getPath(feature, property)
      if (value === undefined) {
        return Promise.reject(new Error(`property not found: ${property}`))
      }
      return Promise.resolve(value as object)
    },

    setResource(): Promise<void> {
      return readOnly()
    },

    deleteResource(): Promise<void> {
      return readOnly()
    }
  }

  return { type: RESOURCE_TYPE, methods }
}

/**
 * Resource ids are UUIDv5(siteId), so resolve by scanning for the zone whose id
 * matches. The index is small enough (thousands) that a linear scan on the rare
 * single-resource GET is cheaper than maintaining a second id->siteId map.
 */
function findById(index: RestrictedAreasIndex, id: string): IndexedZone | undefined {
  for (const zone of index.allZones()) {
    if (zoneId(zone.props.siteId) === id) return zone
  }
  return undefined
}

/**
 * In-memory spatial index over ProtectedSeas Navigator zones.
 *
 * Antimeridian safety (see the locked geometry rules): a single Navigator
 * feature can be a MultiPolygon whose components straddle ±180°. Indexing the
 * feature by its overall bbox would yield a ~358°-wide box that matches almost
 * every query. We therefore EXPLODE every MultiPolygon into its component
 * Polygons and index ONE RBush entry per component (back-referenced to the
 * parent siteId), so each box is tight and no ring is assumed to cross ±180.
 */

import { readFile } from 'node:fs/promises'

import bbox from '@turf/bbox'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { deserialize } from 'flatgeobuf/lib/mjs/geojson.js'
import RBush from 'rbush'
import type { Feature, FeatureCollection, Geometry, Polygon, Position } from 'geojson'

import { normalizeProps, type Activity, type Level, type RestrictedZoneProps } from './schema.js'

// FlatGeobuf columns are scalar-only, so the pipeline serializes these object/
// array fields to JSON strings. Keep in sync with FGB_JSON_FIELDS in the data
// repo's bin/normalize.mjs. The fallback is what we use if a field is missing
// or unparseable.
const FGB_JSON_FIELDS: Record<string, unknown> = {
  restrictions: {},
  raw: {},
  sourceUrls: [],
  siteVersion: { major: null, minor: null }
}

function parseJsonField(value: unknown, fallback: unknown): unknown {
  if (typeof value !== 'string') return value ?? fallback
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

/**
 * Reconstruct a RestrictedZoneProps from a FlatGeobuf feature's properties (the
 * pipeline already normalized them and JSON-stringified the non-scalar fields).
 * This is NOT the raw-Navigator path — it does not re-run normalizeProps.
 */
function restoreFromFgb(props: Record<string, unknown>, attribution: string): RestrictedZoneProps {
  return {
    siteId: typeof props.siteId === 'string' ? props.siteId : '',
    name: typeof props.name === 'string' ? props.name : '(unnamed area)',
    country: (props.country as string | null) ?? null,
    state: (props.state as string | null) ?? null,
    authority: (props.authority as string | null) ?? null,
    designation: (props.designation as string | null) ?? null,
    category: (props.category as string | null) ?? null,
    categoryId: (props.categoryId as number | 'unknown' | undefined) ?? 'unknown',
    wdpaId: (props.wdpaId as string | null) ?? null,
    iucnCat: (props.iucnCat as string | null) ?? null,
    lfp: (props.lfp as number | null) ?? null,
    tribalExemption: (props.tribalExemption as boolean | null) ?? null,
    restrictions: parseJsonField(props.restrictions, FGB_JSON_FIELDS.restrictions) as Partial<
      Record<Activity, Level>
    >,
    raw: parseJsonField(props.raw, FGB_JSON_FIELDS.raw) as Record<string, Level>,
    summary: (props.summary as string | null) ?? null,
    sourceUrls: parseJsonField(props.sourceUrls, FGB_JSON_FIELDS.sourceUrls) as string[],
    season: (props.season as string | null) ?? null,
    effectiveFrom: (props.effectiveFrom as string | null) ?? null,
    effectiveTo: (props.effectiveTo as string | null) ?? null,
    siteVersion: parseJsonField(props.siteVersion, FGB_JSON_FIELDS.siteVersion) as {
      major: number | null
      minor: number | null
    },
    attribution
  }
}

/** One RBush leaf: a tight bbox for a single component polygon, back-ref'd to its zone. */
interface ComponentEntry {
  minX: number
  minY: number
  maxX: number
  maxY: number
  siteId: string
  componentIndex: number
}

/** Everything a query needs to return: normalized props plus the component geometries. */
interface ZoneEntry {
  props: RestrictedZoneProps
  components: Polygon[]
}

/** Split a Polygon | MultiPolygon into its component Polygons. Other geometries yield none. */
function explode(geometry: Geometry | null): Polygon[] {
  if (geometry === null) return []
  if (geometry.type === 'Polygon') return [geometry]
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.map((coordinates) => ({ type: 'Polygon', coordinates }))
  }
  return []
}

function entryFor(component: Polygon, siteId: string, componentIndex: number): ComponentEntry {
  const [minX, minY, maxX, maxY] = bbox(component)
  return { minX, minY, maxX, maxY, siteId, componentIndex }
}

export class SpatialIndex {
  private readonly tree: RBush<ComponentEntry>
  private readonly zones: Map<string, ZoneEntry>

  private constructor(tree: RBush<ComponentEntry>, zones: Map<string, ZoneEntry>) {
    this.tree = tree
    this.zones = zones
  }

  /** Shared builder: `toProps` maps a feature's raw properties to RestrictedZoneProps. */
  private static build(
    features: FeatureCollection['features'],
    toProps: (props: Record<string, unknown>) => RestrictedZoneProps
  ): SpatialIndex {
    const tree = new RBush<ComponentEntry>()
    const zones = new Map<string, ZoneEntry>()
    const entries: ComponentEntry[] = []

    for (const feature of features) {
      const components = explode(feature.geometry)
      if (components.length === 0) continue
      const props = toProps(feature.properties ?? {})
      if (props.siteId === '') continue

      // Later features with a duplicate siteId would overwrite the zone record but
      // still add components; merge into one record to keep components consistent.
      const existing = zones.get(props.siteId)
      const merged = existing
        ? { props, components: [...existing.components, ...components] }
        : { props, components }
      zones.set(props.siteId, merged)

      const base = existing ? existing.components.length : 0
      components.forEach((component, i) => {
        entries.push(entryFor(component, props.siteId, base + i))
      })
    }

    tree.load(entries)
    return new SpatialIndex(tree, zones)
  }

  /**
   * Build an index from an in-memory GeoJSON FeatureCollection of RAW Navigator
   * features (properties run through `normalizeProps`). Used for dev fixtures and
   * tests. Features without Polygon/MultiPolygon geometry or a siteId are skipped.
   *
   * Building is synchronous now that rbush is a static import, but the Promise
   * return type is kept so the three `from*` builders stay interchangeable.
   */
  static fromFeatureCollection(fc: FeatureCollection, attribution: string): Promise<SpatialIndex> {
    return Promise.resolve(
      SpatialIndex.build(fc.features, (props) => normalizeProps(props, attribution))
    )
  }

  /**
   * Build an index from a FlatGeobuf file (production path). The FGB carries
   * already-normalized properties with the non-scalar fields JSON-encoded, so it
   * uses the restore path, NOT normalizeProps.
   */
  static async fromFlatGeobufFile(filePath: string, attribution: string): Promise<SpatialIndex> {
    const buffer = await readFile(filePath)
    const fc = deserialize(new Uint8Array(buffer))
    return SpatialIndex.build(fc.features, (props) => restoreFromFgb(props, attribution))
  }

  /**
   * Build one index from several regional FlatGeobuf files. Features are merged
   * into a single collection (duplicate siteIds across regions coalesce via
   * {@link fromFeatureCollection}).
   */
  static async fromFlatGeobufFiles(
    filePaths: string[],
    attribution: string
  ): Promise<SpatialIndex> {
    const features: FeatureCollection['features'] = []
    for (const filePath of filePaths) {
      const buffer = await readFile(filePath)
      const fc = deserialize(new Uint8Array(buffer))
      features.push(...fc.features)
    }
    return SpatialIndex.build(features, (props) => restoreFromFgb(props, attribution))
  }

  /** Number of distinct zones (not components) in the index. */
  size(): number {
    return this.zones.size
  }

  /** All normalized zone records. */
  allZones(): RestrictedZoneProps[] {
    return [...this.zones.values()].map((z) => z.props)
  }

  /**
   * The display geometry for one zone as a GeoJSON Feature: a single Polygon
   * when the zone has one component, otherwise a MultiPolygon. Returns null for
   * an unknown siteId.
   */
  getFeature(
    siteId: string
  ): Feature<Polygon | { type: 'MultiPolygon'; coordinates: Position[][][] }> | null {
    const zone = this.zones.get(siteId)
    if (zone === undefined) return null
    const { components, props } = zone
    const geometry =
      components.length === 1
        ? (components[0] as Polygon)
        : { type: 'MultiPolygon' as const, coordinates: components.map((c) => c.coordinates) }
    return { type: 'Feature', geometry, properties: { ...props } }
  }

  /** Zones whose geometry contains the given [lon, lat], deduped by siteId. */
  queryPoint(lon: number, lat: number): RestrictedZoneProps[] {
    const candidates = this.tree.search({ minX: lon, minY: lat, maxX: lon, maxY: lat })
    const point: Position = [lon, lat]
    const hits = new Map<string, RestrictedZoneProps>()
    for (const candidate of candidates) {
      if (hits.has(candidate.siteId)) continue
      const zone = this.zones.get(candidate.siteId)
      if (zone === undefined) continue
      const component = zone.components[candidate.componentIndex]
      if (component !== undefined && booleanPointInPolygon(point, component)) {
        hits.set(candidate.siteId, zone.props)
      }
    }
    return [...hits.values()]
  }

  /**
   * Zones whose bbox intersects [minLon, minLat, maxLon, maxLat], deduped by
   * siteId. This is a coarse bbox-overlap query (the use case is map viewport
   * fetching), not a precise polygon-intersection test.
   */
  queryBbox(extent: [number, number, number, number]): RestrictedZoneProps[] {
    const [minX, minY, maxX, maxY] = extent
    const candidates = this.tree.search({ minX, minY, maxX, maxY })
    const hits = new Map<string, RestrictedZoneProps>()
    for (const candidate of candidates) {
      if (hits.has(candidate.siteId)) continue
      const zone = this.zones.get(candidate.siteId)
      if (zone !== undefined) hits.set(candidate.siteId, zone.props)
    }
    return [...hits.values()]
  }
}

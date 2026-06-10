import { describe, it, expect } from 'vitest'
import type { Feature, FeatureCollection, Geometry } from 'geojson'
import {
  makeResourceProvider,
  zoneId,
  type IndexedZone,
  type RestrictedAreasIndex,
  type Bbox
} from '../src/resource-provider.js'
import { normalizeProps, type Activity } from '../src/schema.js'

const ATTRIBUTION = 'Data: ProtectedSeas Navigator (CC BY 4.0). ... ALWAYS VERIFY.'
const MONITORED: readonly Activity[] = ['anchoring', 'entry']

function square(lon: number, lat: number): Geometry {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [lon, lat],
        [lon + 1, lat],
        [lon + 1, lat + 1],
        [lon, lat + 1],
        [lon, lat]
      ]
    ]
  }
}

/** Build an IndexedZone from minimal Navigator props at a given location. */
function makeZone(
  siteId: string,
  overrides: Record<string, unknown>,
  lon = 0,
  lat = 0
): IndexedZone {
  return {
    props: normalizeProps(
      { SITE_ID: siteId, site_name: `Zone ${siteId}`, ...overrides },
      ATTRIBUTION
    ),
    geometry: square(lon, lat)
  }
}

const prohibitedZone = makeZone('PROH1', { anchoring: 1 }, 0, 0) // anchoring prohibited
const restrictedZone = makeZone('REST1', { entry: 2 }, 10, 10) // entry restricted
const infoZone = makeZone('INFO1', { lfp: 5 }, 20, 20) // no monitored limit

function fakeIndex(zones: readonly IndexedZone[]): RestrictedAreasIndex {
  return {
    allZones: () => zones,
    getFeature: (siteId) => zones.find((z) => z.props.siteId === siteId),
    queryBbox: (bbox: Bbox) =>
      zones.filter((z) => {
        const [lon, lat] = (z.geometry as { coordinates: number[][][] }).coordinates[0][0]
        return lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3]
      })
  }
}

function provider(zones: readonly IndexedZone[]) {
  return makeResourceProvider({
    index: fakeIndex(zones),
    monitored: MONITORED,
    attribution: ATTRIBUTION
  })
}

const ALL = [prohibitedZone, restrictedZone, infoZone]

describe('makeResourceProvider — provider shape', () => {
  it('declares a resource type and the four CRUD methods', () => {
    const p = provider(ALL)
    expect(typeof p.type).toBe('string')
    expect(typeof p.methods.listResources).toBe('function')
    expect(typeof p.methods.getResource).toBe('function')
    expect(typeof p.methods.setResource).toBe('function')
    expect(typeof p.methods.deleteResource).toBe('function')
  })
})

describe('listResources — default severity buckets', () => {
  it('splits zones into prohibited / restricted / info ResourceSets', async () => {
    const sets = await provider(ALL).methods.listResources({})
    const ids = Object.keys(sets)
    expect(ids).toContain('restricted-areas-prohibited')
    expect(ids).toContain('restricted-areas-restricted')
    expect(ids).toContain('restricted-areas-info')

    const proh = sets['restricted-areas-prohibited'] as { values: FeatureCollection }
    const rest = sets['restricted-areas-restricted'] as { values: FeatureCollection }
    const info = sets['restricted-areas-info'] as { values: FeatureCollection }
    expect(proh.values.features.map((f) => f.id)).toEqual([zoneId('PROH1')])
    expect(rest.values.features.map((f) => f.id)).toEqual([zoneId('REST1')])
    expect(info.values.features.map((f) => f.id)).toEqual([zoneId('INFO1')])
  })

  it('every ResourceSet description ends with the attribution block', async () => {
    const sets = await provider(ALL).methods.listResources({})
    for (const set of Object.values(sets) as { description: string }[]) {
      expect(set.description.endsWith(ATTRIBUTION)).toBe(true)
    }
  })

  it('tags each Feature with a styleRef matching its severity bucket', async () => {
    const sets = (await provider(ALL).methods.listResources({})) as Record<
      string,
      { values: FeatureCollection }
    >
    const styleRefOf = (set: { values: FeatureCollection }): unknown =>
      set.values.features[0]?.properties?.styleRef
    expect(styleRefOf(sets['restricted-areas-prohibited'])).toBe('prohibited')
    expect(styleRefOf(sets['restricted-areas-restricted'])).toBe('restricted')
    expect(styleRefOf(sets['restricted-areas-info'])).toBe('info')
  })

  it('uses Freeboard stroke/fill/width style keys per bucket', async () => {
    const sets = await provider(ALL).methods.listResources({})
    const set = sets['restricted-areas-prohibited'] as {
      styles: Record<string, Record<string, unknown>>
    }
    for (const key of ['default', 'prohibited', 'restricted', 'info']) {
      const style = set.styles[key]
      expect(style).toHaveProperty('stroke')
      expect(style).toHaveProperty('fill')
      expect(style).toHaveProperty('width')
      expect(typeof style.stroke).toBe('string')
      expect(typeof style.width).toBe('number')
    }
  })

  it('carries the zone display props onto each Feature', async () => {
    const sets = await provider(ALL).methods.listResources({})
    const proh = sets['restricted-areas-prohibited'] as { values: FeatureCollection }
    const props = proh.values.features[0]?.properties
    expect(props?.name).toBe('Zone PROH1')
    expect(props?.restrictions).toMatchObject({ anchoring: 'prohibited' })
    expect(props).toHaveProperty('sourceUrls')
    expect(props).toHaveProperty('authority')
  })
})

describe('listResources — bbox query', () => {
  it('returns a single filtered ResourceSet for a bbox string', async () => {
    // bbox around the prohibited zone only (origin square).
    const sets = await provider(ALL).methods.listResources({ bbox: '-1,-1,2,2' })
    const ids = Object.keys(sets)
    expect(ids).toHaveLength(1)
    const set = sets[ids[0]] as { values: FeatureCollection; description: string }
    expect(set.values.features.map((f) => f.id)).toEqual([zoneId('PROH1')])
    expect(set.description.endsWith(ATTRIBUTION)).toBe(true)
  })

  it('the bbox set still assigns severity-correct styleRefs', async () => {
    const sets = await provider(ALL).methods.listResources({ bbox: '9,9,12,12' })
    const set = Object.values(sets)[0] as { values: FeatureCollection }
    expect(set.values.features[0]?.properties?.styleRef).toBe('restricted')
  })

  it('falls back to buckets when bbox is not a parseable string', async () => {
    const sets = await provider(ALL).methods.listResources({ bbox: 'not-a-bbox' })
    expect(Object.keys(sets)).toContain('restricted-areas-prohibited')
  })
})

describe('getResource', () => {
  it('returns a single zone as a GeoJSON Feature', async () => {
    const feature = (await provider(ALL).methods.getResource(zoneId('REST1'))) as Feature
    expect(feature.type).toBe('Feature')
    expect(feature.id).toBe(zoneId('REST1'))
    expect(feature.geometry.type).toBe('Polygon')
    expect(feature.properties?.name).toBe('Zone REST1')
  })

  it('returns a dotted sub-value when property is given', async () => {
    const name = await provider(ALL).methods.getResource(zoneId('PROH1'), 'properties.name')
    expect(name).toBe('Zone PROH1')
  })

  it('rejects an unknown id', async () => {
    await expect(provider(ALL).methods.getResource(zoneId('NOPE'))).rejects.toThrow()
  })

  it('rejects an unknown dotted property', async () => {
    await expect(
      provider(ALL).methods.getResource(zoneId('PROH1'), 'properties.nope.deep')
    ).rejects.toThrow()
  })
})

describe('read-only enforcement', () => {
  it('setResource rejects with the read-only error', async () => {
    await expect(
      provider(ALL).methods.setResource(zoneId('PROH1'), { foo: 'bar' })
    ).rejects.toThrow('restricted-areas is read-only')
  })

  it('deleteResource rejects with the read-only error', async () => {
    await expect(provider(ALL).methods.deleteResource(zoneId('PROH1'))).rejects.toThrow(
      'restricted-areas is read-only'
    )
  })
})

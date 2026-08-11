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
const DISPLAY_ACTIVITIES: readonly Activity[] = ['anchoring', 'entry']

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
    displayActivities: DISPLAY_ACTIVITIES,
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

describe('listResources — per-activity layers', () => {
  it('emits one ResourceSet per display activity plus an info set', async () => {
    const sets = await provider(ALL).methods.listResources({})
    const ids = Object.keys(sets)
    expect(ids).toContain('restricted-areas-anchoring')
    expect(ids).toContain('restricted-areas-entry')
    expect(ids).toContain('restricted-areas-info')

    const anchoring = sets['restricted-areas-anchoring'] as { values: FeatureCollection }
    const entry = sets['restricted-areas-entry'] as { values: FeatureCollection }
    const info = sets['restricted-areas-info'] as { values: FeatureCollection }
    // PROH1 prohibits anchoring -> anchoring layer; REST1 restricts entry -> entry layer.
    expect(anchoring.values.features.map((f) => f.id)).toEqual([zoneId('PROH1')])
    expect(entry.values.features.map((f) => f.id)).toEqual([zoneId('REST1')])
    // INFO1 restricts neither displayed activity -> info catch-all.
    expect(info.values.features.map((f) => f.id)).toEqual([zoneId('INFO1')])
  })

  it('places a zone in EVERY activity layer it restricts', async () => {
    // A zone that both prohibits anchoring and restricts entry shows in both.
    const both = makeZone('BOTH1', { anchoring: 1, entry: 2 }, 5, 5)
    const sets = await provider([both]).methods.listResources({})
    const anchoring = sets['restricted-areas-anchoring'] as { values: FeatureCollection }
    const entry = sets['restricted-areas-entry'] as { values: FeatureCollection }
    expect(anchoring.values.features.map((f) => f.id)).toEqual([zoneId('BOTH1')])
    expect(entry.values.features.map((f) => f.id)).toEqual([zoneId('BOTH1')])
  })

  it('gives a zone the same description in every layer it appears in', async () => {
    // A zone's popup description is derived from the zone, not the layer — it
    // must read identically whether viewed via its anchoring or entry layer.
    const both = makeZone('BOTH1', { anchoring: 1, entry: 2 }, 5, 5)
    const sets = (await provider([both]).methods.listResources({})) as Record<
      string,
      { values: FeatureCollection }
    >
    const descriptionOf = (set: { values: FeatureCollection }): unknown =>
      set.values.features[0]?.properties?.description
    const inAnchoring = descriptionOf(sets['restricted-areas-anchoring'])
    const inEntry = descriptionOf(sets['restricted-areas-entry'])
    expect(typeof inAnchoring).toBe('string')
    expect(inAnchoring).toBe(inEntry)
  })

  it('only emits layers for the configured display activities', async () => {
    const sets = await provider(ALL).methods.listResources({})
    expect(Object.keys(sets)).not.toContain('restricted-areas-fishingCommercial')
    expect(Object.keys(sets)).not.toContain('restricted-areas-diving')
  })

  it('every ResourceSet description ends with the attribution block', async () => {
    const sets = await provider(ALL).methods.listResources({})
    for (const set of Object.values(sets) as { description: string }[]) {
      expect(set.description.endsWith(ATTRIBUTION)).toBe(true)
    }
  })

  it('styleRef reflects the level of THAT activity in THAT layer', async () => {
    const sets = (await provider(ALL).methods.listResources({})) as Record<
      string,
      { values: FeatureCollection }
    >
    const styleRefOf = (set: { values: FeatureCollection }): unknown =>
      set.values.features[0]?.properties?.styleRef
    expect(styleRefOf(sets['restricted-areas-anchoring'])).toBe('prohibited') // PROH1 anchoring=1
    expect(styleRefOf(sets['restricted-areas-entry'])).toBe('restricted') // REST1 entry=2
    expect(styleRefOf(sets['restricted-areas-info'])).toBe('info')
  })

  it('uses Freeboard stroke/fill/width style keys', async () => {
    const sets = await provider(ALL).methods.listResources({})
    const set = sets['restricted-areas-anchoring'] as {
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

  it('freezes the shared style map so one response cannot mutate later ones', async () => {
    const sets = await provider(ALL).methods.listResources({})
    const styles = (sets['restricted-areas-anchoring'] as { styles: Record<string, unknown> })
      .styles
    expect(Object.isFrozen(styles)).toBe(true)
    expect(Object.values(styles).every(Object.isFrozen)).toBe(true)
  })

  it('carries the zone display props onto each Feature', async () => {
    const sets = await provider(ALL).methods.listResources({})
    const anchoring = sets['restricted-areas-anchoring'] as { values: FeatureCollection }
    const props = anchoring.values.features[0]?.properties
    expect(props?.name).toBe('Zone PROH1')
    expect(props?.restrictions).toMatchObject({ anchoring: 'prohibited' })
    expect(props).toHaveProperty('description')
    expect(props).toHaveProperty('sourceUrls')
    expect(props).toHaveProperty('authority')
  })
})

describe('listResources — bbox query', () => {
  it('returns per-activity sets filtered to the bbox', async () => {
    // bbox around the prohibited (anchoring) zone only (origin square).
    const sets = await provider(ALL).methods.listResources({ bbox: '-1,-1,2,2' })
    const anchoring = sets['restricted-areas-anchoring'] as {
      values: FeatureCollection
      description: string
    }
    const entry = sets['restricted-areas-entry'] as { values: FeatureCollection }
    expect(anchoring.values.features.map((f) => f.id)).toEqual([zoneId('PROH1')])
    expect(entry.values.features).toHaveLength(0) // REST1 is outside the bbox
    expect(anchoring.description.endsWith(ATTRIBUTION)).toBe(true)
  })

  it('the bbox set assigns the activity-correct styleRef', async () => {
    const sets = await provider(ALL).methods.listResources({ bbox: '9,9,12,12' })
    const entry = sets['restricted-areas-entry'] as { values: FeatureCollection }
    expect(entry.values.features[0]?.properties?.styleRef).toBe('restricted')
  })

  it('falls back to the full per-activity listing when bbox is unparseable', async () => {
    const sets = await provider(ALL).methods.listResources({ bbox: 'not-a-bbox' })
    expect(Object.keys(sets)).toContain('restricted-areas-anchoring')
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

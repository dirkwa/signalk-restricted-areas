import { readFileSync } from 'node:fs'
import { writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, it, expect, beforeAll } from 'vitest'
import { serialize } from 'flatgeobuf/lib/mjs/geojson.js'
import type { FeatureCollection } from 'geojson'

import { SpatialIndex } from '../src/spatial-index.js'

const ATTR = 'TEST-ATTRIBUTION'

function loadFixture(name: string): FeatureCollection {
  const url = new URL(`./fixtures/${name}`, import.meta.url)
  return JSON.parse(readFileSync(fileURLToPath(url), 'utf8')) as FeatureCollection
}

function siteIds(zones: { siteId: string }[]): string[] {
  return zones.map((z) => z.siteId).sort()
}

describe('SpatialIndex', () => {
  let index: SpatialIndex

  beforeAll(async () => {
    index = await SpatialIndex.fromFeatureCollection(loadFixture('antimeridian.geojson'), ATTR)
  })

  it('counts distinct zones, not components', () => {
    // 4 features in the fixture; two are MultiPolygons (2 + 2 components) but each
    // is still one zone.
    expect(index.size()).toBe(4)
    expect(siteIds(index.allZones())).toEqual(['ANTIMERIDIAN', 'ATLANTIC', 'BISECTED', 'PACIFIC'])
  })

  it('injects the attribution string into normalized zones', () => {
    const zone = index.allZones().find((z) => z.siteId === 'ATLANTIC')
    expect(zone?.attribution).toBe(ATTR)
  })

  it('decodes coded columns through the schema (1 = prohibited)', () => {
    const am = index.allZones().find((z) => z.siteId === 'ANTIMERIDIAN')
    expect(am?.restrictions.anchoring).toBe('prohibited')
    expect(am?.restrictions.entry).toBe('restricted')
  })

  describe('queryPoint', () => {
    it('matches a point inside the W179 component', () => {
      const hits = index.queryPoint(-179.5, 0)
      expect(siteIds(hits)).toEqual(['ANTIMERIDIAN'])
    })

    it('matches a point inside the E179 component', () => {
      const hits = index.queryPoint(179.5, 0)
      expect(siteIds(hits)).toEqual(['ANTIMERIDIAN'])
    })

    it('antimeridian regression: a far-away mid-Pacific point matches nothing', () => {
      // The per-FEATURE bbox of the dateline MultiPolygon spans ~359° and would
      // wrongly flag [0,0]. Per-component indexing + point-in-polygon must not.
      expect(index.queryPoint(0, 0)).toEqual([])
    })

    it('matches a point inside a simple Polygon zone', () => {
      const hits = index.queryPoint(-29.5, 40.5)
      expect(siteIds(hits)).toEqual(['ATLANTIC'])
    })

    it('returns nothing for open ocean inside no zone', () => {
      expect(index.queryPoint(-60, 0)).toEqual([])
    })

    it('dedupes a zone whose nested MultiPolygon components both contain the point', () => {
      // BISECTED's two components are an outer 1°x1° box and an inner box, both of
      // which contain this point. The zone must appear exactly once.
      const hits = index.queryPoint(10.5, 10.5)
      expect(hits.map((z) => z.siteId)).toEqual(['BISECTED'])
      expect(hits).toHaveLength(1)
    })
  })

  describe('queryBbox', () => {
    it('returns zones whose bbox intersects the viewport', () => {
      const hits = index.queryBbox([-31, 39, -28, 42])
      expect(siteIds(hits)).toEqual(['ATLANTIC'])
    })

    it('returns multiple zones for a wide viewport, deduped', () => {
      const hits = index.queryBbox([-130, 28, -28, 42])
      expect(siteIds(hits)).toEqual(['ATLANTIC', 'PACIFIC'])
    })

    it('only the E179 component is reachable from an eastern-hemisphere viewport', () => {
      const hits = index.queryBbox([178, -2, 180, 2])
      expect(siteIds(hits)).toEqual(['ANTIMERIDIAN'])
    })

    it('returns nothing for an empty region', () => {
      expect(index.queryBbox([0, 50, 5, 55])).toEqual([])
    })
  })

  describe('getFeature', () => {
    it('returns a single Polygon Feature for a one-component zone', () => {
      const feature = index.getFeature('ATLANTIC')
      expect(feature?.type).toBe('Feature')
      expect(feature?.geometry.type).toBe('Polygon')
      expect(feature?.properties.siteId).toBe('ATLANTIC')
    })

    it('returns a MultiPolygon Feature reassembling all components', () => {
      const feature = index.getFeature('ANTIMERIDIAN')
      expect(feature?.geometry.type).toBe('MultiPolygon')
      const geometry = feature?.geometry
      if (geometry?.type === 'MultiPolygon') {
        expect(geometry.coordinates).toHaveLength(2)
      }
    })

    it('returns null for an unknown siteId', () => {
      expect(index.getFeature('NOPE')).toBeNull()
    })
  })

  it('skips features that carry no siteId', async () => {
    const fc: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { site_name: 'No identity' },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 1],
                [0, 0]
              ]
            ]
          }
        }
      ]
    }
    const empty = await SpatialIndex.fromFeatureCollection(fc, ATTR)
    expect(empty.size()).toBe(0)
    expect(empty.queryPoint(0.5, 0.5)).toEqual([])
  })
})

describe('FlatGeobuf round-trip (un-flatten normalized props)', () => {
  it('parses JSON-encoded non-scalar fields back from a real FGB', async () => {
    // Shape the pipeline writes: already-normalized props with the non-scalar
    // fields JSON-stringified so FlatGeobuf's scalar-only columns accept them.
    const fc: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {
            siteId: 'FGB1',
            name: 'Round Trip Reserve',
            categoryId: 1,
            lfp: 4,
            restrictions: JSON.stringify({ anchoring: 'prohibited', entry: 'restricted' }),
            raw: JSON.stringify({ anchoring: 'prohibited' }),
            sourceUrls: JSON.stringify(['https://example.org/reg']),
            siteVersion: JSON.stringify({ major: 2, minor: 1 })
          },
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [10, 10],
                [11, 10],
                [11, 11],
                [10, 11],
                [10, 10]
              ]
            ]
          }
        }
      ]
    }

    const dir = await mkdtemp(path.join(tmpdir(), 'ra-fgb-'))
    const fgbPath = path.join(dir, 'round-trip.fgb')
    try {
      await writeFile(fgbPath, Buffer.from(serialize(fc)))
      const index = await SpatialIndex.fromFlatGeobufFile(fgbPath, ATTR)
      expect(index.size()).toBe(1)
      const [zone] = index.allZones()
      expect(zone.siteId).toBe('FGB1')
      // Non-scalar fields are real objects/arrays again, not strings.
      expect(zone.restrictions.anchoring).toBe('prohibited')
      expect(zone.restrictions.entry).toBe('restricted')
      expect(zone.sourceUrls).toEqual(['https://example.org/reg'])
      expect(zone.siteVersion).toEqual({ major: 2, minor: 1 })
      // A point inside the polygon hits the zone.
      expect(index.queryPoint(10.5, 10.5).map((z) => z.siteId)).toEqual(['FGB1'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

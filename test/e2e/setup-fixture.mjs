/**
 * Stage an offline dataset for the end-to-end run.
 *
 * The production path downloads regional FlatGeobuf extracts from the data
 * repo's GitHub Releases. That is exactly what an e2e test must not do: it
 * would pull tens of megabytes per CI run and fail whenever GitHub is having a
 * bad day. Instead we write a small FGB (plus the manifest that rides beside
 * it) straight into the plugin's data dir and run the plugin with
 * `autoUpdate: false`, which routes DataManager down its offline branch and
 * never opens a socket.
 *
 * The geometry is synthetic, but the PROPERTY SHAPE is not. A published FGB
 * carries post-pipeline properties — camelCase keys, activity levels already
 * decoded from the numeric coding key, and the non-scalar fields JSON-encoded
 * because FlatGeobuf columns are scalar-only. `SpatialIndex.fromFlatGeobufFile`
 * restores exactly that shape and does NOT re-run `normalizeProps`, so a
 * fixture written in raw snake_case Navigator form silently indexes zero zones.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { serialize } from 'flatgeobuf/lib/mjs/geojson.js'

/** The plugin's default region, so the stock configuration finds this file. */
const REGION = 'sw-pacific'

/**
 * Two zones off New Zealand, in published-FGB form. The first prohibits
 * anchoring — the level the pipeline decodes from the raw code `1`, and the one
 * a truthy test would invert into "allowed".
 */
const FEATURES = [
  {
    type: 'Feature',
    properties: {
      siteId: 'E2E-ANCHOR-PROHIBITED',
      name: 'E2E Anchoring Closure',
      country: 'NZ',
      lfp: 5,
      restrictions: JSON.stringify({ anchoring: 'prohibited', fishing: 'prohibited' }),
      raw: JSON.stringify({ anchoring: 'prohibited' }),
      sourceUrls: JSON.stringify([]),
      siteVersion: JSON.stringify({ major: 1, minor: 0 })
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [174.0, -37.0],
          [174.0, -36.0],
          [175.0, -36.0],
          [175.0, -37.0],
          [174.0, -37.0]
        ]
      ]
    }
  },
  {
    type: 'Feature',
    properties: {
      siteId: 'E2E-FAR-AWAY',
      name: 'E2E Distant Area',
      country: 'NZ',
      lfp: 1,
      restrictions: JSON.stringify({ anchoring: 'allowed' }),
      raw: JSON.stringify({ anchoring: 'allowed' }),
      sourceUrls: JSON.stringify([]),
      siteVersion: JSON.stringify({ major: 1, minor: 0 })
    },
    geometry: {
      type: 'Polygon',
      coordinates: [
        [
          [150.0, -20.0],
          [150.0, -19.0],
          [151.0, -19.0],
          [151.0, -20.0],
          [150.0, -20.0]
        ]
      ]
    }
  }
]

/** Mirrors the published manifest's shape — assets nest under regions[].assets. */
function manifest(assetName) {
  return {
    version: 'v2026.01.01-e2e',
    datasetDate: '2026-01-01',
    downloadDate: '2026-01-02',
    license: 'CC BY 4.0',
    attribution: 'ProtectedSeas Navigator',
    regions: [{ region: REGION, assets: [{ name: assetName, size: 0, sha256: '', bbox: [] }] }]
  }
}

/** Write the FGB + manifest under <dataDir>/restricted-areas. Returns that dir. */
export async function stageDataset(dataDir) {
  const datasetDir = join(dataDir, 'restricted-areas')
  await mkdir(datasetDir, { recursive: true })

  const assetName = `${REGION}.display.fgb`
  const fc = { type: 'FeatureCollection', features: FEATURES }
  await writeFile(join(datasetDir, assetName), Buffer.from(serialize(fc)))
  await writeFile(join(datasetDir, 'manifest.json'), JSON.stringify(manifest(assetName), null, 2))

  return datasetDir
}

/** A position inside E2E-ANCHOR-PROHIBITED, for the geofence assertions. */
export const INSIDE_POSITION = { longitude: 174.5, latitude: -36.5 }

/** A position far outside every staged zone. */
export const OUTSIDE_POSITION = { longitude: 100.0, latitude: 10.0 }

export const PROHIBITED_SITE_ID = 'E2E-ANCHOR-PROHIBITED'

/**
 * The served features identify zones by NAME, not siteId — the resource
 * provider projects a display-facing property set (styleRef, name, description,
 * restrictions, …) and deliberately does not leak the internal id.
 */
export const PROHIBITED_NAME = 'E2E Anchoring Closure'
export const DISTANT_NAME = 'E2E Distant Area'
export const REGION_NAME = REGION

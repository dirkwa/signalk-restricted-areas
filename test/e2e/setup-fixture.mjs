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
 * The prohibited zone is drawn around the SAMPLE VESSEL's track, not somewhere
 * arbitrary. CI starts the server with BOTH `--sample-nmea0183-data` and
 * `--sample-n2k-data`, and the two replay onto navigation.position alternately:
 *   plaka.log  (NMEA0183) ~60.08°N 23.54°E → 59.86°N 23.40°E
 *   aava-n2k   (N2K)      ~59.72°N 24.74°E
 *
 * The geofence evaluates whichever fix wins its throttle (`minMoveM` AND
 * `evalIntervalSeconds`), and the sample streams emit far more often than a test
 * can inject — so a zone placed anywhere else sees an outside fix and never
 * alarms. The box therefore spans BOTH sources, which makes the check
 * independent of which one wins and closer to real use: the alarm is raised from
 * the server's own live position stream rather than a hand-fed delta.
 */
const SAMPLE_TRACK = { lon: 24.07, lat: 59.9 }
const HALF_SPAN = 1.1 // degrees — covers the plaka track AND the aava position

const FEATURES = [
  {
    type: 'Feature',
    properties: {
      siteId: 'E2E-ANCHOR-PROHIBITED',
      name: 'E2E Anchoring Closure',
      country: 'FI',
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
          [SAMPLE_TRACK.lon - HALF_SPAN, SAMPLE_TRACK.lat - HALF_SPAN],
          [SAMPLE_TRACK.lon - HALF_SPAN, SAMPLE_TRACK.lat + HALF_SPAN],
          [SAMPLE_TRACK.lon + HALF_SPAN, SAMPLE_TRACK.lat + HALF_SPAN],
          [SAMPLE_TRACK.lon + HALF_SPAN, SAMPLE_TRACK.lat - HALF_SPAN],
          [SAMPLE_TRACK.lon - HALF_SPAN, SAMPLE_TRACK.lat - HALF_SPAN]
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

/**
 * The staged manifest's dates. The plugin feeds these to `attributionBlock()`,
 * so the assertions rebuild the expected block from the same two constants.
 */
export const DATASET_DATE = '2026-01-01'
export const DOWNLOAD_DATE = '2026-01-02'

/** Mirrors the published manifest's shape — assets nest under regions[].assets. */
function manifest(assetName) {
  return {
    version: 'v2026.01.01-e2e',
    datasetDate: DATASET_DATE,
    downloadDate: DOWNLOAD_DATE,
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

/**
 * A position inside E2E-ANCHOR-PROHIBITED. On a bare server this is what raises
 * the alarm; under CI's sample data the replayed track is already inside the
 * zone, so this simply agrees with it instead of fighting it.
 */
export const INSIDE_POSITION = { longitude: SAMPLE_TRACK.lon, latitude: SAMPLE_TRACK.lat }

/**
 * A position far outside every staged zone.
 *
 * ⚠️ Only meaningful on a server with no competing position source. Under CI's
 * sample data the stream drags the vessel back inside within a fix or two, so
 * the "move clear" phase must tolerate the zone staying active — see run.mjs.
 */
export const OUTSIDE_POSITION = { longitude: 100.0, latitude: 10.0 }

/**
 * A bbox around the prohibited zone only — the distant zone must fall outside.
 * Derived from the zone's own span so widening the zone cannot silently clip it.
 */
export const PROHIBITED_BBOX = [
  SAMPLE_TRACK.lon - HALF_SPAN - 0.5,
  SAMPLE_TRACK.lat - HALF_SPAN - 0.5,
  SAMPLE_TRACK.lon + HALF_SPAN + 0.5,
  SAMPLE_TRACK.lat + HALF_SPAN + 0.5
].join(',')

export const PROHIBITED_SITE_ID = 'E2E-ANCHOR-PROHIBITED'

/**
 * The served features identify zones by NAME, not siteId — the resource
 * provider projects a display-facing property set (styleRef, name, description,
 * restrictions, …) and deliberately does not leak the internal id.
 */
export const PROHIBITED_NAME = 'E2E Anchoring Closure'
export const DISTANT_NAME = 'E2E Distant Area'
export const REGION_NAME = REGION

import type { Plugin, ServerAPI } from '@signalk/server-api'
import { attributionBlock, ATTRIBUTION_TAG } from './attribution.js'
import { ACTIVITIES, type Activity } from './schema.js'
import { SpatialIndex } from './spatial-index.js'
import { DataManager, type Manifest } from './data-manager.js'
import {
  makeResourceProvider,
  RESOURCE_TYPE,
  type RestrictedAreasIndex,
  type IndexedZone,
  type Bbox
} from './resource-provider.js'
import { GeofenceEngine, type ZoneIndex, type ZoneHit } from './geofence.js'

const PLUGIN_ID = 'signalk-restricted-areas'

const REGION_SLUGS = [
  'sw-pacific',
  'ne-pacific',
  'se-pacific',
  'nw-atlantic',
  'ne-atlantic',
  'caribbean',
  'mediterranean',
  'indian-ocean'
] as const

interface Config {
  regions: string[]
  minLfp: number
  geofence: {
    enabled: boolean
    alertOn: Activity[]
    approachDistanceM: number
    lookaheadSeconds: number
    hysteresisM: number
    evalIntervalSeconds: number
    minMoveM: number
  }
  autoUpdate: boolean
  updateIntervalDays: number
  resourceType: string
  dataRepo: string
}

const DEFAULTS: Config = {
  regions: ['sw-pacific'],
  minLfp: 0,
  geofence: {
    enabled: true,
    alertOn: ['anchoring', 'entry'],
    approachDistanceM: 1852,
    lookaheadSeconds: 600,
    hysteresisM: 200,
    evalIntervalSeconds: 10,
    minMoveM: 20
  },
  autoUpdate: true,
  updateIntervalDays: 30,
  resourceType: RESOURCE_TYPE,
  dataRepo: 'dirkwa/restricted-areas-data'
}

/**
 * Adapt SpatialIndex (which returns RestrictedZoneProps + a getFeature → GeoJSON
 * Feature) to the {props, geometry} surface the resource provider reads.
 */
function asResourceIndex(index: SpatialIndex): RestrictedAreasIndex {
  const toIndexed = (siteId: string): IndexedZone | undefined => {
    const feature = index.getFeature(siteId)
    if (feature === null || feature.properties === null) return undefined
    // getFeature builds properties from RestrictedZoneProps (geojson widens it to
    // GeoJsonProperties); narrow it back for the provider.
    return { props: feature.properties as IndexedZone['props'], geometry: feature.geometry }
  }
  return {
    allZones(): readonly IndexedZone[] {
      return index
        .allZones()
        .map((p) => toIndexed(p.siteId))
        .filter((z): z is IndexedZone => z !== undefined)
    },
    getFeature(siteId: string): IndexedZone | undefined {
      return toIndexed(siteId)
    },
    queryBbox(bbox: Bbox): readonly IndexedZone[] {
      return index
        .queryBbox(bbox)
        .map((p) => toIndexed(p.siteId))
        .filter((z): z is IndexedZone => z !== undefined)
    }
  }
}

/** Adapt SpatialIndex to the geofence ZoneIndex (queryBbox takes 4 scalars there). */
function asZoneIndex(index: SpatialIndex): ZoneIndex {
  return {
    queryPoint(lon: number, lat: number): ZoneHit[] {
      return index.queryPoint(lon, lat)
    },
    queryBbox(minLon: number, minLat: number, maxLon: number, maxLat: number): ZoneHit[] {
      return index.queryBbox([minLon, minLat, maxLon, maxLat])
    }
  }
}

function buildSchema(): object {
  return {
    type: 'object',
    title: 'Restricted Areas (ProtectedSeas Navigator)',
    description:
      'Marine protected/managed area geofencing & display. Data: ProtectedSeas Navigator, CC BY 4.0. ' +
      'Summary data — NOT a legal/compliance document. Verify against official sources.',
    properties: {
      regions: {
        type: 'array',
        title: 'Ocean-basin regions to load',
        description: 'Load only the basin(s) you sail.',
        items: { type: 'string', enum: [...REGION_SLUGS] },
        default: DEFAULTS.regions,
        uniqueItems: true
      },
      minLfp: {
        type: 'integer',
        title: 'Minimum Level of Fishing Protection to display',
        description: '0 = show all zones; raise to filter to more strongly fish-protected areas.',
        minimum: 0,
        maximum: 5,
        default: DEFAULTS.minLfp
      },
      geofence: {
        type: 'object',
        title: 'Proximity notifications',
        properties: {
          enabled: { type: 'boolean', default: DEFAULTS.geofence.enabled },
          alertOn: {
            type: 'array',
            title: 'Activities to alert on',
            items: { type: 'string', enum: [...ACTIVITIES] },
            default: DEFAULTS.geofence.alertOn,
            uniqueItems: true
          },
          approachDistanceM: {
            type: 'number',
            title: 'Approach radius (m)',
            default: DEFAULTS.geofence.approachDistanceM
          },
          lookaheadSeconds: {
            type: 'number',
            title: 'COG look-ahead (s)',
            default: DEFAULTS.geofence.lookaheadSeconds
          },
          hysteresisM: {
            type: 'number',
            title: 'Exit hysteresis (m)',
            default: DEFAULTS.geofence.hysteresisM
          },
          evalIntervalSeconds: {
            type: 'number',
            title: 'Eval interval (s)',
            default: DEFAULTS.geofence.evalIntervalSeconds
          },
          minMoveM: {
            type: 'number',
            title: 'Min movement to re-eval (m)',
            default: DEFAULTS.geofence.minMoveM
          }
        }
      },
      autoUpdate: {
        type: 'boolean',
        title: 'Auto-check for dataset updates',
        default: DEFAULTS.autoUpdate
      },
      updateIntervalDays: {
        type: 'number',
        title: 'Update check interval (days)',
        default: DEFAULTS.updateIntervalDays
      },
      resourceType: {
        type: 'string',
        title: 'Resource type name',
        default: DEFAULTS.resourceType
      },
      dataRepo: {
        type: 'string',
        title: 'Data release repo',
        default: DEFAULTS.dataRepo
      }
    }
  }
}

function withDefaults(raw: object): Config {
  const config = raw as Partial<Config>
  return {
    ...DEFAULTS,
    ...config,
    geofence: { ...DEFAULTS.geofence, ...(config.geofence ?? {}) }
  }
}

module.exports = (app: ServerAPI): Plugin => {
  let geofence: GeofenceEngine | undefined
  let status = `No dataset — configure regions to fetch from ${DEFAULTS.dataRepo}`

  function setStatus(msg: string): void {
    status = msg
    app.setPluginStatus(msg)
  }

  async function startAsync(config: Config): Promise<void> {
    const manager = new DataManager({
      dataRepo: config.dataRepo,
      regions: config.regions,
      dataDir: app.getDataDirPath(),
      autoUpdate: config.autoUpdate
    })

    setStatus(`Fetching dataset from ${config.dataRepo}…`)
    const dataset = await manager.ensureDataset()
    const manifest: Manifest | undefined = dataset.manifest

    const attribution = attributionBlock({
      visited: manifest?.datasetDate,
      downloaded: manifest?.downloadDate
    })

    // Load every verified regional FGB into one in-memory index.
    let index = await SpatialIndex.fromFeatureCollection(
      { type: 'FeatureCollection', features: [] },
      attribution
    )
    if (dataset.localFiles.length > 0) {
      index = await SpatialIndex.fromFlatGeobufFiles(dataset.localFiles, attribution)
    }

    app.registerResourceProvider(
      makeResourceProvider({
        index: asResourceIndex(index),
        monitored: config.geofence.alertOn,
        attribution
      })
    )

    if (config.geofence.enabled) {
      geofence = new GeofenceEngine({
        app: {
          // Bridge the plugin-friendly {path:string, value} message to the
          // branded Delta the server API expects.
          handleMessage: (pluginId, msg) => {
            app.handleMessage(pluginId, msg as Parameters<ServerAPI['handleMessage']>[1])
          },
          debug: (msg, ...args) => {
            app.debug(msg, ...args)
          }
        },
        pluginId: PLUGIN_ID,
        index: asZoneIndex(index),
        config: config.geofence
      })
      geofence.start(app.streambundle)
    }

    const version = manifest?.version ?? 'no dataset'
    const detail = dataset.ok ? `${index.size()} zones` : dataset.message
    setStatus(`${version} · ${detail} · ${ATTRIBUTION_TAG}`)
  }

  const plugin: Plugin = {
    id: PLUGIN_ID,
    name: 'Restricted Areas (ProtectedSeas Navigator)',
    description:
      'Serve marine restricted-area data to Freeboard-SK via the Resources API and emit ' +
      'server-side geofence notifications. Data: ProtectedSeas Navigator (CC BY 4.0).',

    schema: buildSchema,

    start(rawConfig: object): void {
      const config = withDefaults(rawConfig)
      // Never block server startup on network/index work.
      startAsync(config).catch((err: unknown) => {
        app.setPluginError(err instanceof Error ? err.message : String(err))
      })
    },

    stop(): void {
      geofence?.stop()
      geofence = undefined
    },

    statusMessage(): string {
      return status
    }
  }

  return plugin
}

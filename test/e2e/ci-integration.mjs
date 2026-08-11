/**
 * Setup wrapper for the end-to-end run — the entry point for BOTH `test:e2e`
 * and `test:integration`. (The two scripts are the same thing; plugin-ci
 * discovers the run by the `test:integration` name, so that one has to keep it.)
 *
 * The shared SignalK plugin-ci workflow starts a server, installs this plugin,
 * and runs the script with SIGNALK_URL pointing at it. That server has no
 * dataset, so before handing off to run.mjs we
 *   1. POST the plugin config with `autoUpdate: false` and let it restart,
 *   2. stage the offline fixture into the plugin's data dir, and
 *   3. restart once more so the plugin indexes it.
 *
 * Steps 1 and 2 are in that order on purpose — see the comment at the call site.
 *
 * Never call run.mjs directly: it asserts, it does not set anything up, so on a
 * server with `autoUpdate` left at its default it would happily check the live
 * Navigator download instead of the fixture. See test/e2e/README.md.
 */

import { join } from 'node:path'

import { stageDataset, REGION_NAME } from './setup-fixture.mjs'

const BASE = process.env.SIGNALK_URL ?? 'http://localhost:3000'
const PLUGIN_ID = 'signalk-restricted-areas'

/**
 * Where the server hands the plugin its data dir. `app.getDataDirPath()` is
 * <config>/plugin-config-data/<pluginId>, and SIGNALK_NODE_CONFIG_DIR is what
 * plugin-ci sets when it starts the server.
 */
function dataDir() {
  const configDir = process.env.SIGNALK_NODE_CONFIG_DIR
  if (configDir === undefined || configDir === '') {
    throw new Error(
      'SIGNALK_NODE_CONFIG_DIR is not set — cannot locate the plugin data dir to stage the fixture'
    )
  }
  return join(configDir, 'plugin-config-data', PLUGIN_ID)
}

const configuration = {
  autoUpdate: false, // the whole point: never touch the network
  regions: [REGION_NAME],
  geofence: { enabled: true }
}

/** POST the config, which makes the server stop the plugin and start it again. */
async function reconfigure() {
  const res = await fetch(`${BASE}/plugins/${PLUGIN_ID}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, configuration }),
    signal: AbortSignal.timeout(30_000)
  })
  if (!res.ok) {
    console.error(`::error::failed to configure the plugin → HTTP ${res.status}`)
    process.exit(1)
  }
}

// ORDER MATTERS. `autoUpdate` defaults to TRUE, and plugin-ci starts the server
// with an empty configuration — so the plugin's first start downloads the real
// multi-megabyte dataset from GitHub Releases and overwrites whatever we staged.
// Pin autoUpdate:false FIRST, let that restart settle, and only then write the
// fixture, so nothing can race in behind us and replace it.
await reconfigure()
await new Promise((resolve) => setTimeout(resolve, 1000))

const staged = await stageDataset(dataDir())
console.log(`staged offline dataset at ${staged}`)

// Restart again, now that the dataset dir holds the fixture.
await reconfigure()
console.log('plugin reconfigured; waiting for it to come back up')

// startAsync is detached, so the resource provider registers a moment after the
// POST returns. Poll for the listing rather than guessing a sleep duration.
const listingUrl = `${BASE}/signalk/v2/api/resources/restricted-areas`
let ready = false
let lastProblem = 'no request completed'
for (let i = 0; i < 30 && !ready; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500))
  const listing = await fetch(listingUrl, { signal: AbortSignal.timeout(10_000) })
    .then((r) => {
      if (!r.ok) {
        lastProblem = `HTTP ${r.status}`
        return null
      }
      return r.json()
    })
    .catch((err) => {
      lastProblem = err instanceof Error ? err.message : 'unknown fetch error'
      return null
    })
  if (listing === null) continue
  lastProblem = 'listing served, but no ResourceSet carried features'
  ready = Object.values(listing).some(
    (v) => v !== null && typeof v === 'object' && (v.values?.features?.length ?? 0) > 0
  )
}

if (!ready) {
  // Without the last failure the CI log just says "no zones" — which looks
  // identical whether the server was down, 404'd, or served an empty index.
  console.error(
    `::error::plugin did not serve any zones after staging the offline dataset (${lastProblem})`
  )
  process.exit(1)
}

console.log('plugin is serving the staged dataset')

// Hand off to the assertions.
await import('./run.mjs')

/**
 * End-to-end test: a real Signal K server, this plugin installed, asserted over
 * HTTP.
 *
 * The unit suites mock the server API, and test/esm-loader.test.ts proves the
 * built package LOADS. Neither proves the plugin actually serves anything: that
 * the custom resource type reaches the Resources API, that the ResourceSets
 * carry the attribution the ProtectedSeas terms require, or that `?bbox=`
 * filters. AGENTS.md records that two real bugs shipped past green unit suites,
 * so this drives the assembled system instead.
 *
 * Run against an already-running server (this is what CI's plugin-ci does):
 *   SIGNALK_URL=http://localhost:3000 npm run test:e2e
 *
 * The dataset is staged offline by setup-fixture.mjs — no network, no download.
 */

import { strict as assert } from 'node:assert'

import { RESOURCE_TYPE } from '../../plugin/resource-provider.js'
import { DISTANT_NAME, INSIDE_POSITION, PROHIBITED_NAME } from './setup-fixture.mjs'

const BASE = process.env.SIGNALK_URL ?? 'http://localhost:3000'
const RESOURCES = `${BASE}/signalk/v2/api/resources/${RESOURCE_TYPE}`

let failures = 0

async function check(label, fn) {
  try {
    await fn()
    console.log(`  ok  ${label}`)
  } catch (err) {
    failures += 1
    console.log(`FAIL  ${label}`)
    console.log(`      ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function getJson(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`)
  return res.json()
}

/**
 * Push a delta into the server over /signalk/v1/stream. The ws interface hands
 * anything with `updates` to app.handleMessage, so this is the supported way to
 * feed the vessel a position without a real data source.
 */
function sendDelta(delta) {
  return new Promise((resolve, reject) => {
    const url = `${BASE.replace(/^http/, 'ws')}/signalk/v1/stream?subscribe=none`
    const socket = new WebSocket(url)
    const fail = (err) => {
      try {
        socket.close()
      } catch {
        /* already closing */
      }
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify(delta))
      // Give the server a tick to process before the socket goes away.
      setTimeout(() => {
        socket.close()
        resolve()
      }, 250)
    })
    socket.addEventListener('error', () => {
      fail(new Error(`websocket to ${url} failed`))
    })
    setTimeout(() => {
      fail(new Error(`websocket to ${url} did not open within 10s`))
    }, 10_000)
  })
}

/** Every ResourceSet in the listing, regardless of how the layers are keyed. */
function resourceSets(listing) {
  return Object.values(listing).filter(
    (v) => v !== null && typeof v === 'object' && v.type === 'ResourceSet'
  )
}

console.log(`e2e: ${BASE}`)

await check('plugin is loaded by the server', async () => {
  const plugins = await getJson(`${BASE}/skServer/plugins`)
  const mine = plugins.find((p) => p.packageName === 'signalk-restricted-areas')
  assert.ok(mine, 'plugin not present in /skServer/plugins')
  // The listing carries id/name/schema, not an `enabled` flag — presence here
  // means the server loaded the ESM entrypoint and called the factory.
  assert.equal(mine.id, 'signalk-restricted-areas')
  assert.ok(mine.schema, 'plugin exposes no config schema')
})

await check('registers its custom resource type', async () => {
  const listing = await getJson(RESOURCES)
  assert.ok(listing && typeof listing === 'object', 'resource listing is not an object')
  assert.ok(resourceSets(listing).length > 0, 'no ResourceSets returned — provider not serving')
})

await check('serves the staged zones as GeoJSON features', async () => {
  const listing = await getJson(RESOURCES)
  const features = resourceSets(listing).flatMap((set) => set.values?.features ?? [])
  assert.ok(features.length > 0, 'ResourceSets contain no features')

  const prohibited = features.find((f) => f.properties?.name === PROHIBITED_NAME)
  assert.ok(prohibited, `staged zone "${PROHIBITED_NAME}" not served`)
  assert.equal(prohibited.type, 'Feature')
  assert.ok(prohibited.geometry, 'served zone has no geometry')
})

await check('decodes the prohibited zone into the prohibited bucket', async () => {
  // The load-bearing assertion. The coding key defines 1 = PROHIBITED, so a
  // truthy read anywhere in the chain would bucket this zone as allowed and
  // invert the plugin's entire safety meaning.
  const listing = await getJson(RESOURCES)
  const prohibited = resourceSets(listing)
    .flatMap((set) => set.values?.features ?? [])
    .find((f) => f.properties?.name === PROHIBITED_NAME)

  assert.ok(prohibited, `staged zone "${PROHIBITED_NAME}" not served`)
  assert.equal(
    prohibited.properties.styleRef,
    'prohibited',
    `expected styleRef "prohibited", got "${String(prohibited.properties.styleRef)}"`
  )
  assert.equal(
    prohibited.properties.restrictions?.anchoring,
    'prohibited',
    'anchoring restriction did not survive the round trip as "prohibited"'
  )
})

await check('carries the ProtectedSeas attribution on every ResourceSet', async () => {
  // CC BY 4.0 — the terms require the attribution to be surfaced, and the spec
  // pins it to the END of the description.
  const listing = await getJson(RESOURCES)
  const sets = resourceSets(listing)
  assert.ok(sets.length > 0, 'no ResourceSets to check')
  for (const set of sets) {
    assert.ok(
      typeof set.description === 'string' && set.description.includes('ProtectedSeas'),
      `ResourceSet "${String(set.name)}" description lacks the attribution`
    )
  }
})

await check('filters by ?bbox=', async () => {
  // A box around the staged prohibited zone only — the distant zone must drop.
  const inBox = await getJson(`${RESOURCES}?bbox=173.5,-37.5,175.5,-35.5`)
  const names = new Set(
    resourceSets(inBox)
      .flatMap((set) => set.values?.features ?? [])
      .map((f) => f.properties?.name)
  )
  assert.ok(names.has(PROHIBITED_NAME), 'bbox query dropped the zone inside the box')
  assert.ok(!names.has(DISTANT_NAME), 'bbox query returned a zone outside the box')
})

await check('raises a geofence notification when the vessel enters a zone', async () => {
  // Drive the real subscription: the engine listens on the self bus for
  // navigation.position, so feeding a delta in exercises the whole chain
  // (delta → streambundle → engine → app.handleMessage → notifications tree).
  //
  // The per-zone path is uuidv5(siteId) under a namespace the engine keeps
  // private, so assert on the SUBTREE rather than recomputing that id here —
  // duplicating the namespace would rot the moment it changed.
  const subtree = 'notifications/navigation/restrictedArea'

  // A delta sent over /signalk/v1/stream is fed straight to app.handleMessage
  // (server src/interfaces/ws.ts), which is the supported way to inject data.
  await sendDelta({
    context: 'vessels.self',
    updates: [
      {
        source: { label: 'e2e' },
        values: [{ path: 'navigation.position', value: INSIDE_POSITION }]
      }
    ]
  })

  // The engine reacts on the delta, but the tree updates asynchronously.
  let notification = null
  for (let i = 0; i < 25 && notification === null; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    const tree = await getJson(`${BASE}/signalk/v1/api/vessels/self/${subtree}`).catch(() => null)
    if (tree === null) continue
    // One child per zone, keyed by the uuidv5 of its siteId.
    for (const zone of Object.values(tree)) {
      if (zone?.value?.state && zone.value.state !== 'normal') {
        notification = zone.value
        break
      }
    }
  }

  assert.ok(notification, `no notification under ${subtree} after entering "${PROHIBITED_NAME}"`)
  assert.ok(
    ['alert', 'warn', 'alarm', 'emergency'].includes(notification.state),
    `unexpected notification state "${String(notification.state)}"`
  )
  // Name the zone, so this cannot pass on some unrelated notification.
  assert.ok(
    typeof notification.message === 'string' && notification.message.includes(PROHIBITED_NAME),
    `notification message does not name the entered zone: ${String(notification.message)}`
  )
})

console.log('')
if (failures > 0) {
  console.log(`e2e FAILED — ${failures} check(s)`)
  process.exit(1)
}
console.log('e2e passed')

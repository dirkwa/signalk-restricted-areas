# End-to-end test

Drives a **real Signal K server** with this plugin installed and asserts over HTTP. The unit
suites mock the server API and `test/esm-loader.test.ts` proves the built package *loads* —
neither proves the plugin actually *serves* anything.

## What it asserts

| Check | Why it matters |
| --- | --- |
| Plugin is loaded by the server | The ESM entrypoint resolves through the real plugin loader |
| Registers its custom resource type | `restricted-areas` reaches the Resources API |
| Serves the staged zones as features | The FGB → index → ResourceSet chain works end to end |
| Prohibited zone lands in the prohibited bucket | **The load-bearing one.** `1 = PROHIBITED`; a truthy read anywhere would invert the plugin's safety meaning |
| Attribution on every ResourceSet | CC BY 4.0 requires it, and the spec pins it to the end of the description |
| `?bbox=` filtering | Viewport queries must drop out-of-box zones |
| Geofence raises a notification | A position delta over `/signalk/v1/stream` must produce an alarm naming the entered zone |

## No network

The production path downloads regional FlatGeobuf extracts from the data repo's GitHub
Releases. An e2e must not do that — tens of megabytes per run, failing whenever GitHub is
having a bad day. Instead `setup-fixture.mjs` writes a small FGB plus its manifest straight
into the plugin's data dir and runs with `autoUpdate: false`, which routes `DataManager` down
its offline branch and never opens a socket.

The geometry is synthetic; the **property shape is not**. A published FGB carries
post-pipeline properties — camelCase keys, activity levels already decoded, non-scalar fields
JSON-encoded (FlatGeobuf columns are scalar-only). `fromFlatGeobufFile` restores exactly that
and does *not* re-run `normalizeProps`, so a fixture written in raw snake_case Navigator form
silently indexes **zero zones**.

## Running it

In CI the shared plugin-ci workflow starts a server, installs the plugin, and runs
`npm run test:integration` with `SIGNALK_URL` set. That server has no dataset, so
`ci-integration.mjs` stages the fixture, POSTs the plugin config to force a restart, waits for
zones to appear, then hands off to `run.mjs`.

Locally, against a server you already have running:

```bash
# one-time: install the server somewhere scratch and install the plugin into it
npm pack --ignore-scripts --pack-destination /tmp
cd ~/dev/tmp/ra-e2e-run && npm install /tmp/signalk-restricted-areas-*.tgz

# stage the fixture + start the server (PORT, not -p — the flag is ignored without a
# settings file, and the server will otherwise take 3000)
export SIGNALK_NODE_CONFIG_DIR=$PWD
PORT=3999 NMEA0183PORT=20111 node node_modules/signalk-server/bin/signalk-server

# then, from this repo
SIGNALK_URL=http://localhost:3999 npm run test:e2e
```

Pick a free `NMEA0183PORT`: the default 10110 is usually already taken by a real server on
this machine, and the collision only shows up as a line in the log.

## Checking that it can still fail

A green e2e that cannot detect breakage is worthless. Flip the fixture's decoded level and the
bucket assertion must fail:

```bash
sed -i "s/anchoring: 'prohibited'/anchoring: 'allowed'/" test/e2e/setup-fixture.mjs
# → FAIL  decodes the prohibited zone into the prohibited bucket
#         expected styleRef "prohibited", got "info"
git checkout test/e2e/setup-fixture.mjs
```

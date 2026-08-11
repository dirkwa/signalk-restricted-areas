# AGENTS.md

Notes for AI coding agents working on this repository. Human-facing install and
configuration live in [README.md](README.md); this file is the orientation an agent needs
before making non-trivial changes.

## What this is

A Signal K server plugin that serves marine **restricted-area** data (anchoring
prohibitions, fishing closures, entry/transit restrictions, …) from the **ProtectedSeas
Navigator** dataset to chart clients — primarily **Freeboard-SK** — via the Signal K
**Resources API**, and performs **server-side geofencing** that emits notifications when
the vessel approaches or enters a restricted zone.

The dataset is produced by the companion pipeline repo
[`restricted-areas-data`](https://github.com/dirkwa/restricted-areas-data) and published as
regional FlatGeobuf extracts in GitHub Releases — kept current automatically by that repo's
weekly Navigator-API sync. This plugin downloads the region(s) the user configures,
sha256-verifies them, indexes them in memory, and serves them.

## ⚠️ THE landmine — the activity coding key

ProtectedSeas codes every fishing + marine-activity column numerically:

```
0 = Allowed   1 = PROHIBITED   2 = Restricted   3 = N/A or Unknown   null = Not-Yet-Coded
```

**`1` means PROHIBITED, not "present/allowed".** A truthy test such as `if (props.anchoring)`
treats `1` as allowed and **inverts the entire safety meaning of the plugin** — the alarm
fires on the wrong zones. Every coded column MUST go through `levelOf()` in
[src/schema.ts](src/schema.ts). There is a golden regression test asserting
`levelOf(1) === 'prohibited'` ([test/schema.test.ts](test/schema.test.ts)) — if it ever
flips, do not "fix" it to make other code pass; the decode is correct and something else is
wrong. The decode contract has **four corners that must stay in lockstep**: `src/schema.ts`
(here) and, in the pipeline repo, `bin/lib/decode.mjs`, `mapping.json`, and
`bin/lib/api-map.mjs` (the Navigator API uses the same coding key but renames five fields
and stringifies all numerics; api-map adapts API records into the schema everything else
consumes). Change one, check all four.

## Architecture rules

- **Read-only resource provider.** The provider registers under a custom resource type
  (`restricted-areas`, configurable). `setResource`/`deleteResource` throw — never write to
  user resource stores (`regions`, `notes`, …).
- **Offline-first.** Network is used only to fetch/update the dataset. Every other function
  works without connectivity. `start()` must never block server startup on network or index
  work — `startAsync` runs detached and routes failures to `app.setPluginError`. The fetched
  `manifest.json` is persisted beside the FGBs so the **Navigator extract date** survives
  offline restarts — users must always be able to see the release date of the data they are
  navigating with (a ProtectedSeas requirement). It shows in the status line and the config
  schema description.
- **Per-component spatial index, never per-feature.** A single Navigator MultiPolygon can
  straddle ±180°; its overall bbox can be ~358° wide and would match almost every query
  point. [src/spatial-index.ts](src/spatial-index.ts) EXPLODES every MultiPolygon into
  component polygons and inserts one RBush entry per component (back-ref'd to the parent
  siteId). Do not "simplify" this to a per-feature bbox.
- **Deterministic notifications.** Geofence notifications go out via `app.handleMessage` with
  explicit `Notification` value objects on STABLE per-zone paths
  `notifications.navigation.restrictedArea.<uuidv5(siteId)>` — NOT `app.notifications.raise`
  (which self-assigns a UUID and is not idempotent across restarts). Do not pass `skVersion`;
  `notifications.*` is a v1 path.
- **Attribution everywhere.** ProtectedSeas Navigator is CC BY 4.0 and the Terms require the
  attribution + disclaimer to be surfaced. It rides on every ResourceSet `description`, the
  plugin `statusMessage`, and the README. [src/attribution.ts](src/attribution.ts) is the
  single source; do not inline citation strings elsewhere.

## File layout

- [src/index.ts](src/index.ts) — plugin entrypoint, lifecycle, config JSON Schema, and the
  module wiring. Holds two thin adapters: SpatialIndex → the resource provider's
  `RestrictedAreasIndex` (`{props, geometry}`) and → the geofence `ZoneIndex` (whose
  `queryBbox` takes four scalars vs SpatialIndex's single tuple). The leaf modules were built
  with slightly different index interfaces on purpose (each is independently testable); the
  glue lives here.
- [src/schema.ts](src/schema.ts) — **the load-bearing module.** `levelOf()` (the coding-key
  decode), the normalizer `normalizeProps()` (raw Navigator properties → `RestrictedZoneProps`),
  the 12-member coarse `Activity` vocabulary with V1/V2 coalescing
  (`dredging`↔`dredging_dumping`, `artisanal`+`subsistence`, the `fishing` rollup over 25 gear
  columns), the special fields (`tribal` boolean, `wdpa_id` type-unstable, `iucn_cat`
  'Unassigned'→null, `lfp` 0..5), and `zoneSeverity()`.
- [src/spatial-index.ts](src/spatial-index.ts) — `SpatialIndex`: `fromFeatureCollection`
  (in-memory, for tests), `fromFlatGeobufFile`/`fromFlatGeobufFiles` (production), `queryPoint`,
  `queryBbox`, `allZones`, `getFeature`, `size`. rbush + flatgeobuf are ESM-only and this package
  is ESM, so they are plain static imports. The `from*` builders keep their `Promise` return type
  even though only the FlatGeobuf ones actually await I/O.
- [src/data-manager.ts](src/data-manager.ts) — `DataManager.ensureDataset()`: fetch the latest
  Release `manifest.json` from the data repo, download + sha256-verify the configured regions'
  display FGBs, atomic-swap into the data dir, persist the manifest locally. Offline-tolerant;
  never throws out of `ensureDataset`. ⚠️ The manifest nests assets under `regions[].assets`
  (NOT a flat `assets` array) — the shape is pinned by the verbatim published manifest in
  [test/fixtures/](test/fixtures/); mock manifests in tests must use the real shape, because
  an invented flat shape is exactly how the first live-release bug slipped past the suite.
- [src/resource-provider.ts](src/resource-provider.ts) — `makeResourceProvider()`: the four
  `ResourceProviderMethods`, ResourceSet shaping (split by severity bucket with `styleRef`),
  `?bbox=` filtering, UUIDv5 ids. Freeboard style keys are `stroke`/`fill`/`width`(/`lineDash`).
- [src/geofence.ts](src/geofence.ts) — `GeofenceEngine`: subscribes position/COG/SOG via
  `app.streambundle.getSelfBus`, per-zone state machine (`clear → approaching → inside → clear`)
  with hysteresis + COG lookahead, emits the deterministic notifications. `evaluate(pos, motion)`
  is clock-free so tests drive it directly. `stop()` unsubscribes AND emits `normal` for every
  active zone (the clean-shutdown invariant).
- [src/attribution.ts](src/attribution.ts) — CC BY 4.0 license tag, the three required
  citations, the disclaimer, and `attributionBlock()`.
- [test/](test/) — vitest. Pure unit tests against in-memory fixtures + mocked `fetch`. The
  antimeridian regression lives in `spatial-index.test.ts`; the coding-key golden in
  `schema.test.ts`; the ESM packaging guard in `esm-loader.test.ts` (it loads the BUILT
  package through a replica of the server's `importOrRequire`).
- [test/e2e/](test/e2e/) — the end-to-end run: a real Signal K server with the plugin
  installed, asserted over HTTP (resource type registered, zones served, severity bucketing,
  attribution, `?bbox=`, and a geofence notification driven by a position delta). Offline —
  the dataset is a staged FGB fixture, never a download. See
  [test/e2e/README.md](test/e2e/README.md); it is **not** part of `npm test`.

## Build, lint, test

```bash
npm run format     # prettier --write + eslint --fix
npm run lint       # eslint check (no auto-fix)
npm run build      # tsc → plugin/
npm run build:all  # lint + build + test
npm test           # vitest (unit only — no server, no network)

# End-to-end, against a Signal K server you are already running:
# SIGNALK_NODE_CONFIG_DIR must match the server's — it is how the wrapper finds
# the plugin data dir to stage the fixture into, and the run aborts without it.
SIGNALK_URL=http://localhost:3999 SIGNALK_NODE_CONFIG_DIR=/path/to/server npm run test:e2e
```

`test:integration` is the same run wrapped for CI — the shared plugin-ci workflow calls it
automatically once a `test:integration` script exists, staging the fixture into the server it
just started. Neither e2e script is part of `npm test`; both need a live server.

`plugin/` is gitignored build output; `.scratch/` is gitignored local scratch (cr output,
verification downloads) — never commit either. `prepublishOnly` rebuilds before npm publish.

## CI and releases

- [.github/workflows/signalk-ci.yml](.github/workflows/signalk-ci.yml) — every push/PR runs
  the shared SignalK reusable plugin-ci workflow: Linux x64/arm64, macOS, Windows on
  Node 20/22/24, `npm run lint` as the blocking format check, plus a Signal K server
  integration test. [.gitattributes](.gitattributes) forces LF on checkout — without it the
  Windows runners check out CRLF and prettier fails every line.
- [.github/workflows/publish.yml](.github/workflows/publish.yml) — pushing a `vX.Y.Z` tag
  creates the GitHub release and publishes to npm via **OIDC trusted publishing**
  (`npm publish --provenance`, no token secret). `-beta.`/`-rc.` tags land on the `beta`
  dist-tag. The job fails if the tag and `package.json` version disagree.
- **Release notes are generated, not hand-written.** There is no `CHANGELOG.md`. The publish
  job sets `generate_release_notes: true`, and [.github/release.yml](.github/release.yml)
  groups the notes into 🚀 Features / 🐛 Fixes / 📦 Dependencies / Other by PR **label**.
  So: label every PR (`enhancement`/`feature`, `bug`/`fix`, `dependencies`), and give it an
  Angular-style title — the title is what appears in the notes. `skip-changelog` omits a PR
  entirely.
- Version bumps ride their own `chore(release): X.Y.Z` PR — never inside a feature/fix PR.
- Dependabot checks npm (minor+patch grouped) and actions weekly; CodeRabbit auto-review
  skips `chore(release):`/`chore(deps):` PRs ([.coderabbit.yaml](.coderabbit.yaml)).

## Gotchas

- **This package is pure ESM** (`"type": "module"`, `module`/`moduleResolution: nodenext`). The
  entrypoint is `export default (app) => …`, NOT `module.exports =`. There is no `require`,
  `__dirname`, or `__filename` — use `import.meta.url` if you ever need a module path. Relative
  imports must carry the `.js` extension (they already do). ESM-only deps (`rbush`, `flatgeobuf`)
  are now plain static imports; the old dynamic-`import()` workaround is gone.
- **Node floor is 20.19.0.** The Signal K server loads plugins via `importOrRequire()`, which
  tries `require()` first — that only works on an ESM plugin from Node 20.19+/22+. Do not lower
  `engines.node` back to `>=20.0.0`.
- **eslint `argsIgnorePattern` is `'^$'`.** You cannot silence an unused arg by prefixing it
  with `_`. Write no-arg functions or actually use the arg. (Same convention as the other
  dirkwa SignalK repos.)
- **`String(unknown)` trips `no-base-to-string`.** Navigator fields are scalars but typed
  `unknown`; coerce via the `scalarToString`/`str` helpers in schema.ts, not bare `String(v)`.
- **No native dependencies.** Target is Raspberry Pi 4/5, Node 20+. Keep it that way.
- **Decode parity.** If you change `levelOf`, the coarse-activity columns, or the special-field
  rules in schema.ts, update the pipeline repo's `bin/lib/decode.mjs`, `mapping.json`, AND
  `bin/lib/api-map.mjs` to match — a drift there means the on-boat decode disagrees with the
  published data. Same for `FGB_JSON_FIELDS` in spatial-index.ts, which mirrors the pipeline's
  JSON-flattening list (FlatGeobuf has no list/struct column type).
- **Test fidelity beats convenience.** Two real bugs reached the live system through unit
  suites that passed: an invented manifest shape in mocks, and code paths only exercised
  end-to-end. When a contract has a real artifact (a published manifest, a captured API
  response), pin the test to the verbatim artifact, and prefer one real end-to-end pass over
  more mocks.

## Conventions

- Prettier: no semicolons, single quotes, `trailingComma: none`, `printWidth: 100`,
  `arrowParens: always`.
- Comments explain WHY, not WHAT — no echo comments restating the code.
- Commits use Angular conventional format (`feat:`, `fix:`, `chore:`, `refactor:`, `test:`,
  `docs:`, `perf:`, `build:`, `ci:`) — a lowercase imperative subject, no trailing period,
  with the body explaining WHY rather than restating the diff. The one exception is the
  release PR, whose subject is the bare version (`chore(release): 1.0.2`).
- **PR titles use the same Angular format.** The title is not cosmetic: it is what the
  generated release notes list under each category, and what a squash-merge records on
  master. `chore(deps):`/`chore(release):` titles additionally opt a PR out of CodeRabbit
  auto-review.
- All new code needs tests; test behaviour, not implementation.

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
regional FlatGeobuf extracts in GitHub Releases. This plugin downloads the region(s) the
user configures, indexes them in memory, and serves them.

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
wrong. The same decode is mirrored in the pipeline repo's `bin/lib/decode.mjs`; the two MUST
stay in sync.

## Architecture rules

- **Read-only resource provider.** The provider registers under a custom resource type
  (`restricted-areas`, configurable). `setResource`/`deleteResource` throw — never write to
  user resource stores (`regions`, `notes`, …).
- **Offline-first.** Network is used only to fetch/update the dataset. Every other function
  works without connectivity. `start()` must never block server startup on network or index
  work — `startAsync` runs detached and routes failures to `app.setPluginError`.
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
  `queryBbox`, `allZones`, `getFeature`, `size`. rbush + flatgeobuf are ESM-only, so under
  `module:node16`/CommonJS they are pulled in via dynamic `import()` and the build functions are
  `async` (see Gotchas).
- [src/data-manager.ts](src/data-manager.ts) — `DataManager.ensureDataset()`: fetch the latest
  Release `manifest.json` from the data repo, download + sha256-verify the configured regions'
  FGBs, atomic-swap into the data dir. Offline-tolerant; never throws out of `ensureDataset`.
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
  `schema.test.ts`.

## Build, lint, test

```bash
npm run format     # prettier --write + eslint --fix
npm run lint       # eslint check (no auto-fix)
npm run build      # tsc → plugin/
npm run build:all  # lint + build + test
npm test           # vitest
```

`plugin/` is gitignored build output. `prepublishOnly` rebuilds before npm publish.

## Gotchas

- **ESM-only deps under node16/CommonJS.** `rbush` and `flatgeobuf` ship ESM only. A static
  `import` of them errors at build with TS1479. They are loaded via dynamic `import()`; this is
  why `SpatialIndex.from*` are async. `@turf/*` and `uuid` have `require` conditions and use
  normal static imports.
- **eslint `argsIgnorePattern` is `'^$'`.** You cannot silence an unused arg by prefixing it
  with `_`. Write no-arg functions or actually use the arg. (Same convention as the other
  dirkwa SignalK repos.)
- **`String(unknown)` trips `no-base-to-string`.** Navigator fields are scalars but typed
  `unknown`; coerce via the `scalarToString`/`str` helpers in schema.ts, not bare `String(v)`.
- **No native dependencies.** Target is Raspberry Pi 4/5, Node 20+. Keep it that way.
- **Decode parity.** If you change `levelOf`, the coarse-activity columns, or the special-field
  rules in schema.ts, update the pipeline repo's `bin/lib/decode.mjs` and `mapping.json` to
  match — a drift there means the on-boat decode disagrees with the published data.

## Conventions

- Prettier: no semicolons, single quotes, `trailingComma: none`, `printWidth: 100`,
  `arrowParens: always`.
- Comments explain WHY, not WHAT — no echo comments restating the code.
- Commits use Angular conventional format (`feat:`, `fix:`, `chore:`, …).
- All new code needs tests; test behaviour, not implementation.

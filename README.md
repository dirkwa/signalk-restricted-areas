# signalk-restricted-areas

A [Signal K](https://signalk.org/) server plugin that serves marine **restricted-area**
data (anchoring prohibitions, fishing closures, entry/transit restrictions, …) from the
[**ProtectedSeas Navigator**](https://navigatormap.org) dataset to chart clients —
primarily **[Freeboard-SK](https://github.com/SignalK/freeboard-sk)** — via the Signal K
**Resources API**, and performs **server-side geofencing** that emits Signal K
notifications when your vessel approaches or enters a restricted zone.

> ⚠️ **Not for navigation or legal compliance.** This is summary data and may be
> incomplete, inaccurate, or out of date. It is **not** a legal document. Always verify
> against official sources before relying on it. See [Attribution & disclaimer](#attribution--disclaimer).

## What it does

- **Resource layer for Freeboard-SK.** Publishes restricted-area polygons (with
  per-activity restriction attributes and severity styling) on the custom resource path
  `restricted-areas`, consumable as a selectable layer.
- **Server-side geofence notifications.** Watches `navigation.position` (with COG/SOG
  look-ahead) and raises `notifications.navigation.restrictedArea.<id>` when you approach
  or enter a zone whose monitored activities are restricted/prohibited. Works for any
  client on the Signal K stream — not just Freeboard.
- **Offline-first.** The dataset lives on the boat after a one-time download. Only dataset
  *updates* need connectivity; everything else works offline.

## Install

Install from the Signal K App Store (search "restricted areas"), or manually:

```sh
cd ~/.signalk/node_modules
npm install signalk-restricted-areas
```

Then enable and configure it in **Server → Plugin Config → Restricted Areas**.

## Configuration

| Option | Default | Meaning |
|---|---|---|
| **Regions** | `["sw-pacific"]` | Ocean-basin region(s) to load. Load only the basin(s) you sail. |
| **Minimum LFP** | `0` | Hide zones below this Level of Fishing Protection (0 = show all). |
| **Geofence → enabled** | `true` | Emit proximity notifications. |
| **Geofence → alertOn** | `["anchoring","entry"]` | Activities that raise an alarm. (`fishing` etc. are opt-in.) |
| **Geofence → approach radius** | `1852` m (1 NM) | Distance at which an "approaching" alert fires. |
| **Geofence → look-ahead** | `600` s | COG projection horizon for approach detection. |
| **Auto-update** | `true` | Periodically check the data repo for a newer dataset. |

Restriction codes follow the Navigator convention: **prohibited** (hard ban),
**restricted** (conditional), **allowed**, or **unknown**.

## Freeboard-SK setup

1. In Freeboard, open **Settings → Resources → Paths** and enable `restricted-areas`.
2. Open the layers menu and select the restricted-area resource set(s) you want shown.
   Sets are split by severity (prohibited / restricted / info) so you can toggle each.
3. Polygons render with severity styling; click one for its name, summary, source links,
   and attribution.

## Data

Regional extracts are produced by the companion pipeline
[`restricted-areas-data`](https://github.com/dirkwa/restricted-areas-data) and published as
GitHub Release assets (FlatGeobuf). The plugin downloads and verifies the region(s) you
configure into its data directory.

Jurisdictional/EEZ polygons, high-seas RFMO overlays, and ocean-basin-scale areas without a
hard transit ban are excluded upstream — they are not anchoring/entry restrictions and would
otherwise flood you with false notifications.

## Attribution & disclaimer

Data: **ProtectedSeas Navigator**, licensed **CC BY 4.0**. Each dataset release records its
Navigator extract date (`datasetDate` in the release `manifest.json`); the date of your
installed dataset is shown in the plugin's configuration screen and status line in the
Signal K Admin UI, so you always know the release date of the data you are using.

- Zetterlind, V. et al. (2025). *Navigator — a global database of verified marine protected
  and managed area regulations and boundaries.* Scientific Data, 12, 1212.
  https://doi.org/10.1038/s41597-025-05535-2
- *The ProtectedSeas Navigator Map of Conservation Regulations*, ProtectedSeas®,
  https://map.navigatormap.org
- *Navigator Data Download*, ProtectedSeas®, https://navigatormap.org/data-request

This is summary data and may be incomplete, inaccurate, or out of date. It is **not** a legal
or compliance document. Provided "as-is". Always verify against official sources before
relying on it for navigation or compliance.

## License

Apache-2.0 (plugin code). The Navigator **data** is CC BY 4.0 (see above).

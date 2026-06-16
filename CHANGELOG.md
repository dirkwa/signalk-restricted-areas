# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0]

Initial release.

- Serve marine restricted-area data (ProtectedSeas Navigator) to Freeboard-SK via the
  Signal K Resources API under a configurable resource type.
- Offline-first dataset management: download configured regional FlatGeobuf extracts from
  the companion data repo's GitHub Releases, sha256-verify, atomically swap, and persist the
  release manifest beside the data so the Navigator extract date survives offline restarts.
- Per-component spatial indexing (rbush) that explodes MultiPolygons into component polygons
  to keep antimeridian-spanning zones queryable.
- Server-side geofencing with hysteresis and COG lookahead, emitting deterministic
  per-zone notifications on stable paths.
- ProtectedSeas Navigator (CC BY 4.0) attribution and disclaimer surfaced on every
  ResourceSet, the plugin status line, and the README.

[1.0.0]: https://github.com/dirkwa/signalk-restricted-areas/releases/tag/v1.0.0

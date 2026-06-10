/**
 * Normalized data model for ProtectedSeas Navigator zones and the decode of
 * Navigator's coded activity columns.
 *
 * ⚠️ THE CODING KEY — READ BEFORE TOUCHING ANY ACTIVITY COLUMN ⚠️
 *
 * Navigator codes every fishing + marine-activity column as:
 *     0 = Allowed
 *     1 = PROHIBITED        <-- counterintuitive: 1 is the BAN, not "present/ok"
 *     2 = Restricted
 *     3 = N/A or Unknown
 *     null = Not-Yet-Coded  (treat as N/A)
 *
 * A truthy test such as `if (props.anchoring)` treats 1 as "allowed/present" and
 * INVERTS the safety meaning of the entire plugin. Every coded column MUST go
 * through `levelOf()`. There is a golden regression test asserting
 * `levelOf(1) === 'prohibited'` (test/schema.test.ts).
 */

/** A restriction level for a single activity. */
export type Level = 'allowed' | 'prohibited' | 'restricted' | 'unknown' | 'na'

/** The coarse activity vocabulary the plugin exposes (12 members). */
export type Activity =
  | 'anchoring'
  | 'mooring'
  | 'entry'
  | 'speed'
  | 'diving'
  | 'discharge'
  | 'dredging'
  | 'removalOfArtifacts'
  | 'fishingRecreational'
  | 'fishingCommercial'
  | 'fishingArtisanal'
  | 'fishing'

export const ACTIVITIES: readonly Activity[] = [
  'anchoring',
  'mooring',
  'entry',
  'speed',
  'diving',
  'discharge',
  'dredging',
  'removalOfArtifacts',
  'fishingRecreational',
  'fishingCommercial',
  'fishingArtisanal',
  'fishing'
] as const

/** Severity bucket for a whole zone, given a set of monitored activities. */
export type Severity = 'prohibited' | 'restricted' | 'info'

/**
 * THE decode. v===1 is PROHIBITED. Do not reorder these without updating the
 * golden test. Accepts the raw Navigator cell value (number | string | null).
 */
export function levelOf(v: unknown): Level {
  // Navigator GeoJSON stores these as JSON numbers, but be defensive about
  // string-encoded variants from other exports.
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  if (n === 0) return 'allowed'
  if (n === 1) return 'prohibited'
  if (n === 2) return 'restricted'
  if (n === 3) return 'unknown'
  return 'na'
}

/** Rank for "more restrictive wins" coalescing. Lower index = more severe. */
const LEVEL_RANK: Record<Level, number> = {
  prohibited: 0,
  restricted: 1,
  allowed: 2,
  unknown: 3,
  na: 4
}

/** Return the more-restrictive of two levels (prohibited > restricted > allowed > unknown > na). */
export function moreRestrictive(a: Level, b: Level): Level {
  return LEVEL_RANK[a] <= LEVEL_RANK[b] ? a : b
}

/** The 25 raw fishing/gear columns folded into the `fishing` rollup. */
const FISHING_COLUMNS = [
  'recreational_fishing',
  'commercial_fishing',
  'artisanal_fishing',
  'subsistence_fishing',
  'bottom_trawling',
  'pelagic_trawling',
  'hook_and_line',
  'trolling',
  'longlining',
  'nets',
  'purse_seine_rndhaul_surrd_nets',
  'gillnetting',
  'gillnets_entangling_nets',
  'trammel_nets',
  'dip_scoop_nets',
  'cast_nets',
  'drift_nets',
  'other_nets',
  'dredges',
  'traps_and_pots',
  'spear_fishing',
  'underwater_extraction_diving',
  'hand_capture',
  'fish_aggregating_devices',
  'misc_gear'
] as const

/** The 18 raw non-fishing marine-activity columns. */
const ACTIVITY_COLUMNS = [
  'discharge',
  'speed',
  'entry',
  'diving',
  'removal_of_historic_artifacts',
  'stopping',
  'anchoring',
  'mooring',
  'dragging',
  'landing',
  'dredging',
  'dredging_dumping',
  'industr_or_mineral_exploration',
  'drilling',
  'non_fishing_industr_extraction',
  'aquaculture',
  'construction',
  'overflight_or_drones'
] as const

/** All 43 coded columns, for the lossless `raw` passthrough. */
const ALL_CODED_COLUMNS = [...FISHING_COLUMNS, ...ACTIVITY_COLUMNS] as const

/** Area Categories label -> numeric id (xlsx "Area Categories" sheet). */
const CATEGORY_LABEL_TO_ID: Record<string, number> = {
  'Marine Protected Area': 1,
  'Other Effective Area-Based Conservation Area': 2,
  'Fisheries Management Area': 3,
  'Water Quality/Human Health Area': 4,
  'Recreational Area': 5,
  'Vessel Restricted Area': 6,
  'Vessel Reporting Area': 7,
  'Voluntary Conservation Measure Area': 8,
  'Jurisdictional Authority Area': 9,
  Other: 10,
  'To Be Determined': 11
}

export function categoryIdOf(label: unknown): number | 'unknown' {
  if (typeof label !== 'string') return 'unknown'
  return CATEGORY_LABEL_TO_ID[label] ?? 'unknown'
}

/** Raw Navigator feature properties (loose — V1/V2 differ only in which values are null). */
export type NavigatorProps = Record<string, unknown>

/** The normalized per-zone record carried through the plugin. */
export interface RestrictedZoneProps {
  siteId: string
  name: string
  country: string | null
  state: string | null
  authority: string | null
  designation: string | null
  category: string | null
  categoryId: number | 'unknown'
  wdpaId: string | null
  iucnCat: string | null
  lfp: number | null
  tribalExemption: boolean | null
  /** Coarse activity -> level. Only the 12 coarse activities. */
  restrictions: Partial<Record<Activity, Level>>
  /** Lossless decode of all 43 raw coded columns (key -> level). */
  raw: Record<string, Level>
  summary: string | null
  sourceUrls: string[]
  season: string | null
  effectiveFrom: string | null
  effectiveTo: string | null
  siteVersion: { major: number | null; minor: number | null }
  /** Fixed CC BY 4.0 citation + disclaimer (set by the caller from attribution.ts). */
  attribution: string
}

/** Coerce a scalar (string | number | boolean) to a trimmed string; null for anything else. */
function scalarToString(v: unknown): string | null {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return String(v)
  return null
}

function str(v: unknown): string | null {
  const s = scalarToString(v)
  if (s === null) return null
  const t = s.trim()
  return t === '' ? null : t
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * wdpa_id is type-unstable (number, "0", composite "555542441; 555637321",
 * "102534_B"). Coerce to string; "0"/""/0/null mean absent. NEVER Number()-parse.
 */
function normalizeWdpaId(v: unknown): string | null {
  const s = str(v)
  if (s === null || s === '0') return null
  return s
}

function normalizeIucn(v: unknown): string | null {
  const s = str(v)
  if (s === null || s === 'Unassigned') return null
  return s
}

/** tribal: Yes(0) -> exemption true, No(1) -> false, else null. */
function normalizeTribalExemption(v: unknown): boolean | null {
  const n = num(v)
  if (n === 0) return true
  if (n === 1) return false
  return null
}

/** Strip Navigator's <br> markup and collapse whitespace from a free-text field. */
function cleanText(v: unknown): string | null {
  const s = str(v)
  if (s === null) return null
  return s
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim()
}

function composeSummary(props: NavigatorProps): string | null {
  const parts = [
    cleanText(props.purpose),
    cleanText(props.restrictions),
    cleanText(props.allowed)
  ].filter((p): p is string => p !== null)
  return parts.length > 0 ? parts.join('\n\n') : null
}

/** Read a coded column by KEY (never by existence) and decode. */
function level(props: NavigatorProps, key: string): Level {
  return levelOf(props[key])
}

/** Worst (most restrictive) level over a set of columns. */
function worst(props: NavigatorProps, keys: readonly string[]): Level {
  let acc: Level = 'na'
  for (const k of keys) acc = moreRestrictive(acc, level(props, k))
  return acc
}

/** Decode the 12 coarse activities from raw props, with V1/V2 coalescing. */
export function coarseRestrictions(props: NavigatorProps): Partial<Record<Activity, Level>> {
  return {
    anchoring: level(props, 'anchoring'),
    mooring: level(props, 'mooring'),
    entry: level(props, 'entry'),
    speed: level(props, 'speed'),
    diving: level(props, 'diving'),
    discharge: level(props, 'discharge'),
    // V1 uses `dredging`, V2 uses `dredging_dumping` — coalesce to more-restrictive.
    dredging: moreRestrictive(level(props, 'dredging'), level(props, 'dredging_dumping')),
    removalOfArtifacts: level(props, 'removal_of_historic_artifacts'),
    fishingRecreational: level(props, 'recreational_fishing'),
    fishingCommercial: level(props, 'commercial_fishing'),
    // artisanal + subsistence are both V2-only small-scale — fold to one member.
    fishingArtisanal: moreRestrictive(
      level(props, 'artisanal_fishing'),
      level(props, 'subsistence_fishing')
    ),
    // Single "is fishing limited here" signal over all 25 gear columns.
    fishing: worst(props, FISHING_COLUMNS)
  }
}

/** Decode all 43 raw columns losslessly (key -> level). */
function rawLevels(props: NavigatorProps): Record<string, Level> {
  const out: Record<string, Level> = {}
  for (const k of ALL_CODED_COLUMNS) out[k] = level(props, k)
  return out
}

/**
 * Normalize a raw Navigator GeoJSON feature's `properties` into a
 * RestrictedZoneProps. `attribution` is injected by the caller so the fixed
 * citation/disclaimer string lives in one place (attribution.ts).
 */
export function normalizeProps(props: NavigatorProps, attribution: string): RestrictedZoneProps {
  const sourceUrls = [
    str(props.url),
    str(props.regulation_source),
    str(props.other_helpful_links)
  ].filter((u): u is string => u !== null)
  return {
    siteId: scalarToString(props.SITE_ID) ?? scalarToString(props.site_id) ?? '',
    name: str(props.site_name) ?? '(unnamed area)',
    country: str(props.country),
    state: str(props.state),
    authority: str(props.managing_authority),
    designation: str(props.designation),
    category: str(props.category_name),
    categoryId: categoryIdOf(props.category_name),
    wdpaId: normalizeWdpaId(props.wdpa_id),
    iucnCat: normalizeIucn(props.iucn_cat),
    lfp: num(props.lfp),
    tribalExemption: normalizeTribalExemption(props.tribal),
    restrictions: coarseRestrictions(props),
    raw: rawLevels(props),
    summary: composeSummary(props),
    sourceUrls: [...new Set(sourceUrls)],
    season: str(props.season),
    effectiveFrom: str(props.effective_from),
    effectiveTo: str(props.effective_to),
    siteVersion: { major: num(props.site_major_version), minor: num(props.site_minor_version) },
    attribution
  }
}

/**
 * Severity of a zone, given the set of activities the user wants to monitor.
 *
 *  - If any monitored activity is `prohibited` -> 'prohibited'.
 *  - Else if any monitored activity is `restricted` -> 'restricted'.
 *  - Else 'info' (informational only: lfp/category, no hard limits on what we watch).
 *
 * `unknown`/`na`/`allowed` never raise severity.
 */
export function zoneSeverity(
  zone: Pick<RestrictedZoneProps, 'restrictions'>,
  monitored: readonly Activity[]
): Severity {
  let sawRestricted = false
  for (const a of monitored) {
    const lvl = zone.restrictions[a]
    if (lvl === 'prohibited') return 'prohibited'
    if (lvl === 'restricted') sawRestricted = true
  }
  return sawRestricted ? 'restricted' : 'info'
}

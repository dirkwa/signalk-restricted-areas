/**
 * ProtectedSeas Navigator attribution — CC BY 4.0.
 *
 * Surfaced everywhere the spec requires: ResourceSet descriptions, plugin
 * statusMessage, README, and on every normalized zone record. Required by the
 * Navigator Terms of Use; do not strip.
 *
 * The `[date]` placeholders are filled from the dataset manifest at runtime
 * (see `attributionBlock()`): "last visited" = the published dataset date,
 * "downloaded" = the maintainer's I-AGREE click-through date.
 */

export const LICENSE = 'CC BY 4.0'

export const DISCLAIMER =
  'This is summary data and may be incomplete, inaccurate, or out of date. It is NOT a legal or ' +
  'compliance document. Provided "as-is". Always verify against official sources before relying on ' +
  'it for navigation or compliance.'

/** Short tag for statusMessage() and compact UI. */
export const ATTRIBUTION_TAG = 'ProtectedSeas Navigator (CC BY 4.0)'

const METHODOLOGY_CITATION =
  'Zetterlind, V. et al. (2025). Navigator - a global database of verified marine protected and ' +
  'managed area regulations and boundaries. Scientific Data, 12, 1212. ' +
  'https://doi.org/10.1038/s41597-025-05535-2'

/**
 * The three required citations. `visited` and `downloaded` are ISO dates from
 * the dataset manifest; when absent we omit the parenthetical rather than emit
 * a literal "[date]".
 */
export function citations(opts: { visited?: string; downloaded?: string } = {}): string[] {
  const visited = opts.visited ? ` (last visited ${opts.visited}).` : '.'
  const downloaded = opts.downloaded ? ` (downloaded ${opts.downloaded}).` : '.'
  return [
    METHODOLOGY_CITATION,
    `The ProtectedSeas Navigator Map of Conservation Regulations, ProtectedSeas®, https://map.navigatormap.org${visited}`,
    `Navigator Data Download, ProtectedSeas®. https://navigatormap.org/data-request${downloaded}`
  ]
}

/** Full attribution + disclaimer block for ResourceSet descriptions / status. */
export function attributionBlock(opts: { visited?: string; downloaded?: string } = {}): string {
  return `Data: ${ATTRIBUTION_TAG}. ${citations(opts).join(' ')} ${DISCLAIMER}`
}

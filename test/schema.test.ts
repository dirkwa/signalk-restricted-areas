import { describe, it, expect } from 'vitest'
import {
  levelOf,
  moreRestrictive,
  coarseRestrictions,
  normalizeProps,
  zoneSeverity,
  categoryIdOf,
  type Level
} from '../src/schema.js'

describe('levelOf — THE coding key (1 = PROHIBITED)', () => {
  // This is the load-bearing safety test. If it ever flips, the plugin's
  // alarms invert. Do not "fix" it to make other code pass.
  it('decodes 1 as prohibited, not allowed', () => {
    expect(levelOf(1)).toBe('prohibited')
  })

  it('decodes the full key', () => {
    expect(levelOf(0)).toBe('allowed')
    expect(levelOf(1)).toBe('prohibited')
    expect(levelOf(2)).toBe('restricted')
    expect(levelOf(3)).toBe('unknown')
    expect(levelOf(null)).toBe('na')
    expect(levelOf(undefined)).toBe('na')
  })

  it('decodes string-encoded values the same way', () => {
    expect(levelOf('1')).toBe('prohibited')
    expect(levelOf('0')).toBe('allowed')
    expect(levelOf('')).toBe('na')
  })

  it('treats out-of-range / garbage as na', () => {
    expect(levelOf(7)).toBe('na')
    expect(levelOf('foo')).toBe('na')
  })
})

describe('moreRestrictive', () => {
  const cases: [Level, Level, Level][] = [
    ['prohibited', 'restricted', 'prohibited'],
    ['restricted', 'allowed', 'restricted'],
    ['allowed', 'unknown', 'allowed'],
    ['unknown', 'na', 'unknown'],
    ['na', 'na', 'na']
  ]
  it.each(cases)('max(%s, %s) = %s', (a, b, want) => {
    expect(moreRestrictive(a, b)).toBe(want)
    expect(moreRestrictive(b, a)).toBe(want)
  })
})

describe('categoryIdOf', () => {
  it('maps known labels', () => {
    expect(categoryIdOf('Marine Protected Area')).toBe(1)
    expect(categoryIdOf('Jurisdictional Authority Area')).toBe(9)
  })
  it('returns unknown on drift', () => {
    expect(categoryIdOf('Something New')).toBe('unknown')
    expect(categoryIdOf(undefined)).toBe('unknown')
  })
})

describe('coarseRestrictions — V1/V2 coalescing', () => {
  it('coalesces dredging (V1) and dredging_dumping (V2) to more-restrictive', () => {
    // V1 feature: dredging present, dredging_dumping null
    expect(coarseRestrictions({ dredging: 1, dredging_dumping: null }).dredging).toBe('prohibited')
    // V2 feature: dredging null, dredging_dumping present
    expect(coarseRestrictions({ dredging: null, dredging_dumping: 2 }).dredging).toBe('restricted')
  })

  it('folds artisanal + subsistence into fishingArtisanal', () => {
    expect(
      coarseRestrictions({ artisanal_fishing: 2, subsistence_fishing: 1 }).fishingArtisanal
    ).toBe('prohibited')
  })

  it('fishing rollup is the worst over all gear columns', () => {
    const r = coarseRestrictions({
      recreational_fishing: 0,
      commercial_fishing: 2,
      bottom_trawling: 1, // prohibited dominates
      spear_fishing: 0
    })
    expect(r.fishing).toBe('prohibited')
  })

  it('keeps diving separate from underwater_extraction_diving (extractive fishing)', () => {
    // diving (recreational) allowed, but extractive diving prohibited -> diving stays allowed,
    // the extractive one only feeds the fishing rollup.
    const r = coarseRestrictions({ diving: 0, underwater_extraction_diving: 1 })
    expect(r.diving).toBe('allowed')
    expect(r.fishing).toBe('prohibited')
  })
})

describe('normalizeProps — identity + special fields', () => {
  const props = {
    SITE_ID: 'AIISR33',
    site_name: 'Test Reserve',
    country: 'Israel',
    managing_authority: 'Israel Nature and Parks Authority',
    category_name: 'Marine Protected Area',
    wdpa_id: 0,
    iucn_cat: 'Unassigned',
    lfp: 0,
    tribal: 1,
    anchoring: 1,
    entry: 3,
    recreational_fishing: 1,
    url: 'https://example.org',
    purpose: 'Protect reefs.<br>Line two.',
    restrictions: 'No anchoring.',
    site_major_version: 2,
    site_minor_version: 0,
    OBJECTID: 123,
    Shape_Area: 4.5
  }

  it('maps identity and normalizes special fields', () => {
    const z = normalizeProps(props, 'ATTR')
    expect(z.siteId).toBe('AIISR33')
    expect(z.name).toBe('Test Reserve')
    expect(z.categoryId).toBe(1)
    expect(z.wdpaId).toBeNull() // 0 -> absent
    expect(z.iucnCat).toBeNull() // 'Unassigned' -> null
    expect(z.tribalExemption).toBe(false) // tribal=1 -> No
    expect(z.lfp).toBe(0)
    expect(z.attribution).toBe('ATTR')
  })

  it('decodes anchoring=1 as prohibited on the zone', () => {
    const z = normalizeProps(props, 'ATTR')
    expect(z.restrictions.anchoring).toBe('prohibited')
    expect(z.restrictions.entry).toBe('unknown')
  })

  it('strips <br> in the composed summary and drops GIS bookkeeping', () => {
    const z = normalizeProps(props, 'ATTR')
    expect(z.summary).toContain('Line two.')
    expect(z.summary).not.toContain('<br>')
    expect(z).not.toHaveProperty('OBJECTID')
  })

  it('keeps composite wdpa_id verbatim', () => {
    const z = normalizeProps({ ...props, wdpa_id: '555542441; 555637321' }, 'ATTR')
    expect(z.wdpaId).toBe('555542441; 555637321')
  })
})

describe('zoneSeverity', () => {
  it('prohibited monitored activity -> prohibited', () => {
    const z = { restrictions: { anchoring: 'prohibited' as Level } }
    expect(zoneSeverity(z, ['anchoring', 'entry'])).toBe('prohibited')
  })
  it('only restricted -> restricted', () => {
    const z = { restrictions: { entry: 'restricted' as Level } }
    expect(zoneSeverity(z, ['anchoring', 'entry'])).toBe('restricted')
  })
  it('unknown/na/allowed never raise severity -> info', () => {
    const z = { restrictions: { anchoring: 'unknown' as Level, entry: 'allowed' as Level } }
    expect(zoneSeverity(z, ['anchoring', 'entry'])).toBe('info')
  })
  it('ignores activities not in the monitored set', () => {
    const z = { restrictions: { fishing: 'prohibited' as Level } }
    expect(zoneSeverity(z, ['anchoring', 'entry'])).toBe('info')
  })
})

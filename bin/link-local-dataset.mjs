#!/usr/bin/env node
/**
 * link-local-dataset: stage a LOCAL pipeline build (restricted-areas-data's
 * dist/) into the plugin's Signal K data dir so the plugin can serve it without
 * a published GitHub release. For local testing / M0 — no network, no publish.
 *
 * It copies only the FULL .fgb variants (the plugin's offline loader globs by
 * region name and would otherwise also pick up <region>.display.fgb, loading
 * every zone twice), and writes a minimal manifest.json so attribution dates
 * surface in the plugin status.
 *
 * IMPORTANT: the plugin reads from app.getDataDirPath(), which for a plugin is
 *   <sk-config-dir>/plugin-config-data/<plugin-id>/restricted-areas
 * NOT the config dir root. Pass --sk-config-dir (the dir you start the server
 * with via `-c`) and this script writes to the correct subpath.
 *
 * Usage:
 *   node bin/link-local-dataset.mjs \
 *     --dist /home/dirk/dev/restricted-areas-data/dist \
 *     --sk-config-dir ~/.signalk-restricted
 *
 * Then set the plugin config autoUpdate=false and regions to the basins copied
 * (the script prints the list), and reload the plugin (toggle it off/on or
 * restart the server).
 */
import { readdir, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

const PLUGIN_ID = 'signalk-restricted-areas'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]
    if (!k || !k.startsWith('--')) throw new Error(`unexpected argument: ${k}`)
    out[k.slice(2)] = argv[i + 1]
  }
  if (!out.dist) throw new Error('missing required --dist')
  if (!out['sk-config-dir']) throw new Error('missing required --sk-config-dir')
  return out
}

function expandHome(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

/** The simplified DISPLAY FGBs — what the plugin loads and serves to chart clients. */
function isDisplayFgb(name) {
  return name.endsWith('.display.fgb')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dist = expandHome(args.dist)
  // Mirror app.getDataDirPath(): <sk-config>/plugin-config-data/<plugin-id>.
  const dest = join(
    expandHome(args['sk-config-dir']),
    'plugin-config-data',
    PLUGIN_ID,
    'restricted-areas'
  )
  await mkdir(dest, { recursive: true })

  // Stage the DISPLAY variant as the plugin's <region>.fgb. Display geometry is
  // simplified (~50 m), which is what chart clients should render and is well
  // within the geofence hysteresis, so the plugin uses it for both. Copying the
  // full variant would hand Freeboard ~hundreds of MB of dense polygons.
  const fgbs = (await readdir(dist)).filter(isDisplayFgb)
  if (fgbs.length === 0) throw new Error(`no .display.fgb files found in ${dist}`)

  const regions = []
  for (const displayName of fgbs) {
    const region = basename(displayName, '.display.fgb')
    await copyFile(join(dist, displayName), join(dest, `${region}.fgb`))
    regions.push(region)
  }

  // Carry the manifest's attribution/dates through if the build produced one.
  let manifest
  try {
    manifest = JSON.parse(await readFile(join(dist, 'manifest.json'), 'utf8'))
  } catch {
    manifest = null
  }
  if (manifest) {
    await writeFile(join(dest, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  }

  process.stdout.write(`Staged ${fgbs.length} region(s) into ${dest}:\n`)
  for (const r of regions.sort()) process.stdout.write(`  - ${r}\n`)
  process.stdout.write(
    `\nSet the plugin config: autoUpdate=false, regions=[${regions
      .sort()
      .map((r) => `"${r}"`)
      .join(', ')}], then restart the server.\n`
  )
}

main().catch((err) => {
  process.stderr.write(`${err.message}\n`)
  process.exit(1)
})

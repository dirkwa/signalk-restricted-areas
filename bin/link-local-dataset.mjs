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
 * Usage:
 *   node bin/link-local-dataset.mjs \
 *     --dist /home/dirk/dev/restricted-areas-data/dist \
 *     --data-dir ~/.signalk-restricted
 *
 * Then in the plugin config set autoUpdate=false and regions to the basins you
 * copied (the script prints the list), and restart the server.
 */
import { readdir, mkdir, copyFile, readFile, writeFile } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]
    if (!k || !k.startsWith('--')) throw new Error(`unexpected argument: ${k}`)
    out[k.slice(2)] = argv[i + 1]
  }
  if (!out.dist) throw new Error('missing required --dist')
  if (!out['data-dir']) throw new Error('missing required --data-dir')
  return out
}

function expandHome(p) {
  return p.startsWith('~') ? join(homedir(), p.slice(1)) : p
}

/** Full FGBs only — exclude the .display.fgb siblings. */
function isFullFgb(name) {
  return name.endsWith('.fgb') && !name.endsWith('.display.fgb')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const dist = expandHome(args.dist)
  const dest = join(expandHome(args['data-dir']), 'restricted-areas')
  await mkdir(dest, { recursive: true })

  const fgbs = (await readdir(dist)).filter(isFullFgb)
  if (fgbs.length === 0) throw new Error(`no full .fgb files found in ${dist}`)

  const regions = []
  for (const name of fgbs) {
    await copyFile(join(dist, name), join(dest, name))
    regions.push(basename(name, '.fgb'))
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

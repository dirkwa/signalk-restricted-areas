/**
 * Interop guard for the pure-ESM build.
 *
 * The Signal K server does not `import` a plugin directly — it goes through
 * `importOrRequire()` (server src/modules.ts), which tries `require()` first and
 * falls back to `import()` via esm-resolve. `require()` of an ESM module only
 * works on Node >=20.19, which is why engines.node is pinned there.
 *
 * These tests exercise the BUILT package (plugin/index.js) through a replica of
 * that loader, not the TypeScript source, because the failure this guards
 * against — a CommonJS-shaped export, or a dep that resolves at build time but
 * not at runtime — only appears in the emitted output.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, it, expect, beforeAll } from 'vitest'

import type { Plugin } from '@signalk/server-api'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const builtEntrypoint = path.join(packageDir, 'plugin', 'index.js')

type PluginFactory = (app: unknown) => Plugin

/** Replica of the server's importOrRequire() — keep in step with src/modules.ts. */
async function importOrRequire(moduleDir: string): Promise<PluginFactory> {
  const require = createRequire(import.meta.url)
  try {
    const mod: unknown = require(moduleDir)
    const resolved = (mod as { default?: unknown }).default ?? mod
    return resolved as PluginFactory
  } catch {
    // import() needs a file:// URL here — on Windows a bare `D:\…` path is
    // rejected with ERR_UNSUPPORTED_ESM_URL_SCHEME.
    const entry = pathToFileURL(path.join(moduleDir, 'plugin', 'index.js')).href
    const imported: unknown = await import(entry)
    return (imported as { default: PluginFactory }).default
  }
}

/** Enough of ServerAPI for the factory to construct; it must not touch the network. */
function stubApp(): unknown {
  return {
    setPluginStatus: () => {},
    setPluginError: () => {},
    getDataDirPath: () => packageDir,
    registerResourceProvider: () => {},
    handleMessage: () => {},
    streambundle: { getSelfBus: () => ({ onValue: () => () => {} }) },
    debug: () => {},
    error: () => {}
  }
}

describe('ESM packaging', () => {
  beforeAll(() => {
    // tsc does not prune its outDir, so a stale plugin/*.js from a since-renamed
    // source file would still be loadable. Assert against a fresh emit only.
    rmSync(path.join(packageDir, 'plugin'), { recursive: true, force: true })

    // Run the compiler through this same Node binary rather than `npx`: on
    // Windows the launcher is `npx.cmd`, and execFileSync does no PATHEXT
    // resolution, so spawning bare `npx` fails with ENOENT.
    const require = createRequire(import.meta.url)
    execFileSync(process.execPath, [require.resolve('typescript/bin/tsc')], {
      cwd: packageDir,
      stdio: 'pipe'
    })
  })

  it('emits the built entrypoint declared as package main', () => {
    expect(existsSync(builtEntrypoint)).toBe(true)
  })

  it('loads through the server loader and yields a callable factory', async () => {
    const factory = await importOrRequire(packageDir)
    expect(typeof factory).toBe('function')
  })

  it('produces a well-formed plugin object', async () => {
    const factory = await importOrRequire(packageDir)
    const plugin = factory(stubApp())

    expect(plugin.id).toBe('signalk-restricted-areas')
    expect(typeof plugin.name).toBe('string')
    expect(typeof plugin.start).toBe('function')
    expect(typeof plugin.stop).toBe('function')
    expect(typeof plugin.schema).toBe('function')
  })

  it('emits no CommonJS interop artifacts in the built output', async () => {
    const { readFile } = await import('node:fs/promises')
    const emitted = await readFile(builtEntrypoint, 'utf8')

    expect(emitted).toContain('export default')
    expect(emitted).not.toContain('module.exports')
    expect(emitted).not.toContain('__importDefault')
  })
})

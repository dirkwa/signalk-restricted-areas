import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DataManager,
  atomicWrite,
  selectAssets,
  sha256Bytes,
  sha256File,
  type Manifest
} from '../src/data-manager.js'

function sha(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Tiny stand-in for FGB bytes — fixtures stay small because /tmp is RAM-backed. */
function fakeFgb(seed: string): Uint8Array {
  return new TextEncoder().encode(`FGB:${seed}`)
}

/** Place a local FGB without going near the network (avoids a real fetch in setup). */
async function seedLocal(dm: DataManager, name: string, bytes: Uint8Array): Promise<string> {
  await mkdir(dm.datasetDir, { recursive: true })
  const path = join(dm.datasetDir, name)
  await writeFile(path, bytes)
  return path
}

/** Build a manifest in the REAL published shape: assets nested per region. */
function manifestFor(assets: { name: string; region: string; bytes: Uint8Array }[]): Manifest {
  const regions = new Map<string, Manifest['regions'][number]>()
  for (const a of assets) {
    const entry = regions.get(a.region) ?? { region: a.region, assets: [] }
    entry.assets.push({
      name: a.name,
      size: a.bytes.byteLength,
      sha256: sha(a.bytes),
      bbox: [-10, 30, 5, 45],
      featureCount: 3
    })
    regions.set(a.region, entry)
  }
  return {
    version: 'v2026.05',
    datasetDate: '2026-05-28',
    downloadDate: '2026-06-01',
    regions: [...regions.values()]
  }
}

/**
 * Build a fetch mock that serves: the GitHub releases/latest JSON, the
 * manifest.json download, and each asset's bytes. `corrupt` lets a test return
 * wrong bytes for a named asset while leaving its manifest sha256 untouched.
 */
function mockGitHub(opts: {
  manifest: Manifest
  bytesByName: Record<string, Uint8Array>
  corrupt?: string
}): ReturnType<typeof vi.fn> {
  const base = 'https://dl.example/'
  const releaseJson = {
    assets: [
      { name: 'manifest.json', browser_download_url: `${base}manifest.json` },
      ...opts.manifest.regions
        .flatMap((r) => r.assets)
        .map((a) => ({ name: a.name, browser_download_url: `${base}${a.name}` }))
    ]
  }
  return vi.fn((url: string) => {
    if (url.includes('/releases/latest')) {
      return Promise.resolve(jsonResponse(releaseJson))
    }
    if (url.endsWith('manifest.json')) {
      return Promise.resolve(jsonResponse(opts.manifest))
    }
    const name = url.slice(base.length)
    const bytes = name === opts.corrupt ? fakeFgb('TAMPERED') : opts.bytesByName[name]
    if (!bytes) return Promise.resolve(notFound())
    return Promise.resolve(bytesResponse(bytes))
  })
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response
}

function bytesResponse(bytes: Uint8Array): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: () => Promise.resolve(bytes.buffer.slice(0))
  } as unknown as Response
}

function notFound(): Response {
  return { ok: false, status: 404 } as unknown as Response
}

let dataDir: string
const realFetch = globalThis.fetch

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ra-data-'))
})

afterEach(async () => {
  globalThis.fetch = realFetch
  vi.restoreAllMocks()
  await rm(dataDir, { recursive: true, force: true })
})

describe('sha256 helpers + atomicWrite', () => {
  it('atomicWrite places the final file with the expected content and leaves no temp', async () => {
    const path = join(dataDir, 'thing.fgb')
    const bytes = fakeFgb('A')
    await atomicWrite(path, bytes)

    expect(new Uint8Array(await readFile(path))).toEqual(bytes)
    expect(await sha256File(path)).toBe(sha256Bytes(bytes))
    expect((await readdir(dataDir)).filter((n) => n.endsWith('.tmp'))).toEqual([])
  })
})

describe('ensureDataset — download + verify', () => {
  it('downloads, sha256-verifies, and atomically places configured region files', async () => {
    const eu = fakeFgb('eu')
    const manifest = manifestFor([{ name: 'eu.display.fgb', region: 'eu', bytes: eu }])
    globalThis.fetch = mockGitHub({ manifest, bytesByName: { 'eu.display.fgb': eu } })

    const dm = new DataManager({ dataRepo: 'o/r', regions: ['eu'], dataDir, autoUpdate: true })
    const status = await dm.ensureDataset()

    const placed = join(dm.datasetDir, 'eu.display.fgb')
    expect(status.ok).toBe(true)
    expect(status.localFiles).toEqual([placed])
    expect(status.manifest?.datasetDate).toBe('2026-05-28')
    expect(new Uint8Array(await readFile(placed))).toEqual(eu)
  })

  it('only fetches configured regions, ignoring other assets in the manifest', async () => {
    const eu = fakeFgb('eu')
    const us = fakeFgb('us')
    const manifest = manifestFor([
      { name: 'eu.display.fgb', region: 'eu', bytes: eu },
      { name: 'us.display.fgb', region: 'us', bytes: us }
    ])
    globalThis.fetch = mockGitHub({
      manifest,
      bytesByName: { 'eu.display.fgb': eu, 'us.display.fgb': us }
    })

    const dm = new DataManager({ dataRepo: 'o/r', regions: ['eu'], dataDir, autoUpdate: true })
    const status = await dm.ensureDataset()

    expect(status.localFiles).toEqual([join(dm.datasetDir, 'eu.display.fgb')])
    // Besides the configured region, only the persisted manifest (which keeps
    // the dataset date visible across offline restarts) may be written.
    expect((await readdir(dm.datasetDir)).sort()).toEqual(['eu.display.fgb', 'manifest.json'])
  })

  it('persists the manifest so the dataset date survives offline restarts', async () => {
    const eu = fakeFgb('eu')
    const manifest = manifestFor([{ name: 'eu.display.fgb', region: 'eu', bytes: eu }])
    globalThis.fetch = mockGitHub({ manifest, bytesByName: { 'eu.display.fgb': eu } })

    const dm = new DataManager({ dataRepo: 'o/r', regions: ['eu'], dataDir, autoUpdate: true })
    await dm.ensureDataset()

    const persisted = JSON.parse(
      (await readFile(join(dm.datasetDir, 'manifest.json'))).toString()
    ) as { datasetDate?: string }
    expect(persisted.datasetDate).toBe('2026-05-28')

    // A later offline start (auto-update off ≙ unreachable network path)
    // surfaces the persisted manifest, so users still see the extract date.
    const offline = new DataManager({
      dataRepo: 'o/r',
      regions: ['eu'],
      dataDir,
      autoUpdate: false
    })
    const status = await offline.ensureDataset()
    expect(status.manifest?.datasetDate).toBe('2026-05-28')
  })

  it('rejects a corrupted asset (sha256 mismatch) and does not place it', async () => {
    const eu = fakeFgb('eu')
    const manifest = manifestFor([{ name: 'eu.display.fgb', region: 'eu', bytes: eu }])
    globalThis.fetch = mockGitHub({
      manifest,
      bytesByName: { 'eu.display.fgb': eu },
      corrupt: 'eu.display.fgb'
    })

    const dm = new DataManager({ dataRepo: 'o/r', regions: ['eu'], dataDir, autoUpdate: true })
    const status = await dm.ensureDataset()

    expect(status.ok).toBe(false)
    expect(status.localFiles).toEqual([])
    expect(status.message).toContain('sha256 mismatch')
    expect(await readdir(dm.datasetDir)).toEqual([])
  })

  it('skips re-download when a verified local copy already exists', async () => {
    const eu = fakeFgb('eu')
    const manifest = manifestFor([{ name: 'eu.display.fgb', region: 'eu', bytes: eu }])
    const dm = new DataManager({ dataRepo: 'o/r', regions: ['eu'], dataDir, autoUpdate: true })
    await seedLocal(dm, 'eu.display.fgb', eu)

    const fetchMock = mockGitHub({ manifest, bytesByName: { 'eu.display.fgb': eu } })
    globalThis.fetch = fetchMock
    const status = await dm.ensureDataset()

    expect(status.ok).toBe(true)
    // releases/latest + manifest.json only — never the asset itself.
    const assetCalls = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('eu.display.fgb'))
    expect(assetCalls).toEqual([])
  })
})

describe('ensureDataset — offline-first', () => {
  it('falls back to existing local files when the network fails, without throwing', async () => {
    const eu = fakeFgb('eu')
    const dm = new DataManager({ dataRepo: 'o/r', regions: ['eu'], dataDir, autoUpdate: true })
    const placed = await seedLocal(dm, 'eu.display.fgb', eu)

    globalThis.fetch = vi.fn(() => Promise.reject(new Error('ENOTFOUND api.github.com')))

    const status = await dm.ensureDataset()

    expect(status.ok).toBe(true)
    expect(status.localFiles).toEqual([placed])
    expect(status.manifest).toBeUndefined()
    expect(status.message).toContain('update check failed')
  })

  it('reports not-ok (no throw) when offline with no local dataset', async () => {
    const dm = new DataManager({ dataRepo: 'o/r', regions: ['eu'], dataDir, autoUpdate: true })
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('offline')))

    const status = await dm.ensureDataset()

    expect(status.ok).toBe(false)
    expect(status.localFiles).toEqual([])
  })

  it('autoUpdate:false never touches the network and serves local files', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('should not be called')))
    globalThis.fetch = fetchSpy
    const eu = fakeFgb('eu')
    const dm = new DataManager({ dataRepo: 'o/r', regions: ['eu'], dataDir, autoUpdate: false })
    const placed = await seedLocal(dm, 'eu.display.fgb', eu)

    const status = await dm.ensureDataset()

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(status.ok).toBe(true)
    expect(status.localFiles).toEqual([placed])
    expect(status.message).toContain('auto-update disabled')
  })
})

describe('REGRESSION: the real published manifest shape (regions[].assets)', () => {
  // The first live auto-update crashed with "Cannot read properties of
  // undefined (reading 'filter')": the code expected a flat manifest.assets
  // array, but make-manifest.mjs nests assets per region. This fixture is the
  // verbatim v2026.06.11 manifest from the public release.
  const real = JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'published-manifest-v2026.06.11.json'), 'utf8')
  ) as Manifest

  it('selects the display variant of exactly the configured regions', () => {
    const one = selectAssets(real, ['sw-pacific'])
    expect(one.map((a) => a.name)).toEqual(['sw-pacific.display.fgb'])
    expect(one[0].sha256).toMatch(/^[0-9a-f]{64}$/)

    const two = selectAssets(real, ['sw-pacific', 'mediterranean'])
    expect(two.map((a) => a.name).sort()).toEqual([
      'mediterranean.display.fgb',
      'sw-pacific.display.fgb'
    ])
    expect(selectAssets(real, [])).toEqual([])
  })

  it('carries the dataset date users must see', () => {
    expect(real.datasetDate).toBe('2026-05-28')
    expect(real.version).toBe('v2026.06.11')
  })
})

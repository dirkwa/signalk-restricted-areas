/**
 * Offline-first dataset acquisition for the restricted-areas plugin.
 *
 * The plugin must start and serve whatever it already has on disk WITHOUT any
 * network. `ensureDataset` only reaches out to GitHub to UPDATE; every network
 * failure degrades to the verified local copy, and problems are reported in the
 * returned status object rather than thrown. start() must never block or fail
 * because GitHub is unreachable.
 *
 * Integrity is non-negotiable: a downloaded FGB is verified by sha256 against
 * the release manifest before it is allowed to replace a local file, and the
 * replacement is an atomic rename so a crashed download can never leave a
 * half-written dataset in place.
 */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** A single FGB asset described by the data-pipeline release manifest. */
export interface ManifestAsset {
  name: string
  size: number
  sha256: string
  bbox: [number, number, number, number]
  featureCount: number
}

/** One region's entry in the manifest: its slug plus full+display assets. */
export interface ManifestRegion {
  region: string
  assets: ManifestAsset[]
}

/**
 * The release manifest.json published alongside the FGB assets. Assets are
 * nested per region (`regions[].assets`), exactly as make-manifest.mjs emits —
 * test fixtures must mirror this real shape, not a flattened invention.
 */
export interface Manifest {
  version: string
  datasetDate: string
  downloadDate: string
  regions: ManifestRegion[]
}

export interface DataManagerConfig {
  /** GitHub `owner/repo` holding the release assets, e.g. 'dirkwa/restricted-areas-data'. */
  dataRepo: string
  /** Region keys to load (matched against asset.region). */
  regions: string[]
  /** Plugin data dir, from app.getDataDirPath(). */
  dataDir: string
  /** When false, ensureDataset skips the network and only uses local files. */
  autoUpdate: boolean
}

export interface DatasetStatus {
  /** True when at least one verified FGB is available to load. */
  ok: boolean
  message: string
  /** Absolute paths of verified FGB files the plugin should index. */
  localFiles: string[]
  /** The manifest used, when one was fetched (for attribution dates). */
  manifest?: Manifest
}

const GITHUB_API = 'https://api.github.com'

/** sha256 of a file, lowercase hex, streamed so large FGBs don't buffer in RAM. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => {
      resolve(hash.digest('hex'))
    })
  })
}

/** sha256 of an in-memory buffer (used to gate a download before it touches disk). */
export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Write `bytes` to `finalPath` atomically: stage in a sibling temp file, then
 * rename. The temp file shares the destination directory so the rename stays on
 * one filesystem and is atomic on POSIX. The temp file is always cleaned up.
 */
export async function atomicWrite(finalPath: string, bytes: Uint8Array): Promise<void> {
  const tmpPath = `${finalPath}.${process.pid.toString()}.${Date.now().toString()}.tmp`
  try {
    await writeFile(tmpPath, bytes)
    await rename(tmpPath, finalPath)
  } catch (err) {
    await rm(tmpPath, { force: true })
    throw err
  }
}

/** Does a file at `path` already match `sha256`? Missing/mismatch both return false. */
async function localCopyVerified(path: string, sha256: string): Promise<boolean> {
  try {
    await stat(path)
  } catch {
    return false
  }
  return (await sha256File(path)) === sha256
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Pick the manifest assets to download for the configured regions: the
 * simplified DISPLAY variant only. Display geometry is what chart clients render
 * and is within the geofence hysteresis, so the plugin serves it for both; the
 * full variant exists for offline analysis but would bloat the on-boat download.
 */
export function selectAssets(manifest: Manifest, regions: readonly string[]): ManifestAsset[] {
  const wanted = new Set(regions)
  return manifest.regions
    .filter((r) => wanted.has(r.region))
    .flatMap((r) => r.assets.filter((a) => a.name.endsWith('.display.fgb')))
}

async function fetchManifest(
  dataRepo: string
): Promise<{ manifest: Manifest; assetUrls: Map<string, string> }> {
  const res = await fetch(`${GITHUB_API}/repos/${dataRepo}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) {
    throw new Error(`GitHub releases/latest returned ${res.status.toString()}`)
  }
  const release = (await res.json()) as {
    assets?: { name: string; browser_download_url: string }[]
  }
  const releaseAssets = release.assets ?? []
  const manifestAsset = releaseAssets.find((a) => a.name === 'manifest.json')
  if (!manifestAsset) {
    throw new Error('release has no manifest.json asset')
  }
  const manifestRes = await fetch(manifestAsset.browser_download_url)
  if (!manifestRes.ok) {
    throw new Error(`manifest.json download returned ${manifestRes.status.toString()}`)
  }
  const manifest = (await manifestRes.json()) as Manifest
  const assetUrls = new Map(releaseAssets.map((a) => [a.name, a.browser_download_url]))
  return { manifest, assetUrls }
}

/**
 * Download one asset, verify its sha256 in memory, and only then atomically
 * place it. Throws on any failure so the caller can keep the prior local copy.
 */
async function downloadAsset(asset: ManifestAsset, url: string, finalPath: string): Promise<void> {
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`download ${asset.name} returned ${res.status.toString()}`)
  }
  const bytes = new Uint8Array(await res.arrayBuffer())
  const got = sha256Bytes(bytes)
  if (got !== asset.sha256) {
    throw new Error(`sha256 mismatch for ${asset.name}: expected ${asset.sha256}, got ${got}`)
  }
  await atomicWrite(finalPath, bytes)
}

/**
 * Manages the on-disk restricted-areas dataset under `<dataDir>/restricted-areas`.
 */
export class DataManager {
  private readonly config: DataManagerConfig
  /** Where FGB files live; exposed so the plugin/loaders agree on one path. */
  readonly datasetDir: string

  constructor(config: DataManagerConfig) {
    this.config = config
    this.datasetDir = join(config.dataDir, 'restricted-areas')
  }

  /**
   * Ensure the configured regions' FGB files are present and verified, updating
   * from the latest GitHub release when `autoUpdate` is on and the network is
   * reachable. Never throws; always returns a DatasetStatus.
   */
  async ensureDataset(): Promise<DatasetStatus> {
    await mkdir(this.datasetDir, { recursive: true })

    if (!this.config.autoUpdate) {
      return this.offlineStatus('auto-update disabled')
    }

    let fetched: { manifest: Manifest; assetUrls: Map<string, string> }
    try {
      fetched = await fetchManifest(this.config.dataRepo)
    } catch (err) {
      return this.offlineStatus(`update check failed (${errorMessage(err)})`)
    }

    const { manifest, assetUrls } = fetched
    const assets = selectAssets(manifest, this.config.regions)
    const localFiles: string[] = []
    const problems: string[] = []

    for (const asset of assets) {
      const finalPath = join(this.datasetDir, asset.name)
      if (await localCopyVerified(finalPath, asset.sha256)) {
        localFiles.push(finalPath)
        continue
      }
      const url = assetUrls.get(asset.name)
      if (!url) {
        problems.push(`${asset.name}: not in release`)
        if (await pathExists(finalPath)) localFiles.push(finalPath)
        continue
      }
      try {
        await downloadAsset(asset, url, finalPath)
        localFiles.push(finalPath)
      } catch (err) {
        problems.push(`${asset.name}: ${errorMessage(err)}`)
        // Keep any pre-existing (possibly stale) copy so the plugin still serves.
        if (await pathExists(finalPath)) localFiles.push(finalPath)
      }
    }

    const ok = localFiles.length > 0
    if (ok) {
      // Persist the manifest beside the FGBs so the dataset date (and the
      // attribution dates) survive offline restarts — users must always be
      // able to see the Navigator extract date of the data they are using.
      try {
        await atomicWrite(
          join(this.datasetDir, 'manifest.json'),
          Buffer.from(JSON.stringify(manifest, null, 2))
        )
      } catch {
        // Non-fatal: the dataset still serves; only the offline date hint suffers.
      }
    }
    const base = `${localFiles.length.toString()}/${assets.length.toString()} region file(s) ready (dataset ${manifest.datasetDate})`
    const message = problems.length > 0 ? `${base}; ${problems.join('; ')}` : base
    return { ok, message, localFiles, manifest }
  }

  /** Status assembled from whatever verified local files already exist. */
  private async offlineStatus(reason: string): Promise<DatasetStatus> {
    const localFiles: string[] = []
    for (const region of this.config.regions) {
      for (const path of await regionFiles(this.datasetDir, region)) {
        localFiles.push(path)
      }
    }
    const ok = localFiles.length > 0
    const message = ok
      ? `offline: serving ${localFiles.length.toString()} local file(s) (${reason})`
      : `no local dataset and ${reason}`
    // Surface the locally-staged manifest (version + attribution dates) when present.
    const manifest = await this.readLocalManifest()
    return { ok, message, localFiles, manifest }
  }

  /** Read a previously-downloaded/staged manifest.json from the dataset dir, if any. */
  private async readLocalManifest(): Promise<Manifest | undefined> {
    try {
      const raw = await readFile(join(this.datasetDir, 'manifest.json'), 'utf8')
      return JSON.parse(raw) as Manifest
    } catch {
      return undefined
    }
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Existing FGB files for a region (offline path: no manifest to consult).
 * Prefer the simplified `.display.fgb` if present; otherwise the plain
 * `<region>.fgb`. Never return both — the index would load each zone twice.
 */
async function regionFiles(dir: string, region: string): Promise<string[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  // Match `<region>.fgb` / `<region>.display.fgb` by exact prefix — `includes`
  // would let one region's file match another whose name is a substring
  // (e.g. region "ne-pacific" must not pick up "se-pacific.fgb").
  const forRegion = names.filter((n) => n.startsWith(`${region}.`) && n.endsWith('.fgb'))
  const display = forRegion.filter((n) => n.endsWith('.display.fgb'))
  const chosen = display.length > 0 ? display : forRegion
  return chosen.map((n) => join(dir, n))
}

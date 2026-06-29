import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { AtlasDatabase, IncompatibleAtlasError } from './atlasDb'
import { formatBytes, formatViews } from './data'
import { MapPanel } from './MapPanel'
import { fullResolutionImageUrl, thumbnailImageUrl } from './images'
import { clearInstalledAtlas, readInstalledAtlas, requestPersistentStorage, saveInstalledAtlas } from './storage'
import type { AtlasManifest, AtlasStats, MapBounds, Place, PlaceFilters, StoredAtlasMetadata } from './types'

type Route = { kind: 'home' } | { kind: 'place'; qid: string }
type InstallProgress = { stage: 'idle' | 'downloading' | 'installing'; received: number; total?: number }

const PAGE_SIZE = 20
const EMPTY_STATS: AtlasStats = { placeCount: 0, countries: [], registries: [] }
const EMPTY_FILTERS: PlaceFilters = { query: '', country: '', registry: '', style: '', sort: 'views' }
const DISPLAYED_SOURCE_FIELDS = new Set([
  'wikidata_qid', 'label_native', 'label_en', 'label_zh', 'coordinates_wkt',
  'native_language_label_en', 'country_label_en', 'heritage_designation_labels_native',
  'architectural_style_label_en', 'inception_values', 'nativewikiviewcount',
  'enwikiviewcount', 'wikiviewcount', 'wikipedia_sitelinks_count', 'source_record_urls',
  'nativewiki_url', 'enwiki_url', 'commons_image_urls', 'official_website_urls',
])

function readRoute(): Route {
  const raw = window.location.hash.replace(/^#/, '')
  const match = raw.match(/^\/place\/([^/]+)\/?$/)
  const qid = match?.[1]
  return qid ? { kind: 'place', qid: decodeURIComponent(qid) } : { kind: 'home' }
}

function placeHref(qid: string): string {
  return `#/place/${encodeURIComponent(qid)}`
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => readRoute())

  useEffect(() => {
    const update = () => setRoute(readRoute())
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])

  return route
}

function resolvePublicUrl(path: string): string {
  const base = new URL(import.meta.env.BASE_URL, window.location.origin)
  return new URL(path, base).toString()
}

async function loadManifest(): Promise<AtlasManifest> {
  const response = await fetch(resolvePublicUrl('data/atlas-manifest.json'), { cache: 'no-store' })
  if (!response.ok) throw new Error(`Could not load the atlas manifest: ${response.status}`)
  const raw: unknown = await response.json()
  if (!raw || typeof raw !== 'object') throw new Error('atlas-manifest.json must contain an object.')
  const manifest = raw as Partial<AtlasManifest>
  if (!manifest.version || !manifest.name || !manifest.datasetUrl) {
    throw new Error('atlas-manifest.json needs version, name, and datasetUrl.')
  }
  return manifest as AtlasManifest
}

async function downloadBytes(url: string, onProgress: (received: number, total?: number) => void): Promise<Uint8Array> {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Could not download the atlas: ${response.status}`)
  const totalHeader = Number(response.headers.get('content-length') ?? '')
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : undefined

  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    onProgress(bytes.byteLength, total)
    return bytes
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      chunks.push(value)
      received += value.byteLength
      onProgress(received, total)
    }
  }

  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', copyToArrayBuffer(bytes))
  return [...new Uint8Array(hash)].map((part) => part.toString(16).padStart(2, '0')).join('')
}

function Thumbnail({ place, variant = 'card' }: { place: Place; variant?: 'card' | 'hero' }) {
  const candidates = place.commonsImageUrls
  const [index, setIndex] = useState(0)
  const source = candidates[index]
  const className = variant === 'hero' ? 'thumbnail thumbnail-hero' : 'thumbnail'

  if (!source || index >= candidates.length) {
    return (
      <div className={`${className} thumbnail-fallback`} aria-label="No verified photograph">
        <span>⌖</span>
        <small>No image</small>
      </div>
    )
  }

  const imageSource = variant === 'hero' ? fullResolutionImageUrl(source) : thumbnailImageUrl(source)
  const image = <img className={className} src={imageSource} alt={place.labelNative} loading={variant === 'hero' ? 'eager' : 'lazy'} onError={() => setIndex((current) => current + 1)} />
  if (variant === 'card') return image
  return <a href={fullResolutionImageUrl(source)} target="_blank" rel="noreferrer" className="thumbnail-link">{image}</a>
}

function PlaceCard({ place }: { place: Place }) {
  return (
    <article className="place-card">
      <a className="card-button" href={placeHref(place.qid)}>
        <Thumbnail place={place} />
        <span className="card-copy">
          <strong>{place.labelNative}</strong>
          {(place.labelEn || place.labelZh) && <span className="place-subheading">{[place.labelEn, place.labelZh].filter(Boolean).join(' · ')}</span>}
          <span>{place.countryLabelEn || 'Location not recorded'}</span>
          <span className="badge">{place.registryName}</span>
        </span>
      </a>
      <div className="card-meta">
        {place.designations.slice(0, 2).map((item) => <span key={item}>{item}</span>)}
        {place.wikiViewCount ? <span>{formatViews(place.wikiViewCount)} Wikipedia views</span> : null}
      </div>
    </article>
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="detail-row"><dt>{label}</dt><dd>{children}</dd></div>
}

function TextList({ values }: { values: string[] }) {
  return values.length ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul> : <>Not recorded</>
}

function LinkList({ values }: { values: string[] }) {
  const uniqueValues = [...new Set(values)]
  return uniqueValues.length ? <ul>{uniqueValues.map((url) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></li>)}</ul> : <>Not recorded</>
}

function PlacePanel({ database, qid, onClose }: { database: AtlasDatabase; qid: string; onClose: () => void }) {
  const place = useMemo(() => database.getPlace(qid), [database, qid])

  useEffect(() => {
    document.title = place ? `${place.labelNative} · Heritage Atlas` : 'Record not found · Heritage Atlas'
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.title = 'Heritage Atlas'
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [onClose, place])

  if (!place) {
    return (
      <div className="record-overlay" onMouseDown={onClose}>
        <section className="record-panel record-panel-empty" role="dialog" aria-modal="true" aria-labelledby="record-not-found-title" onMouseDown={(event) => event.stopPropagation()}>
          <button className="panel-close" type="button" onClick={onClose} aria-label="Close place details">&times;</button>
          <h1 id="record-not-found-title">Record not found</h1>
          <p>This link does not match the installed atlas dataset.</p>
        </section>
      </div>
    )
  }

  const hasCoordinates = typeof place.latitude === 'number' && typeof place.longitude === 'number'
  const coordinateText = hasCoordinates ? `${place.latitude!.toFixed(5)}, ${place.longitude!.toFixed(5)}` : ''
  const additionalFields = Object.entries(place.sourceFields).filter(
    ([key, value]) => value.trim() && !DISPLAYED_SOURCE_FIELDS.has(key.toLocaleLowerCase()),
  )

  return (
    <div className="record-overlay" onMouseDown={onClose}>
      <section className="record-panel" role="dialog" aria-modal="true" aria-labelledby="place-detail-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="panel-close" type="button" onClick={onClose} aria-label="Close place details">&times;</button>
        <article className="record-shell">
          <section className="record-hero-wrap">
            <Thumbnail place={place} variant="hero" />
            <div>
              <p className="eyebrow">{place.registryName}</p>
              <h1 id="place-detail-title">{place.labelNative}</h1>
              {(place.labelEn || place.labelZh) && <p className="translated-name">
                {place.labelEn && <span lang="en">{place.labelEn}</span>}
                {place.labelZh && <span lang="zh">{place.labelZh}</span>}
              </p>}
              {place.countryLabelEn && <p className="record-location">{place.countryLabelEn}</p>}
            </div>
          </section>
          <section className="record-grid" aria-label="Record details">
            <dl>
              <DetailRow label="Native label (label_native)">{place.labelNative || 'Not recorded'}</DetailRow>
              <DetailRow label="English label (label_en)">{place.labelEn || 'Not recorded'}</DetailRow>
              <DetailRow label="Chinese label (label_zh)">{place.labelZh || 'Not recorded'}</DetailRow>
              <DetailRow label="Native language">{place.nativeLanguageLabelEn || 'Not recorded'}</DetailRow>
              <DetailRow label="Country">{place.countryLabelEn || 'Not recorded'}</DetailRow>
              <DetailRow label="Heritage designation"><TextList values={place.designations} /></DetailRow>
              <DetailRow label="Architectural style"><TextList values={place.styles} /></DetailRow>
              <DetailRow label="Inception"><TextList values={place.inceptionValues} /></DetailRow>
            </dl>
            <dl>
              <DetailRow label="Coordinates (WKT)">{place.coordinatesWkt || 'Not recorded'}</DetailRow>
              <DetailRow label="Map coordinates">{hasCoordinates ? <a href={`https://www.openstreetmap.org/?mlat=${place.latitude}&mlon=${place.longitude}#map=16/${place.latitude}/${place.longitude}`} target="_blank" rel="noreferrer">{coordinateText}</a> : 'Not recorded'}</DetailRow>
              <DetailRow label="Native Wikipedia views">{place.nativeWikiViewCount.toLocaleString()}</DetailRow>
              <DetailRow label="English Wikipedia views">{place.enWikiViewCount.toLocaleString()}</DetailRow>
              <DetailRow label="Combined Wikipedia views">{(place.wikiViewCount ?? 0).toLocaleString()}</DetailRow>
              <DetailRow label="Wikipedia sitelinks">{place.wikipediaSitelinksCount.toLocaleString()}</DetailRow>
              <DetailRow label="Wikidata QID"><a href={`https://www.wikidata.org/wiki/${place.qid}`} target="_blank" rel="noreferrer">{place.qid}</a></DetailRow>
              <DetailRow label="Registry used for import">{place.registryName}</DetailRow>
            </dl>
            <dl>
              <DetailRow label="Source record URLs"><LinkList values={place.sourceRecordUrls} /></DetailRow>
              <DetailRow label="Native Wikipedia URL">{place.nativeWikiUrl ? <a href={place.nativeWikiUrl} target="_blank" rel="noreferrer">{place.nativeWikiUrl}</a> : 'Not recorded'}</DetailRow>
              <DetailRow label="English Wikipedia URL">{place.enWikiUrl ? <a href={place.enWikiUrl} target="_blank" rel="noreferrer">{place.enWikiUrl}</a> : 'Not recorded'}</DetailRow>
              <DetailRow label="Commons image URLs"><LinkList values={place.commonsImageUrls} /></DetailRow>
              <DetailRow label="Official website URLs"><LinkList values={place.officialWebsiteUrls} /></DetailRow>
            </dl>
            {additionalFields.length > 0 && <dl>
              {additionalFields.map(([key, value]) => <DetailRow key={key} label={key}>{value}</DetailRow>)}
            </dl>}
          </section>
        </article>
        <footer><span>Map: © OpenStreetMap contributors.</span><span>Images remain hosted by their original sources.</span></footer>
      </section>
    </div>
  )
}

type ExploreProps = {
  database: AtlasDatabase
  stats: AtlasStats
  installed: StoredAtlasMetadata
  manifest: AtlasManifest | null
  onInstallLatest: () => void
  onCheckUpdates: () => void
  onDelete: () => void
  updating: boolean
  updateNote: string
}

function ExplorePage({ database, stats, installed, manifest, onInstallLatest, onCheckUpdates, onDelete, updating, updateNote }: ExploreProps) {
  const [filters, setFilters] = useState<PlaceFilters>(EMPTY_FILTERS)
  const [page, setPage] = useState(0)
  const [bounds, setBounds] = useState<MapBounds | null>(null)

  useEffect(() => { document.title = 'Heritage Atlas' }, [])

  const result = useMemo(() => database.search(filters, page, PAGE_SIZE), [database, filters, page])
  const mapPlaces = useMemo(() => bounds ? database.getMapPlaces(filters, bounds) : [], [database, filters, bounds])
  const pageCount = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
  const from = result.total ? page * PAGE_SIZE + 1 : 0
  const to = Math.min((page + 1) * PAGE_SIZE, result.total)
  const updateAvailable = Boolean(manifest && manifest.version !== installed.version)

  const updateFilters = (patch: Partial<PlaceFilters>) => {
    setFilters((current) => ({ ...current, ...patch }))
    setPage(0)
  }

  return (
    <main>
      <header className="site-header">
        <div>
          <p className="eyebrow">Installed local atlas</p>
          <h1>Heritage Atlas</h1>
          <p>All filtering, sorting, and pagination run against the database saved in this browser. Only thumbnails and map tiles need normal network requests.</p>
        </div>
        <div className="data-status">
          <strong>{installed.name}</strong>
          <span>{stats.placeCount.toLocaleString()} places · {formatBytes(installed.bytes)} · {installed.version}</span>
          <span>Stored locally in this browser</span>
          {updateAvailable ? <button className="small-button" onClick={onInstallLatest} disabled={updating}>{updating ? 'Updating…' : 'Update available'}</button> : <button className="small-button" onClick={onCheckUpdates} disabled={updating}>{updating ? 'Checking…' : 'Check for updates'}</button>}
          {updateNote && <span className="update-note">{updateNote}</span>}
          <button className="text-button" onClick={onDelete} disabled={updating}>Delete local data</button>
        </div>
      </header>

      <section className="controls" aria-label="Place filters">
        <label>Search<input value={filters.query} onChange={(event) => updateFilters({ query: event.target.value })} placeholder="Name, country, style, designation…" /></label>
        <label>Style keyword<input value={filters.style} onChange={(event) => updateFilters({ style: event.target.value })} placeholder="e.g. Baroque" /></label>
        <label>Country<select value={filters.country} onChange={(event) => updateFilters({ country: event.target.value })}><option value="">All countries</option>{stats.countries.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>Registry<select value={filters.registry} onChange={(event) => updateFilters({ registry: event.target.value })}><option value="">All registries</option>{stats.registries.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
        <label>Sort<select value={filters.sort} onChange={(event) => updateFilters({ sort: event.target.value as PlaceFilters['sort'] })}><option value="views">Wikipedia views</option><option value="name">Name</option></select></label>
      </section>

      <p className="results-summary">{result.total.toLocaleString()} places match. Results {from.toLocaleString()}–{to.toLocaleString()} are loaded locally; the map clusters all matching places in the current view.</p>

      <section className="atlas-layout">
        <MapPanel places={mapPlaces} onOpenPlace={(qid) => { window.location.hash = `/place/${encodeURIComponent(qid)}` }} onViewportChanged={setBounds} />
        <aside className="place-list" aria-label="Heritage place results">
          {result.items.map((place) => <PlaceCard key={place.qid} place={place} />)}
          {!result.items.length && <p className="notice">No places match these filters.</p>}
          {result.total > PAGE_SIZE && <nav className="pagination" aria-label="Results pagination">
            <button onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={page === 0}>← Previous</button>
            <span>Page {page + 1} of {pageCount}</span>
            <button onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} disabled={page + 1 >= pageCount}>Next →</button>
          </nav>}
        </aside>
      </section>
      <footer><span>Map: © OpenStreetMap contributors.</span><span>Images remain hosted by their original sources.</span></footer>
    </main>
  )
}

type InstallerProps = {
  manifest: AtlasManifest | null
  current: StoredAtlasMetadata | null
  progress: InstallProgress
  error: string
  onDownload: () => void
  onImport: (file: File) => void
}

function Installer({ manifest, current, progress, error, onDownload, onImport }: InstallerProps) {
  const inputRef = useRef<HTMLInputElement | null>(null)
  const percent = progress.total ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : undefined
  const working = progress.stage !== 'idle'

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) onImport(file)
    event.target.value = ''
  }

  return (
    <main className="installer-page">
      <section className="installer-card">
        <p className="eyebrow">Offline-first heritage database</p>
        <h1>Install the Heritage Atlas</h1>
        <p>Download the catalogue once. It is saved privately in this browser and reopened automatically on later visits. Searches, filters, sorting, and 20-result pages then run locally.</p>
        {manifest && <dl className="dataset-facts"><div><dt>Dataset</dt><dd>{manifest.name}</dd></div><div><dt>Version</dt><dd>{manifest.version}</dd></div><div><dt>Download</dt><dd>{formatBytes(manifest.bytes)}</dd></div>{manifest.recordCount && <div><dt>Places</dt><dd>{manifest.recordCount.toLocaleString()}</dd></div>}</dl>}
        {current && <p className="notice">A previous dataset is available locally ({current.name}, {current.version}), but it could not be opened yet.</p>}
        {error && <p className="notice error">{error}</p>}
        {working && <div className="install-progress"><strong>{progress.stage === 'downloading' ? 'Downloading atlas…' : 'Installing local database…'}</strong><span>{formatBytes(progress.received)}{progress.total ? ` of ${formatBytes(progress.total)}` : ''}{percent !== undefined ? ` · ${percent}%` : ''}</span><progress value={progress.received} max={progress.total ?? Math.max(progress.received, 1)} /></div>}
        <div className="installer-actions">
          <button className="primary-button" onClick={onDownload} disabled={!manifest || working}>{working ? 'Working…' : 'Download dataset'}</button>
          <button onClick={() => inputRef.current?.click()} disabled={working}>Import a .sqlite file</button>
          <input ref={inputRef} type="file" accept=".sqlite,.sqlite3,.db,application/vnd.sqlite3,application/x-sqlite3" hidden onChange={chooseFile} />
        </div>
        <p className="installer-note">Use <strong>Import</strong> only for a database file you already downloaded. Once imported, you will not have to select it again unless you clear browser data.</p>
      </section>
    </main>
  )
}

export default function App() {
  const [database, setDatabase] = useState<AtlasDatabase | null>(null)
  const [stats, setStats] = useState<AtlasStats>(EMPTY_STATS)
  const [manifest, setManifest] = useState<AtlasManifest | null>(null)
  const [installed, setInstalled] = useState<StoredAtlasMetadata | null>(null)
  const [progress, setProgress] = useState<InstallProgress>({ stage: 'idle', received: 0 })
  const [error, setError] = useState('')
  const [updateNote, setUpdateNote] = useState('')
  const route = useHashRoute()

  const openLocalBytes = useCallback(async (bytes: Uint8Array) => {
    const opened = await AtlasDatabase.open(bytes)
    setDatabase(opened)
    setStats(opened.getStats())
  }, [])

  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        const local = await readInstalledAtlas()
        if (!active) return
        if (local) {
          try {
            await openLocalBytes(local.bytes)
            if (active) setInstalled(local.metadata)
            return
          } catch (reason) {
            if (!(reason instanceof IncompatibleAtlasError)) throw reason
            await clearInstalledAtlas().catch(() => undefined)
            if (!active) return
            const latestManifest = await loadManifest()
            if (!active) return
            setInstalled(null)
            setManifest(latestManifest)
            setError('Your saved atlas used the previous data structure and was removed. Download the current dataset to continue.')
            return
          }
        }
        const latestManifest = await loadManifest()
        if (active) setManifest(latestManifest)
      } catch (reason) {
        if (!active) return
        setError(reason instanceof Error ? reason.message : 'Could not open local atlas data.')
      }
    })()
    return () => { active = false }
  }, [openLocalBytes])

  useEffect(() => () => { database?.close() }, [database])

  const installBytes = useCallback(async (bytes: Uint8Array, metadata: StoredAtlasMetadata) => {
    setProgress({ stage: 'installing', received: bytes.byteLength, total: bytes.byteLength })
    await openLocalBytes(bytes)
    await saveInstalledAtlas(metadata, bytes)
    await requestPersistentStorage()
    setInstalled(metadata)
    setError('')
    setProgress({ stage: 'idle', received: 0 })
  }, [openLocalBytes])

  const downloadLatest = useCallback(async () => {
    if (!manifest) return
    try {
      setError('')
      setProgress({ stage: 'downloading', received: 0, total: manifest.bytes })
      const sourceUrl = new URL(manifest.datasetUrl, new URL(import.meta.env.BASE_URL, window.location.origin)).toString()
      const bytes = await downloadBytes(sourceUrl, (received, total) => setProgress({ stage: 'downloading', received, total: total ?? manifest.bytes }))
      if (manifest.sha256) {
        const actual = await sha256Hex(bytes)
        if (actual.toLocaleLowerCase() !== manifest.sha256.toLocaleLowerCase()) {
          throw new Error('The downloaded atlas did not match the manifest checksum.')
        }
      }
      await installBytes(bytes, { version: manifest.version, name: manifest.name, bytes: bytes.byteLength, installedAt: new Date().toISOString(), sourceUrl, sha256: manifest.sha256 })
    } catch (reason) {
      setProgress({ stage: 'idle', received: 0 })
      setError(reason instanceof Error ? reason.message : 'Could not install the atlas.')
    }
  }, [installBytes, manifest])

  const importAtlas = useCallback(async (file: File) => {
    try {
      setError('')
      setProgress({ stage: 'downloading', received: 0, total: file.size })
      const bytes = new Uint8Array(await file.arrayBuffer())
      setProgress({ stage: 'installing', received: bytes.byteLength, total: bytes.byteLength })
      await installBytes(bytes, { version: `manual-${file.lastModified}`, name: file.name, bytes: bytes.byteLength, installedAt: new Date().toISOString() })
    } catch (reason) {
      setProgress({ stage: 'idle', received: 0 })
      setError(reason instanceof Error ? reason.message : 'Could not import this file.')
    }
  }, [installBytes])

  const checkForUpdates = useCallback(async () => {
    try {
      setError('')
      setUpdateNote('Checking the small update manifest…')
      setProgress({ stage: 'installing', received: 0 })
      const latestManifest = await loadManifest()
      setManifest(latestManifest)
      setUpdateNote(latestManifest.version === installed?.version ? 'This browser already has the latest dataset.' : 'A newer dataset is available.')
    } catch (reason) {
      setUpdateNote('')
      setError(reason instanceof Error ? reason.message : 'Could not check for updates.')
    } finally {
      setProgress({ stage: 'idle', received: 0 })
    }
  }, [installed?.version])

  const deleteLocal = useCallback(async () => {
    const shouldDelete = window.confirm('Delete the installed atlas from this browser? You can download it again later.')
    if (!shouldDelete) return
    try {
      setDatabase(null)
      setStats(EMPTY_STATS)
      setInstalled(null)
      await clearInstalledAtlas()
      window.location.hash = '/'
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not delete local data.')
    }
  }, [database])

  if (!database || !installed) {
    return <Installer manifest={manifest} current={installed} progress={progress} error={error} onDownload={downloadLatest} onImport={importAtlas} />
  }

  const closePlace = () => { window.location.hash = '/' }

  return <>
    <ExplorePage database={database} stats={stats} installed={installed} manifest={manifest} onInstallLatest={downloadLatest} onCheckUpdates={checkForUpdates} onDelete={deleteLocal} updating={progress.stage !== 'idle'} updateNote={updateNote} />
    {route.kind === 'place' && <PlacePanel database={database} qid={route.qid} onClose={closePlace} />}
  </>
}

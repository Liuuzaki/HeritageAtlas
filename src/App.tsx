import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { LocateFixed } from 'lucide-react'
import { AtlasDatabase, IncompatibleAtlasError } from './atlasDb'
import { formatBytes, formatViews } from './data'
import { MapPanel, type MapFocusRequest } from './MapPanel'
import { fullResolutionImageUrl, thumbnailImageUrl } from './images'
import { clearInstalledAtlas, readInstalledAtlas, requestPersistentStorage, saveInstalledAtlas } from './storage'
import type { AtlasManifest, AtlasStats, MapBounds, Place, PlaceFilters, StoredAtlasMetadata } from './types'

type Route = { kind: 'home' } | { kind: 'place'; qid: string }
type InstallProgress = { stage: 'idle' | 'downloading' | 'installing'; received: number; total?: number }

const PAGE_SIZE = 20
const EMPTY_STATS: AtlasStats = { placeCount: 0, countries: [], registries: [] }
const EMPTY_FILTERS: PlaceFilters = { query: '', country: '', registry: '', style: '', sort: 'sitelinks' }
const COMMONS_IMAGE_STEP = 8

type WikipediaLoadState = 'idle' | 'loading' | 'ready' | 'error'
type WikipediaCandidate = {
  language: string
  title: string
  articleUrl: string
  apiUrl: string
  sourceLabel: string
}
type WikipediaArticle = {
  language: string
  title: string
  html: string
  articleUrl: string
  sourceLabel: string
}
type WikipediaParseResult = {
  title?: string
  displaytitle?: string
  text?: string
}
type WikipediaParseResponse = {
  parse?: WikipediaParseResult
}
type CommonsSource = {
  title: string
  kind: 'category' | 'page' | 'file'
  sourceUrl: string
  sourceLabel: string
}
type CommonsFile = {
  title: string
  thumbUrl: string
  fullUrl: string
}
type CommonsImageInfo = {
  thumburl?: string
  url?: string
}
type CommonsPage = {
  title?: string
  imageinfo?: CommonsImageInfo[]
}
type CommonsImageResponse = {
  query?: {
    pages?: CommonsPage[]
  }
  continue?: Record<string, string>
}
type CommonsImagePage = {
  files: CommonsFile[]
  continuation?: Record<string, string>
}
type CommonsLoadState = 'idle' | 'loading' | 'ready' | 'error'
type TagNameInfo = {
  qid?: string
  nativeName?: string
  nativeLanguageName?: string
  chineseName?: string
  wikidataUrl?: string
}
type TagLookupState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; info: TagNameInfo }
  | { status: 'error' }
type WikidataSearchResult = {
  id?: string
  label?: string
  match?: {
    text?: string
  }
}
type WikidataSearchResponse = {
  search?: WikidataSearchResult[]
}
type WikidataEntity = {
  id?: string
  labels?: Record<string, { value?: string }>
  claims?: Record<string, { mainsnak?: { datavalue?: { value?: unknown } } }[]>
}
type WikidataEntityResponse = {
  entities?: Record<string, WikidataEntity>
}

const WIKIDATA_API = 'https://www.wikidata.org/w/api.php'
const tagLookupCache = new Map<string, Promise<TagNameInfo>>()
const WIKIDATA_LANGUAGE_CODES: Record<string, string> = {
  arabic: 'ar',
  chinese: 'zh',
  czech: 'cs',
  danish: 'da',
  dutch: 'nl',
  english: 'en',
  finnish: 'fi',
  french: 'fr',
  german: 'de',
  greek: 'el',
  hindi: 'hi',
  hungarian: 'hu',
  indonesian: 'id',
  italian: 'it',
  japanese: 'ja',
  korean: 'ko',
  norwegian: 'no',
  persian: 'fa',
  polish: 'pl',
  portuguese: 'pt',
  romanian: 'ro',
  russian: 'ru',
  spanish: 'es',
  swedish: 'sv',
  thai: 'th',
  turkish: 'tr',
  ukrainian: 'uk',
  vietnamese: 'vi',
}

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

function wikidataApiUrl(params: Record<string, string>): string {
  const url = new URL(WIKIDATA_API)
  url.searchParams.set('origin', '*')
  url.searchParams.set('format', 'json')
  url.searchParams.set('formatversion', '2')
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value)
  }
  return url.toString()
}

function nativeNameFromEntity(entity: WikidataEntity | undefined): string | undefined {
  const nativeNameClaim = entity?.claims?.P1705?.[0]?.mainsnak?.datavalue?.value
  if (!nativeNameClaim || typeof nativeNameClaim !== 'object' || Array.isArray(nativeNameClaim)) return undefined
  const text = (nativeNameClaim as { text?: unknown }).text
  return typeof text === 'string' && text.trim() ? text.trim() : undefined
}

function wikidataLanguageCode(languageLabel: string | undefined): string | undefined {
  const normalized = languageLabel?.trim().toLocaleLowerCase()
  return normalized ? WIKIDATA_LANGUAGE_CODES[normalized] : undefined
}

async function fetchTagNameInfo(tag: string, nativeLanguageLabel: string | undefined): Promise<TagNameInfo> {
  const nativeLanguageCode = wikidataLanguageCode(nativeLanguageLabel)
  const cacheKey = `${nativeLanguageCode || ''}\u0000${tag}`
  const cached = tagLookupCache.get(cacheKey)
  if (cached) return cached

  const lookup = (async () => {
    const searchResponse = await fetch(wikidataApiUrl({
      action: 'wbsearchentities',
      language: 'en',
      uselang: 'en',
      type: 'item',
      limit: '1',
      search: tag,
    }))
    if (!searchResponse.ok) throw new Error(`Wikidata returned ${searchResponse.status}`)
    const searchData = await searchResponse.json() as WikidataSearchResponse
    const match = searchData.search?.find((result) => result.id)
    const qid = match?.id
    if (!qid) return {}

    const entityResponse = await fetch(wikidataApiUrl({
      action: 'wbgetentities',
      ids: qid,
      props: 'labels|claims',
      languages: [...new Set([nativeLanguageCode, 'zh', 'zh-hans', 'zh-hant', 'en'].filter(Boolean))].join('|'),
      languagefallback: '1',
    }))
    if (!entityResponse.ok) throw new Error(`Wikidata returned ${entityResponse.status}`)
    const entityData = await entityResponse.json() as WikidataEntityResponse
    const entity = entityData.entities?.[qid]
    const localizedNativeName = nativeLanguageCode ? entity?.labels?.[nativeLanguageCode]?.value : undefined
    return {
      qid,
      nativeName: localizedNativeName || nativeNameFromEntity(entity),
      nativeLanguageName: nativeLanguageLabel,
      chineseName: entity?.labels?.zh?.value || entity?.labels?.['zh-hans']?.value || entity?.labels?.['zh-hant']?.value,
      wikidataUrl: `https://www.wikidata.org/wiki/${qid}`,
    }
  })()

  tagLookupCache.set(cacheKey, lookup)
  return lookup
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

  const imageSource = variant === 'hero' ? fullResolutionImageUrl(source) : thumbnailImageUrl(source, 384)
  const image = <img className={className} src={imageSource} alt={place.labelNative} loading={variant === 'hero' ? 'eager' : 'lazy'} onError={() => setIndex((current) => current + 1)} />
  if (variant === 'card') return image
  return <a href={fullResolutionImageUrl(source)} target="_blank" rel="noreferrer" className="thumbnail-link">{image}</a>
}

function PlaceCard({ place, sort, onFocusMap }: { place: Place; sort: PlaceFilters['sort']; onFocusMap: (place: Place) => void }) {
  const popularityTitle = `${place.wikipediaSitelinksCount.toLocaleString()} Wikipedia languages`
  const hasCoordinates = typeof place.latitude === 'number' && typeof place.longitude === 'number'
  return (
    <article className="place-card">
      <a className="card-button" href={placeHref(place.qid)}>
        <Thumbnail place={place} />
        <div className="card-copy">
          <strong>{place.labelNative}</strong>
          {(place.labelEn || place.labelZh) && <span className="place-subheading">{[place.labelEn, place.labelZh].filter(Boolean).join(' · ')}</span>}
          <div className="card-meta">
            <DesignationText values={place.designations} limit={2} className="card-designations" />
            <span className="card-popularity-row">
              <span className="map-card-popularity" title={popularityTitle}>
                <span>Wiki popularity</span>
                <strong>{place.wikipediaSitelinksCount > 100 ? '100+' : place.wikipediaSitelinksCount.toLocaleString()}</strong>
              </span>
              {sort === 'views' && place.wikiViewCount ? <span className="map-card-views">{formatViews(place.wikiViewCount)} TODO: Wikipedia pageview</span> : null}
            </span>
          </div>
        </div>
      </a>
      <button
        className="card-focus-button"
        type="button"
        onClick={() => onFocusMap(place)}
        disabled={!hasCoordinates}
        aria-label={hasCoordinates ? `Focus ${place.labelNative} on map` : `No map location for ${place.labelNative}`}
        title={hasCoordinates ? 'Focus on map' : 'Map location unavailable'}
      >
        <LocateFixed size={18} strokeWidth={2} aria-hidden="true" />
      </button>
    </article>
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="detail-row"><dt>{label}</dt><dd>{children}</dd></div>
}

function TextList({ values }: { values: string[] }) {
  return values.length ? <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul> : <>Not recorded</>
}

function DesignationText({ values, limit, className }: { values: string[]; limit?: number; className?: string }) {
  const displayedValues = typeof limit === 'number' ? values.slice(0, limit) : values
  return displayedValues.length
    ? <span className={className}>{displayedValues.join('/')}</span>
    : <>Not recorded</>
}

function aliasedLinks(place: Place): { href: string; label: string }[] {
  const links: { href: string; label: string }[] = []
  const add = (href: string | undefined, label: string) => {
    if (href && !links.some((link) => link.href === href)) links.push({ href, label })
  }

  place.sourceRecordUrls.forEach((url, index) => add(url, place.sourceRecordUrls.length > 1 ? `Source record ${index + 1}` : 'Source record'))
  add(place.enWikiUrl, 'English Wikipedia')
  add(place.nativeWikiUrl, 'Native Wikipedia')
  place.officialWebsiteUrls.forEach((url, index) => add(url, place.officialWebsiteUrls.length > 1 ? `Official website ${index + 1}` : 'Official website'))
  add(place.wikicommonsCategory, 'Wiki Commons')
  add(`https://www.wikidata.org/wiki/${place.qid}`, 'Wikidata')
  return links
}

function RecordSummary({ place, coordinateText, hasCoordinates }: { place: Place; coordinateText: string; hasCoordinates: boolean }) {
  const links = aliasedLinks(place)
  const googleMapsUrl = hasCoordinates ? `https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}` : ''

  return (
    <section className="record-summary" aria-label="Record details">
      <dl className="summary-facts">
        <DetailRow label="Country">{place.countryLabelEn || 'Not recorded'}</DetailRow>
        <DetailRow label="Heritage designation"><DesignationText values={place.designations} /></DetailRow>
        <DetailRow label="Architectural style"><TextList values={place.styles} /></DetailRow>
        <DetailRow label="Inception"><TextList values={place.inceptionValues} /></DetailRow>
        <DetailRow label="Map coordinates">{hasCoordinates ? <a href={googleMapsUrl} target="_blank" rel="noreferrer">{coordinateText}</a> : 'Not recorded'}</DetailRow>
      </dl>
      {links.length > 0 && <nav className="summary-links" aria-label="Record links">
        {links.map((link) => <a key={link.href} href={link.href} target="_blank" rel="noreferrer">{link.label}</a>)}
      </nav>}
    </section>
  )
}

function TagsSection({ tags, nativeLanguageLabel }: { tags: string[]; nativeLanguageLabel?: string }) {
  return (
    <section className="record-section tags-section" aria-labelledby="place-tags-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Tags</p>
          <h2 id="place-tags-title">Instance of</h2>
        </div>
      </div>
      {tags.length
        ? <ul className="tag-list">{tags.map((tag) => <TagItem key={tag} tag={tag} nativeLanguageLabel={nativeLanguageLabel} />)}</ul>
        : <p className="section-empty">No tags are recorded for this place.</p>}
    </section>
  )
}

function TagItem({ tag, nativeLanguageLabel }: { tag: string; nativeLanguageLabel?: string }) {
  const [open, setOpen] = useState(false)
  const [lookup, setLookup] = useState<TagLookupState>({ status: 'idle' })
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const loadNames = () => {
    setOpen(true)
    if (lookup.status === 'loading' || lookup.status === 'ready') return
    setLookup({ status: 'loading' })
    fetchTagNameInfo(tag, nativeLanguageLabel)
      .then((info) => {
        if (mounted.current) setLookup({ status: 'ready', info })
      })
      .catch(() => {
        if (mounted.current) setLookup({ status: 'error' })
      })
  }

  return (
    <li className="tag-item" tabIndex={0} onMouseEnter={loadNames} onMouseLeave={() => setOpen(false)} onFocus={loadNames} onBlur={() => setOpen(false)}>
      <span>{tag}</span>
      {open && <TagTooltip tag={tag} lookup={lookup} />}
    </li>
  )
}

function TagTooltip({ tag, lookup }: { tag: string; lookup: TagLookupState }) {
  if (lookup.status === 'idle' || lookup.status === 'loading') {
    return <span className="tag-tooltip" role="tooltip">Loading Wikidata names...</span>
  }
  if (lookup.status === 'error') {
    return <span className="tag-tooltip" role="tooltip">Wikidata names unavailable.</span>
  }

  const { info } = lookup
  return (
    <span className="tag-tooltip" role="tooltip">
      <span><strong>{info.nativeLanguageName ? `${info.nativeLanguageName} name` : 'Native name'}</strong>{info.nativeName || 'Not recorded'}</span>
      <span><strong>Chinese name</strong>{info.chineseName || 'Not recorded'}</span>
      {info.wikidataUrl
        ? <a href={info.wikidataUrl} target="_blank" rel="noreferrer">Wikidata {info.qid}</a>
        : <span>Wikidata match not found for {tag}.</span>}
    </span>
  )
}

function wikipediaCandidateFromUrl(articleUrl: string | undefined, sourceLabel: string): WikipediaCandidate | undefined {
  if (!articleUrl) return undefined
  try {
    const url = new URL(articleUrl)
    const host = url.hostname.toLocaleLowerCase()
    const suffix = '.wikipedia.org'
    const prefix = '/wiki/'
    if (!host.endsWith(suffix) || !url.pathname.startsWith(prefix)) return undefined
    const language = host.slice(0, -suffix.length)
    const title = decodeURIComponent(url.pathname.slice(prefix.length)).replaceAll('_', ' ')
    if (!language || !title) return undefined
    return {
      language,
      title,
      articleUrl: url.toString(),
      apiUrl: `https://${host}/w/api.php`,
      sourceLabel,
    }
  } catch {
    return undefined
  }
}

function wikipediaCandidates(place: Place): WikipediaCandidate[] {
  const seen = new Set<string>()
  return [
    wikipediaCandidateFromUrl(place.enWikiUrl, 'English Wikipedia'),
    wikipediaCandidateFromUrl(place.nativeWikiUrl, 'Native language Wikipedia'),
  ].filter((candidate): candidate is WikipediaCandidate => {
    if (!candidate || seen.has(candidate.articleUrl)) return false
    seen.add(candidate.articleUrl)
    return true
  })
}

async function fetchWikipediaArticle(candidate: WikipediaCandidate, signal: AbortSignal): Promise<WikipediaArticle | undefined> {
  const url = new URL(candidate.apiUrl)
  url.searchParams.set('action', 'parse')
  url.searchParams.set('format', 'json')
  url.searchParams.set('formatversion', '2')
  url.searchParams.set('origin', '*')
  url.searchParams.set('redirects', '1')
  url.searchParams.set('prop', 'text|displaytitle')
  url.searchParams.set('page', candidate.title)

  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Wikipedia returned ${response.status}`)
  const data = await response.json() as WikipediaParseResponse
  const page = data.parse
  if (!page?.text?.trim()) return undefined
  return {
    language: candidate.language,
    title: page.title?.trim() || candidate.title,
    html: page.text.trim(),
    articleUrl: candidate.articleUrl,
    sourceLabel: candidate.sourceLabel,
  }
}

function wikipediaPageDocument(article: WikipediaArticle): string {
  const baseUrl = new URL(article.articleUrl)
  const baseHref = `${baseUrl.origin}/`
  const content = article.html.replaceAll('href="//', 'href="https://').replaceAll('src="//', 'src="https://')
  return `<!doctype html>
<html lang="${article.language}">
<head>
  <meta charset="utf-8">
  <base href="${baseHref}" target="_blank">
  <style>
    :root { color: #202122; background: #fff; font-family: sans-serif; }
    body { margin: 0; padding: 20px; font-size: 15px; line-height: 1.6; }
    a { color: #0645ad; text-decoration: none; }
    a:hover { text-decoration: underline; }
    img, video { max-width: 100%; height: auto; }
    table { max-width: 100%; border-collapse: collapse; }
    th, td { border: 1px solid #a2a9b1; padding: .25rem .45rem; vertical-align: top; }
    .mw-parser-output > :first-child { margin-top: 0; }
    .infobox, .thumb, figure { max-width: min(100%, 320px); }
    .thumb, figure { margin: 0 0 1rem 1rem; float: right; }
    .thumbinner { max-width: 100%; }
    .mw-editsection, .reference, .reflist, .navbox, .metadata, .ambox, .sistersitebox { display: none; }
    @media (max-width: 640px) {
      body { padding: 14px; font-size: 14px; }
      .thumb, figure { float: none; margin: 0 0 1rem; }
      .infobox { width: 100% !important; }
    }
  </style>
</head>
<body><main class="mw-parser-output">${content}</main></body>
</html>`
}

function WikipediaContentSection({ place }: { place: Place }) {
  const candidates = useMemo(() => wikipediaCandidates(place), [place.enWikiUrl, place.nativeWikiUrl])
  const [state, setState] = useState<WikipediaLoadState>('idle')
  const [article, setArticle] = useState<WikipediaArticle | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setArticle(null)

    if (!candidates.length) {
      setState('idle')
      return () => controller.abort()
    }

    setState('loading')
    ;(async () => {
      for (const candidate of candidates) {
        try {
          const loaded = await fetchWikipediaArticle(candidate, controller.signal)
          if (!active) return
          if (loaded) {
            setArticle(loaded)
            setState('ready')
            return
          }
        } catch (reason) {
          if (reason instanceof DOMException && reason.name === 'AbortError') return
        }
      }
      if (active) setState('error')
    })()

    return () => {
      active = false
      controller.abort()
    }
  }, [candidates])

  const pageDocument = useMemo(() => article ? wikipediaPageDocument(article) : '', [article])

  return (
    <section className="record-section wikipedia-section" aria-labelledby="wikipedia-content-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Wikipedia</p>
        </div>
        {article && <a href={article.articleUrl} target="_blank" rel="noreferrer">{article.sourceLabel}</a>}
      </div>
      {state === 'idle' && <p className="section-empty">No Wikipedia article is recorded for this place.</p>}
      {state === 'loading' && <p className="section-empty">Loading Wikipedia page...</p>}
      {state === 'error' && <p className="section-empty">Wikipedia page could not be loaded right now.</p>}
      {state === 'ready' && article && <>
        <div className="article-meta">
          <strong>{article.title}</strong>
          <span lang={article.language}>{article.language.toLocaleUpperCase()}</span>
        </div>
        <div className="wikipedia-frame-wrap">
          <iframe
            className="wikipedia-frame"
            title={`${article.title} on Wikipedia`}
            srcDoc={pageDocument}
            sandbox="allow-popups allow-popups-to-escape-sandbox"
            scrolling="auto"
          />
        </div>
      </>}
    </section>
  )
}

function commonsSourceFromCategoryUrl(categoryUrl: string | undefined): CommonsSource | undefined {
  if (!categoryUrl) return undefined
  try {
    const url = new URL(categoryUrl)
    if (url.hostname.toLocaleLowerCase() !== 'commons.wikimedia.org') return undefined
    const prefix = '/wiki/'
    if (!url.pathname.startsWith(prefix)) return undefined
    const title = decodeURIComponent(url.pathname.slice(prefix.length)).replaceAll('_', ' ').trim()
    if (!title) return undefined
    const categoryTitle = title.startsWith('Category:') ? title : `Category:${title}`
    return {
      title: categoryTitle,
      kind: 'category',
      sourceUrl: url.toString(),
      sourceLabel: 'Commons category',
    }
  } catch {
    return undefined
  }
}

function addCommonsImageQuery(url: URL, source: CommonsSource, continuation?: Record<string, string>) {
  url.searchParams.set('action', 'query')
  url.searchParams.set('format', 'json')
  url.searchParams.set('formatversion', '2')
  url.searchParams.set('origin', '*')
  url.searchParams.set('prop', 'imageinfo')
  url.searchParams.set('iiprop', 'url')
  url.searchParams.set('iiurlwidth', '520')

  if (source.kind === 'category') {
    url.searchParams.set('generator', 'categorymembers')
    url.searchParams.set('gcmtitle', source.title)
    url.searchParams.set('gcmtype', 'file')
    url.searchParams.set('gcmlimit', String(COMMONS_IMAGE_STEP))
  } else if (source.kind === 'page') {
    url.searchParams.set('generator', 'images')
    url.searchParams.set('titles', source.title)
    url.searchParams.set('gimlimit', String(COMMONS_IMAGE_STEP))
  } else {
    url.searchParams.set('titles', source.title)
  }

  if (continuation) {
    for (const [key, value] of Object.entries(continuation)) {
      url.searchParams.set(key, value)
    }
  }
}

function commonsFileFromPage(page: CommonsPage): CommonsFile | undefined {
  const imageInfo = page.imageinfo?.[0]
  if (!page.title || !imageInfo?.url) return undefined
  return {
    title: page.title,
    thumbUrl: imageInfo.thumburl || imageInfo.url,
    fullUrl: imageInfo.url,
  }
}

async function fetchCommonsImages(source: CommonsSource, continuation: Record<string, string> | undefined, signal: AbortSignal): Promise<CommonsImagePage> {
  const url = new URL('https://commons.wikimedia.org/w/api.php')
  addCommonsImageQuery(url, source, continuation)

  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`Commons returned ${response.status}`)
  const data = await response.json() as CommonsImageResponse
  const files = (data.query?.pages ?? []).map(commonsFileFromPage).filter((file): file is CommonsFile => Boolean(file))
  return { files, continuation: data.continue }
}

function CommonsGalleryImage({ file, label, index }: { file: CommonsFile; label: string; index: number }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    <a className="commons-gallery-item" href={file.fullUrl} target="_blank" rel="noreferrer">
      <img src={file.thumbUrl} alt={`${label} image ${index + 1}`} title={file.title} loading="lazy" onError={() => setFailed(true)} />
    </a>
  )
}

function CommonsImagesSection({ place }: { place: Place }) {
  const [state, setState] = useState<CommonsLoadState>('idle')
  const [source, setSource] = useState<CommonsSource | null>(null)
  const [images, setImages] = useState<CommonsFile[]>([])
  const [continuation, setContinuation] = useState<Record<string, string> | undefined>()

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setState('loading')
    setSource(null)
    setImages([])
    setContinuation(undefined)

    ;(async () => {
      try {
        const loadedSource = commonsSourceFromCategoryUrl(place.wikicommonsCategory)
        if (!active) return
        if (!loadedSource) {
          setState('idle')
          return
        }
        setSource(loadedSource)
        const firstPage = await fetchCommonsImages(loadedSource, undefined, controller.signal)
        if (!active) return
        setImages(firstPage.files)
        setContinuation(firstPage.continuation)
        setState('ready')
      } catch (reason) {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        if (active) setState('error')
      }
    })()

    return () => {
      active = false
      controller.abort()
    }
  }, [place.wikicommonsCategory])

  const loadMoreImages = async () => {
    if (!source || !continuation || state === 'loading') return
    try {
      setState('loading')
      const nextPage = await fetchCommonsImages(source, continuation, new AbortController().signal)
      setImages((current) => {
        const seen = new Set(current.map((image) => image.fullUrl))
        return [...current, ...nextPage.files.filter((image) => !seen.has(image.fullUrl))]
      })
      setContinuation(nextPage.continuation)
      setState('ready')
    } catch {
      setState('error')
    }
  }

  return (
    <section className="record-section commons-section" aria-labelledby="commons-images-title">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Wiki Commons</p>
        </div>
        {source && <a href={source.sourceUrl} target="_blank" rel="noreferrer">{source.sourceLabel}</a>}
      </div>
      {state === 'idle' && <p className="section-empty">No Wiki Commons category is recorded for this place.</p>}
      {state === 'error' && <p className="section-empty">Wiki Commons images could not be loaded right now.</p>}
      {state === 'loading' && !images.length && <p className="section-empty">Finding Wiki Commons images...</p>}
      {images.length ? <>
        <p className="commons-count">{images.length.toLocaleString()} image{images.length === 1 ? '' : 's'} loaded from Wiki Commons</p>
        <div className="commons-gallery">
          {images.map((file, index) => <CommonsGalleryImage key={file.fullUrl} file={file} label={place.labelNative} index={index} />)}
        </div>
        {continuation && <button className="load-more-button" type="button" onClick={loadMoreImages} disabled={state === 'loading'}>{state === 'loading' ? 'Loading...' : 'Load More'}</button>}
      </> : null}
    </section>
  )
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

  return (
    <div className="record-overlay" onMouseDown={onClose}>
      <section className="record-panel" role="dialog" aria-modal="true" aria-labelledby="place-detail-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="panel-close" type="button" onClick={onClose} aria-label="Close place details">&times;</button>
        <article className="record-shell">
          <section className="record-hero-wrap">
            <Thumbnail place={place} variant="hero" />
            <div>
              <h1 id="place-detail-title">{place.labelNative}</h1>
              {(place.labelEn || place.labelZh) && <p className="translated-name">
                {place.labelEn && <span lang="en">{place.labelEn}</span>}
                {place.labelZh && <span lang="zh">{place.labelZh}</span>}
              </p>}
              <RecordSummary place={place} coordinateText={coordinateText} hasCoordinates={hasCoordinates} />
            </div>
          </section>
          <TagsSection tags={place.instanceOf} nativeLanguageLabel={place.nativeLanguageLabelEn} />
          <WikipediaContentSection place={place} />
          <CommonsImagesSection place={place} />
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
  const [mapFocusRequest, setMapFocusRequest] = useState<MapFocusRequest | null>(null)
  const mapFocusRequestId = useRef(0)

  useEffect(() => { document.title = 'Heritage Atlas' }, [])

  const result = useMemo(() => database.search(filters, page, PAGE_SIZE), [database, filters, page])
  const mapPlaces = useMemo(() => bounds ? database.getMapPlaces(filters, bounds) : [], [database, filters, bounds])
  const mapDataKey = JSON.stringify(filters)
  const pageCount = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
  const from = result.total ? page * PAGE_SIZE + 1 : 0
  const to = Math.min((page + 1) * PAGE_SIZE, result.total)
  const updateAvailable = Boolean(manifest && manifest.version !== installed.version)

  const updateFilters = (patch: Partial<PlaceFilters>) => {
    setFilters((current) => ({ ...current, ...patch }))
    setPage(0)
  }

  const focusPlaceOnMap = (place: Place) => {
    if (typeof place.latitude !== 'number' || typeof place.longitude !== 'number') return
    mapFocusRequestId.current += 1
    setMapFocusRequest({
      qid: place.qid,
      latitude: place.latitude,
      longitude: place.longitude,
      requestId: mapFocusRequestId.current,
    })
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
        <label>Sort<select value={filters.sort} onChange={(event) => updateFilters({ sort: event.target.value as PlaceFilters['sort'] })}><option value="sitelinks">Wikipedia popularity</option><option value="views">TODO: Wikipedia pageview</option><option value="name">Name</option></select></label>
      </section>

      <p className="results-summary">{result.total.toLocaleString()} places match. Results {from.toLocaleString()}–{to.toLocaleString()} are loaded locally; the map clusters all matching places in the current view.</p>

      <section className="atlas-layout">
        <MapPanel places={mapPlaces} dataKey={mapDataKey} colorMetric={filters.sort === 'sitelinks' ? 'sitelinks' : 'views'} focusRequest={mapFocusRequest} onOpenPlace={(qid) => { window.location.hash = `/place/${encodeURIComponent(qid)}` }} onViewportChanged={setBounds} />
        <aside className="place-list" aria-label="Heritage place results">
          {result.items.map((place) => <PlaceCard key={place.qid} place={place} sort={filters.sort} onFocusMap={focusPlaceOnMap} />)}
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

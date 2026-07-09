import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { ChevronDown, Download, ExternalLink, HelpCircle, Languages, LocateFixed, RefreshCw, Trash2, Upload, X } from 'lucide-react'
import { extractSqliteFromZip } from './archive'
import { AtlasDatabase, IncompatibleAtlasError } from './atlasDb'
import { formatBytes, formatInception, formatViews } from './data'
import { countryFlags, localizedCountryLabel } from './countryFlags'
import { MapPanel, type MapFocusRequest } from './MapPanel'
import { fullResolutionImageUrl, thumbnailImageUrl } from './images'
import { clearInstalledAtlas, readInstalledAtlas, requestPersistentStorage, saveInstalledAtlas } from './storage'
import { isArticleSlug, SITE_ARTICLES_BY_SLUG, type ArticleSlug } from './content/articles'
import type { AtlasManifest, AtlasStats, MapBounds, Place, PlaceFilters, SiteLanguage, StoredAtlasMetadata, TagFilterOption } from './types'

type Route = { kind: 'home' } | { kind: 'place'; qid: string } | { kind: 'article'; slug: ArticleSlug }
type InstallProgress = { stage: 'idle' | 'downloading' | 'extracting' | 'verifying' | 'installing'; received: number; total?: number }
type AtlasManifestConfig = { releaseApiUrl?: unknown; assetName?: unknown; archiveFormat?: unknown }
type GitHubReleaseAsset = { name?: unknown; size?: unknown; digest?: unknown; browser_download_url?: unknown; created_at?: unknown; updated_at?: unknown }
type GitHubRelease = { tag_name?: unknown; name?: unknown; assets?: unknown }
type LanguageContextValue = {
  language: SiteLanguage
  setLanguage: (language: SiteLanguage) => void
}

const LanguageContext = createContext<LanguageContextValue>({ language: 'en', setLanguage: () => undefined })
const LANGUAGE_STORAGE_KEY = 'heritage-atlas-language'

function useLanguage() {
  return useContext(LanguageContext)
}

export function uiText(language: SiteLanguage, english: string, chinese: string): string {
  return language === 'zh' ? chinese : english
}

function localizedArticleText(slug: ArticleSlug, language: SiteLanguage) {
  return SITE_ARTICLES_BY_SLUG[slug].translations[language]
}

function LanguageToggle() {
  const { language, setLanguage } = useLanguage()
  const nextLanguage: SiteLanguage = language === 'en' ? 'zh' : 'en'
  return (
    <button
      className="language-toggle"
      type="button"
      onClick={() => setLanguage(nextLanguage)}
      aria-label={uiText(language, 'Switch site language to Chinese', '将网站语言切换为英语')}
      title={uiText(language, 'Switch to Chinese', '切换为英语')}
    >
      <Languages size={17} aria-hidden="true" />
      {language === 'en' ? '中文' : 'English'}
    </button>
  )
}

const PAGE_SIZE = 20
const DATASET_RELEASES_URL = 'https://github.com/Liuuzaki/HeritageAtlas/releases'
const ATLAS_FILE_ACCEPT = '.zip,.sqlite,.sqlite3,.db,application/zip,application/x-zip-compressed,application/vnd.sqlite3,application/x-sqlite3'
const EMPTY_STATS: AtlasStats = { placeCount: 0, countries: [], instanceOf: [], architecturalStyles: [] }
const EMPTY_FILTERS: PlaceFilters = {
  query: '',
  country: [],
  instanceOf: [],
  architecturalStyles: [],
  timespanEnabled: false,
  timespanStart: null,
  timespanEnd: null,
  sort: 'sitelinks',
}
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
  qid: string
  nativeName?: string
  nativeLanguageName?: string
  chineseName?: string
  englishDescription?: string
  wikidataUrl: string
}
type Tag = { label: string; qid?: string }
type TagLookupState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; info: TagNameInfo }
  | { status: 'error' }
type WikidataEntity = {
  id?: string
  labels?: Record<string, { value?: string }>
  descriptions?: Record<string, { value?: string }>
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
  const articleMatch = raw.match(/^\/article\/([^/]+)\/?$/)
  const articleSlug = articleMatch?.[1]
  if (articleSlug && isArticleSlug(articleSlug)) return { kind: 'article', slug: articleSlug }
  const match = raw.match(/^\/place\/([^/]+)\/?$/)
  const qid = match?.[1]
  return qid ? { kind: 'place', qid: decodeURIComponent(qid) } : { kind: 'home' }
}

function placeHref(qid: string): string {
  return `#/place/${encodeURIComponent(qid)}`
}

function articleHref(slug: ArticleSlug): string {
  return `#/article/${slug}`
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
  const config = raw as AtlasManifestConfig
  if (typeof config.releaseApiUrl !== 'string' || typeof config.assetName !== 'string' || config.archiveFormat !== 'zip') {
    throw new Error('atlas-manifest.json needs releaseApiUrl, assetName, and ZIP archiveFormat.')
  }

  const releaseResponse = await fetch(config.releaseApiUrl, {
    cache: 'no-store',
    headers: { Accept: 'application/vnd.github+json' },
  })
  if (!releaseResponse.ok) throw new Error(`Could not load the latest GitHub release: ${releaseResponse.status}`)
  const release = await releaseResponse.json() as GitHubRelease
  const assets = Array.isArray(release.assets) ? release.assets as GitHubReleaseAsset[] : []
  const asset = assets.find((candidate) => candidate.name === config.assetName)
  if (!asset || typeof asset.size !== 'number' || typeof asset.browser_download_url !== 'string') {
    throw new Error(`The latest GitHub release does not contain ${config.assetName}.`)
  }
  if (typeof asset.digest !== 'string' || !/^sha256:[a-f\d]{64}$/i.test(asset.digest)) {
    throw new Error(`GitHub did not provide a SHA-256 digest for ${config.assetName}.`)
  }
  if (typeof release.tag_name !== 'string' || !release.tag_name) {
    throw new Error('The latest GitHub release does not have a tag name.')
  }

  return {
    version: release.tag_name,
    name: typeof release.name === 'string' && release.name ? release.name : release.tag_name,
    datasetUrl: asset.browser_download_url,
    archiveFormat: 'zip',
    bytes: asset.size,
    sha256: asset.digest.slice('sha256:'.length),
    assetDate: typeof asset.updated_at === 'string'
      ? asset.updated_at
      : typeof asset.created_at === 'string'
        ? asset.created_at
        : undefined,
  }
}

function startBrowserDownload(url: string): void {
  const link = document.createElement('a')
  link.href = url
  link.target = '_blank'
  link.rel = 'noreferrer'
  link.download = ''
  document.body.append(link)
  link.click()
  link.remove()
}

function isZipFile(file: File): boolean {
  return file.name.toLowerCase().endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed'
}

function formatAssetDate(value: string | undefined, language: SiteLanguage): string {
  if (!value) return uiText(language, 'Not published yet', '尚未发布')
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return uiText(language, 'Date unavailable', '日期不可用')
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(date)
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

async function fetchTagNameInfo(qid: string, nativeLanguageLabel: string | undefined): Promise<TagNameInfo> {
  const nativeLanguageCode = wikidataLanguageCode(nativeLanguageLabel)
  const cacheKey = `${nativeLanguageCode || ''}\u0000${qid}`
  const cached = tagLookupCache.get(cacheKey)
  if (cached) return cached

  const lookup = (async () => {
    const entityResponse = await fetch(wikidataApiUrl({
      action: 'wbgetentities',
      ids: qid,
      props: 'labels|descriptions|claims',
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
      englishDescription: entity?.descriptions?.en?.value,
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
  const { language } = useLanguage()
  const popularityTitle = `${place.wikipediaSitelinksCount.toLocaleString()} Wikipedia languages`
  const hasCoordinates = typeof place.latitude === 'number' && typeof place.longitude === 'number'
  const flags = countryFlags(place.countryLabelEn)
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
                <span>{uiText(language, 'Wiki popularity', 'Wiki 热度')}</span>
                <strong>{place.wikipediaSitelinksCount > 100 ? '100+' : place.wikipediaSitelinksCount.toLocaleString()}</strong>
              </span>
              {sort === 'views' && place.wikiViewCount ? <span className="map-card-views">{formatViews(place.wikiViewCount)} TODO: Wikipedia pageview</span> : null}
            </span>
          </div>
        </div>
      </a>
      <div className="card-rail">
        <button
          className="card-focus-button"
          type="button"
          onClick={() => onFocusMap(place)}
          disabled={!hasCoordinates}
          aria-label={hasCoordinates
            ? uiText(language, `Focus ${place.labelNative} on map`, `在地图上定位 ${place.labelNative}`)
            : uiText(language, `No map location for ${place.labelNative}`, `${place.labelNative} 没有地图位置`)}
          title={hasCoordinates ? uiText(language, 'Focus on map', '在地图上定位') : uiText(language, 'Map location unavailable', '地图位置不可用')}
        >
          <LocateFixed size={18} strokeWidth={2} aria-hidden="true" />
        </button>
        {flags.length > 0 && (
          <span className="card-country-flags">
            {flags.map((flag) => <img key={flag.code} src={`https://flagcdn.com/${flag.code.toLowerCase()}.svg`} alt={`Flag of ${flag.name}`} title={flag.name} width="32" height="24" loading="lazy" referrerPolicy="no-referrer" />)}
          </span>
        )}
      </div>
    </article>
  )
}

function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return <div className="detail-row"><dt>{label}</dt><dd>{children}</dd></div>
}

function TextList({ values, formatValue = (value) => value }: { values: string[]; formatValue?: (value: string) => string }) {
  return values.length ? <ul>{values.map((value) => <li key={value}>{formatValue(value)}</li>)}</ul> : <>Not recorded</>
}

function tagsFromValues(...valueGroups: string[][]): Tag[] {
  const tags: Tag[] = []
  const seen = new Set<string>()

  for (const value of valueGroups.flat()) {
    const match = value.match(/^(.*?)\s*\[\s*(Q\d+)\s*\]\s*$/i)
    const qid = match?.[2]?.toUpperCase()
    const label = (match?.[1] || value).trim()
    if (!label) continue

    const key = qid || label.toLocaleLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    tags.push({ label, qid })
  }

  return tags
}

function DesignationText({ values, limit, className }: { values: string[]; limit?: number; className?: string }) {
  const displayedValues = typeof limit === 'number' ? values.slice(0, limit) : values
  return displayedValues.length
    ? <span className={className}>{displayedValues.join('/')}</span>
    : <>Not recorded</>
}

function wikipediaLanguageFromUrl(articleUrl: string | undefined): string | undefined {
  if (!articleUrl) return undefined
  try {
    const url = new URL(articleUrl)
    const suffix = '.wikipedia.org'
    const host = url.hostname.toLocaleLowerCase()
    return host.endsWith(suffix) ? host.slice(0, -suffix.length) : undefined
  } catch {
    return undefined
  }
}

function placeIsInChina(place: Place): boolean {
  return countryFlags(place.countryLabelEn).some((flag) => flag.code === 'CN')
}

function wikipediaSources(place: Place, language: SiteLanguage): { articleUrl: string; label: string }[] {
  const nativeLanguage = wikipediaLanguageFromUrl(place.nativeWikiUrl)
  const nativeLabel = nativeLanguage === 'zh' ? 'Chinese Wikipedia' : 'Native Wikipedia'
  const englishSource = { articleUrl: place.enWikiUrl, label: 'English Wikipedia' }
  const nativeSource = { articleUrl: place.nativeWikiUrl, label: nativeLabel }
  const orderedSources = language === 'zh' && placeIsInChina(place) && nativeLanguage === 'zh'
    ? [nativeSource, englishSource]
    : [englishSource, nativeSource]
  const seen = new Set<string>()

  return orderedSources.filter((source): source is { articleUrl: string; label: string } => {
    if (!source.articleUrl || seen.has(source.articleUrl)) return false
    seen.add(source.articleUrl)
    return true
  })
}

function VisitLink({ href, label, className }: { href: string; label: string; className?: string }) {
  const accessibleLabel = `Visit ${label}`
  return (
    <a className={['visit-link', className].filter(Boolean).join(' ')} href={href} target="_blank" rel="noreferrer" aria-label={accessibleLabel} title={accessibleLabel}>
      <ExternalLink size={16} strokeWidth={2.2} aria-hidden="true" />
      <span className="visually-hidden">{accessibleLabel}</span>
    </a>
  )
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
  const { language } = useLanguage()
  const links = aliasedLinks(place)
  const googleMapsUrl = hasCoordinates ? `https://www.google.com/maps/search/?api=1&query=${place.latitude},${place.longitude}` : ''

  return (
    <section className="record-summary" aria-label={uiText(language, 'Record details', '记录详情')}>
      <dl className="summary-facts">
        <DetailRow label={uiText(language, 'Country', '国家/地区')}>{place.countryLabelEn || 'Not recorded'}</DetailRow>
        <DetailRow label={uiText(language, 'Heritage designation', '遗产认定')}><DesignationText values={place.designations} /></DetailRow>
        <DetailRow label={uiText(language, 'Inception', '始建时间')}><TextList values={place.inceptionValues} formatValue={formatInception} /></DetailRow>
        <DetailRow label={uiText(language, 'Map coordinates', '地图坐标')}>{hasCoordinates ? <a href={googleMapsUrl} target="_blank" rel="noreferrer">{coordinateText}</a> : 'Not recorded'}</DetailRow>
      </dl>
      {links.length > 0 && <nav className="summary-links" aria-label="Record links">
        {links.map((link) => <a key={link.href} href={link.href} target="_blank" rel="noreferrer">{link.label}</a>)}
      </nav>}
    </section>
  )
}

function TagsSection({ values, nativeLanguageLabel }: { values: string[][]; nativeLanguageLabel?: string }) {
  const { language } = useLanguage()
  const tags = tagsFromValues(...values)
  return (
    <section className="record-section tags-section" aria-labelledby="place-tags-title">
      <div className="section-heading">
        <h2 id="place-tags-title">{uiText(language, 'Tags', '标签')}</h2>
      </div>
      {tags.length
        ? <ul className="tag-list">{tags.map((tag) => <TagItem key={tag.qid || tag.label} tag={tag} nativeLanguageLabel={nativeLanguageLabel} />)}</ul>
        : <p className="section-empty">No tags are recorded for this place.</p>}
    </section>
  )
}

function TagItem({ tag, nativeLanguageLabel }: { tag: Tag; nativeLanguageLabel?: string }) {
  const { open, lookup, loadNames, close } = useTagTooltip(tag, nativeLanguageLabel)

  return (
    <li className="tag-item" tabIndex={0} onMouseEnter={loadNames} onMouseLeave={close} onFocus={loadNames} onBlur={close}>
      <span>{tag.label}</span>
      {open && <TagTooltip tag={tag} lookup={lookup} />}
    </li>
  )
}

function useTagTooltip(tag: Tag, nativeLanguageLabel?: string) {
  const [open, setOpen] = useState(false)
  const [lookup, setLookup] = useState<TagLookupState>({ status: 'idle' })

  const loadNames = () => {
    setOpen(true)
    if (lookup.status === 'loading' || lookup.status === 'ready') return
    if (!tag.qid) {
      setLookup({ status: 'error' })
      return
    }
    setLookup({ status: 'loading' })
    fetchTagNameInfo(tag.qid, nativeLanguageLabel)
      .then((info) => setLookup({ status: 'ready', info }))
      .catch(() => setLookup({ status: 'error' }))
  }

  return { open, lookup, loadNames, close: () => setOpen(false) }
}

function TagHelp({ tag, placement = 'below' }: { tag: Tag; placement?: 'above' | 'below' }) {
  const { language } = useLanguage()
  const { open, lookup, loadNames, close } = useTagTooltip(tag)
  return (
    <span
      className={`tag-filter-help${placement === 'above' ? ' tag-filter-help-above' : ''}`}
      onMouseEnter={loadNames}
      onMouseLeave={close}
      onFocus={loadNames}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close()
      }}
    >
      <button type="button" className="tag-help-button" aria-label={uiText(language, `About ${tag.label}`, `关于 ${tag.label}`)}>
        <HelpCircle size={17} aria-hidden="true" />
      </button>
      {open && <TagTooltip tag={tag} lookup={lookup} showNativeName={false} />}
    </span>
  )
}

function TagTooltip({ tag, lookup, showNativeName = true }: { tag: Tag; lookup: TagLookupState; showNativeName?: boolean }) {
  if (lookup.status === 'idle' || lookup.status === 'loading') {
    return <span className="tag-tooltip" role="tooltip">Loading Wikidata details...</span>
  }
  if (lookup.status === 'error') {
    return <span className="tag-tooltip" role="tooltip">{tag.qid ? 'Wikidata details unavailable.' : 'Wikidata QID not recorded.'}</span>
  }

  const { info } = lookup
  return (
    <span className="tag-tooltip" role="tooltip">
      {showNativeName && <span><strong>{info.nativeLanguageName ? `${info.nativeLanguageName} name` : 'Native name'}</strong>{info.nativeName || 'Not recorded'}</span>}
      <span><strong>Chinese name</strong>{info.chineseName || 'Not recorded'}</span>
      <span><strong>English description</strong>{info.englishDescription || 'Not recorded'}</span>
      <a href={info.wikidataUrl} target="_blank" rel="noreferrer">Wikidata {info.qid}</a>
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

function wikipediaCandidates(place: Place, language: SiteLanguage): WikipediaCandidate[] {
  return wikipediaSources(place, language)
    .map((source) => wikipediaCandidateFromUrl(source.articleUrl, source.label))
    .filter((candidate): candidate is WikipediaCandidate => Boolean(candidate))
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
  const { language } = useLanguage()
  const candidates = useMemo(() => wikipediaCandidates(place, language), [language, place.countryLabelEn, place.enWikiUrl, place.nativeWikiUrl])
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
          <p className="eyebrow">{uiText(language, 'Wikipedia', '维基百科')}</p>
        </div>
        {article && <VisitLink href={article.articleUrl} label={article.sourceLabel} />}
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
  const { language } = useLanguage()
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
          <p className="eyebrow">{uiText(language, 'Wiki Commons', '维基共享资源')}</p>
        </div>
        {source && <VisitLink href={source.sourceUrl} label={source.sourceLabel} />}
      </div>
      {state === 'idle' && <p className="section-empty">No Wiki Commons category is recorded for this place.</p>}
      {state === 'error' && <p className="section-empty">Wiki Commons images could not be loaded right now.</p>}
      {state === 'loading' && !images.length && <p className="section-empty">Finding Wiki Commons images...</p>}
      {images.length ? <>
        <p className="commons-count">{images.length.toLocaleString()} image{images.length === 1 ? '' : 's'} loaded from Wiki Commons</p>
        <div className="commons-gallery">
          {images.map((file, index) => <CommonsGalleryImage key={file.fullUrl} file={file} label={place.labelNative} index={index} />)}
        </div>
        {continuation && <button className="load-more-button" type="button" onClick={loadMoreImages} disabled={state === 'loading'}>{state === 'loading' ? uiText(language, 'Loading...', '正在加载...') : uiText(language, 'Load More', '加载更多')}</button>}
      </> : null}
    </section>
  )
}

function PlacePanel({ database, qid, onClose }: { database: AtlasDatabase; qid: string; onClose: () => void }) {
  const { language } = useLanguage()
  const place = useMemo(() => database.getPlace(qid), [database, qid])

  useEffect(() => {
    const brand = uiText(language, 'Wiki Monument Atlas', '维基建筑遗产图谱')
    document.title = place ? `${place.labelNative} · ${brand}` : `${uiText(language, 'Record not found', '未找到记录')} · ${brand}`
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.title = brand
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [language, onClose, place])

  if (!place) {
    return (
      <div className="record-overlay" onMouseDown={onClose}>
        <section className="record-panel record-panel-empty" role="dialog" aria-modal="true" aria-labelledby="record-not-found-title" onMouseDown={(event) => event.stopPropagation()}>
          <button className="panel-close" type="button" onClick={onClose} aria-label={uiText(language, 'Close place details', '关闭地点详情')}>&times;</button>
          <h1 id="record-not-found-title">{uiText(language, 'Record not found', '未找到记录')}</h1>
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
        <button className="panel-close" type="button" onClick={onClose} aria-label={uiText(language, 'Close place details', '关闭地点详情')}>&times;</button>
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
          <TagsSection values={[place.instanceOf, place.styles]} nativeLanguageLabel={place.nativeLanguageLabelEn} />
          <WikipediaContentSection place={place} />
          <CommonsImagesSection place={place} />
        </article>
        <footer><span>Map: © OpenStreetMap contributors.</span><span>Images remain hosted by their original sources.</span></footer>
      </section>
    </div>
  )
}

function renderArticleInline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g).filter(Boolean).map((part, index) => {
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (link?.[1] && link[2]) {
      const external = /^https?:\/\//i.test(link[2])
      return <a key={`${part}-${index}`} href={link[2]} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}>{link[1]}</a>
    }
    const strong = part.match(/^\*\*(.+)\*\*$/)
    return strong?.[1] ? <strong key={`${part}-${index}`}>{strong[1]}</strong> : part
  })
}

function MarkdownArticle({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let index = 0

  while (index < lines.length) {
    const line = (lines[index] ?? '').trim()
    if (!line) {
      index += 1
      continue
    }

    const heading = line.match(/^(#{2,3})\s+(.+)$/)
    if (heading?.[2]) {
      blocks.push(heading[1] === '##'
        ? <h2 key={`heading-${index}`}>{renderArticleInline(heading[2])}</h2>
        : <h3 key={`heading-${index}`}>{renderArticleInline(heading[2])}</h3>)
      index += 1
      continue
    }

    if (line.startsWith('- ')) {
      const items: ReactNode[] = []
      const listStart = index
      while (index < lines.length) {
        const item = (lines[index] ?? '').trim()
        if (!item.startsWith('- ')) break
        items.push(<li key={`item-${index}`}>{renderArticleInline(item.slice(2))}</li>)
        index += 1
      }
      blocks.push(<ul key={`list-${listStart}`}>{items}</ul>)
      continue
    }

    const paragraph: string[] = []
    const paragraphStart = index
    while (index < lines.length) {
      const part = (lines[index] ?? '').trim()
      if (!part || /^(#{2,3})\s+/.test(part) || part.startsWith('- ')) break
      paragraph.push(part)
      index += 1
    }
    blocks.push(<p key={`paragraph-${paragraphStart}`}>{renderArticleInline(paragraph.join(' '))}</p>)
  }

  return <div className="article-body">{blocks}</div>
}

function ArticlePanel({ slug, onClose }: { slug: ArticleSlug; onClose: () => void }) {
  const { language } = useLanguage()
  const article = localizedArticleText(slug, language)

  useEffect(() => {
    const brand = uiText(language, 'Wiki Monument Atlas', '维基建筑遗产图谱')
    document.title = `${article.title} · ${brand}`
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.title = brand
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [article.title, language, onClose])

  return (
    <div className="record-overlay" onMouseDown={onClose}>
      <section className="record-panel article-panel" role="dialog" aria-modal="true" aria-labelledby="article-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="panel-close" type="button" onClick={onClose} aria-label={uiText(language, 'Close article', '关闭文章')}>&times;</button>
        <article className="article-shell" lang={language}>
          <header className="article-header">
            <p className="eyebrow">{article.eyebrow}</p>
            <h1 id="article-title">{article.title}</h1>
          </header>
          <MarkdownArticle source={article.source} />
          <p className="article-edit-note">
            {uiText(language, 'Edit this article in', '在此文件中编辑本文')} <code>{article.editPath}</code>{uiText(language, '.', '。')}
          </p>
        </article>
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
  onImport: (file: File) => void
  onDelete: () => void
  progress: InstallProgress
  updateNote: string
  localMatchesLatest: boolean | null
}

type TagFilterKey = 'country' | 'instanceOf' | 'architecturalStyles'
const TAG_FILTER_ROW_HEIGHT = 34
const TAG_FILTER_MAX_HEIGHT = 460
const TAG_FILTER_OVERSCAN = 4

function TagCategoryDropdown({ filterKey, label, triggerLabel = label, options, filters, onChange, showHelp = true }: {
  filterKey: TagFilterKey
  label: string
  triggerLabel?: string
  options: TagFilterOption[]
  filters: PlaceFilters
  onChange: (patch: Partial<PlaceFilters>) => void
  showHelp?: boolean
}) {
  const { language } = useLanguage()
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [sortByCount, setSortByCount] = useState(true)
  const [scrollTop, setScrollTop] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const optionsRef = useRef<HTMLDivElement>(null)
  const selected = filters[filterKey]
  const selectedSet = useMemo(() => new Set(selected), [selected])
  const normalizedSearch = search.trim().toLocaleLowerCase()
  const visibleOptions = useMemo(() => {
    const selectedOptions: TagFilterOption[] = []
    const unselectedOptions: TagFilterOption[] = []
    for (const option of options) {
      if (normalizedSearch && !option.label.toLocaleLowerCase().includes(normalizedSearch)) continue
      if (selectedSet.has(option.value)) selectedOptions.push(option)
      else unselectedOptions.push(option)
    }
    if (sortByCount) {
      const byCount = (left: TagFilterOption, right: TagFilterOption) => right.count - left.count
        || left.label.localeCompare(right.label, undefined, { sensitivity: 'base' })
      selectedOptions.sort(byCount)
      unselectedOptions.sort(byCount)
    }
    return [...selectedOptions, ...unselectedOptions]
  }, [normalizedSearch, options, selectedSet, sortByCount])
  const maxListHeight = Math.min(TAG_FILTER_MAX_HEIGHT, Math.max(170, Math.floor(window.innerHeight * .58)))
  const totalListHeight = visibleOptions.length * TAG_FILTER_ROW_HEIGHT
  const listHeight = Math.min(maxListHeight, totalListHeight)
  const firstVisibleIndex = Math.floor(scrollTop / TAG_FILTER_ROW_HEIGHT)
  const firstRenderedIndex = Math.max(0, firstVisibleIndex - TAG_FILTER_OVERSCAN)
  const renderedCount = Math.ceil(listHeight / TAG_FILTER_ROW_HEIGHT) + TAG_FILTER_OVERSCAN * 2
  const renderedOptions = visibleOptions.slice(firstRenderedIndex, firstRenderedIndex + renderedCount)

  const resetListScroll = () => {
    setScrollTop(0)
    if (optionsRef.current) optionsRef.current.scrollTop = 0
  }

  const close = () => {
    setOpen(false)
    setSearch('')
    resetListScroll()
  }

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('pointerdown', closeOutside)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOutside)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const toggle = (value: string) => {
    onChange({
      [filterKey]: selected.includes(value)
        ? selected.filter((item) => item !== value)
        : [...selected, value],
    })
    resetListScroll()
  }

  return (
    <div className="tag-category-dropdown" ref={rootRef}>
      <button
        type="button"
        className="tag-filter-trigger"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => open ? close() : setOpen(true)}
      >
        <span>{triggerLabel}</span>
        {selected.length > 0 && <span className="tag-filter-count">{selected.length}</span>}
        <ChevronDown size={17} aria-hidden="true" />
      </button>
      {open && (
        <div className="tag-filter-menu">
          <div className="tag-filter-menu-heading">
            <strong>{label}</strong>
            <span className="tag-filter-menu-actions">
              <button
                type="button"
                className="tag-filter-sort"
                aria-pressed={sortByCount}
                onClick={() => {
                  setSortByCount((current) => !current)
                  resetListScroll()
                }}
              >
                {uiText(language, 'Sort by count', '按数量排序')}
              </button>
              {selected.length > 0 && (
                <button type="button" className="tag-filter-clear" onClick={() => {
                  onChange({ [filterKey]: [] })
                  resetListScroll()
                }}>
                  <X size={14} aria-hidden="true" /> {uiText(language, 'Clear', '清除')}
                </button>
              )}
            </span>
          </div>
          <label className="tag-filter-search">
            <span className="visually-hidden">Search {label} tags</span>
            <input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                resetListScroll()
              }}
              placeholder={uiText(language, `Search ${label.toLocaleLowerCase()}…`, `搜索${label}…`)}
              autoFocus
            />
          </label>
          <div
            className={`tag-filter-options${totalListHeight > listHeight ? ' tag-filter-options-scrollable' : ''}`}
            ref={optionsRef}
            style={visibleOptions.length ? { height: listHeight } : undefined}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            {visibleOptions.length ? (
              <div className="tag-filter-options-spacer" style={{ height: totalListHeight }}>
                {renderedOptions.map((option, offset) => {
                  const index = firstRenderedIndex + offset
                  const tooltipAbove = index * TAG_FILTER_ROW_HEIGHT > scrollTop + listHeight / 2
                  return (
                    <div
                      className="tag-filter-option tag-filter-option-virtual"
                      key={option.value}
                      style={{ transform: `translateY(${index * TAG_FILTER_ROW_HEIGHT}px)` }}
                    >
                      <label>
                        <input
                          type="checkbox"
                          checked={selectedSet.has(option.value)}
                          onChange={() => toggle(option.value)}
                        />
                        <span className="tag-filter-option-label">
                          <span>{option.label}</span>
                          <span className="tag-filter-total">({option.count.toLocaleString()})</span>
                        </span>
                      </label>
                      {showHelp && <TagHelp tag={{ label: option.label, qid: option.qid }} placement={tooltipAbove ? 'above' : 'below'} />}
                    </div>
                  )
                })}
              </div>
            ) : <p className="tag-filter-empty">{options.length
              ? uiText(language, 'No matching options', '没有匹配选项')
              : uiText(language, 'No options recorded', '暂无选项')}</p>}
          </div>
        </div>
      )}
    </div>
  )
}

function TagFilterDropdown({ filters, stats, onChange }: {
  filters: PlaceFilters
  stats: AtlasStats
  onChange: (patch: Partial<PlaceFilters>) => void
}) {
  const { language } = useLanguage()
  return (
    <div className="filter-field tag-filter">
      <span className="filter-label">{uiText(language, 'Tags', '标签')}</span>
      <div className="tag-filter-categories">
        <TagCategoryDropdown filterKey="instanceOf" label={uiText(language, 'Instance of', '类型')} options={stats.instanceOf} filters={filters} onChange={onChange} />
        <TagCategoryDropdown filterKey="architecturalStyles" label={uiText(language, 'Architectural style', '建筑风格')} options={stats.architecturalStyles} filters={filters} onChange={onChange} />
      </div>
    </div>
  )
}

function CountryFilterDropdown({ filters, options, onChange }: {
  filters: PlaceFilters
  options: TagFilterOption[]
  onChange: (patch: Partial<PlaceFilters>) => void
}) {
  const { language } = useLanguage()
  return (
    <div className="filter-field tag-filter country-filter">
      <span className="filter-label">{uiText(language, 'Country', '国家/地区')}</span>
      <TagCategoryDropdown
        filterKey="country"
        label={uiText(language, 'Countries', '国家/地区')}
        triggerLabel={uiText(language, 'Select countries', '选择国家/地区')}
        options={options}
        filters={filters}
        onChange={onChange}
        showHelp={false}
      />
    </div>
  )
}

function TimespanFilter({ filters, onChange }: {
  filters: PlaceFilters
  onChange: (patch: Partial<PlaceFilters>) => void
}) {
  const { language } = useLanguage()
  const [startInput, setStartInput] = useState(filters.timespanStart?.toString() ?? '')
  const [endInput, setEndInput] = useState(filters.timespanEnd?.toString() ?? '')

  useEffect(() => {
    setStartInput(filters.timespanStart?.toString() ?? '')
  }, [filters.timespanStart])

  useEffect(() => {
    setEndInput(filters.timespanEnd?.toString() ?? '')
  }, [filters.timespanEnd])

  const parseYear = (value: string): number | null => {
    if (value === '') return null
    const year = Number(value)
    return Number.isFinite(year) ? Math.trunc(year) : null
  }

  const applyTimespan = () => {
    const timespanStart = parseYear(startInput)
    const timespanEnd = parseYear(endInput)
    if (timespanStart === filters.timespanStart && timespanEnd === filters.timespanEnd) return
    onChange({ timespanStart, timespanEnd })
  }

  return (
    <div className={`filter-field timespan-filter${filters.timespanEnabled ? ' timespan-filter-enabled' : ''}`}>
      <div className="timespan-heading">
        <label>
          <input
            type="checkbox"
            checked={filters.timespanEnabled}
            onChange={(event) => onChange({ timespanEnabled: event.target.checked })}
          />
          {uiText(language, 'Timespan', '时间范围')}
        </label>
        <span className="timespan-help">
          <button type="button" aria-label={uiText(language, 'About the timespan filter', '关于时间范围筛选')} aria-describedby="timespan-help-tooltip">
            <HelpCircle size={15} aria-hidden="true" />
          </button>
          <span id="timespan-help-tooltip" className="timespan-tooltip" role="tooltip">
            <p>Use negative years for BCE.</p>
            <p>Disabled by default because construction date data is available for only about one-third of places.</p>
          </span>
        </span>
      </div>
      <div className="timespan-inputs">
        <input
          type="number"
          step="1"
          value={startInput}
          placeholder={uiText(language, 'From', '起始年份')}
          aria-label={uiText(language, 'Timespan from year', '时间范围起始年份')}
          disabled={!filters.timespanEnabled}
          onChange={(event) => setStartInput(event.target.value)}
          onBlur={applyTimespan}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              applyTimespan()
            }
          }}
        />
        <span aria-hidden="true">–</span>
        <input
          type="number"
          step="1"
          value={endInput}
          placeholder={uiText(language, 'To', '结束年份')}
          aria-label={uiText(language, 'Timespan until year', '时间范围结束年份')}
          disabled={!filters.timespanEnabled}
          onChange={(event) => setEndInput(event.target.value)}
          onBlur={applyTimespan}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              applyTimespan()
            }
          }}
        />
      </div>
    </div>
  )
}

function ExplorePage({ database, stats, installed, manifest, onInstallLatest, onImport, onDelete, progress, updateNote, localMatchesLatest }: ExploreProps) {
  const { language } = useLanguage()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [filters, setFilters] = useState<PlaceFilters>(EMPTY_FILTERS)
  const [searchInput, setSearchInput] = useState('')
  const [page, setPage] = useState(0)
  const [pageInput, setPageInput] = useState('1')
  const [bounds, setBounds] = useState<MapBounds | null>(null)
  const [mapFocusRequest, setMapFocusRequest] = useState<MapFocusRequest | null>(null)
  const mapFocusRequestId = useRef(0)
  const placeListRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => { document.title = uiText(language, 'Wiki Monument Atlas', '维基建筑遗产图谱') }, [language])

  const result = useMemo(() => database.search(filters, page, PAGE_SIZE), [database, filters, page])
  const tagFilterStats = useMemo(() => database.getTagFilterStats(filters), [database, filters])
  const mapPlaces = useMemo(() => bounds ? database.getMapPlaces(filters, bounds) : [], [database, filters, bounds])
  const mapDataKey = JSON.stringify(filters)
  const countryOptions = useMemo(() => tagFilterStats.countries
    .map((option) => ({ ...option, label: localizedCountryLabel(option.value, language) }))
    .sort((left, right) => left.label.localeCompare(right.label, language === 'zh' ? 'zh-CN' : 'en')),
  [tagFilterStats.countries, language])
  const pageCount = Math.max(1, Math.ceil(result.total / PAGE_SIZE))
  const updateAvailable = Boolean(manifest && localMatchesLatest === false)
  const updating = progress.stage !== 'idle'
  const updateButtonLabel = uiText(language, updating ? 'Updating…' : 'Update', updating ? '正在更新…' : '更新')
  const manualDownloadLabel = uiText(language, 'Download manually', '手动下载')
  const importDatasetLabel = uiText(language, 'Import ZIP or SQLite', '导入 ZIP 或 SQLite')
  const deleteLocalDataLabel = uiText(language, 'Delete local data', '删除本地数据')
  const updatePercent = progress.total && progress.received > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : undefined
  const updateProgressLabel = progress.stage === 'downloading'
    ? progress.received > 0 ? 'Downloading update…' : 'Connecting to download…'
    : progress.stage === 'verifying'
      ? 'Verifying update…'
      : progress.stage === 'extracting'
        ? 'Extracting update…'
        : 'Updating local data…'

  useEffect(() => {
    setPageInput(String(page + 1))
    if (placeListRef.current) placeListRef.current.scrollTop = 0
  }, [page, pageCount])

  const updateFilters = (patch: Partial<PlaceFilters>) => {
    setFilters((current) => ({ ...current, ...patch }))
    setPage(0)
  }

  const applySearch = () => {
    if (searchInput === filters.query) return
    updateFilters({ query: searchInput })
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

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) onImport(file)
    event.target.value = ''
  }

  const applyPageJump = () => {
    const requestedPage = Number.parseInt(pageInput, 10)
    const nextPage = Number.isFinite(requestedPage)
      ? Math.min(pageCount, Math.max(1, requestedPage))
      : page + 1
    setPageInput(String(nextPage))
    setPage(nextPage - 1)
  }

  return (
    <main>
      <header className="site-header">
        <div className="site-title-row">
          <div className="site-title-left">
            <h1>{uiText(language, 'Wiki Monument Atlas', '维基建筑遗产图谱')}</h1>
            <a
              className="site-about-link"
              href={articleHref('about-the-atlas')}
            >
              {localizedArticleText('about-the-atlas', language).title}
            </a>
            <a
              className="site-about-link"
              href={articleHref('explore-further')}
            >
              {localizedArticleText('explore-further', language).title}
            </a>
          </div>

          <div className="site-title-right">
            <div className="data-status">
              <div className="data-status-copy">
                <strong>{installed.name}</strong>
                <span>
                  {stats.placeCount.toLocaleString()} places · {formatBytes(installed.bytes)}
                </span>
              </div>

              <div className="data-status-actions">
                {updateAvailable && (
                  <button className="small-button data-status-icon-button" onClick={onInstallLatest} disabled={updating} aria-label={updateButtonLabel} title={updateButtonLabel}>
                    <RefreshCw size={16} aria-hidden="true" />
                  </button>
                )}

                <a className="small-button data-status-icon-button" href={manifest?.datasetUrl ?? DATASET_RELEASES_URL} target="_blank" rel="noreferrer" aria-label={manualDownloadLabel} title={manualDownloadLabel}>
                  <Download size={16} aria-hidden="true" />
                </a>

                <button className="small-button data-status-icon-button" onClick={() => inputRef.current?.click()} disabled={updating} aria-label={importDatasetLabel} title={importDatasetLabel}>
                  <Upload size={16} aria-hidden="true" />
                </button>
                <input ref={inputRef} type="file" accept={ATLAS_FILE_ACCEPT} hidden onChange={chooseFile} />

                <button className="small-button data-status-icon-button" onClick={onDelete} disabled={updating} aria-label={deleteLocalDataLabel} title={deleteLocalDataLabel}>
                  <Trash2 size={16} aria-hidden="true" />
                </button>
              </div>

              {updating && (
                <div className="data-status-progress" role="status" aria-live="polite">
                  <span>{updateProgressLabel}{updatePercent !== undefined ? ` ${updatePercent}%` : ''}</span>
                  <progress
                    aria-label={updateProgressLabel}
                    value={progress.total && progress.received > 0 ? progress.received : undefined}
                    max={progress.total}
                  />
                </div>
              )}
            </div>

            <LanguageToggle />
          </div>
        </div>
      </header>

      <section className="controls" aria-label={uiText(language, 'Place filters', '地点筛选')}>
        <label>{uiText(language, 'Search', '搜索')}<input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} onBlur={applySearch} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applySearch() } }} placeholder={uiText(language, 'Name, country, style, designation…', '名称、国家/地区、风格、遗产认定…')} /></label>
        <TagFilterDropdown filters={filters} stats={{ ...stats, ...tagFilterStats }} onChange={updateFilters} />
        <CountryFilterDropdown filters={filters} options={countryOptions} onChange={updateFilters} />
        <label>{uiText(language, 'Sort', '排序')}<select value={filters.sort} onChange={(event) => updateFilters({ sort: event.target.value as PlaceFilters['sort'] })}><option value="sitelinks">{uiText(language, 'Wikipedia popularity', '维基百科热度')}</option><option value="views">TODO: Wikipedia pageview</option><option value="name">{uiText(language, 'Name', '名称')}</option></select></label>
        <TimespanFilter filters={filters} onChange={updateFilters} />
        <p className="results-summary controls-results-summary" role="status" aria-live="polite">
          {language === 'zh'
            ? `查询到${result.total.toLocaleString()}个地点，其中${result.missingCoordinateCount.toLocaleString()}个地点缺失坐标，未显示在地图上`
            : `Found ${result.total.toLocaleString()} places; ${result.missingCoordinateCount.toLocaleString()} are missing coordinates and are not shown on the map.`}
        </p>
      </section>

      <section className="atlas-layout">
        <MapPanel places={mapPlaces} dataKey={mapDataKey} colorMetric={filters.sort === 'sitelinks' ? 'sitelinks' : 'views'} wikiPopularityLabel={uiText(language, 'Wiki popularity', 'Wiki 热度')} language={language} focusRequest={mapFocusRequest} onOpenPlace={(qid) => { window.location.hash = `/place/${encodeURIComponent(qid)}` }} onViewportChanged={setBounds} />
        <aside className="place-list-panel" aria-label="Heritage place results">
          <div ref={placeListRef} className="place-list">
            {result.items.map((place) => <PlaceCard key={place.qid} place={place} sort={filters.sort} onFocusMap={focusPlaceOnMap} />)}
            {!result.items.length && <p className="notice">No places match these filters.</p>}
          </div>
          {result.total > PAGE_SIZE && <nav className="pagination" aria-label="Results pagination">
            <button onClick={() => setPage((current) => Math.max(0, current - 1))} disabled={page === 0}>← {uiText(language, 'Previous', '上一页')}</button>
            <label className="page-status">{uiText(language, 'Page', '页数')}<input type="number" min="1" max={pageCount} inputMode="numeric" value={pageInput} onChange={(event) => setPageInput(event.target.value)} onBlur={applyPageJump} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); applyPageJump() } }} aria-label="Current page" /> / {pageCount}</label>
            <button onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))} disabled={page + 1 >= pageCount}>{uiText(language, 'Next', '下一页')} →</button>
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
  notice: string
  onDownload: () => void
  onImport: (file: File) => void
}

function Installer({ manifest, current, progress, error, notice, onDownload, onImport }: InstallerProps) {
  const { language } = useLanguage()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const percent = progress.total && progress.received > 0 ? Math.min(100, Math.round((progress.received / progress.total) * 100)) : undefined
  const working = progress.stage !== 'idle'
  const progressLabel = progress.stage === 'downloading'
    ? progress.received > 0 ? uiText(language, 'Downloading atlas...', '正在下载图集...') : uiText(language, 'Connecting to download...', '正在连接下载...')
    : progress.stage === 'extracting'
      ? uiText(language, 'Extracting database...', '正在解压数据库...')
      : progress.stage === 'verifying'
        ? uiText(language, 'Verifying archive...', '正在验证压缩包...')
        : uiText(language, 'Installing local database...', '正在安装本地数据库...')
  const noticeText = notice === 'The dataset is downloading from GitHub Releases. Import the downloaded ZIP here after it finishes.'
    ? uiText(language, 'The dataset is downloading from GitHub Releases. Import the downloaded ZIP here after it finishes.', '数据集正在从 GitHub Releases 下载。下载完成后，请在此导入 ZIP 文件。')
    : notice

  const chooseFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) onImport(file)
    event.target.value = ''
  }

  return (
    <main className="installer-page">
      <section className="installer-card">
        <div className="installer-heading">
          <div>
            <p className="eyebrow">{uiText(language, 'Wiki Monument Atlas', '维基建筑遗产图谱')}</p>
            <h1>{uiText(language, 'Install the dataset', '安装数据集')}</h1>
          </div>
          <LanguageToggle />
        </div>

        <p className="installer-intro">{uiText(language, 'Please download the latest released data from GitHub first, then import the ZIP file. This can both save website bandwidth and improve query performance.', '请先从GitHub下载最新发布的数据，然后导入ZIP文件，这既可以节省网站流量，也可以提高查询性能。')}</p>

        <section className="latest-data-panel" aria-label={uiText(language, 'Newest data details', '最新数据详情')}>
          <div className="latest-data-heading">
            <span>{uiText(language, 'Newest data', '最新数据')}</span>
            {!manifest && <span className="latest-data-loading"><span className="loading-dot" aria-hidden="true" />{uiText(language, 'Loading...', '正在加载...')}</span>}
          </div>
          {manifest
            ? <dl className="dataset-facts">
                <div><dt>{uiText(language, 'Size', '大小')}</dt><dd>{formatBytes(manifest.bytes)}</dd></div>
                <div><dt>{uiText(language, 'Date', '日期')}</dt><dd>{formatAssetDate(manifest.assetDate, language)}</dd></div>
              </dl>
            : <div className="dataset-facts-placeholder" aria-hidden="true" />}
        </section>

        {current && <p className="notice">{uiText(language, `A previous dataset is available locally (${current.name}, ${current.version}), but it could not be opened yet.`, `已有本地数据集（${current.name}，${current.version}），但暂时无法打开。`)}</p>}
        {noticeText && <p className="notice">{noticeText}</p>}
        {error && <p className="notice error">{error}</p>}
        {working && <div className="install-progress"><strong>{progressLabel}</strong><span>{progress.stage === 'downloading' && progress.received === 0 ? uiText(language, 'Waiting for the first bytes...', '正在等待数据...') : <>{formatBytes(progress.received)}{progress.total ? uiText(language, ` of ${formatBytes(progress.total)}`, ` / ${formatBytes(progress.total)}`) : ''}{percent !== undefined ? ` · ${percent}%` : ''}</>}</span><progress value={progress.received > 0 ? progress.received : undefined} max={progress.total ?? Math.max(progress.received, 1)} /></div>}
        <div className="installer-actions">
          <button className="primary-button" onClick={onDownload} disabled={!manifest || working}>{working ? uiText(language, 'Working...', '正在处理...') : uiText(language, 'Download latest ZIP', '下载最新 ZIP')}</button>
          <button onClick={() => inputRef.current?.click()} disabled={working}>{uiText(language, 'Import ZIP or SQLite', '导入 ZIP 或 SQLite')}</button>
          <input ref={inputRef} type="file" accept={ATLAS_FILE_ACCEPT} hidden onChange={chooseFile} />
        </div>
      </section>
    </main>
  )
}

export default function App() {
  const [language, setLanguage] = useState<SiteLanguage>(() => {
    try {
      return localStorage.getItem(LANGUAGE_STORAGE_KEY) === 'zh' ? 'zh' : 'en'
    } catch {
      return 'en'
    }
  })
  const [database, setDatabase] = useState<AtlasDatabase | null>(null)
  const [stats, setStats] = useState<AtlasStats>(EMPTY_STATS)
  const [manifest, setManifest] = useState<AtlasManifest | null>(null)
  const [installed, setInstalled] = useState<StoredAtlasMetadata | null>(null)
  const [progress, setProgress] = useState<InstallProgress>({ stage: 'idle', received: 0 })
  const [error, setError] = useState('')
  const [updateNote, setUpdateNote] = useState('')
  const [localMatchesLatest, setLocalMatchesLatest] = useState<boolean | null>(null)
  const route = useHashRoute()

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
    try {
      localStorage.setItem(LANGUAGE_STORAGE_KEY, language)
    } catch {
      // The language switch still works when browser storage is unavailable.
    }
  }, [language])

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
            if (!active) return
            setInstalled(local.metadata)
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

          try {
            const latestManifest = await loadManifest()
            if (!active) return
            setManifest(latestManifest)
            const localSha256 = local.archiveBytes ? await sha256Hex(local.archiveBytes) : null
            if (!active) return
            const matches = localSha256?.toLowerCase() === latestManifest.sha256.toLowerCase()
            setLocalMatchesLatest(matches)
            setUpdateNote(matches ? '' : 'A newer dataset is available.')
          } catch {
            if (active) setUpdateNote('Could not check for dataset updates. Your local atlas is still available.')
          }
          return
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

  const installBytes = useCallback(async (bytes: Uint8Array, metadata: StoredAtlasMetadata, archiveBytes?: Uint8Array) => {
    setProgress({ stage: 'installing', received: bytes.byteLength, total: bytes.byteLength })
    await openLocalBytes(bytes)
    await saveInstalledAtlas(metadata, bytes, archiveBytes)
    await requestPersistentStorage()
    setInstalled(metadata)
    setLocalMatchesLatest(Boolean(archiveBytes))
    setUpdateNote('')
    setError('')
    setProgress({ stage: 'idle', received: 0 })
  }, [openLocalBytes])

  const downloadLatest = useCallback(() => {
    if (!manifest) return
    try {
      setError('')
      const sourceUrl = new URL(manifest.datasetUrl, new URL(import.meta.env.BASE_URL, window.location.origin)).toString()
      startBrowserDownload(sourceUrl)
      setUpdateNote('The dataset is downloading from GitHub Releases. Import the downloaded ZIP here after it finishes.')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not start the atlas download.')
    }
  }, [manifest])

  const importAtlas = useCallback(async (file: File) => {
    try {
      setError('')
      setUpdateNote('')
      setProgress({ stage: 'downloading', received: 0, total: file.size })
      const fileBytes = new Uint8Array(await file.arrayBuffer())
      if (isZipFile(file)) {
        setProgress({ stage: 'verifying', received: fileBytes.byteLength, total: fileBytes.byteLength })
        const actual = await sha256Hex(fileBytes)
        const matchesLatest = Boolean(manifest && actual.toLowerCase() === manifest.sha256.toLowerCase())
        setProgress({ stage: 'extracting', received: 0 })
        const bytes = await extractSqliteFromZip(fileBytes)
        await installBytes(bytes, {
          version: matchesLatest && manifest ? manifest.version : `manual-${file.lastModified}`,
          name: matchesLatest && manifest ? manifest.name : file.name,
          bytes: bytes.byteLength,
          installedAt: new Date().toISOString(),
          sourceUrl: matchesLatest && manifest ? manifest.datasetUrl : undefined,
          sha256: actual,
        }, fileBytes)
        setLocalMatchesLatest(matchesLatest)
        return
      }
      setProgress({ stage: 'installing', received: fileBytes.byteLength, total: fileBytes.byteLength })
      await installBytes(fileBytes, { version: `manual-${file.lastModified}`, name: file.name, bytes: fileBytes.byteLength, installedAt: new Date().toISOString() })
    } catch (reason) {
      setProgress({ stage: 'idle', received: 0 })
      setError(reason instanceof Error ? reason.message : 'Could not import this file.')
    }
  }, [installBytes, manifest])

  const deleteLocal = useCallback(async () => {
    const shouldDelete = window.confirm('Delete the installed atlas from this browser? You can download it again later.')
    if (!shouldDelete) return
    try {
      setDatabase(null)
      setStats(EMPTY_STATS)
      setInstalled(null)
      setLocalMatchesLatest(null)
      await clearInstalledAtlas()
      window.location.hash = '/'
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not delete local data.')
    }
  }, [database])

  if (!database || !installed) {
    return <LanguageContext.Provider value={{ language, setLanguage }}>
      <Installer manifest={manifest} current={installed} progress={progress} error={error} notice={updateNote} onDownload={downloadLatest} onImport={importAtlas} />
    </LanguageContext.Provider>
  }

  const closePanel = () => { window.location.hash = '/' }

  return <LanguageContext.Provider value={{ language, setLanguage }}>
    <ExplorePage database={database} stats={stats} installed={installed} manifest={manifest} onInstallLatest={downloadLatest} onImport={importAtlas} onDelete={deleteLocal} progress={progress} updateNote={updateNote} localMatchesLatest={localMatchesLatest} />
    {route.kind === 'place' && <PlacePanel database={database} qid={route.qid} onClose={closePanel} />}
    {route.kind === 'article' && <ArticlePanel slug={route.slug} onClose={closePanel} />}
  </LanguageContext.Provider>
}

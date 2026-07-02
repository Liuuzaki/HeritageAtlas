export type Place = {
  qid: string
  labelNative: string
  labelEn?: string
  labelZh?: string
  coordinatesWkt?: string
  latitude?: number
  longitude?: number
  nativeLanguageLabelEn?: string
  countryLabelEn?: string
  designations: string[]
  instanceOf: string[]
  styles: string[]
  inceptionValues: string[]
  nativeWikiViewCount: number
  enWikiViewCount: number
  wikiViewCount?: number
  mapPointCount?: number
  mapAggregate?: boolean
  wikipediaSitelinksCount: number
  sourceRecordUrls: string[]
  nativeWikiUrl?: string
  enWikiUrl?: string
  commonsImageUrls: string[]
  wikicommonsCategory?: string
  officialWebsiteUrls: string[]
}

export type AtlasManifest = {
  version: string
  name: string
  datasetUrl: string
  archiveFormat: 'zip'
  bytes: number
  sha256: string
  recordCount?: number
}

export type StoredAtlasMetadata = {
  version: string
  name: string
  bytes: number
  installedAt: string
  sourceUrl?: string
  sha256?: string
}

export type StoredAtlas = {
  metadata: StoredAtlasMetadata
  bytes: Uint8Array
  archiveBytes?: Uint8Array
  storage: 'opfs' | 'indexeddb'
}

export type PlaceFilters = {
  query: string
  country: string
  instanceOf: string[]
  architecturalStyles: string[]
  timespanEnabled: boolean
  timespanStart: number | null
  timespanEnd: number | null
  sort: 'views' | 'sitelinks' | 'name'
}

export type TagFilterOption = {
  label: string
  qid?: string
  value: string
  count: number
}

export type PlaceSearchPage = {
  total: number
  items: Place[]
}

export type MapBounds = {
  south: number
  west: number
  north: number
  east: number
  zoom: number
  pixelWidth: number
  pixelHeight: number
}

export type AtlasStats = {
  placeCount: number
  countries: string[]
  instanceOf: TagFilterOption[]
  architecturalStyles: TagFilterOption[]
}

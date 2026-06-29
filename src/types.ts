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
  styles: string[]
  inceptionValues: string[]
  nativeWikiViewCount: number
  enWikiViewCount: number
  wikiViewCount?: number
  mapPointCount?: number
  wikipediaSitelinksCount: number
  sourceRecordUrls: string[]
  nativeWikiUrl?: string
  enWikiUrl?: string
  commonsImageUrls: string[]
  officialWebsiteUrls: string[]
  registryName: string
  sourceFields: Record<string, string>
}

export type AtlasManifest = {
  version: string
  name: string
  datasetUrl: string
  bytes?: number
  sha256?: string
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
  storage: 'opfs' | 'indexeddb'
}

export type PlaceFilters = {
  query: string
  country: string
  registry: string
  style: string
  sort: 'views' | 'name'
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
}

export type AtlasStats = {
  placeCount: number
  countries: string[]
  registries: string[]
}

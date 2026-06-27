export type Place = {
  qid: string
  name: string
  nativeName?: string
  country?: string
  city?: string
  latitude: number
  longitude: number
  registry: {
    name: string
    identifier: string
    url?: string
  }
  designations: string[]
  styles: string[]
  thumbnail: {
    primary?: string
    backups?: string[]
    sourcePage?: string
    kind: 'commons' | 'external' | 'generated'
  }
  wikipedia: {
    native?: string
    english?: string
  }
  wikiViewCount?: number
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

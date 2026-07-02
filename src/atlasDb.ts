import { loadSqlJs, type SqlDatabase, type SqlValue } from './sqlite'
import { INDIVIDUAL_MARKER_ZOOM } from './mapConfig'
import type { AtlasStats, MapBounds, Place, PlaceFilters, PlaceSearchPage, TagFilterOption } from './types'

const DELIMITER = '\u001f'
const MAP_AGGREGATE_CELL_SIZE_PX = 72
const MAP_TILE_SIZE_PX = 256
type Row = Record<string, SqlValue | undefined>

function mapBucketCellSize(zoom: number): number {
  return (360 * MAP_AGGREGATE_CELL_SIZE_PX) / (MAP_TILE_SIZE_PX * 2 ** Math.max(0, Math.floor(zoom)))
}

function snapDown(value: number, origin: number, cellSize: number): number {
  return origin + Math.floor((value - origin) / cellSize) * cellSize
}

function snapUp(value: number, origin: number, cellSize: number): number {
  return origin + Math.ceil((value - origin) / cellSize) * cellSize
}

function firstResult(database: SqlDatabase, sql: string, params: SqlValue[] = []): Row[] {
  const result = database.exec(sql, params)[0]
  if (!result) return []
  return result.values.map((values) => Object.fromEntries(result.columns.map((column, index) => [column, values[index]])))
}

function asString(value: SqlValue | undefined): string {
  return typeof value === 'string' ? value : value == null ? '' : String(value)
}

function asNumber(value: SqlValue | undefined): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

function asOptionalNumber(value: SqlValue | undefined): number | undefined {
  if (value == null || value === '') return undefined
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function splitList(value: SqlValue | undefined): string[] {
  return asString(value).split(/\s*\|\s*|\u001f/g).map((item) => item.trim()).filter(Boolean)
}

function tagFilterOptions(rows: Row[], column: string): TagFilterOption[] {
  const options = new Map<string, TagFilterOption>()
  for (const row of rows) {
    for (const value of splitList(row[column])) {
      const match = value.match(/^(.*?)\s*\[\s*(Q\d+)\s*\]\s*$/i)
      const qid = match?.[2]?.toUpperCase()
      const label = (match?.[1] || value).trim()
      if (!label) continue
      const filterValue = qid || label
      const key = filterValue.toLocaleLowerCase()
      if (!options.has(key)) options.set(key, { label, qid, value: filterValue })
    }
  }
  return [...options.values()].sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }))
}

function displayName(row: Row): string {
  return asString(row.label_native) || asString(row.label_en) || asString(row.label_zh) || asString(row.qid)
}

function toPlace(row: Row): Place {
  return {
    qid: asString(row.qid),
    labelNative: displayName(row),
    labelEn: asString(row.label_en) || undefined,
    labelZh: asString(row.label_zh) || undefined,
    coordinatesWkt: asString(row.coordinates_wkt) || undefined,
    latitude: asOptionalNumber(row.latitude),
    longitude: asOptionalNumber(row.longitude),
    nativeLanguageLabelEn: asString(row.native_language_label_en) || undefined,
    countryLabelEn: asString(row.country_label_en) || undefined,
    designations: splitList(row.heritage_designation_labels_native),
    instanceOf: splitList(row.instance_of),
    styles: splitList(row.architectural_style_label_en),
    inceptionValues: splitList(row.inception_values),
    nativeWikiViewCount: asNumber(row.native_wiki_view_count),
    enWikiViewCount: asNumber(row.en_wiki_view_count),
    wikiViewCount: asNumber(row.wiki_view_count) || undefined,
    wikipediaSitelinksCount: asNumber(row.wikipedia_sitelinks_count),
    sourceRecordUrls: splitList(row.source_record_urls),
    nativeWikiUrl: asString(row.nativewiki_url) || undefined,
    enWikiUrl: asString(row.enwiki_url) || undefined,
    commonsImageUrls: splitList(row.commons_image_urls),
    wikicommonsCategory: asString(row.wikicommons_category) || undefined,
    officialWebsiteUrls: splitList(row.official_website_urls),
  }
}

function toMapPlace(row: Row): Place {
  const isMapAggregate = asNumber(row.is_map_aggregate) === 1
  return {
    qid: asString(row.qid),
    labelNative: isMapAggregate ? '' : displayName(row),
    labelEn: asString(row.label_en) || undefined,
    labelZh: asString(row.label_zh) || undefined,
    latitude: asOptionalNumber(row.latitude),
    longitude: asOptionalNumber(row.longitude),
    countryLabelEn: asString(row.country_label_en) || undefined,
    designations: splitList(row.heritage_designation_labels_native),
    instanceOf: splitList(row.instance_of),
    styles: [],
    inceptionValues: [],
    nativeWikiViewCount: 0,
    enWikiViewCount: 0,
    wikiViewCount: asNumber(row.wiki_view_count) || undefined,
    mapPointCount: asNumber(row.map_point_count) || 1,
    mapAggregate: isMapAggregate,
    wikipediaSitelinksCount: asNumber(row.wikipedia_sitelinks_count),
    sourceRecordUrls: [],
    commonsImageUrls: splitList(row.commons_image_urls),
    wikicommonsCategory: asString(row.wikicommons_category) || undefined,
    officialWebsiteUrls: [],
  }
}

function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
}

type WhereClause = { sql: string; params: SqlValue[] }

function filtersToWhere(filters: PlaceFilters, bounds?: MapBounds): WhereClause {
  const where: string[] = []
  const params: SqlValue[] = []
  const query = filters.query.trim()

  if (query) {
    const like = `%${escapeLike(query.toLocaleLowerCase())}%`
    where.push(`(
      lower(COALESCE(p.label_native, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.label_en, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.label_zh, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.country_label_en, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.native_language_label_en, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.heritage_designation_labels_native, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.instance_of, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.architectural_style_label_en, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.inception_values, '')) LIKE ? ESCAPE '\\'
    )`)
    params.push(like, like, like, like, like, like, like, like, like)
  }

  if (filters.country) {
    where.push('p.country_label_en = ?')
    params.push(filters.country)
  }
  const addTagFilters = (column: string, values: string[]) => {
    if (!values.length) return
    const normalizedColumn = `replace(replace(replace(replace(lower(trim(COALESCE(${column}, ''))), ' | ', char(31)), '| ', char(31)), ' |', char(31)), '|', char(31))`
    where.push(`(${values.map((value) => {
      if (/^Q\d+$/i.test(value)) {
        params.push(`%[${escapeLike(value.toLocaleLowerCase())}]%`)
        return `lower(COALESCE(${column}, '')) LIKE ? ESCAPE '\\'`
      }
      params.push(value.toLocaleLowerCase())
      return `instr(char(31) || ${normalizedColumn} || char(31), char(31) || ? || char(31)) > 0`
    }).join(' OR ')})`)
  }
  addTagFilters('p.instance_of', filters.instanceOf)
  addTagFilters('p.architectural_style_label_en', filters.architecturalStyles)
  if (bounds) {
    where.push('p.latitude IS NOT NULL AND p.longitude IS NOT NULL')
    where.push('p.latitude BETWEEN ? AND ?')
    where.push('p.longitude BETWEEN ? AND ?')
    params.push(bounds.south, bounds.north, bounds.west, bounds.east)
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

const FULL_SELECT = `
  SELECT
    p.wikidata_qid AS qid, p.label_native, p.label_en, p.label_zh, p.coordinates_wkt,
    p.latitude, p.longitude, p.native_language_label_en, p.country_label_en,
    p.heritage_designation_labels_native, p.instance_of, p.architectural_style_label_en, p.inception_values,
    p.nativeWikiViewCount AS native_wiki_view_count,
    p.enWikiViewCount AS en_wiki_view_count,
    p.wikiViewCount AS wiki_view_count,
    p.wikipedia_sitelinks_count, p.source_record_urls, p.nativewiki_url, p.enwiki_url,
    p.commons_image_urls, p.wikicommons_category, p.official_website_urls
  FROM places p
`

export class IncompatibleAtlasError extends Error {
  constructor() {
    super('This atlas uses an older database structure.')
    this.name = 'IncompatibleAtlasError'
  }
}

export class AtlasDatabase {
  private constructor(private readonly database: SqlDatabase) {}

  static async open(bytes: Uint8Array): Promise<AtlasDatabase> {
    const SQL = await loadSqlJs()
    const database = new SQL.Database(bytes)
    const columns = firstResult(database, "PRAGMA table_info(places)").map((row) => asString(row.name).toLocaleLowerCase())
    if (!columns.includes('wikidata_qid') || !columns.includes('label_native')) {
      database.close()
      throw new IncompatibleAtlasError()
    }
    if (!columns.includes('wikicommons_category')) {
      database.exec("ALTER TABLE places ADD COLUMN wikicommons_category TEXT")
    }
    if (!columns.includes('instance_of')) {
      database.exec("ALTER TABLE places ADD COLUMN instance_of TEXT")
    }
    return new AtlasDatabase(database)
  }

  close(): void {
    this.database.close()
  }

  getStats(): AtlasStats {
    const count = firstResult(this.database, 'SELECT COUNT(*) AS count FROM places')[0]
    const countries = firstResult(this.database, "SELECT DISTINCT country_label_en AS country FROM places WHERE country_label_en <> '' AND country_label_en IS NOT NULL ORDER BY country_label_en COLLATE NOCASE LIMIT 500").map((row) => asString(row.country))
    const instanceRows = firstResult(this.database, "SELECT DISTINCT instance_of FROM places WHERE instance_of <> '' AND instance_of IS NOT NULL")
    const styleRows = firstResult(this.database, "SELECT DISTINCT architectural_style_label_en FROM places WHERE architectural_style_label_en <> '' AND architectural_style_label_en IS NOT NULL")
    return {
      placeCount: asNumber(count?.count),
      countries,
      instanceOf: tagFilterOptions(instanceRows, 'instance_of'),
      architecturalStyles: tagFilterOptions(styleRows, 'architectural_style_label_en'),
    }
  }

  search(filters: PlaceFilters, page: number, pageSize: number): PlaceSearchPage {
    const where = filtersToWhere(filters)
    const countRow = firstResult(this.database, `SELECT COUNT(*) AS count FROM places p ${where.sql}`, where.params)[0]
    const order = filters.sort === 'name'
      ? "COALESCE(NULLIF(p.label_native, ''), NULLIF(p.label_en, ''), p.wikidata_qid) COLLATE NOCASE ASC"
      : filters.sort === 'sitelinks'
        ? 'p.wikipedia_sitelinks_count DESC, p.label_native COLLATE NOCASE ASC, p.wikidata_qid ASC'
        : 'p.wikiViewCount DESC, p.label_native COLLATE NOCASE ASC, p.wikidata_qid ASC'
    const offset = Math.max(0, page) * pageSize
    const rows = firstResult(
      this.database,
      `${FULL_SELECT} ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...where.params, pageSize, offset],
    )
    return { total: asNumber(countRow?.count), items: rows.map(toPlace) }
  }

  getPlace(qid: string): Place | undefined {
    const row = firstResult(this.database, `${FULL_SELECT} WHERE p.wikidata_qid = ? LIMIT 1`, [qid])[0]
    return row ? toPlace(row) : undefined
  }

  getMapPlaces(filters: PlaceFilters, bounds: MapBounds): Place[] {
    const mapOrderColumn = filters.sort === 'sitelinks' ? 'wikipedia_sitelinks_count' : 'wiki_view_count'

    if (bounds.zoom < INDIVIDUAL_MARKER_ZOOM) {
      // Use one aggregation strategy below the shared threshold, even for
      // small result sets, so isolated places cannot leak through as dots.
      // Anchor buckets to a zoom-level world grid, then load complete cells.
      // Their membership and centroid therefore stay fixed while the viewport
      // pans; only a zoom change selects a different grid resolution.
      const cellSize = Math.max(mapBucketCellSize(bounds.zoom), 0.000_001)
      const bucketBounds: MapBounds = {
        ...bounds,
        west: snapDown(bounds.west, -180, cellSize),
        east: snapUp(bounds.east, -180, cellSize),
        south: snapDown(bounds.south, -90, cellSize),
        north: snapUp(bounds.north, -90, cellSize),
      }
      const where = filtersToWhere(filters, bucketBounds)
      const bucketZoom = Math.max(0, Math.floor(bounds.zoom))
      const rows = firstResult(
        this.database,
        `WITH matched AS (
           SELECT p.latitude, p.longitude, p.wikiViewCount, p.wikipedia_sitelinks_count,
                  CAST((p.longitude + 180.0) / ? AS INTEGER) AS longitude_bucket,
                  CAST((p.latitude + 90.0) / ? AS INTEGER) AS latitude_bucket
           FROM places p ${where.sql}
         )
         SELECT 'map-bucket-${bucketZoom}-' || longitude_bucket || '-' || latitude_bucket AS qid,
                AVG(latitude) AS latitude, AVG(longitude) AS longitude,
                MAX(wikiViewCount) AS wiki_view_count,
                MAX(wikipedia_sitelinks_count) AS wikipedia_sitelinks_count,
                COUNT(*) AS map_point_count,
                1 AS is_map_aggregate,
                '' AS label_native, '' AS country_label_en,
                '' AS heritage_designation_labels_native,
                '' AS instance_of, '' AS commons_image_urls, '' AS wikicommons_category
         FROM matched
         GROUP BY longitude_bucket, latitude_bucket
         ORDER BY ${mapOrderColumn} DESC, qid ASC`,
        [cellSize, cellSize, ...where.params],
      )
      return rows.map(toMapPlace)
    }

    const where = filtersToWhere(filters, bounds)
    const rows = firstResult(
      this.database,
      `SELECT p.wikidata_qid AS qid, p.label_native, p.label_en, p.label_zh,
              p.country_label_en, p.latitude, p.longitude, p.commons_image_urls,
              p.wikicommons_category,
              p.heritage_designation_labels_native, p.instance_of,
              p.wikiViewCount AS wiki_view_count, p.wikipedia_sitelinks_count,
              0 AS is_map_aggregate
       FROM places p ${where.sql}
       ORDER BY p.${filters.sort === 'sitelinks' ? 'wikipedia_sitelinks_count' : 'wikiViewCount'} DESC, p.wikidata_qid ASC`,
      where.params,
    )
    return rows.map(toMapPlace)
  }
}

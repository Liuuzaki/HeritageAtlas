import { loadSqlJs, type SqlDatabase, type SqlValue } from './sqlite'
import { COUNTRY_CLUSTER_MAX_ZOOM, INDIVIDUAL_MARKER_ZOOM } from './mapConfig'
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

function countryClusterCacheKey(filters: PlaceFilters): string {
  return JSON.stringify([
    filters.query.trim(),
    filters.country,
    [...filters.instanceOf].sort(),
    [...filters.architecturalStyles].sort(),
    filters.timespanEnabled,
    filters.timespanStart,
    filters.timespanEnd,
  ])
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

function parseTag(value: string): Omit<TagFilterOption, 'count'> | undefined {
  const match = value.match(/^(.*?)\s*\[\s*(Q\d+)\s*\]\s*$/i)
  const qid = match?.[2]?.toUpperCase()
  const label = (match?.[1] || value).trim()
  if (!label) return undefined
  return { label, qid, value: qid || label }
}

function tagFilterOptions(rows: Row[], column: string): TagFilterOption[] {
  const options = new Map<string, TagFilterOption>()
  for (const row of rows) {
    const placeTags = new Set<string>()
    for (const value of splitList(row[column])) {
      const tag = parseTag(value)
      if (!tag) continue
      const key = tag.value.toLocaleLowerCase()
      if (placeTags.has(key)) continue
      placeTags.add(key)
      const existing = options.get(key)
      if (existing) existing.count += 1
      else options.set(key, { ...tag, count: 1 })
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
    where.push(`p.wikidata_qid IN (
      SELECT place_qid FROM atlas_search_index
      WHERE search_text LIKE ? ESCAPE '\\'
    )`)
    params.push(like)
  }

  if (filters.country) {
    where.push('p.country_label_en = ?')
    params.push(filters.country)
  }
  const addTagFilters = (category: string, values: string[]) => {
    if (!values.length) return
    where.push(`p.wikidata_qid IN (
      SELECT place_qid FROM atlas_tag_index
      WHERE category = ?
        AND value IN (${values.map(() => '?').join(', ')})
    )`)
    params.push(category, ...values.map((value) => value.toLocaleLowerCase()))
  }
  addTagFilters('instance', filters.instanceOf)
  addTagFilters('style', filters.architecturalStyles)
  if (filters.timespanEnabled) {
    where.push("p.inception_values IS NOT NULL AND TRIM(p.inception_values) <> ''")
    if (filters.timespanStart !== null && filters.timespanEnd !== null) {
      const start = Math.min(filters.timespanStart, filters.timespanEnd)
      const end = Math.max(filters.timespanStart, filters.timespanEnd)
      where.push('CAST(p.inception_values AS INTEGER) BETWEEN ? AND ?')
      params.push(start, end)
    } else if (filters.timespanStart !== null) {
      where.push('CAST(p.inception_values AS INTEGER) >= ?')
      params.push(filters.timespanStart)
    } else if (filters.timespanEnd !== null) {
      where.push('CAST(p.inception_values AS INTEGER) <= ?')
      params.push(filters.timespanEnd)
    }
  }
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
  private runtimeIndexesReady = false
  private countryClusterCache: { key: string; places: Place[] } | null = null

  private constructor(private readonly database: SqlDatabase) {}

  private ensureRuntimeIndexes(providedTagRows?: Row[]): Row[] {
    if (this.runtimeIndexesReady) return providedTagRows || []

    const tagRows = providedTagRows || firstResult(
      this.database,
      'SELECT wikidata_qid AS qid, instance_of, architectural_style_label_en FROM places',
    )
    const persistentIndexes = new Set(
      firstResult(
        this.database,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('atlas_search_index', 'atlas_tag_index')",
      ).map((row) => asString(row.name)),
    )
    if (persistentIndexes.has('atlas_search_index') && persistentIndexes.has('atlas_tag_index')) {
      this.runtimeIndexesReady = true
      return tagRows
    }

    this.database.exec(`
      CREATE TEMP TABLE IF NOT EXISTS atlas_search_index (
        place_qid TEXT PRIMARY KEY,
        search_text TEXT NOT NULL
      ) WITHOUT ROWID;
      DELETE FROM atlas_search_index;
      INSERT INTO atlas_search_index (place_qid, search_text)
      SELECT wikidata_qid,
             lower(
               COALESCE(label_native, '') || char(31) ||
               COALESCE(label_en, '') || char(31) ||
               COALESCE(label_zh, '') || char(31) ||
               COALESCE(country_label_en, '') || char(31) ||
               COALESCE(native_language_label_en, '') || char(31) ||
               COALESCE(heritage_designation_labels_native, '') || char(31) ||
               COALESCE(instance_of, '') || char(31) ||
               COALESCE(architectural_style_label_en, '') || char(31) ||
               COALESCE(inception_values, '')
             )
      FROM places;

      CREATE TEMP TABLE IF NOT EXISTS atlas_tag_index (
        category TEXT NOT NULL,
        value TEXT NOT NULL,
        place_qid TEXT NOT NULL,
        PRIMARY KEY (category, value, place_qid)
      ) WITHOUT ROWID;
      DELETE FROM atlas_tag_index;

      WITH RECURSIVE
      source(place_qid, category, rest) AS (
        SELECT wikidata_qid, 'instance', replace(COALESCE(instance_of, ''), '|', char(31)) || char(31)
        FROM places
        UNION ALL
        SELECT wikidata_qid, 'style', replace(COALESCE(architectural_style_label_en, ''), '|', char(31)) || char(31)
        FROM places
      ),
      split(place_qid, category, tag, rest) AS (
        SELECT place_qid, category, '', rest FROM source
        UNION ALL
        SELECT place_qid,
               category,
               trim(substr(rest, 1, instr(rest, char(31)) - 1)),
               substr(rest, instr(rest, char(31)) + 1)
        FROM split
        WHERE rest <> ''
      )
      INSERT OR IGNORE INTO atlas_tag_index (category, value, place_qid)
      SELECT category,
             lower(CASE
               WHEN upper(tag) GLOB '*[[]Q[0-9]*[]]'
               THEN substr(tag, instr(upper(tag), '[Q') + 1, instr(substr(tag, instr(upper(tag), '[Q') + 1), ']') - 1)
               ELSE tag
             END),
             place_qid
      FROM split
      WHERE tag <> '';

      ANALYZE atlas_tag_index;
    `)
    this.runtimeIndexesReady = true
    return tagRows
  }

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
    const inceptionRange = firstResult(
      this.database,
      "SELECT MIN(CAST(inception_values AS INTEGER)) AS minimum, MAX(CAST(inception_values AS INTEGER)) AS maximum FROM places WHERE inception_values IS NOT NULL AND TRIM(inception_values) <> ''",
    )[0]
    const countries = firstResult(this.database, "SELECT DISTINCT country_label_en AS country FROM places WHERE country_label_en <> '' AND country_label_en IS NOT NULL ORDER BY country_label_en COLLATE NOCASE LIMIT 500").map((row) => asString(row.country))
    const tagRows = firstResult(this.database, 'SELECT wikidata_qid AS qid, instance_of, architectural_style_label_en FROM places')
    this.ensureRuntimeIndexes(tagRows)
    return {
      placeCount: asNumber(count?.count),
      countries,
      instanceOf: tagFilterOptions(tagRows, 'instance_of'),
      architecturalStyles: tagFilterOptions(tagRows, 'architectural_style_label_en'),
      inceptionYearMin: asOptionalNumber(inceptionRange?.minimum),
      inceptionYearMax: asOptionalNumber(inceptionRange?.maximum),
    }
  }

  search(filters: PlaceFilters, page: number, pageSize: number): PlaceSearchPage {
    this.ensureRuntimeIndexes()
    const where = filtersToWhere(filters)
    const combinesCountWithRows = Boolean(filters.query.trim())
    const select = combinesCountWithRows
      ? FULL_SELECT.replace('SELECT', 'SELECT COUNT(*) OVER() AS filtered_count,')
      : FULL_SELECT
    const countRow = combinesCountWithRows
      ? undefined
      : firstResult(this.database, `SELECT COUNT(*) AS count FROM places p ${where.sql}`, where.params)[0]
    const order = filters.sort === 'name'
      ? "COALESCE(NULLIF(p.label_native, ''), NULLIF(p.label_en, ''), p.wikidata_qid) COLLATE NOCASE ASC"
      : filters.sort === 'sitelinks'
        ? 'p.wikipedia_sitelinks_count DESC, p.label_native COLLATE NOCASE ASC, p.wikidata_qid ASC'
        : 'p.wikiViewCount DESC, p.label_native COLLATE NOCASE ASC, p.wikidata_qid ASC'
    const offset = Math.max(0, page) * pageSize
    const rows = firstResult(
      this.database,
      `${select} ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...where.params, pageSize, offset],
    )
    const total = combinesCountWithRows ? asNumber(rows[0]?.filtered_count) : asNumber(countRow?.count)
    return { total, items: rows.map(toPlace) }
  }

  getPlace(qid: string): Place | undefined {
    const row = firstResult(this.database, `${FULL_SELECT} WHERE p.wikidata_qid = ? LIMIT 1`, [qid])[0]
    return row ? toPlace(row) : undefined
  }

  getMapPlaces(filters: PlaceFilters, bounds: MapBounds): Place[] {
    this.ensureRuntimeIndexes()
    const mapOrderColumn = filters.sort === 'sitelinks' ? 'wikipedia_sitelinks_count' : 'wiki_view_count'

    if (bounds.zoom <= COUNTRY_CLUSTER_MAX_ZOOM) {
      // Country clusters represent every matching place in that country, so
      // their count and centroid remain stable while the viewport pans. Cache
      // the latest filtered result because bounds do not affect this tier.
      const cacheKey = countryClusterCacheKey(filters)
      if (this.countryClusterCache?.key === cacheKey) return this.countryClusterCache.places

      const where = filtersToWhere(filters)
      const rows = firstResult(
        this.database,
        `WITH matched AS (
           SELECT p.country_label_en, p.latitude, p.longitude,
                  p.wikiViewCount AS wiki_view_count,
                  p.wikipedia_sitelinks_count
           FROM places p ${where.sql}
         )
         SELECT 'map-country-' || country_label_en AS qid,
                AVG(latitude) AS latitude, AVG(longitude) AS longitude,
                MAX(wiki_view_count) AS wiki_view_count,
                MAX(wikipedia_sitelinks_count) AS wikipedia_sitelinks_count,
                COUNT(*) AS map_point_count,
                1 AS is_map_aggregate,
                '' AS label_native, country_label_en,
                '' AS heritage_designation_labels_native,
                '' AS instance_of, '' AS commons_image_urls, '' AS wikicommons_category
         FROM matched
         WHERE latitude IS NOT NULL AND longitude IS NOT NULL
           AND country_label_en IS NOT NULL AND country_label_en <> ''
         GROUP BY country_label_en
         ORDER BY qid ASC`,
        where.params,
      )
      const places = rows.map(toMapPlace)
      this.countryClusterCache = { key: cacheKey, places }
      return places
    }

    if (bounds.zoom < INDIVIDUAL_MARKER_ZOOM) {
      // Medium zooms use fixed world-grid cells. Loading complete snapped
      // cells keeps bucket membership and centroids stable while panning.
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

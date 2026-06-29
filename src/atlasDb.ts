import { loadSqlJs, type SqlDatabase, type SqlValue } from './sqlite'
import type { AtlasStats, MapBounds, Place, PlaceFilters, PlaceSearchPage } from './types'

const DELIMITER = '\u001f'
type Row = Record<string, SqlValue | undefined>

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

function parseSourceFields(value: SqlValue | undefined): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(asString(value) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  } catch {
    return {}
  }
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
    officialWebsiteUrls: splitList(row.official_website_urls),
    registryName: asString(row.registry_name) || 'Unspecified registry',
    sourceFields: parseSourceFields(row.source_fields_json),
  }
}

function toMapPlace(row: Row): Place {
  return {
    qid: asString(row.qid),
    labelNative: displayName(row),
    labelEn: asString(row.label_en) || undefined,
    labelZh: asString(row.label_zh) || undefined,
    latitude: asOptionalNumber(row.latitude),
    longitude: asOptionalNumber(row.longitude),
    countryLabelEn: asString(row.country_label_en) || undefined,
    designations: [],
    styles: [],
    inceptionValues: [],
    nativeWikiViewCount: 0,
    enWikiViewCount: 0,
    wikiViewCount: asNumber(row.wiki_view_count) || undefined,
    mapPointCount: asNumber(row.map_point_count) || 1,
    wikipediaSitelinksCount: 0,
    sourceRecordUrls: [],
    commonsImageUrls: splitList(row.commons_image_urls),
    officialWebsiteUrls: [],
    registryName: asString(row.registry_name) || 'Unspecified registry',
    sourceFields: {},
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
  const style = filters.style.trim()

  if (query) {
    const like = `%${escapeLike(query.toLocaleLowerCase())}%`
    where.push(`(
      lower(COALESCE(p.label_native, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.label_en, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.label_zh, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.country_label_en, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.native_language_label_en, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.heritage_designation_labels_native, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.architectural_style_label_en, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.inception_values, '')) LIKE ? ESCAPE '\\'
    )`)
    params.push(like, like, like, like, like, like, like, like)
  }

  if (filters.country) {
    where.push('p.country_label_en = ?')
    params.push(filters.country)
  }
  if (filters.registry) {
    where.push('p.registry_name = ?')
    params.push(filters.registry)
  }
  if (style) {
    where.push(`lower(COALESCE(p.architectural_style_label_en, '')) LIKE ? ESCAPE '\\'`)
    params.push(`%${escapeLike(style.toLocaleLowerCase())}%`)
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
    p.heritage_designation_labels_native, p.architectural_style_label_en, p.inception_values,
    p.nativeWikiViewCount AS native_wiki_view_count,
    p.enWikiViewCount AS en_wiki_view_count,
    p.wikiViewCount AS wiki_view_count,
    p.wikipedia_sitelinks_count, p.source_record_urls, p.nativewiki_url, p.enwiki_url,
    p.commons_image_urls, p.official_website_urls, p.registry_name, p.source_fields_json
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
    return new AtlasDatabase(database)
  }

  close(): void {
    this.database.close()
  }

  getStats(): AtlasStats {
    const count = firstResult(this.database, 'SELECT COUNT(*) AS count FROM places')[0]
    const countries = firstResult(this.database, "SELECT DISTINCT country_label_en AS country FROM places WHERE country_label_en <> '' AND country_label_en IS NOT NULL ORDER BY country_label_en COLLATE NOCASE LIMIT 500").map((row) => asString(row.country))
    const registries = firstResult(this.database, "SELECT DISTINCT registry_name FROM places WHERE registry_name <> '' AND registry_name IS NOT NULL ORDER BY registry_name COLLATE NOCASE LIMIT 500").map((row) => asString(row.registry_name))
    return { placeCount: asNumber(count?.count), countries, registries }
  }

  search(filters: PlaceFilters, page: number, pageSize: number): PlaceSearchPage {
    const where = filtersToWhere(filters)
    const countRow = firstResult(this.database, `SELECT COUNT(*) AS count FROM places p ${where.sql}`, where.params)[0]
    const order = filters.sort === 'name'
      ? "COALESCE(NULLIF(p.label_native, ''), NULLIF(p.label_en, ''), p.wikidata_qid) COLLATE NOCASE ASC"
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

  getMapPlaces(filters: PlaceFilters, bounds: MapBounds, limit = 2000): Place[] {
    const where = filtersToWhere(filters, bounds)
    const countRow = firstResult(
      this.database,
      `SELECT COUNT(*) AS count FROM places p ${where.sql}`,
      where.params,
    )[0]
    const placeCount = asNumber(countRow?.count)

    if (placeCount > limit) {
      const longitudeCellSize = Math.max((bounds.east - bounds.west) / 36, 0.000_001)
      const latitudeCellSize = Math.max((bounds.north - bounds.south) / 24, 0.000_001)
      const rows = firstResult(
        this.database,
        `WITH matched AS (
           SELECT p.latitude, p.longitude, p.wikiViewCount,
                  CAST((p.longitude - ?) / ? AS INTEGER) AS longitude_bucket,
                  CAST((p.latitude - ?) / ? AS INTEGER) AS latitude_bucket
           FROM places p ${where.sql}
         )
         SELECT 'map-bucket-' || longitude_bucket || '-' || latitude_bucket AS qid,
                AVG(latitude) AS latitude, AVG(longitude) AS longitude,
                MAX(wikiViewCount) AS wiki_view_count, COUNT(*) AS map_point_count,
                '' AS label_native, '' AS country_label_en,
                '' AS registry_name, '' AS commons_image_urls
         FROM matched
         GROUP BY longitude_bucket, latitude_bucket
         ORDER BY wiki_view_count DESC, qid ASC`,
        [bounds.west, longitudeCellSize, bounds.south, latitudeCellSize, ...where.params],
      )
      return rows.map(toMapPlace)
    }

    const rows = firstResult(
      this.database,
      `SELECT p.wikidata_qid AS qid, p.label_native, p.label_en, p.label_zh,
              p.country_label_en, p.latitude, p.longitude, p.registry_name, p.commons_image_urls,
              p.wikiViewCount AS wiki_view_count
       FROM places p ${where.sql}
       ORDER BY p.wikiViewCount DESC, p.wikidata_qid ASC`,
      where.params,
    )
    return rows.map(toMapPlace)
  }
}

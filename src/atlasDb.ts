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

function splitList(value: SqlValue | undefined): string[] {
  return asString(value).split(DELIMITER).map((item) => item.trim()).filter(Boolean)
}

function parseBackups(value: SqlValue | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(asString(value) || '[]')
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function toPlace(row: Row): Place {
  const thumbnailKind = asString(row.thumbnail_kind)
  return {
    qid: asString(row.qid),
    name: asString(row.name),
    nativeName: asString(row.native_name) || undefined,
    country: asString(row.country) || undefined,
    city: asString(row.city) || undefined,
    latitude: asNumber(row.latitude),
    longitude: asNumber(row.longitude),
    registry: {
      name: asString(row.registry_name) || 'Unspecified registry',
      identifier: asString(row.registry_identifier),
      url: asString(row.registry_url) || undefined,
    },
    designations: splitList(row.designations),
    styles: splitList(row.styles),
    thumbnail: {
      primary: asString(row.thumbnail_primary) || undefined,
      backups: parseBackups(row.thumbnail_backups_json),
      sourcePage: asString(row.thumbnail_source_page) || undefined,
      kind: thumbnailKind === 'commons' || thumbnailKind === 'external' ? thumbnailKind : 'generated',
    },
    wikipedia: {
      native: asString(row.wikipedia_native) || undefined,
      english: asString(row.wikipedia_english) || undefined,
    },
    wikiViewCount: asNumber(row.wiki_view_count) || undefined,
  }
}

function toMapPlace(row: Row): Place {
  return {
    qid: asString(row.qid),
    name: asString(row.name),
    nativeName: asString(row.native_name) || undefined,
    country: asString(row.country) || undefined,
    city: asString(row.city) || undefined,
    latitude: asNumber(row.latitude),
    longitude: asNumber(row.longitude),
    registry: { name: asString(row.registry_name) || 'Unspecified registry', identifier: '' },
    designations: [],
    styles: [],
    thumbnail: { kind: 'generated' },
    wikipedia: {},
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
      lower(p.name) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.native_name, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.country, '')) LIKE ? ESCAPE '\\'
      OR lower(COALESCE(p.city, '')) LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM place_styles ps WHERE ps.qid = p.qid AND lower(ps.style) LIKE ? ESCAPE '\\')
      OR EXISTS (SELECT 1 FROM place_designations pd WHERE pd.qid = p.qid AND lower(pd.designation) LIKE ? ESCAPE '\\')
    )`)
    params.push(like, like, like, like, like, like)
  }

  if (filters.country) {
    where.push('p.country = ?')
    params.push(filters.country)
  }

  if (filters.registry) {
    where.push('p.registry_name = ?')
    params.push(filters.registry)
  }

  if (style) {
    where.push(`EXISTS (SELECT 1 FROM place_styles ps WHERE ps.qid = p.qid AND lower(ps.style) LIKE ? ESCAPE '\\')`)
    params.push(`%${escapeLike(style.toLocaleLowerCase())}%`)
  }

  if (bounds) {
    where.push('p.latitude BETWEEN ? AND ?')
    where.push('p.longitude BETWEEN ? AND ?')
    params.push(bounds.south, bounds.north, bounds.west, bounds.east)
  }

  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params }
}

const FULL_SELECT = `
  SELECT
    p.qid, p.name, p.native_name, p.country, p.city, p.latitude, p.longitude,
    p.registry_name, p.registry_identifier, p.registry_url,
    p.thumbnail_primary, p.thumbnail_backups_json, p.thumbnail_source_page, p.thumbnail_kind,
    p.wikipedia_native, p.wikipedia_english, p.wiki_view_count,
    COALESCE((SELECT group_concat(style, char(31)) FROM place_styles ps WHERE ps.qid = p.qid), '') AS styles,
    COALESCE((SELECT group_concat(designation, char(31)) FROM place_designations pd WHERE pd.qid = p.qid), '') AS designations
  FROM places p
`

export class AtlasDatabase {
  private constructor(private readonly database: SqlDatabase) {}

  static async open(bytes: Uint8Array): Promise<AtlasDatabase> {
    const SQL = await loadSqlJs()
    const database = new SQL.Database(bytes)
    const check = firstResult(database, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'places'")
    if (!check.length) {
      database.close()
      throw new Error('This file is not a Heritage Atlas SQLite dataset. It must contain a places table.')
    }
    return new AtlasDatabase(database)
  }

  close(): void {
    this.database.close()
  }

  getStats(): AtlasStats {
    const count = firstResult(this.database, 'SELECT COUNT(*) AS count FROM places')[0]
    const countries = firstResult(this.database, "SELECT DISTINCT country FROM places WHERE country <> '' AND country IS NOT NULL ORDER BY country COLLATE NOCASE LIMIT 500").map((row) => asString(row.country))
    const registries = firstResult(this.database, "SELECT DISTINCT registry_name FROM places WHERE registry_name <> '' AND registry_name IS NOT NULL ORDER BY registry_name COLLATE NOCASE LIMIT 500").map((row) => asString(row.registry_name))
    return { placeCount: asNumber(count?.count), countries, registries }
  }

  search(filters: PlaceFilters, page: number, pageSize: number): PlaceSearchPage {
    const where = filtersToWhere(filters)
    const countRow = firstResult(this.database, `SELECT COUNT(*) AS count FROM places p ${where.sql}`, where.params)[0]
    const order = filters.sort === 'name'
      ? 'p.name COLLATE NOCASE ASC, p.qid ASC'
      : 'p.wiki_view_count DESC, p.name COLLATE NOCASE ASC, p.qid ASC'
    const offset = Math.max(0, page) * pageSize
    const rows = firstResult(
      this.database,
      `${FULL_SELECT} ${where.sql} ORDER BY ${order} LIMIT ? OFFSET ?`,
      [...where.params, pageSize, offset],
    )
    return { total: asNumber(countRow?.count), items: rows.map(toPlace) }
  }

  getPlace(qid: string): Place | undefined {
    const row = firstResult(this.database, `${FULL_SELECT} WHERE p.qid = ? LIMIT 1`, [qid])[0]
    return row ? toPlace(row) : undefined
  }

  getMapPlaces(filters: PlaceFilters, bounds: MapBounds, limit = 2000): Place[] {
    const where = filtersToWhere(filters, bounds)
    const rows = firstResult(
      this.database,
      `SELECT p.qid, p.name, p.native_name, p.country, p.city, p.latitude, p.longitude, p.registry_name
       FROM places p ${where.sql}
       ORDER BY p.wiki_view_count DESC, p.qid ASC
       LIMIT ?`,
      [...where.params, limit],
    )
    return rows.map(toMapPlace)
  }
}

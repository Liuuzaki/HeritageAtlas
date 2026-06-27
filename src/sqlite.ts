/**
 * Minimal type declarations for sql.js, deliberately loaded at runtime.
 * Keeping it out of package.json avoids a new npm dependency for this starter.
 * For a production deployment, you may self-host these two vendor files and
 * change SQL_JS_BASE_URL below.
 */
export type SqlValue = string | number | null | Uint8Array

type SqlResult = {
  columns: string[]
  values: SqlValue[][]
}

export type SqlDatabase = {
  exec(sql: string, params?: SqlValue[]): SqlResult[]
  close(): void
}

export type SqlJsStatic = {
  Database: new (data?: Uint8Array) => SqlDatabase
}

type InitSqlJs = (config: { locateFile: (file: string) => string }) => Promise<SqlJsStatic>

declare global {
  interface Window {
    initSqlJs?: InitSqlJs
  }
}

const SQL_JS_BASE_URL = 'https://cdn.jsdelivr.net/npm/sql.js@1.14.1/dist/'
const SCRIPT_ID = 'heritage-atlas-sqljs'
let sqlPromise: Promise<SqlJsStatic> | undefined

function loadScript(): Promise<void> {
  if (window.initSqlJs) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error('Could not load the local SQLite engine.')), { once: true })
      return
    }

    const script = document.createElement('script')
    script.id = SCRIPT_ID
    script.async = true
    script.src = `${SQL_JS_BASE_URL}sql-wasm.js`
    script.onload = () => resolve()
    script.onerror = () => reject(new Error('Could not load the local SQLite engine.'))
    document.head.appendChild(script)
  })
}

export function loadSqlJs(): Promise<SqlJsStatic> {
  if (!sqlPromise) {
    sqlPromise = (async () => {
      await loadScript()
      if (!window.initSqlJs) {
        throw new Error('The local SQLite engine loaded without its initialization function.')
      }
      return window.initSqlJs({ locateFile: (file) => `${SQL_JS_BASE_URL}${file}` })
    })()
  }
  return sqlPromise
}

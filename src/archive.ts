import { unzip } from 'fflate'

export async function extractSqliteFromZip(archive: Uint8Array): Promise<Uint8Array> {
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    unzip(archive, (error, unzipped) => {
      if (error) reject(error)
      else resolve(unzipped)
    })
  })

  const databases = Object.entries(files).filter(([name]) => /(^|\/)[^/]+\.(sqlite|sqlite3|db)$/i.test(name))
  if (databases.length !== 1) {
    throw new Error(`The atlas archive must contain exactly one SQLite database; found ${databases.length}.`)
  }

  const bytes = databases[0]![1]
  const sqliteHeader = new TextDecoder().decode(bytes.subarray(0, 16))
  if (sqliteHeader !== 'SQLite format 3\0') {
    throw new Error('The database extracted from the atlas archive is not a valid SQLite file.')
  }
  return bytes
}

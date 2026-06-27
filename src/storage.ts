import type { StoredAtlas, StoredAtlasMetadata } from './types'

const OPFS_DB_FILE = 'heritage-atlas.sqlite'
const OPFS_META_FILE = 'heritage-atlas-meta.json'
const IDB_NAME = 'heritage-atlas-local-data'
const IDB_STORE = 'datasets'
const IDB_KEY = 'current'

type StorageWithOpfs = StorageManager & {
  getDirectory?: () => Promise<FileSystemDirectoryHandle>
}

type IndexedRecord = {
  metadata: StoredAtlasMetadata
  bytes: ArrayBuffer
}

function getOpfs(): Promise<FileSystemDirectoryHandle> | null {
  const storage = navigator.storage as StorageWithOpfs
  return typeof storage.getDirectory === 'function' ? storage.getDirectory() : null
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(buffer).set(bytes)
  return buffer
}

function openIndexedDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(IDB_STORE)) {
        request.result.createObjectStore(IDB_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open browser storage.'))
  })
}

async function readIndexedDb(): Promise<StoredAtlas | null> {
  const database = await openIndexedDb()
  try {
    return await new Promise<StoredAtlas | null>((resolve, reject) => {
      const transaction = database.transaction(IDB_STORE, 'readonly')
      const request = transaction.objectStore(IDB_STORE).get(IDB_KEY)
      request.onsuccess = () => {
        const record = request.result as IndexedRecord | undefined
        if (!record) {
          resolve(null)
          return
        }
        resolve({
          metadata: record.metadata,
          bytes: new Uint8Array(record.bytes),
          storage: 'indexeddb',
        })
      }
      request.onerror = () => reject(request.error ?? new Error('Could not read browser storage.'))
    })
  } finally {
    database.close()
  }
}

async function writeIndexedDb(metadata: StoredAtlasMetadata, bytes: Uint8Array): Promise<void> {
  const database = await openIndexedDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(IDB_STORE, 'readwrite')
      transaction.objectStore(IDB_STORE).put({ metadata, bytes: copyToArrayBuffer(bytes) } satisfies IndexedRecord, IDB_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save browser storage.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Saving browser storage was aborted.'))
    })
  } finally {
    database.close()
  }
}

async function clearIndexedDb(): Promise<void> {
  const database = await openIndexedDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(IDB_STORE, 'readwrite')
      transaction.objectStore(IDB_STORE).delete(IDB_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not clear browser storage.'))
    })
  } finally {
    database.close()
  }
}

async function readOpfs(root: FileSystemDirectoryHandle): Promise<StoredAtlas | null> {
  try {
    const metaHandle = await root.getFileHandle(OPFS_META_FILE)
    const dbHandle = await root.getFileHandle(OPFS_DB_FILE)
    const metadata = JSON.parse(await (await metaHandle.getFile()).text()) as StoredAtlasMetadata
    const bytes = new Uint8Array(await (await dbHandle.getFile()).arrayBuffer())
    if (!metadata.version || !metadata.name || bytes.byteLength === 0) return null
    return { metadata, bytes, storage: 'opfs' }
  } catch {
    return null
  }
}

async function writeOpfs(root: FileSystemDirectoryHandle, metadata: StoredAtlasMetadata, bytes: Uint8Array): Promise<void> {
  const dbHandle = await root.getFileHandle(OPFS_DB_FILE, { create: true })
  const dbWriter = await dbHandle.createWritable()
  await dbWriter.write(copyToArrayBuffer(bytes))
  await dbWriter.close()

  const metaHandle = await root.getFileHandle(OPFS_META_FILE, { create: true })
  const metaWriter = await metaHandle.createWritable()
  await metaWriter.write(JSON.stringify(metadata))
  await metaWriter.close()
}

export async function readInstalledAtlas(): Promise<StoredAtlas | null> {
  const opfs = getOpfs()
  if (opfs) {
    try {
      const stored = await readOpfs(await opfs)
      if (stored) return stored
    } catch {
      // Fall back to IndexedDB when OPFS is unavailable or blocked.
    }
  }
  return readIndexedDb()
}

export async function saveInstalledAtlas(metadata: StoredAtlasMetadata, bytes: Uint8Array): Promise<'opfs' | 'indexeddb'> {
  const opfs = getOpfs()
  if (opfs) {
    try {
      await writeOpfs(await opfs, metadata, bytes)
      return 'opfs'
    } catch {
      // The same dataset is saved to IndexedDB below.
    }
  }
  await writeIndexedDb(metadata, bytes)
  return 'indexeddb'
}

export async function clearInstalledAtlas(): Promise<void> {
  const opfs = getOpfs()
  if (opfs) {
    try {
      const root = await opfs
      await Promise.all([
        root.removeEntry(OPFS_DB_FILE).catch(() => undefined),
        root.removeEntry(OPFS_META_FILE).catch(() => undefined),
      ])
    } catch {
      // Clear IndexedDB as well; no action needed here.
    }
  }
  await clearIndexedDb()
}

export async function requestPersistentStorage(): Promise<boolean | null> {
  if (typeof navigator.storage.persist !== 'function') return null
  try {
    return await navigator.storage.persist()
  } catch {
    return null
  }
}

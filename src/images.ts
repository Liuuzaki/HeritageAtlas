const COMMONS_HOST = 'commons.wikimedia.org'
const SPECIAL_FILE_PATH = '/wiki/Special:FilePath/'

function commonsUrl(source: string): URL | undefined {
  try {
    const url = new URL(source)
    if (url.hostname.toLocaleLowerCase() !== COMMONS_HOST || !url.pathname.includes(SPECIAL_FILE_PATH)) {
      return undefined
    }
    return url
  } catch {
    return undefined
  }
}

export function thumbnailImageUrl(source: string, width = 240): string {
  const url = commonsUrl(source)
  if (!url) return source
  url.searchParams.set('width', String(width))
  return url.toString()
}

export function fullResolutionImageUrl(source: string): string {
  const url = commonsUrl(source)
  if (!url) return source
  url.searchParams.delete('width')
  return url.toString()
}

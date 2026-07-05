import type { SiteLanguage } from './types'

export type CountryClusterContent = {
  country: string
  markdown?: string
  /** Coordinates make this entry appear when the atlas has no records for it. */
  placeholderCoordinates?: {
    latitude: number
    longitude: number
  }
}

/**
 * Customize country cards here. Add placeholderCoordinates to create an empty
 * country cluster; omit them to customize an existing cluster only.
 */
export const COUNTRY_CLUSTER_CONTENT: CountryClusterContent[] = [
  {
    country: 'Hungary',
    placeholderCoordinates: { latitude: 47.1625, longitude: 19.5033 },
  },
  {
    country: 'Turkey',
    placeholderCoordinates: { latitude: 38.9637, longitude: 35.2433 },
  },
]

export function countryClusterKey(country: string): string {
  const key = country
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  return key === 'turkiye' ? 'turkey' : key
}

const CONTENT_BY_COUNTRY = new Map(
  COUNTRY_CLUSTER_CONTENT.map((content) => [countryClusterKey(content.country), content]),
)

const COUNTRY_MARKDOWN_MODULES = import.meta.glob<string>('./content/countries/*.{en,zh}.md', {
  eager: true,
  query: '?raw',
  import: 'default',
})

const MARKDOWN_BY_COUNTRY = new Map<string, Partial<Record<SiteLanguage, string>>>()
for (const [path, markdown] of Object.entries(COUNTRY_MARKDOWN_MODULES)) {
  const filename = path.split('/').at(-1) ?? ''
  const match = filename.match(/^(.*)\.(en|zh)\.md$/i)
  if (!match?.[1] || !match[2]) continue
  const key = countryClusterKey(match[1])
  const language = match[2].toLocaleLowerCase() as SiteLanguage
  const translations = MARKDOWN_BY_COUNTRY.get(key) ?? {}
  translations[language] = markdown
  MARKDOWN_BY_COUNTRY.set(key, translations)
}

export function countryClusterContent(country: string, language: SiteLanguage): CountryClusterContent | undefined {
  const key = countryClusterKey(country)
  const configured = CONTENT_BY_COUNTRY.get(key)
  const markdown = MARKDOWN_BY_COUNTRY.get(key)?.[language]
  if (!configured && markdown === undefined) return undefined
  return {
    country: configured?.country ?? country,
    ...configured,
    markdown,
  }
}

import type { SiteLanguage } from './types'
import countryMarkdownEn from './content/countries.en.md?raw'
import countryMarkdownZh from './content/countries.zh.md?raw'

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
  // {
  //   country: 'Hungary',
  //   placeholderCoordinates: { latitude: 47.1625, longitude: 19.5033 },
  // },
  // {
  //   country: 'Turkey',
  //   placeholderCoordinates: { latitude: 38.9637, longitude: 35.2433 },
  // },
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

const MARKDOWN_BY_COUNTRY = new Map<string, Partial<Record<SiteLanguage, string>>>()

function loadCountryMarkdown(source: string, language: SiteLanguage): void {
  let country = ''
  let body: string[] = []

  const saveSection = () => {
    if (!country) return
    const key = countryClusterKey(country)
    const translations = MARKDOWN_BY_COUNTRY.get(key) ?? {}
    translations[language] = body.join('\n').trim()
    MARKDOWN_BY_COUNTRY.set(key, translations)
  }

  for (const line of source.replace(/\r\n/g, '\n').split('\n')) {
    const countryHeading = line.match(/^##\s+(.+?)\s*$/)
    if (countryHeading?.[1]) {
      saveSection()
      country = countryHeading[1]
      body = []
      continue
    }

    if (country) body.push(line)
  }
  saveSection()
}

loadCountryMarkdown(countryMarkdownEn, 'en')
loadCountryMarkdown(countryMarkdownZh, 'zh')

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

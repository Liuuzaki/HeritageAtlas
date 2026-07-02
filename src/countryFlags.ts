export interface CountryFlag {
  code: string
  name: string
}

const normalizeCountryName = (value: string) => value
  .normalize('NFKD')
  .replace(/\p{Diacritic}/gu, '')
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .trim()
  .replace(/^the /, '')

const COUNTRY_ALIASES: Record<string, string> = {
  'france': 'FR',
  'united kingdom': 'GB',
  'czech republic': 'CZ',
  'united states of america': 'US',
  'united states': 'US',
}

function buildCountryCodes() {
  const codes = new Map<string, string>()
  if (typeof Intl.DisplayNames !== 'function') return codes

  const names = new Intl.DisplayNames(['en'], { type: 'region' })
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = String.fromCharCode(first, second)
      const name = names.of(code)
      if (name && name !== code && name !== 'Unknown Region') {
        codes.set(normalizeCountryName(name), code)
      }
    }
  }

  for (const [name, code] of Object.entries(COUNTRY_ALIASES)) codes.set(name, code)
  return codes
}

const COUNTRY_CODES = buildCountryCodes()

export function countryFlags(countryLabel?: string): CountryFlag[] {
  if (!countryLabel) return []

  const seen = new Set<string>()
  const flags: CountryFlag[] = []
  for (const name of countryLabel.split(/\s*\|\s*|\s*;\s*/)) {
    const code = COUNTRY_CODES.get(normalizeCountryName(name))
    if (!code || seen.has(code)) continue
    seen.add(code)
    flags.push({ code, name })
  }
  return flags
}

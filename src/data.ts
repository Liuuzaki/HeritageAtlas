export function formatViews(value?: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value ?? 0)
}

export function formatBytes(value?: number): string {
  if (!value) return 'Unknown size'
  const units = ['B', 'KB', 'MB', 'GB']
  let amount = value
  let unit = 0
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024
    unit += 1
  }
  return `${amount.toFixed(amount >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`
}

export function formatInception(value: string, language: 'en' | 'zh' = 'en'): string {
  const match = value.match(/^([+-]?)(\d+)$/)
  if (!match) return value

  const year = Number(match[2])
  if (!Number.isSafeInteger(year)) return value
  if (match[1] === '-') return language === 'zh' ? `公元前${year}年` : `${year} BCE`
  return language === 'zh' ? `${year}年` : `${year} CE`
}

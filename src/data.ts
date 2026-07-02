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

export function formatInception(value: string): string {
  if (value.startsWith('+')) return value.slice(1)
  if (value.startsWith('-')) return `${value.slice(1)} BC`
  return value
}

/**
 * How a deal's money reads, everywhere it is shown (board card, list cell,
 * contact and company panels, tool results). Client-safe.
 */

/** "$12,500", "€3,000", "12,500 CHF"; '' for no value. Whole amounts drop the cents. */
export function formatDealValue(value: number | string | null | undefined, currency: string | null | undefined = 'USD'): string {
  if (value === null || value === undefined || value === '') return ''
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return ''
  const code = (currency || 'USD').toUpperCase()
  const whole = Number.isInteger(n)
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(n)
  } catch {
    return `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${code}`
  }
}

/** Totals per currency, largest first: "$40,000 + €3,000". */
export function formatDealTotals(deals: ReadonlyArray<{ value: number | string | null; currency: string | null }>): string {
  const totals = new Map<string, number>()
  for (const d of deals) {
    const n = d.value === null ? NaN : Number(d.value)
    if (!Number.isFinite(n)) continue
    const code = (d.currency || 'USD').toUpperCase()
    totals.set(code, (totals.get(code) ?? 0) + n)
  }
  return [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([code, total]) => formatDealValue(Math.round(total * 100) / 100, code))
    .join(' + ')
}

export function count(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? 'Unknown' : value.toLocaleString('en-US')
}
export function usd(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'Unknown'
  if (value > 0 && value < 0.0001) return '<$0.0001'
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 4 : 2 }).format(value)
}
export function duration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return 'Unknown'
  return value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(value >= 10_000 ? 1 : 2)} s`
}
export function fraction(numerator: number, denominator: number): string {
  return denominator > 0 ? `${count(numerator)} / ${count(denominator)} (${Math.round(numerator / denominator * 100)}%)` : 'Unknown — no samples'
}
export function decisionLabel(kind: string): string {
  return ({ 'browser.next_action': 'Browser', 'email.reply_required': 'Email replies',
    'knowledge.extraction_required': 'Knowledge extraction', 'knowledge.anchor': 'Knowledge anchors',
    'knowledge.relationship': 'Knowledge relationships', 'retrieval.relevance': 'Retrieval',
    'automation.reconcile_required': 'Automation', 'email.trust': 'Email trust',
    'action.review': 'Action review', 'nudge.worth': 'Nudge worth' } as Record<string, string>)[kind] ?? kind
}

import { CHAT_MODELS, usageProviderLabel } from '@/lib/ai/models'
import type { UsageReportRow } from './types'

// Feature and JSON metadata alone are not provenance: the ledger still holds
// client-reported rows (provider claude-code-local, from the retired local
// Claude Code pipeline's /api/ai/usage). Restrict both the database query and
// aggregation to the actual server meter sources.
export const DECISION_USAGE_PROVIDER = 'typesafe-ai'
export const PARENT_USAGE_FEATURE = 'ai_chat'
export const PARENT_USAGE_PROVIDERS = [...new Set(CHAT_MODELS.map(model => usageProviderLabel(model.id)))]

export function isDecisionUsage(row: UsageReportRow): boolean {
  return row.provider === DECISION_USAGE_PROVIDER && row.feature.startsWith('decision.')
}
export function isParentUsage(row: UsageReportRow): boolean {
  return row.feature === PARENT_USAGE_FEATURE && PARENT_USAGE_PROVIDERS.includes(row.provider)
}

export const FIELD_TEXT_USAGE_FEATURE = 'browser.field_text'
export function isFieldTextUsage(row: UsageReportRow): boolean {
  return row.feature === FIELD_TEXT_USAGE_FEATURE && PARENT_USAGE_PROVIDERS.includes(row.provider)
}

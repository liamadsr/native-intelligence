/**
 * Open one table from outside the Tables page (a doc's embed, phase 6): the
 * Tables page card, on that table (a data_table place, phase 5).
 *
 * Client-safe.
 */
import { openCard } from '@/lib/chat-cards/open-card'
import type { PageCardSpec } from '@/lib/chat-cards/pages'

export function openTable(tableId: string, name?: string): boolean {
  const label = name?.trim() || undefined
  const spec: PageCardSpec = { kind: 'tables', title: label ?? 'Tables', target: { type: 'data_table', id: tableId, ...(label ? { label } : {}) } }
  return openCard(spec, { from: 'doc' })
}

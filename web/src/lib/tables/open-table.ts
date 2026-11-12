/**
 * Open one table from outside the Tables page (a doc's embed, phase 6): the
 * Tables page card, on that table where the card can name one (pages in the
 * chat: `target` a data_table place), else on the list of tables.
 *
 * Client-safe.
 */
import { openCard } from '@/lib/chat-cards/open-card'
import type { CardSpec } from '@/lib/chat-cards/kinds'

export function openTable(tableId: string, name?: string): boolean {
  const title = name?.trim() || 'Tables'
  const onTable = { kind: 'tables', title, target: { type: 'data_table', id: tableId, ...(name ? { label: name } : {}) } } as unknown as CardSpec
  if (openCard(onTable, { from: 'doc' })) return true
  return openCard({ kind: 'tables', title: 'Tables' } as CardSpec, { from: 'doc' })
}

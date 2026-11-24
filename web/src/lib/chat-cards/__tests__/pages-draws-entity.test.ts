/**
 * Canvases, Spreadsheets and Tables draw a views list at their top level
 * (docs/plans/views-everywhere.md), but `show` and read_card keep reading
 * them the page's own fenced way: those reads run as the service role, where
 * RLS doesn't hide another member's private canvas, table or workbook, and the
 * generic list read would (page-server.ts readPageRows, runPageList).
 */
import { describe, expect, it } from 'vitest'
import { pageEntities, pageListEntity, type PageKind } from '@/lib/chat-cards/pages'

const DRIVE: Array<[PageKind, string]> = [
  ['canvases', 'canvas'],
  ['spreadsheets', 'spreadsheet'],
  ['tables', 'data_table'],
]

describe('the Drive pages’ lists', () => {
  it.each(DRIVE)('%s: its card list reports as the page’s own (%s)', (kind, entity) => {
    expect(pageEntities(kind).has(entity as never)).toBe(true)
  })

  it.each(DRIVE)('%s: the server never re-runs it as a generic list', (kind) => {
    expect(pageListEntity(kind, null, undefined)).toBeNull()
  })
})

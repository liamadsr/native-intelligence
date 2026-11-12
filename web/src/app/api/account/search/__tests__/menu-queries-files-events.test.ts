/**
 * The composer search's files and calendar events (../menu-queries.ts):
 *  - files match by name, each kept only if the caller may read it (the
 *    attachments rule, src/lib/attachments/visibility.ts): a teammate's file
 *    on their private capture never shows; nothing typed lists the caller's
 *    own recent uploads; a file's row says the record it hangs off;
 *  - events are the caller's own only, by title; nothing typed lists what's
 *    on from today, soonest first.
 * Fixtures are made up.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { MENU_QUERIES, type MenuQueryContext } from '../menu-queries'
import type { MenuSearchRow } from '@/lib/search/menu-search'

const WS = '11111111-1111-4111-8111-111111111111'
const ANA = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const BEN = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const BEN_PRIVATE = 'c0000000-0000-4000-8000-000000000002'
const TASK = 'a0000000-0000-4000-8000-000000000001'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>

const hours = (n: number) => new Date(Date.now() + n * 3600_000).toISOString()

beforeEach(() => {
  tables = {
    member: [{ id: 'm-ana', user_id: ANA, workspace_id: WS }],
    captures: [{ id: BEN_PRIVATE, workspace_id: WS, visibility: 'private', user_id: BEN, is_eval: false }],
    attachments: [
      { id: 'f-menu', workspace_id: WS, user_id: BEN, note_id: null, action_id: TASK, project_id: null, file_name: 'Harbor menu.pdf', file_category: 'document', created_at: '2026-11-01T10:00:00Z' },
      { id: 'f-salary', workspace_id: WS, user_id: BEN, note_id: BEN_PRIVATE, action_id: null, project_id: null, file_name: 'menu salaries.xlsx', file_category: 'document', created_at: '2026-11-02T10:00:00Z' },
      { id: 'f-mine', workspace_id: WS, user_id: ANA, note_id: BEN_PRIVATE, action_id: null, project_id: null, file_name: 'my menu photo.png', file_category: 'image', created_at: '2026-11-03T10:00:00Z' },
    ],
    local_calendar_event: [
      { id: 'e-past', workspace_id: WS, user_id: ANA, title: 'Harbor tasting', start_at: hours(-72), end_at: hours(-71), is_all_day: false },
      { id: 'e-soon', workspace_id: WS, user_id: ANA, title: 'Harbor call', start_at: hours(2), end_at: hours(3), is_all_day: false },
      { id: 'e-later', workspace_id: WS, user_id: ANA, title: 'Board day', start_at: hours(48), end_at: hours(72), is_all_day: true },
      { id: 'e-ben', workspace_id: WS, user_id: BEN, title: 'Harbor dentist', start_at: hours(1), end_at: hours(2), is_all_day: false },
    ],
  }
})

function ctx(query: string): MenuQueryContext {
  const db = memoryDb(tables)
  return { supabase: db, service: db as SupabaseClient, workspaceId: WS, userId: ANA, query, limit: 8, excludedRecipeIds: [] }
}

const ids = (rows: MenuSearchRow[]) => rows.map((r) => ('id' in r ? r.id : '')).sort()

describe('files', () => {
  it('match by name, only those the caller may read', async () => {
    const rows = await MENU_QUERIES.attachment(ctx('menu'))
    expect(ids(rows)).toEqual(['f-menu', 'f-mine'])
  })

  it('say the record they hang off', async () => {
    const [row] = await MENU_QUERIES.attachment(ctx('harbor'))
    expect(row).toMatchObject({ kind: 'attachment', id: 'f-menu', title: 'Harbor menu.pdf', parent: { type: 'action', id: TASK } })
  })

  it('nothing typed: the caller’s own uploads', async () => {
    expect(ids(await MENU_QUERIES.attachment(ctx('')))).toEqual(['f-mine'])
  })
})

describe('calendar events', () => {
  it('are the caller’s own, by title', async () => {
    expect(ids(await MENU_QUERIES.calendar_event(ctx('harbor')))).toEqual(['e-past', 'e-soon'])
  })

  it('nothing typed: what’s on from today, soonest first', async () => {
    const rows = await MENU_QUERIES.calendar_event(ctx(''))
    expect(rows.map((r) => ('id' in r ? r.id : ''))).toEqual(['e-soon', 'e-later'])
    expect(rows[1]).toMatchObject({ kind: 'calendar_event', allDay: true })
  })
})

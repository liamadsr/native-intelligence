/**
 * The search's kinds found by a name (../menu-queries.ts, "mentions
 * everywhere"): campaigns, sequences, prospect lists, tables and their rows,
 * channels, decisions, teams and knowledge packages.
 *  - each matches its name, in the caller's workspace only, best match first;
 *  - what is archived (or a dismissed decision, a DM, a pipeline) stays out;
 *  - a row says its table and a decision its capture, and each opens there.
 * The in-memory database knows no joins, so a joined parent's columns are
 * seeded as the flat keys the filters name (`data_table.table_kind`).
 * Fixtures are made up.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { MENU_QUERIES, type MenuQueryContext } from '../menu-queries'
import { menuRowTarget, type MenuSearchRow } from '@/lib/search/menu-search'

const WS = '11111111-1111-4111-8111-111111111111'
const OTHER = '11111111-1111-4111-8111-999999999999'
const ANA = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const at = (day: number) => `2026-11-${String(day).padStart(2, '0')}T10:00:00Z`

type Row = Record<string, unknown>
let tables: Record<string, Row[]>

beforeEach(() => {
  tables = {
    campaign: [
      { id: 'c-spring', workspace_id: WS, name: 'Harbor spring push', status: 'active', updated_at: at(3) },
      { id: 'c-old', workspace_id: WS, name: 'Harbor winter push', status: 'archived', updated_at: at(4) },
      { id: 'c-other', workspace_id: OTHER, name: 'Harbor elsewhere', status: 'active', updated_at: at(5) },
    ],
    sequence: [
      { id: 's-welcome', workspace_id: WS, name: 'Welcome to Harbor', status: 'draft', updated_at: at(1) },
      { id: 's-harbor', workspace_id: WS, name: 'Harbor', status: 'active', updated_at: at(2) },
    ],
    prospect_list: [{ id: 'p-cafes', workspace_id: WS, name: 'Harbor cafes', status: 'active', updated_at: at(1) }],
    data_table: [
      { id: 't-vendors', workspace_id: WS, name: 'Harbor vendors', visibility: 'private', table_kind: 'table', archived_at: null, updated_at: at(2) },
      { id: 't-deals', workspace_id: WS, name: 'Harbor pipeline', visibility: 'workspace', table_kind: 'pipeline', archived_at: null, updated_at: at(3) },
      { id: 't-gone', workspace_id: WS, name: 'Harbor archive', visibility: 'workspace', table_kind: 'table', archived_at: at(1), updated_at: at(1) },
    ],
    data_row: [
      { id: 'r-bakery', workspace_id: WS, title: 'Harbor bakery', table_id: 't-vendors', archived_at: null, updated_at: at(2), data_table: { name: 'Harbor vendors' }, 'data_table.table_kind': 'table', 'data_table.archived_at': null },
      { id: 'r-deal', workspace_id: WS, title: 'Harbor renewal', table_id: 't-deals', archived_at: null, updated_at: at(3), data_table: { name: 'Harbor pipeline' }, 'data_table.table_kind': 'pipeline', 'data_table.archived_at': null },
    ],
    team_chat_channel: [
      { id: 'ch-launch', workspace_id: WS, kind: 'channel', name: 'harbor-launch', topic: 'The spring launch', archived_at: null, last_message_at: at(2) },
      { id: 'ch-dm', workspace_id: WS, kind: 'dm', name: null, topic: null, archived_at: null, last_message_at: at(3) },
      { id: 'ch-gone', workspace_id: WS, kind: 'channel', name: 'harbor-old', topic: null, archived_at: at(1), last_message_at: at(1) },
    ],
    decision: [
      { id: 'd-price', content: 'Hold the Harbor price until June', capture_id: 'cap-1', confirmation: 'confirmed', created_at: at(2), captures: { title: 'Pricing sync' }, 'captures.workspace_id': WS, 'captures.status': 'processed' },
      { id: 'd-no', content: 'Drop the Harbor trial', capture_id: 'cap-1', confirmation: 'dismissed', created_at: at(3), captures: { title: 'Pricing sync' }, 'captures.workspace_id': WS, 'captures.status': 'processed' },
      { id: 'd-other', content: 'Harbor elsewhere', capture_id: 'cap-9', confirmation: 'confirmed', created_at: at(4), captures: { title: 'Elsewhere' }, 'captures.workspace_id': OTHER, 'captures.status': 'processed' },
    ],
    team: [
      { id: 'tm-harbor', workspace_id: WS, name: 'Harbor crew', is_private: true, updated_at: at(1) },
      { id: 'tm-gen', workspace_id: WS, name: 'General', is_private: false, updated_at: at(2) },
    ],
    knowledge_package: [{ id: 'k-brand', workspace_id: WS, name: 'Harbor brand voice', description: 'How we write', updated_at: at(1) }],
    // Agent chats are the caller's OWN (user_id); an untitled one and a teammate's stay out.
    chat_conversations: [
      { id: 'cv-harbor', workspace_id: WS, user_id: ANA, title: 'Harbor launch plan', updated_at: at(3) },
      { id: 'cv-blank', workspace_id: WS, user_id: ANA, title: '', updated_at: at(4) },
      { id: 'cv-other', workspace_id: WS, user_id: OTHER, title: 'Harbor theirs', updated_at: at(5) },
    ],
    // Mail is the caller's OWN (user_id); the trash and a teammate's stay out. No subject is stored.
    email_thread_index: [
      { id: 'em-ana', workspace_id: WS, user_id: ANA, from_email: 'maya@harbor.test', participant_emails: ['maya@harbor.test', 'ana@acme.test'], provider_thread_id: 'thr-1', folder: 'inbox', last_message_at: at(3) },
      { id: 'em-trash', workspace_id: WS, user_id: ANA, from_email: 'maya@harbor.test', participant_emails: [], provider_thread_id: 'thr-2', folder: 'trash', last_message_at: at(4) },
      { id: 'em-other', workspace_id: WS, user_id: OTHER, from_email: 'maya@harbor.test', participant_emails: [], provider_thread_id: 'thr-3', folder: 'inbox', last_message_at: at(5) },
    ],
  }
})

function ctx(query: string): MenuQueryContext {
  const db = memoryDb(tables)
  return { supabase: db, service: db as SupabaseClient, workspaceId: WS, userId: ANA, query, limit: 8, excludedRecipeIds: [] }
}

const ids = (rows: MenuSearchRow[]) => rows.map((r) => ('id' in r ? r.id : ''))

describe('kinds found by a name', () => {
  it('campaigns: this workspace’s, not the archived', async () => {
    const rows = await MENU_QUERIES.campaign(ctx('harbor'))
    expect(ids(rows)).toEqual(['c-spring'])
    expect(rows[0]).toMatchObject({ kind: 'campaign', title: 'Harbor spring push', status: 'active' })
    expect(menuRowTarget(rows[0])).toEqual({ type: 'page', slug: 'campaigns' })
  })

  it('sequences: the best match first', async () => {
    const rows = await MENU_QUERIES.sequence(ctx('harbor'))
    expect(ids(rows)).toEqual(['s-harbor', 's-welcome'])
    expect(menuRowTarget(rows[0])).toEqual({ type: 'sequence', id: 's-harbor', title: 'Harbor' })
  })

  it('prospect lists open as their own page', async () => {
    const [row] = await MENU_QUERIES.prospect_list(ctx('cafes'))
    expect(menuRowTarget(row)).toEqual({ type: 'prospect_list', id: 'p-cafes', title: 'Harbor cafes' })
  })

  it('tables: not a pipeline, not an archived one', async () => {
    const rows = await MENU_QUERIES.data_table(ctx('harbor'))
    expect(ids(rows)).toEqual(['t-vendors'])
    expect(rows[0]).toMatchObject({ status: 'Private' })
  })

  it('rows: not a deal, each saying its table and opening in it', async () => {
    const rows = await MENU_QUERIES.data_row(ctx('harbor'))
    expect(ids(rows)).toEqual(['r-bakery'])
    expect(rows[0]).toMatchObject({ status: 'Harbor vendors', parentId: 't-vendors' })
    expect(menuRowTarget(rows[0])).toEqual({ type: 'data_row', id: 'r-bakery', title: 'Harbor bakery', tableId: 't-vendors' })
  })

  it('channels: by name, never a DM or an archived one', async () => {
    const rows = await MENU_QUERIES.team_chat_channel(ctx('harbor'))
    expect(ids(rows)).toEqual(['ch-launch'])
    expect(menuRowTarget(rows[0])).toEqual({ type: 'team_chat', channelId: 'ch-launch' })
  })

  it('decisions: this workspace’s captures’, not the dismissed, opening the capture', async () => {
    const rows = await MENU_QUERIES.decision(ctx('harbor'))
    expect(ids(rows)).toEqual(['d-price'])
    expect(rows[0]).toMatchObject({ status: 'Pricing sync', parentId: 'cap-1' })
    expect(menuRowTarget(rows[0])).toEqual({ type: 'capture', id: 'cap-1', title: null })
  })

  it('teams and packages', async () => {
    const teams = await MENU_QUERIES.team(ctx('harbor'))
    expect(teams[0]).toMatchObject({ kind: 'team', id: 'tm-harbor', status: 'Private' })
    expect(menuRowTarget(teams[0])).toEqual({ type: 'team', id: 'tm-harbor', title: 'Harbor crew' })
    const [pkg] = await MENU_QUERIES.package(ctx('brand'))
    expect(pkg).toMatchObject({ kind: 'package', id: 'k-brand', status: 'How we write' })
    expect(menuRowTarget(pkg)).toEqual({ type: 'package', id: 'k-brand', title: 'Harbor brand voice' })
  })

  it('nothing typed: the most recent', async () => {
    expect(ids(await MENU_QUERIES.team(ctx('')))).toEqual(['tm-gen', 'tm-harbor'])
  })
})

describe('the caller’s own agent chats (conversation)', () => {
  it('by title, the caller’s own only, never an untitled one or a teammate’s', async () => {
    const rows = await MENU_QUERIES.conversation(ctx('harbor'))
    expect(ids(rows)).toEqual(['cv-harbor'])
    expect(rows[0]).toMatchObject({ kind: 'conversation', title: 'Harbor launch plan', status: null, parentId: null })
    // No card draws a past chat and the menu has no chats page, so opening is a no-op today.
    expect(menuRowTarget(rows[0])).toEqual({ type: 'page', slug: 'chats' })
  })
})

describe('the caller’s own mail threads (email_thread)', () => {
  it('by sender, the caller’s own only, never the trash, opening the mail card on the provider thread', async () => {
    const rows = await MENU_QUERIES.email_thread(ctx('harbor'))
    expect(ids(rows)).toEqual(['em-ana'])
    expect(rows[0]).toMatchObject({ kind: 'email_thread', title: 'maya@harbor.test', status: 'inbox', parentId: 'thr-1' })
    expect(menuRowTarget(rows[0])).toEqual({ type: 'mail', threadId: 'thr-1', title: 'maya@harbor.test' })
  })

  it('a full address also matches a thread it is a participant of', async () => {
    const rows = await MENU_QUERIES.email_thread(ctx('ana@acme.test'))
    expect(ids(rows)).toEqual(['em-ana'])
  })

  it('nothing, or almost nothing, typed: no provider-less mail search runs', async () => {
    expect(await MENU_QUERIES.email_thread(ctx(''))).toEqual([])
    expect(await MENU_QUERIES.email_thread(ctx('ha'))).toEqual([])
  })
})

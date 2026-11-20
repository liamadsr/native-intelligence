/**
 * What a comment @-mentions (../comment-mentions.ts, migration 671):
 *  - teammates are kept only if they are members of this workspace;
 *  - records only while their `@label` is in the words and the author may
 *    read them (another workspace's is dropped);
 *  - once saved, the record the comment is on mentions each record (an edge,
 *    never taken back), and a grantable record is shared, view only, with the
 *    teammates mentioned beside it, never with the author;
 *  - the migration adds the two columns and the notification type, and is
 *    the newest word on the type check.
 * Fixtures are made up.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { migrationsInOrder } from '@/test/migration-sql'
import { NOTIFICATION_TYPES } from '@/lib/notifications'
import { applyCommentMentions, fenceCommentMentions } from '../comment-mentions'

const WS = '11111111-1111-4111-8111-111111111111'
const ANA_USER = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const ANA = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const BEN = '33333333-3333-4333-8333-bbbbbbbbbbbb'
const STRANGER = '33333333-3333-4333-8333-cccccccccccc'
const TASK = 'a0000000-0000-4000-8000-000000000001'
const PROJECT = 'b0000000-0000-4000-8000-000000000001'
const FOREIGN = 'b0000000-0000-4000-8000-000000000002'
const DOC = 'd0000000-0000-4000-8000-000000000001'
const CONV = 'e0000000-0000-4000-8000-000000000001'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>

beforeEach(() => {
  tables = {
    member: [
      { id: ANA, user_id: ANA_USER, workspace_id: WS },
      { id: BEN, user_id: 'ben', workspace_id: WS },
      { id: STRANGER, user_id: 'x', workspace_id: 'another' },
    ],
    projects: [
      { id: PROJECT, workspace_id: WS, name: 'Harbor launch' },
      { id: FOREIGN, workspace_id: 'another', name: 'Elsewhere' },
    ],
    document: [{ id: DOC, workspace_id: WS, title: 'Harbor plan', visibility: 'workspace', created_by: ANA }],
    chat_conversations: [{ id: CONV, workspace_id: WS, user_id: ANA_USER, title: 'Harbor chat' }],
    entity_link: [],
    entity_access: [],
    conversation_share: [],
  }
})

const scope = { workspaceId: WS, userId: ANA_USER }

describe('fenceCommentMentions', () => {
  it('keeps this workspace’s members and the records still in the words', async () => {
    const out = await fenceCommentMentions(
      memoryDb(tables),
      scope,
      {
        mentions: [BEN, STRANGER, 'junk'],
        records: [
          { type: 'project', id: PROJECT, label: 'Harbor launch' },
          { type: 'project', id: FOREIGN, label: 'Elsewhere' },
          { type: 'document', id: DOC, label: 'Harbor plan' },
        ],
      },
      '@Ben see @Harbor launch and @Elsewhere',
    )
    expect(out.memberIds).toEqual([BEN])
    // The doc's label is not in the words; the foreign project is not readable.
    expect(out.records).toEqual([{ type: 'project', id: PROJECT, label: 'Harbor launch' }])
  })

  it('is nothing for a body that sends none', async () => {
    expect(await fenceCommentMentions(memoryDb(tables), scope, {}, 'plain words')).toEqual({ memberIds: [], records: [] })
  })
})

describe('applyCommentMentions', () => {
  it('draws the edge from the record the comment is on, and shares with the teammates mentioned', async () => {
    await applyCommentMentions(memoryDb(tables), {
      workspaceId: WS,
      userId: ANA_USER,
      memberId: ANA,
      commentable: { type: 'action', id: TASK },
      mentions: { memberIds: [BEN, ANA], records: [{ type: 'document', id: DOC, label: 'Harbor plan' }, { type: 'project', id: PROJECT, label: 'Harbor launch' }] },
    })
    expect(tables.entity_link.map((e) => [e.source_type, e.source_id, e.relation, e.target_type, e.target_id])).toEqual([
      ['action', TASK, 'mentions', 'document', DOC],
      ['action', TASK, 'mentions', 'project', PROJECT],
    ])
    // Only the grantable kind (the doc), only to Ben, as a mention's share.
    expect(tables.entity_access).toHaveLength(1)
    expect(tables.entity_access[0]).toMatchObject({ entity_type: 'document', entity_id: DOC, grantee_kind: 'member', grantee_member_id: BEN, level: 'view', source: 'mention', granted_by: ANA })
  })

  it('does nothing for a comment that mentions no record', async () => {
    await applyCommentMentions(memoryDb(tables), { workspaceId: WS, userId: ANA_USER, memberId: ANA, commentable: { type: 'action', id: TASK }, mentions: { memberIds: [BEN], records: [] } })
    expect(tables.entity_link).toEqual([])
    expect(tables.entity_access).toEqual([])
  })

  it('shares a mentioned agent chat read-only with the teammates mentioned beside it (decision 1)', async () => {
    await applyCommentMentions(memoryDb(tables), {
      workspaceId: WS,
      userId: ANA_USER,
      memberId: ANA,
      commentable: { type: 'action', id: TASK },
      mentions: { memberIds: [BEN, ANA], records: [{ type: 'conversation', id: CONV, label: 'Harbor chat' }] },
    })
    // The chat becomes a mentions edge from the task...
    expect(tables.entity_link.map((e) => [e.target_type, e.target_id])).toEqual([['conversation', CONV]])
    // ...and a read-only share to Ben (never the author), not a grant (conversation is not grantable).
    expect(tables.entity_access).toEqual([])
    expect(tables.conversation_share).toHaveLength(1)
    expect(tables.conversation_share[0]).toMatchObject({ conversation_id: CONV, grantee_member_id: BEN, shared_by: ANA_USER, source: 'mention', workspace_id: WS })
  })
})

describe('migration 671', () => {
  const FILE = '671_mentions_everywhere.sql'
  const SQL = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8')
  const BODY = SQL.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').replace(/\s+/g, ' ')

  it('adds the comment’s two columns, bounded, and can run again', () => {
    expect(SQL).not.toContain('\\')
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
    expect(BODY).toContain("add column if not exists mentions uuid[] not null default '{}'")
    expect(BODY).toContain("add column if not exists record_mentions jsonb not null default '[]'::jsonb")
    expect(BODY).toContain('check (cardinality(mentions) <= 50)')
    expect(BODY).toContain("jsonb_typeof(record_mentions) = 'array' and jsonb_array_length(record_mentions) <= 50")
    expect(BODY.indexOf('drop constraint if exists comment_record_mentions')).toBeLessThan(BODY.indexOf('add constraint comment_record_mentions'))
  })

  it('adds `mentioned` to the app’s notification types, and is the newest word on the check', () => {
    const types = [...(/notification_type_check check \(type = any \(array\[([^\]]*)\]\)\)/.exec(BODY)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((v) => v[1])
    expect(types).toEqual([...NOTIFICATION_TYPES])
    expect(types[types.length - 1]).toBe('mentioned')
    const newest = [...migrationsInOrder()].reverse().find((m) => /add constraint notification_type_check/i.test(m.sql))!.file
    expect(newest).toBe(FILE)
    expect(BODY.indexOf('drop constraint if exists notification_type_check')).toBeLessThan(BODY.indexOf('add constraint notification_type_check'))
  })

  it('redefines no shared function or policy (teams stay search-only; their edge fence is its own migration)', () => {
    // entity_visible_to and the entity_link policies were last defined by 664 and 522: a copy here would undo them.
    expect(BODY).not.toContain('function public.entity_visible_to')
    expect(BODY).not.toContain('policy entity_link_select')
    expect(BODY).not.toContain('policy entity_link_insert')
  })

  it('creates conversation_share, and leaves the chat tables owner-only', () => {
    expect(BODY).toContain('create table if not exists public.conversation_share')
    expect(BODY).toContain('grantee_member_id uuid not null references public.member(id) on delete cascade')
    expect(BODY).toContain("source text not null default 'mention' check (source in ('mention'))")
    expect(BODY).toContain('unique (conversation_id, grantee_member_id)')
    expect(BODY).toContain('alter table public.conversation_share enable row level security')
    // Only the chat's owner shares, to a member of the chat's own workspace.
    expect(BODY).toContain('cc.user_id = (select auth.uid()) and cc.workspace_id = conversation_share.workspace_id')
    expect(BODY).toContain('m.id = grantee_member_id and m.workspace_id = conversation_share.workspace_id')
    // No policy on the chat tables: many reads rely on them being their owner's alone.
    expect(BODY).not.toContain('on public.chat_conversations')
    expect(BODY).not.toContain('on public.chat_messages')
  })
})

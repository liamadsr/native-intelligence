/**
 * A main-chat turn's @-mentions as edges (../turn-mentions.ts): the person's
 * own conversation mentions each record their message named, fenced for them,
 * and only ever added (an earlier turn's mention stays when the next turn
 * names something else). Another person's conversation is never a source.
 * Also: a file is mentionable, fenced by the attachments rule. Fixtures are
 * made up.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import { syncTurnMentions, turnMentionRefs } from '../turn-mentions'
import { syncMentions, visibleMentionTargets } from '../mentions'

const WS = '11111111-1111-4111-8111-111111111111'
const ANA = '22222222-2222-4222-8222-aaaaaaaaaaaa'
const BEN = '22222222-2222-4222-8222-bbbbbbbbbbbb'
const ANA_MEMBER = '33333333-3333-4333-8333-aaaaaaaaaaaa'
const CHAT = '44444444-4444-4444-8444-aaaaaaaaaaaa'
const BEN_CHAT = '44444444-4444-4444-8444-bbbbbbbbbbbb'
const ACTION = 'a0000000-0000-4000-8000-000000000042'
const DEAL = 'de000000-0000-4000-8000-000000000001'
const OPEN_FILE = 'f0000000-0000-4000-8000-000000000001'
const PRIVATE_FILE = 'f0000000-0000-4000-8000-000000000002'
const BEN_CALL = 'c0000000-0000-4000-8000-000000000001'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>

beforeEach(() => {
  tables = {
    member: [{ id: ANA_MEMBER, user_id: ANA, workspace_id: WS }],
    chat_conversations: [
      { id: CHAT, user_id: ANA, workspace_id: WS },
      { id: BEN_CHAT, user_id: BEN, workspace_id: WS },
    ],
    actions: [{ id: ACTION, workspace_id: WS }],
    flow: [{ id: DEAL, workspace_id: WS }],
    captures: [{ id: BEN_CALL, workspace_id: WS, visibility: 'private', user_id: BEN, is_eval: false }],
    attachments: [
      { id: OPEN_FILE, workspace_id: WS, user_id: BEN, note_id: null },
      { id: PRIVATE_FILE, workspace_id: WS, user_id: BEN, note_id: BEN_CALL },
    ],
    entity_link: [],
  }
})

const edges = (source: string) =>
  tables.entity_link
    .filter((e) => e.source_id === source && e.relation === 'mentions')
    .map((e) => `${e.source_type}>${e.target_type}:${e.target_id}`)
    .sort()

describe('turnMentionRefs', () => {
  it('reads every kind the turn names, by its system-context key, each once', () => {
    expect(
      turnMentionRefs({
        attachedActionIds: [ACTION, ACTION],
        attachedDealIds: [DEAL],
        attachedFileIds: [OPEN_FILE],
        attachedContactIds: ['not-an-id'],
        attachedProjectIds: 'nope',
      }),
    ).toEqual([
      { type: 'action', id: ACTION },
      // A deal is its pipeline's row (Tables, phase 7).
      { type: 'data_row', id: DEAL },
      { type: 'attachment', id: OPEN_FILE },
    ])
    expect(turnMentionRefs(undefined)).toEqual([])
  })
})

describe('syncTurnMentions', () => {
  it('the person’s conversation mentions what they named, fenced for them', async () => {
    const db = memoryDb(tables)
    await syncTurnMentions(db, {
      workspaceId: WS,
      userId: ANA,
      conversationId: CHAT,
      systemContext: { attachedActionIds: [ACTION], attachedFileIds: [OPEN_FILE, PRIVATE_FILE] },
    })
    expect(edges(CHAT)).toEqual([`conversation>action:${ACTION}`, `conversation>attachment:${OPEN_FILE}`].sort())
    expect(tables.entity_link[0]).toMatchObject({ created_by: ANA_MEMBER })
  })

  it('adds a later turn’s mentions and keeps the earlier ones', async () => {
    const db = memoryDb(tables)
    const scope = { workspaceId: WS, userId: ANA, conversationId: CHAT }
    await syncTurnMentions(db, { ...scope, systemContext: { attachedActionIds: [ACTION] } })
    await syncTurnMentions(db, { ...scope, systemContext: { attachedFlowIds: [DEAL] } })
    await syncTurnMentions(db, { ...scope, systemContext: { attachedFlowIds: [DEAL] } })
    expect(edges(CHAT)).toEqual([`conversation>action:${ACTION}`, `conversation>flow:${DEAL}`].sort())
  })

  it('never writes from someone else’s conversation', async () => {
    const db = memoryDb(tables)
    await syncTurnMentions(db, { workspaceId: WS, userId: ANA, conversationId: BEN_CHAT, systemContext: { attachedActionIds: [ACTION] } })
    expect(tables.entity_link).toEqual([])
  })
})

describe('files as mention targets', () => {
  it('a file the author may read passes the fence; a teammate’s file on their private capture does not', async () => {
    const db = memoryDb(tables)
    const visible = await visibleMentionTargets(db, { workspaceId: WS, userId: ANA }, [
      { type: 'attachment', id: OPEN_FILE },
      { type: 'attachment', id: PRIVATE_FILE },
    ])
    expect(visible).toEqual([{ type: 'attachment', id: OPEN_FILE }])
  })

  it('syncMentions without addOnly takes back what is no longer mentioned', async () => {
    const db = memoryDb(tables)
    const base = { workspaceId: WS, source: { type: 'document' as const, id: 'd0000000-0000-4000-8000-000000000001' }, userId: ANA, memberId: ANA_MEMBER }
    await syncMentions(db, { ...base, targets: [{ type: 'attachment', id: OPEN_FILE }] })
    await syncMentions(db, { ...base, targets: [] })
    expect(tables.entity_link).toEqual([])
  })
})

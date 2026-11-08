/**
 * work_touch — the writers are fail-soft and the tool → entity mapping is
 * deterministic and conservative (Sequence step 2). Pinned:
 *   - input ids of known fields become touches with the tool's class verb;
 *     read tools never record output rows; write tools record created /
 *     proposed / wrote outputs by name;
 *   - only uuid ids, deduped per call, capped;
 *   - no work item → nothing written; an insert failure returns 0, never throws;
 *   - deliverables, verdict entries and extraction entries map to their verbs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'
import {
  TOUCHES_PER_EVENT_MAX,
  emailDraftRefsOut,
  emailThreadRefsIn,
  recordDeliveredTouches,
  recordExtractionTouches,
  recordToolCallTouches,
  recordWorkTouches,
  resetWorkTouchCaches,
  resolveWorkItemIdForAgentRun,
  touchesForDeliverables,
  touchesForToolCall,
  touchesForVerdictEntries,
} from '../touch'

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const WS = U(900)
const ITEM = U(901)

function fakeDb(opts: { insertError?: string; rows?: Array<Record<string, unknown>>; workItem?: string | null; throwOnLookup?: boolean } = {}) {
  const inserted: unknown[][] = []
  const client = {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      const self = () => chain
      Object.assign(chain, {
        select: self, eq: self, in: self, limit: self,
        insert: (rows: unknown[]) => {
          inserted.push(rows)
          return Promise.resolve({ error: opts.insertError ? { message: opts.insertError } : null })
        },
        maybeSingle: async () => {
          if (opts.throwOnLookup) throw new Error('boom')
          return { data: table === 'tracked_job' && opts.workItem ? { id: opts.workItem } : null, error: null }
        },
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: opts.rows ?? [], error: null })),
      })
      return chain
    },
  }
  return { client: client as never, inserted }
}

beforeEach(() => resetWorkTouchCaches())

describe('touchesForToolCall', () => {
  it('a read tool records its input ids as reads and nothing from its output', () => {
    const out = touchesForToolCall({
      toolName: 'list_actions',
      input: { project_id: U(1) },
      output: { actions: [{ id: U(2) }, { id: U(3) }] },
    })
    expect(out).toEqual([{ entityType: 'project', entityId: U(1), verb: 'read' }])
  })

  it('a create tool records its input ids as writes and its returned entity as created', () => {
    const out = touchesForToolCall({
      toolName: 'create_action',
      input: { project_id: U(1), title: 'x' },
      output: { success: true, action: { id: U(2), title: 'x' } },
    })
    expect(out).toEqual([
      { entityType: 'project', entityId: U(1), verb: 'wrote' },
      { entityType: 'action', entityId: U(2), verb: 'created' },
    ])
  })

  it('an update tool writes its target; a delete tool too; a propose tool proposes its output', () => {
    expect(touchesForToolCall({ toolName: 'update_action', input: { action_id: U(1) }, output: { success: true } })).toEqual([
      { entityType: 'action', entityId: U(1), verb: 'wrote' },
    ])
    expect(touchesForToolCall({ toolName: 'delete_action', input: { action_id: U(1) }, output: {} })).toEqual([
      { entityType: 'action', entityId: U(1), verb: 'wrote' },
    ])
    expect(
      touchesForToolCall({ toolName: 'propose_document_edit', input: { document_id: U(1) }, output: { proposal_id: U(2) } }),
    ).toEqual([
      { entityType: 'document', entityId: U(1), verb: 'wrote' },
      { entityType: 'proposal', entityId: U(2), verb: 'proposed' },
    ])
  })

  it('polymorphic pairs and id lists are mapped; non-uuid ids and unknown fields are ignored', () => {
    const out = touchesForToolCall({
      toolName: 'link_entities',
      input: { source_type: 'Contact', source_id: U(1), target_type: 'project', target_id: 'GEN-42', action_ids: [U(3), 'nope'], foo_id: U(4) },
      output: {},
    })
    expect(out).toEqual([
      { entityType: 'action', entityId: U(3), verb: 'wrote' },
      { entityType: 'contact', entityId: U(1), verb: 'wrote' },
    ])
  })

  it('an unregistered tool is read-shaped by name or a write otherwise', () => {
    expect(touchesForToolCall({ toolName: 'dial8_get_thing', input: { capture_id: U(1) }, output: { capture: { id: U(1) } } })).toEqual([
      { entityType: 'capture', entityId: U(1), verb: 'read' },
    ])
    expect(touchesForToolCall({ toolName: 'mystery_tool', input: { capture_id: U(1) }, output: {} })).toEqual([
      { entityType: 'capture', entityId: U(1), verb: 'wrote' },
    ])
  })

  it('dedupes within a call and caps the count', () => {
    const ids = Array.from({ length: 100 }, (_, i) => U(i + 1))
    const out = touchesForToolCall({ toolName: 'update_action', input: { action_ids: ids, action_id: U(1) }, output: {} })
    expect(out.length).toBe(TOUCHES_PER_EVENT_MAX)
    expect(new Set(out.map((t) => t.entityId)).size).toBe(TOUCHES_PER_EVENT_MAX)
  })
})

describe('recordWorkTouches / recordToolCallTouches', () => {
  it('writes valid rows and returns the count; drops invalid ids individually', async () => {
    const db = fakeDb()
    const n = await recordWorkTouches(db.client, [
      { workspaceId: WS, workItemId: ITEM, entityType: 'action', entityId: U(1), verb: 'read', toolName: 'get_action' },
      { workspaceId: WS, workItemId: ITEM, entityType: 'action', entityId: 'GEN-1', verb: 'read' },
    ])
    expect(n).toBe(1)
    expect(db.inserted[0]).toEqual([
      { workspace_id: WS, work_item_id: ITEM, agent_run_id: null, entity_type: 'action', entity_id: U(1), verb: 'read', tool_name: 'get_action' },
    ])
  })

  it('an insert failure is 0, never a throw; nothing valid → no insert at all', async () => {
    const failing = fakeDb({ insertError: 'permission denied' })
    await expect(
      recordWorkTouches(failing.client, [{ workspaceId: WS, workItemId: ITEM, entityType: 'x', entityId: U(1), verb: 'wrote' }]),
    ).resolves.toBe(0)
    const db = fakeDb()
    expect(await recordWorkTouches(db.client, [])).toBe(0)
    expect(db.inserted).toEqual([])
  })

  it('no work item → nothing recorded; with one, the call maps and writes with the run id', async () => {
    const db = fakeDb()
    expect(
      await recordToolCallTouches(db.client, { workspaceId: WS, workItemId: null, toolName: 'get_action', input: { action_id: U(1) }, output: {} }),
    ).toBe(0)
    expect(db.inserted).toEqual([])
    const n = await recordToolCallTouches(db.client, {
      workspaceId: WS,
      workItemId: ITEM,
      agentRunId: U(7),
      toolName: 'get_action',
      input: { action_id: U(1) },
      output: { action: { id: U(1) } },
    })
    expect(n).toBe(1)
    expect(db.inserted[0]).toEqual([
      { workspace_id: WS, work_item_id: ITEM, agent_run_id: U(7), entity_type: 'action', entity_id: U(1), verb: 'read', tool_name: 'get_action' },
    ])
  })
})

describe('resolveWorkItemIdForAgentRun', () => {
  it('looks the item up once per run and caches the answer, including "none"', async () => {
    const db = fakeDb({ workItem: ITEM })
    const from = vi.spyOn(db.client as { from: (t: string) => unknown }, 'from')
    expect(await resolveWorkItemIdForAgentRun(db.client, U(7))).toBe(ITEM)
    expect(await resolveWorkItemIdForAgentRun(db.client, U(7))).toBe(ITEM)
    expect(from).toHaveBeenCalledTimes(1)
    const none = fakeDb({ workItem: null })
    expect(await resolveWorkItemIdForAgentRun(none.client, U(8))).toBeNull()
  })

  it('a failed lookup is null and NOT cached', async () => {
    const db = fakeDb({ throwOnLookup: true })
    expect(await resolveWorkItemIdForAgentRun(db.client, U(9))).toBeNull()
    const ok = fakeDb({ workItem: ITEM })
    expect(await resolveWorkItemIdForAgentRun(ok.client, U(9))).toBe(ITEM)
  })
})

describe('deliverables, verdict entries, extraction entries', () => {
  it('deliverables with an entity become delivered touches; urls, PRs and card counts do not', () => {
    expect(
      touchesForDeliverables([
        { type: 'document', id: U(1) },
        { type: 'pr', id: 'https://github.com/x/y/pull/1' },
        { type: 'attention_cards', id: U(2) },
        { type: 'entity', id: U(3), entity_type: 'claim' },
        { type: 'email_draft', id: U(4) },
      ]),
    ).toEqual([
      { entityType: 'document', entityId: U(1), verb: 'delivered' },
      { entityType: 'claim', entityId: U(3), verb: 'delivered' },
      { entityType: 'email_draft', entityId: U(4), verb: 'delivered' },
    ])
  })

  it('recordDeliveredTouches stamps finish as the tool name', async () => {
    const db = fakeDb()
    await recordDeliveredTouches(db.client, { workspaceId: WS, workItemId: ITEM, agentRunId: U(7), deliverables: [{ type: 'document', id: U(1), label: 'Brief' }] })
    expect(db.inserted[0]).toEqual([
      { workspace_id: WS, work_item_id: ITEM, agent_run_id: U(7), entity_type: 'document', entity_id: U(1), verb: 'delivered', tool_name: 'finish' },
    ])
  })

  it('verdict entries: applied → created (typed), carded → proposed, folded → wrote, the rest nothing', () => {
    expect(
      touchesForVerdictEntries([
        { proposal_id: U(1), decision: 'accept', outcome: 'applied', reason: '', entity_id: U(2), entity_type: 'decision' },
        { proposal_id: U(3), decision: 'accept', outcome: 'applied', reason: '', entity_id: U(4) },
        { proposal_id: U(5), decision: 'accept', outcome: 'carded', reason: '' },
        { proposal_id: U(6), decision: 'fold_into', outcome: 'folded', reason: '', entity_id: U(7) },
        { proposal_id: U(8), decision: 'dismiss', outcome: 'dismissed', reason: '' },
        { proposal_id: U(9), decision: 'accept', outcome: 'staged', reason: '' },
      ]),
    ).toEqual([
      { entityType: 'decision', entityId: U(2), verb: 'created' },
      { entityType: 'action', entityId: U(4), verb: 'created' },
      { entityType: 'proposal', entityId: U(5), verb: 'proposed' },
      { entityType: 'action', entityId: U(7), verb: 'wrote' },
      { entityType: 'proposal', entityId: U(9), verb: 'proposed' },
    ])
  })

  it('extraction: the capture is read, applied entries take their kind from the proposals, staged are proposed', async () => {
    const db = fakeDb({ rows: [{ id: U(1), entity_type: 'contact' }] })
    const n = await recordExtractionTouches(db.client, {
      workspaceId: WS,
      workItemId: ITEM,
      captureId: U(50),
      entries: [
        { proposal_id: U(1), decision: 'accept', outcome: 'applied', reason: '', entity_id: U(2) },
        { proposal_id: U(3), decision: 'accept', outcome: 'carded', reason: '' },
      ],
    })
    expect(n).toBe(3)
    expect(db.inserted[0]).toEqual([
      { workspace_id: WS, work_item_id: ITEM, agent_run_id: null, entity_type: 'capture', entity_id: U(50), verb: 'read', tool_name: 'extraction' },
      { workspace_id: WS, work_item_id: ITEM, agent_run_id: null, entity_type: 'contact', entity_id: U(2), verb: 'created', tool_name: 'extraction' },
      { workspace_id: WS, work_item_id: ITEM, agent_run_id: null, entity_type: 'proposal', entity_id: U(3), verb: 'proposed', tool_name: 'extraction' },
    ])
  })
})

describe('email threads (row 12)', () => {
  const T1 = U(501)
  const T2 = U(502)
  const OTHER_WS_THREAD = U(503)
  const DRAFT = U(601)
  function mailbox() {
    const fake = makeFakeSupabase()
    fake.seed('email_thread_index', [
      { id: T1, workspace_id: WS, provider_thread_id: '18c0ffee' },
      { id: T2, workspace_id: WS, provider_thread_id: 'AAMkAD-outlook' },
      { id: OTHER_WS_THREAD, workspace_id: U(999), provider_thread_id: '18c0ffee' },
    ])
    fake.seed('email_draft', [{ id: DRAFT, workspace_id: WS, email_thread_id: T1 }])
    return fake
  }
  const threadTouches = (fake: ReturnType<typeof mailbox>) =>
    fake.rows('work_touch').filter((r) => r.entity_type === 'email_thread').map((r) => [r.entity_id, r.verb, r.tool_name])

  it('an email tool’s provider thread ids are the refs; other tools and fields are not', () => {
    expect(emailThreadRefsIn('read_email', { thread_id: '18c0ffee', message_id: 'm1' })).toEqual(['18c0ffee'])
    expect(emailThreadRefsIn('dial8_generate_email_drafts', { thread_ids: ['a', 'b', 'a', 7] })).toEqual(['a', 'b'])
    expect(emailThreadRefsIn('create_email_draft', { thread_id: '  ' })).toEqual([])
    expect(emailThreadRefsIn('add_comment', { thread_id: 'c-thread' })).toEqual([])
    expect(emailThreadRefsIn('read_email', null)).toEqual([])
    expect(emailThreadRefsIn('generate_email_drafts', { thread_ids: Array.from({ length: 30 }, (_, i) => `t${i}`) })).toHaveLength(10)
  })

  it('a tool call resolves its threads in the workspace and touches them with the tool’s verb', async () => {
    const fake = mailbox()
    await recordToolCallTouches(fake as never, { workspaceId: WS, workItemId: ITEM, toolName: 'read_email', input: { thread_id: '18c0ffee' }, output: {} })
    await recordToolCallTouches(fake as never, {
      workspaceId: WS,
      workItemId: ITEM,
      toolName: 'create_email_draft',
      input: { thread_id: 'AAMkAD-outlook', subject: 'Re: pricing', body: 'Hi' },
      output: { draft: { id: U(602) } },
    })
    expect(threadTouches(fake)).toEqual([
      [T1, 'read', 'read_email'],
      [T2, 'wrote', 'create_email_draft'],
    ])
    // The draft itself is still recorded, as before.
    expect(fake.rows('work_touch').find((r) => r.entity_type === 'email_draft')).toMatchObject({ entity_id: U(602), verb: 'created' })
  })

  it('an unknown thread (not indexed, or another workspace’s) records nothing for it', async () => {
    const fake = mailbox()
    const n = await recordToolCallTouches(fake as never, { workspaceId: WS, workItemId: ITEM, toolName: 'read_email', input: { thread_id: 'never-synced' }, output: {} })
    expect(n).toBe(0)
    expect(threadTouches(fake)).toEqual([])
  })

  it('a delivered draft also touches its thread', async () => {
    const fake = mailbox()
    await recordDeliveredTouches(fake as never, {
      workspaceId: WS,
      workItemId: ITEM,
      deliverables: [
        { type: 'email_draft', id: DRAFT, label: 'Reply to Dana' },
        { type: 'document', id: U(1), label: 'Brief' },
      ],
    })
    expect(fake.rows('work_touch').map((r) => [r.entity_type, r.verb])).toEqual([
      ['email_draft', 'delivered'],
      ['document', 'delivered'],
      ['email_thread', 'delivered'],
    ])
    expect(threadTouches(fake)).toEqual([[T1, 'delivered', 'finish']])
  })

  it('a failed thread lookup drops only the thread touch', async () => {
    const fake = mailbox()
    const broken = {
      from: (table: string) =>
        table === 'email_thread_index'
          ? { select: () => ({ eq: () => ({ in: () => ({ limit: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) }
          : fake.from(table),
    }
    const n = await recordToolCallTouches(broken as never, { workspaceId: WS, workItemId: ITEM, toolName: 'create_email_draft', input: { thread_id: '18c0ffee' }, output: { draft: { id: U(603) } } })
    expect(n).toBe(1)
    expect(threadTouches(fake)).toEqual([])
  })
})

describe('a draft the email tools made is recorded on its thread (provider ids)', () => {
  // create_email_draft returns the PROVIDER's ids (a Gmail message id here):
  // no email_draft row exists, so the draft's Native Intelligence row is its thread's index
  // row, written by the tool before it returns.
  const NEW_THREAD = U(701)
  const REPLY_THREAD = U(702)
  const ELSEWHERE = U(703)
  function mailbox() {
    const fake = makeFakeSupabase()
    fake.seed('email_thread_index', [
      { id: NEW_THREAD, workspace_id: WS, provider_thread_id: '1a0e8b6b5baa5eb0', provider_message_id: '1a0e8b6b5baa5eb0', is_draft: true },
      { id: REPLY_THREAD, workspace_id: WS, provider_thread_id: '18c0ffee', provider_message_id: 'm-reply', is_draft: true },
      { id: ELSEWHERE, workspace_id: U(999), provider_thread_id: 'only-elsewhere', provider_message_id: 'only-elsewhere', is_draft: true },
    ])
    return fake
  }
  const touches = (fake: ReturnType<typeof mailbox>) => fake.rows('work_touch').map((r) => [r.entity_type, r.entity_id, r.verb, r.tool_name])

  it('emailDraftRefsOut reads the provider draft and thread ids an email tool returned; uuids and other tools are not provider ids', () => {
    expect(emailDraftRefsOut('create_email_draft', { success: true, draft_id: '1a0e8b6b5baa5eb0', thread_id: '1a0e8b6b5baa5eb0' })).toEqual({
      messageIds: ['1a0e8b6b5baa5eb0'],
      threadIds: ['1a0e8b6b5baa5eb0'],
    })
    expect(emailDraftRefsOut('create_email_draft', { draft_id: U(1), thread_id: '' })).toEqual({ messageIds: [], threadIds: [] })
    expect(emailDraftRefsOut('create_document', { draft_id: 'x', thread_id: 'y' })).toEqual({ messageIds: [], threadIds: [] })
    expect(emailDraftRefsOut('create_email_draft', null)).toEqual({ messageIds: [], threadIds: [] })
  })

  it('a new draft (no thread in the input): its thread is touched `created` by the tool', async () => {
    const fake = mailbox()
    const n = await recordToolCallTouches(fake as never, {
      workspaceId: WS,
      workItemId: ITEM,
      toolName: 'create_email_draft',
      input: { to: ['etienne@corvanne.com'], subject: 'Heads-up', body: 'Hi' },
      output: { success: true, draft_id: '1a0e8b6b5baa5eb0', thread_id: '1a0e8b6b5baa5eb0', is_reply: false },
    })
    expect(n).toBe(1)
    expect(touches(fake)).toEqual([['email_thread', NEW_THREAD, 'created', 'create_email_draft']])
  })

  it('a reply draft: the thread the input named is touched once (`wrote`), not again as created', async () => {
    const fake = mailbox()
    await recordToolCallTouches(fake as never, {
      workspaceId: WS,
      workItemId: ITEM,
      toolName: 'create_email_draft',
      input: { thread_id: '18c0ffee', subject: 'Re: pricing', body: 'Hi' },
      output: { success: true, draft_id: 'm-reply', thread_id: '18c0ffee', is_reply: true },
    })
    expect(touches(fake)).toEqual([['email_thread', REPLY_THREAD, 'wrote', 'create_email_draft']])
  })

  it('delivered by its provider id: the thread is touched `delivered` (there is no email_draft row to touch)', async () => {
    const fake = mailbox()
    const n = await recordDeliveredTouches(fake as never, {
      workspaceId: WS,
      workItemId: ITEM,
      deliverables: [{ type: 'email_draft', id: '1a0e8b6b5baa5eb0', label: 'Heads-up: UserCube × middleware' }],
    })
    expect(n).toBe(1)
    expect(touches(fake)).toEqual([['email_thread', NEW_THREAD, 'delivered', 'finish']])
  })

  it('a provider draft indexed only in another workspace, or not at all, records nothing', async () => {
    const fake = mailbox()
    expect(
      await recordDeliveredTouches(fake as never, {
        workspaceId: WS,
        workItemId: ITEM,
        deliverables: [
          { type: 'email_draft', id: 'only-elsewhere', label: 'x' },
          { type: 'email_draft', id: 'never-indexed', label: 'y' },
        ],
      }),
    ).toBe(0)
    expect(
      await recordToolCallTouches(fake as never, {
        workspaceId: WS,
        workItemId: ITEM,
        toolName: 'create_email_draft',
        input: {},
        output: { draft_id: 'never-indexed', thread_id: 'never-indexed' },
      }),
    ).toBe(0)
    expect(touches(fake)).toEqual([])
  })
})

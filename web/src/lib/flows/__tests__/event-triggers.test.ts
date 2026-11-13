/**
 * The owner-scoped event triggers (event-triggers.ts and their matchers and
 * validators in queries.ts): a loop fires only for what its OWNER can see,
 * never for what an agent made, chat loops keep to their channel or to
 * mentions of the owner, mail loops to their sender filter, and the per-flow
 * cap holds a busy loop to 50 runs a day with a visible (hourly) skip.
 * People and companies here are made up.
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import {
  EVENT_CAP_SKIP_REASON,
  EVENT_FIRE_CAP_PER_DAY,
  chatFlowMatches,
  chatFlowsToFire,
  chatMessageSkipReason,
  chatTriggerChannelProblem,
  documentFlowsToFire,
  documentSkipReason,
  eventFireCapState,
  loadChatMessageFacts,
  ownerCanSeeDocument,
  workspaceHasEventFlows,
  type ChatMessageFacts,
} from '../event-triggers'
import {
  emailFromMatches,
  findMatchingFlowsForChatMessage,
  findMatchingFlowsForEmailReceived,
  normalizeEmailFrom,
  validateTriggerConfig,
} from '../queries'
import { TEMPLATE_TOKENS, buildTemplateContext, renderTemplate } from '../template'
import { AGENT_PAUSED_REASON } from '@/lib/work/agent-paused'
import type { FlowWithSecrets } from '../types'

const WS = 'ws-fernhill'
const CH_GENERAL = '11111111-1111-4111-8111-111111111111'
const CH_DESIGN = '22222222-2222-4222-8222-222222222222'
const CH_DM = '33333333-3333-4333-8333-333333333333'

type Row = Record<string, unknown>

/** Ana (owner of loops), Ben (a teammate), Cy (on another team), Dee (a guest, in nothing). */
function chatTables(): Record<string, Row[]> {
  return {
    member: [
      { id: 'm-ana', user_id: 'u-ana', workspace_id: WS, role: 'member' },
      { id: 'm-ben', user_id: 'u-ben', workspace_id: WS, role: 'member' },
      { id: 'm-cy', user_id: 'u-cy', workspace_id: WS, role: 'member' },
      { id: 'm-dee', user_id: 'u-dee', workspace_id: WS, role: 'guest' },
    ],
    team_chat_channel: [
      { id: CH_GENERAL, workspace_id: WS, team_id: null, kind: 'channel', name: 'general' },
      { id: CH_DESIGN, workspace_id: WS, team_id: 'team-design', kind: 'channel', name: 'design' },
      { id: CH_DM, workspace_id: WS, team_id: null, kind: 'dm', name: null },
    ],
    team_member: [
      { team_id: 'team-design', member_id: 'm-ana' },
      { team_id: 'team-design', member_id: 'm-ben' },
    ],
    team_chat_member: [
      { channel_id: CH_DM, member_id: 'm-ben' },
      { channel_id: CH_DM, member_id: 'm-cy' },
    ],
  }
}

function flow(id: string, owner: string, cfg: Record<string, unknown>, type = 'chat_message'): FlowWithSecrets {
  return { id, workspace_id: WS, created_by: owner, trigger_type: type, trigger_config: { kind: type, ...cfg }, actions: [], enabled: true } as unknown as FlowWithSecrets
}

function msg(over: Partial<ChatMessageFacts> = {}): ChatMessageFacts {
  return {
    id: 'msg-1',
    channel_id: CH_DESIGN,
    workspace_id: WS,
    author_kind: 'member',
    author_member_id: 'm-ben',
    thread_root_id: null,
    mentions: [],
    kind: 'message',
    deleted: false,
    ...over,
  }
}

describe('chat: the loop guard', () => {
  it("only a person's written message fires: never an agent's reply, a call's row or a deleted message", () => {
    expect(chatMessageSkipReason(msg())).toBeNull()
    expect(chatMessageSkipReason(msg({ author_kind: 'agent', author_member_id: null }))).toBe('written by an agent')
    expect(chatMessageSkipReason(msg({ kind: 'call' }))).not.toBeNull()
    expect(chatMessageSkipReason(msg({ deleted: true }))).not.toBeNull()
  })

  it('reads the message facts, the agent author included', async () => {
    const db = memoryDb({
      team_chat_message: [
        { id: 'msg-a', channel_id: CH_GENERAL, workspace_id: WS, author_kind: 'agent', author_member_id: null, thread_root_id: 'root-1', mentions: ['m-ana'], kind: 'message', deleted_at: null },
      ],
    })
    const facts = await loadChatMessageFacts(db, 'msg-a')
    expect(facts).toMatchObject({ author_kind: 'agent', thread_root_id: 'root-1', mentions: ['m-ana'], deleted: false })
    expect(chatMessageSkipReason(facts!)).toBe('written by an agent')
    expect(await loadChatMessageFacts(db, 'missing')).toBeNull()
  })
})

describe('chat: which loops take a message', () => {
  it('a channel loop takes its channel only (thread replies too); the owner’s own message counts', () => {
    const cfg = { channel_id: CH_DESIGN, mentions_only: false }
    expect(chatFlowMatches(cfg, msg(), 'm-ana')).toBe(true)
    expect(chatFlowMatches(cfg, msg({ thread_root_id: 'root-9' }), 'm-ana')).toBe(true)
    expect(chatFlowMatches(cfg, msg({ channel_id: CH_GENERAL }), 'm-ana')).toBe(false)
    expect(chatFlowMatches(cfg, msg({ author_member_id: 'm-ana' }), 'm-ana')).toBe(true)
  })

  it('mentions_only: a mention of the owner, never their own message', () => {
    const cfg = { channel_id: CH_DESIGN, mentions_only: true }
    expect(chatFlowMatches(cfg, msg(), 'm-ana')).toBe(false)
    expect(chatFlowMatches(cfg, msg({ mentions: ['m-ana'] }), 'm-ana')).toBe(true)
    expect(chatFlowMatches(cfg, msg({ mentions: ['m-ben'] }), 'm-ana')).toBe(false)
    expect(chatFlowMatches(cfg, msg({ mentions: ['m-ana'], author_member_id: 'm-ana' }), 'm-ana')).toBe(false)
  })

  it('any channel only with mentions_only; a removed owner never matches', () => {
    expect(chatFlowMatches({ channel_id: null, mentions_only: true }, msg({ channel_id: CH_GENERAL, mentions: ['m-ana'] }), 'm-ana')).toBe(true)
    expect(chatFlowMatches({ channel_id: null, mentions_only: false }, msg({ mentions: ['m-ana'] }), 'm-ana')).toBe(false)
    expect(chatFlowMatches({ channel_id: CH_DESIGN, mentions_only: false }, msg(), null)).toBe(false)
  })

  it('the matcher asks for the channel’s loops and the any-channel mention loops only', async () => {
    const db = memoryDb({
      flow: [
        { id: 'f-design', workspace_id: WS, enabled: true, trigger_type: 'chat_message', trigger_config: { kind: 'chat_message', channel_id: CH_DESIGN, mentions_only: false }, actions: [] },
        { id: 'f-general', workspace_id: WS, enabled: true, trigger_type: 'chat_message', trigger_config: { kind: 'chat_message', channel_id: CH_GENERAL, mentions_only: false }, actions: [] },
        { id: 'f-any', workspace_id: WS, enabled: true, trigger_type: 'chat_message', trigger_config: { kind: 'chat_message', channel_id: null, mentions_only: true }, actions: [] },
        // A hand-edited any-channel row without mentions_only never fires.
        { id: 'f-bad', workspace_id: WS, enabled: true, trigger_type: 'chat_message', trigger_config: { kind: 'chat_message', channel_id: null, mentions_only: false }, actions: [] },
        { id: 'f-off', workspace_id: WS, enabled: false, trigger_type: 'chat_message', trigger_config: { kind: 'chat_message', channel_id: CH_DESIGN, mentions_only: false }, actions: [] },
      ],
    })
    const flows = await findMatchingFlowsForChatMessage(db, { workspaceId: WS, channelId: CH_DESIGN })
    expect(flows.map((f) => f.id).sort()).toEqual(['f-any', 'f-design'])
  })

  it('owner scoping: a loop fires only when its owner can read the channel now', async () => {
    const db = memoryDb(chatTables())
    const flows = [
      flow('f-ana', 'u-ana', { channel_id: CH_DESIGN, mentions_only: false }),
      // Cy is not on the design team: the channel isn't theirs to read.
      flow('f-cy', 'u-cy', { channel_id: CH_DESIGN, mentions_only: false }),
      // Dee, a guest, is in no channel.
      flow('f-dee', 'u-dee', { channel_id: null, mentions_only: true }),
    ]
    const fired = await chatFlowsToFire(db, flows, msg({ mentions: ['m-dee'] }))
    expect(fired.map((f) => f.id)).toEqual(['f-ana'])
  })

  it('a DM: only its members’ loops', async () => {
    const db = memoryDb(chatTables())
    const flows = [flow('f-ana', 'u-ana', { channel_id: null, mentions_only: true }), flow('f-cy', 'u-cy', { channel_id: null, mentions_only: true })]
    const fired = await chatFlowsToFire(db, flows, msg({ channel_id: CH_DM, mentions: ['m-ana', 'm-cy'] }))
    expect(fired.map((f) => f.id)).toEqual(['f-cy'])
  })

  it('an agent’s message fires nothing at all', async () => {
    const db = memoryDb(chatTables())
    expect(await chatFlowsToFire(db, [flow('f-ana', 'u-ana', { channel_id: CH_DESIGN, mentions_only: false })], msg({ author_kind: 'agent', author_member_id: null }))).toEqual([])
  })

  it('save-time: a named channel must be one the owner can read', async () => {
    const db = memoryDb(chatTables())
    expect(await chatTriggerChannelProblem(db, { workspaceId: WS, ownerUserId: 'u-ana', triggerType: 'chat_message', config: { channel_id: CH_DESIGN } })).toBeNull()
    expect(await chatTriggerChannelProblem(db, { workspaceId: WS, ownerUserId: 'u-cy', triggerType: 'chat_message', config: { channel_id: CH_DESIGN } })).toMatch(/can read/)
    expect(await chatTriggerChannelProblem(db, { workspaceId: WS, ownerUserId: 'u-cy', triggerType: 'chat_message', config: { channel_id: null } })).toBeNull()
    expect(await chatTriggerChannelProblem(db, { workspaceId: WS, ownerUserId: 'u-cy', triggerType: 'schedule', config: {} })).toBeNull()
  })
})

describe('chat: the validator', () => {
  it('a channel, or any channel only with mentions_only', () => {
    expect(validateTriggerConfig('chat_message', { channel_id: CH_DESIGN })).toEqual({ kind: 'chat_message', channel_id: CH_DESIGN, mentions_only: false })
    expect(validateTriggerConfig('chat_message', { channel_id: null, mentions_only: true })).toEqual({ kind: 'chat_message', channel_id: null, mentions_only: true })
    const refused = validateTriggerConfig('chat_message', { channel_id: null, mentions_only: false })
    expect(refused).toBeInstanceOf(Error)
    expect((refused as Error).message).toMatch(/^trigger_config\.channel_id is required unless mentions_only/)
    expect(validateTriggerConfig('chat_message', {})).toBeInstanceOf(Error)
    expect(validateTriggerConfig('chat_message', { channel_id: 'general' })).toBeInstanceOf(Error)
    expect(validateTriggerConfig('chat_message', { channel_id: CH_DESIGN, mentions_only: 'yes' })).toBeInstanceOf(Error)
  })
})

describe('email: the sender filter', () => {
  it('normalizes an address or a domain (with or without @), lowercased', () => {
    expect(normalizeEmailFrom(' Ana@Fernhill.Example ')).toBe('ana@fernhill.example')
    expect(normalizeEmailFrom('@Fernhill.example')).toBe('fernhill.example')
    expect(normalizeEmailFrom('fernhill.example')).toBe('fernhill.example')
    expect(normalizeEmailFrom('')).toBe('')
    expect(normalizeEmailFrom(undefined)).toBe('')
    expect(normalizeEmailFrom('not an address')).toBeInstanceOf(Error)
    expect(normalizeEmailFrom('ana@')).toBeInstanceOf(Error)
    expect(normalizeEmailFrom(42)).toBeInstanceOf(Error)
  })

  it('the validator keeps the filter, or none', () => {
    expect(validateTriggerConfig('email_received', { from: '@Acme.example' })).toEqual({ kind: 'email_received', from: 'acme.example' })
    expect(validateTriggerConfig('email_received', {})).toEqual({ kind: 'email_received' })
    expect(validateTriggerConfig('email_received', null)).toEqual({ kind: 'email_received' })
    expect(validateTriggerConfig('email_received', { from: 'x y' })).toBeInstanceOf(Error)
    expect(validateTriggerConfig('document_created', { anything: 1 })).toEqual({ kind: 'document_created' })
    expect(validateTriggerConfig('document_created', 'x')).toBeInstanceOf(Error)
  })

  it('matches an exact address, or a domain and its subdomains, case-insensitively', () => {
    expect(emailFromMatches(undefined, 'ben@acme.example')).toBe(true)
    expect(emailFromMatches('ben@acme.example', 'Ben@Acme.example')).toBe(true)
    expect(emailFromMatches('ben@acme.example', 'cy@acme.example')).toBe(false)
    expect(emailFromMatches('acme.example', 'cy@acme.example')).toBe(true)
    expect(emailFromMatches('@acme.example', 'cy@mail.acme.example')).toBe(true)
    expect(emailFromMatches('acme.example', 'cy@notacme.example')).toBe(false)
    expect(emailFromMatches('acme.example', null)).toBe(false)
  })

  it("the matcher fires only the mailbox person's own loops, with their filter", async () => {
    const db = memoryDb({
      flow: [
        { id: 'f-ana-any', workspace_id: WS, enabled: true, trigger_type: 'email_received', trigger_config: { kind: 'email_received' }, created_by: 'u-ana', actions: [] },
        { id: 'f-ana-acme', workspace_id: WS, enabled: true, trigger_type: 'email_received', trigger_config: { kind: 'email_received', from: 'acme.example' }, created_by: 'u-ana', actions: [] },
        { id: 'f-ana-other', workspace_id: WS, enabled: true, trigger_type: 'email_received', trigger_config: { kind: 'email_received', from: 'other.example' }, created_by: 'u-ana', actions: [] },
        { id: 'f-ben', workspace_id: WS, enabled: true, trigger_type: 'email_received', trigger_config: { kind: 'email_received' }, created_by: 'u-ben', actions: [] },
      ],
    })
    const flows = await findMatchingFlowsForEmailReceived(db, { workspaceId: WS, ownerUserId: 'u-ana', fromEmail: 'cy@acme.example' })
    expect(flows.map((f) => f.id).sort()).toEqual(['f-ana-acme', 'f-ana-any'])
  })

  it('no sender rides the template: {{trigger.email_from}} is not a token, only the ids are', () => {
    // A well-formed address still carries a stranger's words in its local part.
    expect(TEMPLATE_TOKENS).not.toContain('{{trigger.email_from}}')
    expect(TEMPLATE_TOKENS).toEqual(expect.arrayContaining(['{{trigger.email_thread_id}}', '{{trigger.email_account_id}}']))
    const ctx = buildTemplateContext(null, {
      type: 'email_received',
      entity_type: null,
      from_status_id: null,
      to_status_id: null,
      fired_at: '2026-11-16T15:00:00Z',
      email_thread_id: 't-1',
      email_account_id: 'acct-1',
    }, 'https://app.example', { workspaceId: WS })
    expect(ctx.trigger).not.toHaveProperty('email_from')
    expect(renderTemplate('{{trigger.email_from}}|{{trigger.email_thread_id}}', ctx)).not.toContain('@')
  })
})

describe('documents', () => {
  const doc = (over: Row = {}) => ({ id: 'doc-1', workspace_id: WS, status: 'active', visibility: 'workspace', ...over }) as never

  it('a document deleted, archived or moved by the time the fire runs is skipped', () => {
    expect(documentSkipReason(null, WS)).toBe('deleted')
    expect(documentSkipReason(doc({ workspace_id: 'ws-other' }), WS)).toBe('deleted')
    expect(documentSkipReason(doc({ status: 'archived' }), WS)).toBe('archived')
    expect(documentSkipReason(doc(), WS)).toBeNull()
  })

  it("owner scoping: the graph's own rule (no grants), and never a private document", async () => {
    const asked: unknown[] = []
    const db = memoryDb({})
    ;(db as unknown as Record<string, unknown>).rpc = async (_fn: string, args: Record<string, unknown>) => {
      asked.push(args)
      // Cy can't see it; Ana can.
      return { data: args.p_user === 'u-cy' ? [{ entity_type: 'document', entity_id: 'doc-1' }] : [], error: null }
    }
    expect(await ownerCanSeeDocument(db, 'u-ana', doc())).toBe(true)
    expect(await ownerCanSeeDocument(db, 'u-cy', doc())).toBe(false)
    expect(asked[0]).toMatchObject({ p_user: 'u-ana', p_workspace: WS, p_types: ['document'], p_ids: ['doc-1'], p_grants: false })
    // A private one: not even its author's loop (a loop's run reads no private document).
    expect(await ownerCanSeeDocument(db, 'u-ana', doc({ visibility: 'private' }))).toBe(false)
    const fired = await documentFlowsToFire(db, [flow('f-ana', 'u-ana', {}, 'document_created'), flow('f-cy', 'u-cy', {}, 'document_created')], doc())
    expect(fired.map((f) => f.id)).toEqual(['f-ana'])
  })

  it('a failed visibility read hides the document (fails closed)', async () => {
    const db = memoryDb({})
    ;(db as unknown as Record<string, unknown>).rpc = async () => ({ data: null, error: { message: 'down' } })
    expect(await ownerCanSeeDocument(db, 'u-ana', doc())).toBe(false)
  })
})

describe('the cap: at most 50 runs a day per event loop', () => {
  const NOW = Date.parse('2026-11-16T15:00:00.000Z')
  const runs = (n: number, preview: string | null = null, hoursAgo = 2) =>
    Array.from({ length: n }, (_, i) => ({ id: `r-${preview ?? 'run'}-${i}`, flow_id: 'f-1', fired_at: new Date(NOW - hoursAgo * 3_600_000).toISOString(), response_body_preview: preview }))

  it('runs below the cap', async () => {
    expect(await eventFireCapState(memoryDb({ flow_run: runs(EVENT_FIRE_CAP_PER_DAY - 1) }), 'f-1', NOW)).toBe('ok')
  })

  it('capped at 50 in 24 hours; older runs do not count', async () => {
    expect(await eventFireCapState(memoryDb({ flow_run: runs(50) }), 'f-1', NOW)).toBe('capped')
    expect(await eventFireCapState(memoryDb({ flow_run: runs(50, null, 25) }), 'f-1', NOW)).toBe('ok')
  })

  it("skip rows (the cap's own, the kill switch's) are not runs", async () => {
    expect(await eventFireCapState(memoryDb({ flow_run: [...runs(49), ...runs(3, AGENT_PAUSED_REASON), ...runs(3, EVENT_CAP_SKIP_REASON)] }), 'f-1', NOW)).toBe('ok')
  })

  it('while capped, one skip row an hour: quiet after that', async () => {
    expect(await eventFireCapState(memoryDb({ flow_run: [...runs(50), ...runs(1, EVENT_CAP_SKIP_REASON, 0.5)] }), 'f-1', NOW)).toBe('capped_quiet')
    expect(await eventFireCapState(memoryDb({ flow_run: [...runs(50), ...runs(1, EVENT_CAP_SKIP_REASON, 1.5)] }), 'f-1', NOW)).toBe('capped')
  })

  it('fails open on a read error (a transient failure never drops a fire)', async () => {
    const broken = { from: () => ({ select: () => { throw new Error('down') } }) } as unknown as SupabaseClient
    expect(await eventFireCapState(broken, 'f-1', NOW)).toBe('ok')
  })
})

describe('workspaceHasEventFlows (the emitters ask first)', () => {
  it('counts enabled loops of the type, the owner’s own when asked', async () => {
    const db = memoryDb({
      flow: [
        { id: 'f-1', workspace_id: WS, enabled: true, trigger_type: 'chat_message', created_by: 'u-ana' },
        { id: 'f-2', workspace_id: WS, enabled: false, trigger_type: 'document_created', created_by: 'u-ana' },
      ],
    })
    expect(await workspaceHasEventFlows(db, { workspaceId: WS, triggerType: 'chat_message' })).toBe(true)
    expect(await workspaceHasEventFlows(db, { workspaceId: WS, triggerType: 'chat_message', ownerUserId: 'u-ben' })).toBe(false)
    expect(await workspaceHasEventFlows(db, { workspaceId: WS, triggerType: 'document_created' })).toBe(false)
  })
})

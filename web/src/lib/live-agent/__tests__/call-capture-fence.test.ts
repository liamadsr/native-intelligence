/**
 * The fence on a call's capture (src/lib/live-agent/call-capture-fence.ts):
 * what anyone says in a call is untrusted, the turn runs as the capture's
 * owner, and its notes are read by the whole conversation, so a turn on a
 * call's capture holds only what writing the shared notes needs. Proven on
 * the REAL surfaces, not a stub of them:
 *
 *   - the tool MAP a notes turn gets (assembleLiveAgentToolSet over the real
 *     createLiveAgentTools and buildLiveAgentReadTools factories): exactly the
 *     record's writers and three structural reads, no owner-private read, no
 *     connected-app proposal, no web;
 *   - the eve spec rebuilt for a notes turn on a call's capture
 *     (rebuildLiveAgentSpec, which reads the capture row): the same ceiling,
 *     web off, no canon registry, none of the requester's own context;
 *   - propose_change on a call's capture: new action items, decisions and
 *     milestones only;
 *   - an ordinary capture is untouched by any of it.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ToolSet } from 'ai'
import { createFakeSupabase, meetingFixture, FIX, type FakeQuery } from './helpers/live-turn-fixture'

vi.mock('server-only', () => ({}))

const { createLiveAgentTools } = await import('../tools')
const { buildLiveAgentReadTools } = await import('../read-tools')
const { assembleLiveAgentToolSet } = await import('../turn-composition')
const { computeLiveAgentCeiling } = await import('../ceiling')
const { BUILTIN_ASSISTANT_TOOL_SELECTION } = await import('../read-tool-names')
const { rebuildLiveAgentSpec } = await import('../live-agent-spec')
const { CALL_CAPTURE_CHANGE_REFUSAL, fenceCallCapture, isCallCapture } = await import('../call-capture-fence')

const CHANNEL = 'chan-call-1'
const stub = {} as SupabaseClient

/** What a notes turn on a call's capture may call: the record's own writers and three structural reads. */
const ALLOWED = [
  'propose_change',
  'edit_proposal',
  'dismiss_proposal',
  'record_commitment',
  'set_capture_title',
  'write_summary',
  'update_summary',
  'list_workspace_members',
  'list_labels',
  'list_workflow_states',
].sort()

/** Owner-private reads and actions a spoken instruction must not reach. */
const WITHHELD = [
  'read_email',
  'list_emails',
  'get_email_summary',
  'get_email_drafts',
  'get_calendar_events',
  'get_upcoming_meetings',
  'get_meeting_prep',
  'get_document',
  'list_documents',
  'read_canon',
  'get_attachment_content',
  'read_chat_file',
  'list_attachments',
  'get_package',
  'list_packages',
  'deep_search',
  'search',
  'find',
  'get_capture_transcript',
  'list_captures',
  'search_claims',
  'get_contact',
  'list_contacts',
  'search_contacts',
  'search_projects',
  'get_project_details',
  'propose_mcp_call',
  'say_to_user',
  'ask_user',
  'load_skill',
  'direct_notes',
]

describe('which capture is a call’s', () => {
  it('one with a notes channel (the server’s own column), and only then', () => {
    expect(isCallCapture({ notes_channel_id: CHANNEL })).toBe(true)
    expect(isCallCapture({ notes_channel_id: null })).toBe(false)
    expect(isCallCapture({})).toBe(false)
    expect(isCallCapture(null)).toBe(false)
    for (const t of ['notes', 'copilot', 'batch'] as const) expect(fenceCallCapture({ notes_channel_id: CHANNEL }, t)).toBe(true)
    expect(fenceCallCapture({ notes_channel_id: null }, 'notes')).toBe(false)
  })
})

describe('the tool map of a notes turn on a call’s capture (the real factories)', () => {
  const stagingTools = createLiveAgentTools('u', stub, 'w', 'c', null, null)
  const readTools = buildLiveAgentReadTools('u', stub, 'w')
  const webTools = { web_search: { description: 'the web' } } as unknown as ToolSet
  const build = (callCapture: boolean) =>
    assembleLiveAgentToolSet({
      allStagingTools: stagingTools,
      readTools,
      webTools,
      turnType: 'notes',
      assistOnly: false,
      agentConfig: BUILTIN_ASSISTANT_TOOL_SELECTION,
      packageBlock: null,
      callCapture,
    })

  it('holds exactly the record’s writers and three structural reads (plus search_tools over them)', () => {
    const { tools } = build(true)
    expect(Object.keys(tools).filter((n) => n !== 'search_tools').sort()).toEqual(ALLOWED)
    for (const name of WITHHELD) expect(Object.keys(tools), name).not.toContain(name)
    expect(Object.keys(tools)).not.toContain('web_search')
  })

  it('the same ceiling the tool route and the spec re-derive', () => {
    const { ceiling } = computeLiveAgentCeiling({ turnType: 'notes', assistOnly: false, agentConfig: BUILTIN_ASSISTANT_TOOL_SELECTION, callCapture: true })
    expect([...ceiling].sort()).toEqual(ALLOWED)
    // The end-of-call pass on a call's capture: the same fence.
    const batch = computeLiveAgentCeiling({ turnType: 'batch', assistOnly: false, agentConfig: BUILTIN_ASSISTANT_TOOL_SELECTION, callCapture: true })
    expect([...batch.ceiling].sort()).toEqual(ALLOWED)
  })

  it('an ordinary capture keeps its whole surface', () => {
    const { tools } = build(false)
    for (const name of ['read_email', 'get_document', 'deep_search', 'propose_mcp_call', 'search_contacts']) expect(Object.keys(tools)).toContain(name)
    expect(Object.keys(tools)).toContain('web_search')
  })
})

describe('the spec eve runs for a notes turn on a call’s capture (rebuilt from the capture row)', () => {
  /** The fixture's capture, as a call's: its notes channel set. */
  const callFixture = () => {
    const base = meetingFixture()
    return (q: FakeQuery) => {
      const r = base(q)
      if (q.table === 'captures' && q.columns.includes('is_eval') && r.data && !Array.isArray(r.data)) {
        return { ...r, data: { ...(r.data as Record<string, unknown>), notes_channel_id: CHANNEL } }
      }
      return r
    }
  }
  const claims = {
    captureId: FIX.captureId,
    workspaceId: FIX.workspaceId,
    userId: FIX.userId,
    currentMemberId: FIX.memberId,
    turnType: 'notes' as const,
    model: 'deepseek-v4-flash',
    isEvalCapture: false,
    allowAutoArchive: false,
    exp: Date.now() + 60_000,
  }

  it('the fenced ceiling, no web, none of the requester’s own context', async () => {
    const spec = await rebuildLiveAgentSpec(claims, { supabase: createFakeSupabase(callFixture()).client })
    expect(spec).not.toBeNull()
    expect([...spec!.ceiling].sort()).toEqual(ALLOWED)
    expect(spec!.webAccess).toBe(false)
  })

  it('an ordinary capture’s spec is unchanged by the fence', async () => {
    const spec = await rebuildLiveAgentSpec(claims, { supabase: createFakeSupabase(meetingFixture()).client })
    expect(spec!.ceiling).toContain('read_email')
    expect(spec!.ceiling).toContain('propose_mcp_call')
  })
})

describe('the end-of-call pass on a call’s capture: owner-only follow-up drafts kept', () => {
  /** The fixture, with a staged proposal's insert answered. */
  const staged: Array<Record<string, unknown>> = []
  const db = () => {
    const base = meetingFixture()
    return createFakeSupabase((q: FakeQuery) => {
      if (q.table === 'proposed_change' && q.op === 'insert') {
        staged.push(q.payload as Record<string, unknown>)
        return { data: { id: 'pc-draft' }, error: null }
      }
      return base(q)
    }).client
  }
  const build = (endOfCall: boolean) =>
    createLiveAgentTools('u', db(), FIX.workspaceId, FIX.captureId, null, null, null, null, null, {
      callCapture: true,
      ...(endOfCall ? { callCaptureEndOfCall: true } : {}),
    }) as unknown as Record<string, { execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown> }>
  const draft = { change_type: 'send_email', entity_type: 'action', display_text: 'Send Sam the pilot dates', email_to_name: 'Sam Ruiz', email_subject: 'Pilot dates', confidence: 0.9 }

  it('the same tool map as the live notes (the drafts ride propose_change, nothing is added)', () => {
    const live = computeLiveAgentCeiling({ turnType: 'notes', assistOnly: false, agentConfig: BUILTIN_ASSISTANT_TOOL_SELECTION, callCapture: true })
    const end = computeLiveAgentCeiling({ turnType: 'batch', assistOnly: false, agentConfig: BUILTIN_ASSISTANT_TOOL_SELECTION, callCapture: true })
    expect([...end.ceiling].sort()).toEqual([...live.ceiling].sort())
  })

  it('stages a follow-up email draft at the end of the call, never during it', async () => {
    staged.length = 0
    const atEnd = await build(true).propose_change.execute(draft, { toolCallId: 't', messages: [] })
    expect(atEnd).not.toEqual({ success: false, error: CALL_CAPTURE_CHANGE_REFUSAL })
    // A proposal on this capture (the owner's to review), nothing sent.
    expect(staged).toHaveLength(1)
    expect(staged[0]).toMatchObject({ change_type: 'send_email', entity_type: 'action', status: 'pending', email_to_name: 'Sam Ruiz' })
    const live = await build(false).propose_change.execute(draft, { toolCallId: 't', messages: [] })
    expect(live).toEqual({ success: false, error: CALL_CAPTURE_CHANGE_REFUSAL })
    expect(staged).toHaveLength(1)
  })

  it('a new CRM contact, an update or a delete stays withheld at the end of the call too', async () => {
    for (const [change_type, entity_type] of [['create', 'contact'], ['update', 'action'], ['delete', 'action'], ['assign', 'action']]) {
      const out = await build(true).propose_change.execute({ change_type, entity_type, display_text: 'x' }, { toolCallId: 't', messages: [] })
      expect(out, `${change_type}:${entity_type}`).toEqual({ success: false, error: CALL_CAPTURE_CHANGE_REFUSAL })
    }
  })
})

describe('propose_change on a call’s capture', () => {
  const tools = createLiveAgentTools('u', stub, 'w', 'c', null, null, null, null, null, { callCapture: true }) as unknown as Record<
    string,
    { execute: (input: Record<string, unknown>, ctx: unknown) => Promise<unknown> }
  >

  it('refuses anything but a new action item, decision or milestone, before touching anything', async () => {
    for (const [change_type, entity_type] of [
      ['send_email', 'contact'],
      ['update', 'action'],
      ['assign', 'action'],
      ['delete', 'action'],
      ['create', 'contact'],
      ['update', 'project'],
    ]) {
      const out = await tools.propose_change.execute({ change_type, entity_type, display_text: 'x' }, { toolCallId: 't', messages: [] })
      expect(out, `${change_type}:${entity_type}`).toEqual({ success: false, error: CALL_CAPTURE_CHANGE_REFUSAL })
    }
  })
})

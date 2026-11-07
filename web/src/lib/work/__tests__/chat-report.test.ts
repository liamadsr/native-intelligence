/**
 * A chat-requested run reports back in the conversation that asked (bots v2,
 * phase 7): the recorder's won transitions of an origin 'chat' row into
 * needs_review / needs_input / failed / canceled append ONE assistant message
 * there, in the run owner's name and workspace, worded as the teammate.
 *
 * Against the stateful fake, whose chat_messages upsert honors the
 * (conversation_id, ui_message_id) unique index, so "written once" is a real
 * property: a retried settle, a replayed report and a re-parked question each
 * leave exactly one row.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from './fake-supabase'

const hoisted = vi.hoisted(() => ({ createNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))
// The recorder wakes the agent router (and the home turn) through Inngest: mocked,
// so no test sends a real event (src/test/setup.ts fails any that slip through).
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => ({ ids: [] })) } }))

import { attachWork, findWork, startWork, type StartWorkInput } from '../recorder'
import { deliverWorkReport, reportWorkToChat, failureReason, type ChatReportRow } from '../chat-report'
import { ensureWorkForAgentRun, mirrorAgentRunStatus, resetAgentRunMirrorCaches } from '../agent-run-mirror'
import { NO_REPORT_BACK } from '../reaper'
import type { WorkItem } from '../types'
import { prepBrief } from '@/lib/agent-events/meeting-prep'
import { prepFireKey } from '@/lib/agent-events/meeting-soon'
import { meetingKey } from '@/lib/agent-events/upcoming-meetings'
import { teammateReportContextLine, parseTeammateReport } from '@/lib/chat/teammate-report'

const CHAT_ROW: StartWorkInput = {
  workspaceId: 'w1',
  memberId: 'm1',
  kind: 'work_run',
  title: 'Draft a Q3 recap for the board',
  actor: 'agent',
  status: 'running',
  runKey: 'run-1',
  agentRunId: 'run-1',
  origin: 'chat',
  aiTeamMemberId: 'tm-writer',
  source: { agent_run_id: 'run-1', chat_conversation_id: 'conv-1' },
}

const REVIEW = { kind: 'review', verb: 'review' } as const

function seeded(): FakeSupabase {
  const fake = makeFakeSupabase()
  fake.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1' }])
  fake.seed('ai_team_member', [{ id: 'tm-writer', workspace_id: 'w1', name: 'Quill', role: 'writer' }])
  fake.seed('chat_conversations', [{ id: 'conv-1', user_id: 'u1', workspace_id: 'w1' }])
  return fake
}

type Stored = {
  conversation_id: string
  user_id: string
  workspace_id: string
  role: string
  ui_message_id: string
  ui_message: { id: string; role: string; parts: Array<Record<string, unknown>>; metadata: Record<string, unknown> }
}
const messages = (fake: FakeSupabase) => fake.rows('chat_messages') as unknown as Stored[]
const texts = (fake: FakeSupabase) => messages(fake).map((m) => m.ui_message.parts[0]?.text)

beforeEach(() => {
  hoisted.createNotification.mockClear()
  resetAgentRunMirrorCaches()
})

describe('a chat-requested run reports back in its conversation', () => {
  it('finished with a draft: one message as the teammate, in the owner’s conversation, with the chip', async () => {
    const fake = seeded()
    const work = await startWork(fake as never, CHAT_ROW)
    await work.finish({ summary: 'Recap drafted', deliverables: [{ type: 'document', id: 'doc-1', label: 'Q3 recap' }], review: REVIEW })

    const rows = messages(fake)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ conversation_id: 'conv-1', user_id: 'u1', workspace_id: 'w1', role: 'assistant' })
    expect(rows[0].ui_message.id).toBe('teammate-report-run-1-needs_review')
    expect(rows[0].ui_message.parts).toEqual([
      { type: 'text', text: 'Quill finished **Q3 recap** — ready for your review.' },
      {
        type: 'data-teammate-report',
        // A result's chip opens to its output (Liam, 10-15): the primary deliverable rides on it.
        data: {
          work_item_id: work.id,
          workspace_id: 'w1',
          status: 'needs_review',
          title: 'Draft a Q3 recap for the board',
          deliverable: { type: 'document', id: 'doc-1', label: 'Q3 recap' },
        },
      },
    ])
    expect(rows[0].ui_message.metadata).toMatchObject({
      eve_written: true,
      kind: 'teammate_report',
      teammate_report: {
        run_id: 'run-1',
        work_item_id: work.id,
        status: 'needs_review',
        teammate_id: 'tm-writer',
        teammate_name: 'Quill',
        deliverables: [{ type: 'document', id: 'doc-1', label: 'Q3 recap' }],
      },
    })
    // The notification is unchanged: it still targets (and opens) the work item.
    expect(hoisted.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'work_needs_you', targetType: 'work_item', targetId: work.id }),
    )
  })

  it('a retried settle writes nothing new: the second handle loses the CAS', async () => {
    const fake = seeded()
    const work = await startWork(fake as never, CHAT_ROW)
    const args = { deliverables: [{ type: 'document' as const, id: 'doc-1', label: 'Q3 recap' }], review: REVIEW }
    await work.finish(args)
    const again = attachWork(fake as never, (await findWork(fake as never, { agentRunId: 'run-1' })) as WorkItem)
    await again.finish(args)
    expect(messages(fake)).toHaveLength(1)
  })

  it('is idempotent per run and status: the same report twice is one row', async () => {
    const fake = seeded()
    const work = await startWork(fake as never, CHAT_ROW)
    const row: ChatReportRow = {
      id: work.id as string,
      workspace_id: 'w1',
      member_id: 'm1',
      title: 'Draft a Q3 recap for the board',
      agent_run_id: 'run-1',
      ai_team_member_id: 'tm-writer',
      chat_conversation_id: 'conv-1',
      needs: { kind: 'review', verb: 'review' },
      deliverables: [{ type: 'document', id: 'doc-1', label: 'Q3 recap' }],
      result_summary: null,
      error_message: null,
    }
    expect(await reportWorkToChat(fake as never, row, 'needs_review')).toBe(true)
    expect(await reportWorkToChat(fake as never, row, 'needs_review')).toBe(false)
    expect(messages(fake)).toHaveLength(1)
    // Another status of the same run is its own report.
    expect(await reportWorkToChat(fake as never, { ...row, error_message: 'Model timed out' }, 'failed')).toBe(true)
    expect(messages(fake).map((m) => m.ui_message_id)).toEqual(['teammate-report-run-1-needs_review', 'teammate-report-run-1-failed'])
  })

  it('a question: once per question, a re-park of the same one is absorbed, a new one is reported', async () => {
    const fake = seeded()
    const work = await startWork(fake as never, CHAT_ROW)
    await work.needInput([{ question: 'Which quarter, fiscal or calendar?' }])
    expect(texts(fake)).toEqual(['Quill has a question for you about **Draft a Q3 recap for the board**.'])

    // The same park again (a replayed settle on a fresh handle): the CAS refuses it.
    const replay = attachWork(fake as never, (await findWork(fake as never, { agentRunId: 'run-1' })) as WorkItem)
    await replay.needInput([{ question: 'Which quarter, fiscal or calendar?' }])
    expect(messages(fake)).toHaveLength(1)

    // Answered, resumed, then a different question: a second report.
    await work.resume()
    await work.needInput(['Should it include the pricing decision?'])
    expect(texts(fake)).toEqual([
      'Quill has a question for you about **Draft a Q3 recap for the board**.',
      'Quill has a question for you about **Draft a Q3 recap for the board**.',
    ])
    const ids = messages(fake).map((m) => m.ui_message_id)
    expect(ids[0]).toMatch(/^teammate-report-run-1-needs_input-[0-9a-f]{8}$/)
    expect(ids[1]).not.toBe(ids[0])
  })

  it('a failure says why in a few words; a cancel says it was canceled', async () => {
    const fake = seeded()
    const failed = await startWork(fake as never, CHAT_ROW)
    await failed.fail('AI usage limit reached for this workspace')
    const canceled = await startWork(fake as never, { ...CHAT_ROW, runKey: 'run-2', agentRunId: 'run-2', title: 'Find three competitors' })
    await canceled.cancel('Canceled by user')
    expect(texts(fake)).toEqual([
      "Quill couldn't finish **Draft a Q3 recap for the board**: the AI usage limit was reached",
      'Quill stopped work on **Find three competitors** — it was canceled.',
    ])
    expect(messages(fake).map((m) => m.ui_message_id)).toEqual(['teammate-report-run-1-failed', 'teammate-report-run-2-canceled'])
    // Nothing delivered: the chips carry no output, so they open the item.
    for (const m of messages(fake)) {
      const chip = (m.ui_message.parts as Array<{ type: string; data?: Record<string, unknown> }>).find((p) => p.type === 'data-teammate-report')
      expect(chip?.data).not.toHaveProperty('deliverable')
    }
  })

  it('a result’s chip carries its primary deliverable whole: a long link the report’s own copy withholds', async () => {
    const fake = seeded()
    const work = await startWork(fake as never, CHAT_ROW)
    const url = `https://example.com/${'a'.repeat(120)}`
    await work.finish({ deliverables: [{ type: 'url', id: url, label: 'The page' }], review: REVIEW })
    const [row] = messages(fake)
    const chip = (row.ui_message.parts as Array<{ type: string; data?: Record<string, unknown> }>).find((p) => p.type === 'data-teammate-report')
    expect(chip?.data?.deliverable).toEqual({ type: 'url', id: url, label: 'The page' })
    expect((row.ui_message.metadata as { teammate_report: { deliverables: Array<{ id: string }> } }).teammate_report.deliverables[0].id).toBe('')
  })

  it('reaches the chat through the agent_run mirror, the funnel every settle site uses', async () => {
    const fake = seeded()
    await ensureWorkForAgentRun(fake as never, {
      id: 'run-9',
      workspace_id: 'w1',
      kind: 'workspace',
      status: 'queued',
      triggered_by: 'u1',
      task_prompt: 'Research the Acme renewal\n\nThe person requested this work through the main chat assistant.',
      origin: 'chat',
      ai_team_member_id: 'tm-writer',
      chat_conversation_id: 'conv-1',
    })
    await mirrorAgentRunStatus(fake as never, { agentRunId: 'run-9', workspaceId: 'w1' }, { status: 'running' })
    expect(messages(fake)).toHaveLength(0)
    await mirrorAgentRunStatus(
      fake as never,
      { agentRunId: 'run-9', workspaceId: 'w1' },
      { status: 'completed', summary: 'Two risks found', deliverables: [{ type: 'document', id: 'doc-9', label: 'Acme renewal notes' }] },
    )
    expect(texts(fake)).toEqual(['Quill finished **Acme renewal notes** — ready for your review.'])
  })
})

describe('a meeting prep is delivered, not waiting (docs/plans/chat-ui-polish.md Phase 5)', () => {
  it('finishes done through the mirror, still reports to the chat, and waits on nobody', async () => {
    const fake = seeded()
    fake.seed('agent_run', [{ id: 'run-p', workspace_id: 'w1', server_helper: 'meeting_prep', triggered_by: 'u1' }])
    await ensureWorkForAgentRun(fake as never, {
      id: 'run-p',
      workspace_id: 'w1',
      kind: 'workspace',
      status: 'queued',
      triggered_by: 'u1',
      task_prompt: 'Prepare the person for their meeting at 12:15 PM EDT on Sunday, October 18.',
      origin: 'chat',
      ai_team_member_id: 'tm-writer',
      chat_conversation_id: 'conv-1',
    })
    await mirrorAgentRunStatus(
      fake as never,
      { agentRunId: 'run-p', workspaceId: 'w1' },
      { status: 'completed', summary: 'Prep ready', deliverables: [{ type: 'document', id: 'doc-p', label: 'Prep — Delilah’s shower' }] },
    )
    expect(fake.rows('tracked_job')[0]).toMatchObject({ status: 'done', needs: null })
    expect(texts(fake)).toEqual(['Quill finished **Prep — Delilah’s shower**.'])
    const chip = messages(fake)[0].ui_message.parts[1] as { data: Record<string, unknown> }
    expect(chip.data).toMatchObject({ status: 'done', deliverable: { type: 'document', id: 'doc-p' } })
    // Nothing waits on the person, so nothing pushes.
    expect(hoisted.createNotification).not.toHaveBeenCalled()
  })

  it('any other completed run with a deliverable still waits on review', async () => {
    const fake = seeded()
    fake.seed('agent_run', [{ id: 'run-q', workspace_id: 'w1', server_helper: null, triggered_by: 'u1' }])
    await ensureWorkForAgentRun(fake as never, {
      id: 'run-q', workspace_id: 'w1', kind: 'workspace', status: 'queued', triggered_by: 'u1',
      task_prompt: 'Research Acme', origin: 'chat', ai_team_member_id: 'tm-writer', chat_conversation_id: 'conv-1',
    })
    await mirrorAgentRunStatus(fake as never, { agentRunId: 'run-q', workspaceId: 'w1' }, { status: 'completed', deliverables: [{ type: 'document', id: 'd', label: 'Notes' }] })
    expect(fake.rows('tracked_job')[0]).toMatchObject({ status: 'needs_review' })
  })

  it('a plain done (no reportDone) still reports nothing', async () => {
    const fake = seeded()
    const work = await startWork(fake as never, CHAT_ROW)
    await work.finish({ deliverables: [{ type: 'document', id: 'd', label: 'Doc' }] })
    expect(messages(fake)).toHaveLength(0)
    const reported = await startWork(fake as never, { ...CHAT_ROW, runKey: 'run-r', agentRunId: 'run-r' })
    await reported.finish({ deliverables: [{ type: 'document', id: 'd2', label: 'Doc' }], reportDone: true })
    expect(texts(fake)).toEqual(['Quill finished **Doc**.'])
  })
})

describe('what does not report', () => {
  it('a run nobody asked for in chat (origin user, attempt, delegation) writes no chat message', async () => {
    const fake = seeded()
    for (const [i, origin] of (['user', 'attempt', 'delegation'] as const).entries()) {
      // Even with a conversation id on the source, only a chat root reports.
      const work = await startWork(fake as never, { ...CHAT_ROW, runKey: `r-${i}`, agentRunId: `r-${i}`, origin })
      await work.finish({ deliverables: [{ type: 'document', id: `d-${i}`, label: 'Doc' }], review: REVIEW })
    }
    const plain = await startWork(fake as never, { ...CHAT_ROW, runKey: 'r-plain', agentRunId: 'r-plain', origin: undefined, source: {} })
    await plain.fail('boom')
    expect(messages(fake)).toHaveLength(0)
  })

  it('a chat root reports only its settles: steps, a delegation park and a plain done stay quiet', async () => {
    const fake = seeded()
    const work = await startWork(fake as never, { ...CHAT_ROW, status: 'queued' })
    await work.step('Reading the brief')
    await work.waitOnChild({ workItemId: 'child-1', role: 'researcher', label: 'Researcher', count: 1 })
    await work.resume()
    await work.finish({ summary: 'Nothing to review' })
    expect(messages(fake)).toHaveLength(0)
  })

  it('never writes into a conversation the run owner does not own', async () => {
    const fake = seeded()
    fake.rows('chat_conversations')[0].user_id = 'someone-else'
    const work = await startWork(fake as never, CHAT_ROW)
    await work.finish({ deliverables: [{ type: 'document', id: 'doc-1', label: 'Q3 recap' }], review: REVIEW })
    expect(messages(fake)).toHaveLength(0)
    // The move and its push are untouched.
    expect(fake.rows('tracked_job')[0].status).toBe('needs_review')
    expect(hoisted.createNotification).toHaveBeenCalled()
  })

  it('a deleted conversation is skipped without failing the settle', async () => {
    const fake = seeded()
    fake.rows('chat_conversations').splice(0)
    const work = await startWork(fake as never, CHAT_ROW)
    await work.fail('Model timed out')
    expect(messages(fake)).toHaveLength(0)
    expect(fake.rows('tracked_job')[0].status).toBe('failed')
  })
})

describe('failureReason', () => {
  it('says the known failures plainly and keeps any other as written', () => {
    expect(failureReason('Workspace AI usage limit exceeded')).toBe('the AI usage limit was reached')
    expect(failureReason(NO_REPORT_BACK)).toBe('it stopped reporting back')
    expect(failureReason('Model timed out')).toBe('Model timed out')
    expect(failureReason('  ')).toBeNull()
    expect(failureReason(null)).toBeNull()
  })
})

describe('a report in a home thread asks for a server turn (home/turn.requested, A4)', () => {
  const rowFor = (id: string): ChatReportRow => ({
    id,
    workspace_id: 'w1',
    member_id: 'm1',
    title: 'Research Acme',
    agent_run_id: 'run-1',
    ai_team_member_id: null,
    chat_conversation_id: 'conv-1',
    needs: { kind: 'review', verb: 'review' },
    deliverables: [],
    result_summary: 'Done',
    error_message: null,
  })
  const homeFake = (isHome: boolean | null) => {
    const fake = makeFakeSupabase()
    fake.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1' }])
    fake.seed('chat_conversations', [{ id: 'conv-1', user_id: 'u1', workspace_id: 'w1', is_home: isHome }])
    return fake
  }

  it('a landed report in the home thread sends one event with the conversation, person, workspace and item', async () => {
    const fake = homeFake(true)
    const send = vi.fn(async () => {})
    expect(await reportWorkToChat(fake as never, rowFor('item-1'), 'needs_review', { send })).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      id: 'home-turn-requested:teammate-report-run-1-needs_review',
      name: 'home/turn.requested',
      data: { conversationId: 'conv-1', userId: 'u1', workspaceId: 'w1', workItemIds: ['item-1'], reason: 'helper_report' },
    })
    // The same report again writes nothing new, so it asks for nothing new.
    expect(await reportWorkToChat(fake as never, rowFor('item-1'), 'needs_review', { send })).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a muted row (a server-started meeting prep, A6) lands its report but asks for no home turn', async () => {
    const send = vi.fn(async () => {})
    expect(await reportWorkToChat(homeFake(true) as never, { ...rowFor('item-9'), quiet: true }, 'needs_review', { send })).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it("a meeting prep's report knows its meeting: metadata.meeting_prep, its start in the person's zone, and its document stamped", async () => {
    const fake = homeFake(true)
    const key = meetingKey('calendar_event', 'evt-1')
    const start = '2026-10-17T16:00:00.000Z'
    const doc = '3f0c8a52-6d2b-4c51-9a39-5d2f2b1f7e10'
    fake.rows('member')[0].time_zone = 'America/New_York'
    fake.seed('agent_run', [
      {
        id: 'run-1',
        workspace_id: 'w1',
        server_helper: 'meeting_prep',
        triggered_by: 'u1',
        fire_key: prepFireKey('conv-1', { meetingKey: key, startIso: start }),
        task_prompt: prepBrief(
          { ref: 'calendar_event', meetingKey: key, workspaceId: 'w1', userId: 'u1', conversationId: 'conv-1', title: null, startIso: start, endIso: '2026-10-17T18:00:00.000Z', calendarEventId: 'evt-1', captureId: 'cap-1', audience: 'external', seriesKey: null, icalUid: null },
          { timeZone: 'America/New_York' },
        ).taskPrompt,
      },
    ])
    fake.seed('document', [{ id: doc, workspace_id: 'w1', frontmatter: {} }])
    const send = vi.fn(async () => {})
    const row = { ...rowFor('item-7'), quiet: true, deliverables: [{ type: 'document' as const, id: doc, label: 'Prep — Physical therapy' }] }
    expect(await reportWorkToChat(fake as never, row, 'needs_review', { send })).toBe(true)
    const meta = messages(fake)[0].ui_message.metadata
    expect(meta.meeting_prep).toEqual({ startIso: start, endIso: '2026-10-17T18:00:00.000Z', calendarEventId: 'evt-1', captureId: 'cap-1', meetingKey: key })
    const report = parseTeammateReport(meta.teammate_report)!
    expect(report.meeting).toEqual({ start_iso: start, label: '12:00 PM EDT on Saturday, October 17' })
    expect(teammateReportContextLine(report)).toContain('the prep for their meeting at 12:00 PM EDT on Saturday, October 17')
    expect(fake.rows('document')[0].frontmatter).toEqual({
      meeting_prep: { startIso: start, endIso: '2026-10-17T18:00:00.000Z', calendarEventId: 'evt-1', captureId: 'cap-1', meetingKey: key, userId: 'u1' },
    })
    expect(send).not.toHaveBeenCalled()
  })

  it("a meeting prep's report carries its enrichment offer: the brief's contacts still not enriched, by the name on their card", async () => {
    const fake = makeFakeSupabase({ rpc: { contact_visible_to: () => ({ data: true, error: null }) } })
    fake.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1' }])
    fake.seed('chat_conversations', [{ id: 'conv-1', user_id: 'u1', workspace_id: 'w1', is_home: true }])
    const key = meetingKey('calendar_event', 'evt-1')
    const start = '2026-10-17T16:00:00.000Z'
    const dana = '11111111-1111-4111-8111-111111111111'
    const sam = '22222222-2222-4222-8222-222222222222'
    fake.seed('contact', [
      { id: dana, workspace_id: 'w1', full_name: 'Dana Lee', email: 'dana@acme.example', enrichment_status: null, metadata: {}, member_id: null, merged_into_contact_id: null },
      // Enriched since the prep started: not offered.
      { id: sam, workspace_id: 'w1', full_name: 'Sam Ortiz', email: 'sam@acme.example', enrichment_status: 'enriched', metadata: {}, member_id: null, merged_into_contact_id: null },
    ])
    fake.seed('agent_run', [
      {
        id: 'run-1',
        workspace_id: 'w1',
        server_helper: 'meeting_prep',
        triggered_by: 'u1',
        fire_key: prepFireKey('conv-1', { meetingKey: key, startIso: start }),
        task_prompt: prepBrief(
          { ref: 'calendar_event', meetingKey: key, workspaceId: 'w1', userId: 'u1', conversationId: 'conv-1', title: null, startIso: start, endIso: null, calendarEventId: 'evt-1', captureId: null, audience: 'external', seriesKey: null, icalUid: null },
          { timeZone: 'America/New_York', enrichContactIds: [dana, sam] },
        ).taskPrompt,
      },
    ])
    const row = { ...rowFor('item-7'), quiet: true, deliverables: [{ type: 'document' as const, id: 'doc-1', label: 'Prep — Acme sync' }] }
    expect(await reportWorkToChat(fake as never, row, 'needs_review', { send: vi.fn(async () => {}) })).toBe(true)
    const report = parseTeammateReport(messages(fake)[0].ui_message.metadata.teammate_report)!
    expect(report.enrich_offer).toEqual([{ contact_id: dana, name: 'Dana Lee' }])
    expect(teammateReportContextLine(report)).toContain(`(contact ${dana})`)
  })

  it('any other muted run (a home turn\'s helper) carries no meeting', async () => {
    const fake = homeFake(true)
    fake.seed('agent_run', [{ id: 'run-1', workspace_id: 'w1', server_helper: 'home_turn', triggered_by: 'u1', fire_key: 'x', task_prompt: 'y' }])
    expect(await reportWorkToChat(fake as never, { ...rowFor('item-8'), quiet: true }, 'needs_review', {})).toBe(true)
    expect(messages(fake)[0].ui_message.metadata).not.toHaveProperty('meeting_prep')
    expect(messages(fake)[0].ui_message.metadata.teammate_report).not.toHaveProperty('meeting')
  })

  it('a side chat (not is_home) with no home thread anywhere keeps the report where it was asked, and sends nothing', async () => {
    const send = vi.fn(async () => {})
    expect(await reportWorkToChat(homeFake(null) as never, rowFor('item-2'), 'needs_review', { send })).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  it('a send that fails never fails the report', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const send = vi.fn(async () => {
      throw new Error('inngest down')
    })
    expect(await reportWorkToChat(homeFake(true) as never, rowFor('item-3'), 'failed', { send })).toBe(true)
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe('every report goes home (the one-chat rework: live → main agent bridge)', () => {
  const rowIn = (conversationId: string): ChatReportRow => ({
    id: 'item-live',
    workspace_id: 'w1',
    member_id: 'm1',
    title: 'Look up Acme pricing',
    agent_run_id: 'run-live',
    ai_team_member_id: null,
    chat_conversation_id: conversationId,
    needs: { kind: 'review', verb: 'review' },
    deliverables: [],
    result_summary: 'Found it',
    error_message: null,
  })
  const fakeWithHome = () => {
    const fake = makeFakeSupabase()
    fake.seed('member', [{ id: 'm1', workspace_id: 'w1', user_id: 'u1' }])
    fake.seed('chat_conversations', [
      { id: 'capture-conv', user_id: 'u1', workspace_id: 'w1', is_home: null, capture_id: 'cap-1' },
      { id: 'old-side', user_id: 'u1', workspace_id: 'w1', is_home: null },
      { id: 'home', user_id: 'u1', workspace_id: 'w1', is_home: true },
    ])
    return fake
  }

  it.each([
    ['a capture\'s live conversation', 'capture-conv'],
    ['an old side chat (a helper still running at cutover)', 'old-side'],
  ])('a helper started in %s reports into the owner\'s HOME thread, with a home turn; the push is muted', async (_label, asked) => {
    const fake = fakeWithHome()
    const send = vi.fn(async () => {})
    const out = await deliverWorkReport(fake as never, rowIn(asked), 'needs_review', { send })
    expect(out).toEqual({ written: true, home: true, conversationId: 'home', muted: true })
    const rows = messages(fake)
    expect(rows).toHaveLength(1)
    expect(rows[0].conversation_id).toBe('home')
    expect(rows[0].ui_message.metadata).toMatchObject({ kind: 'teammate_report', asked_in_conversation_id: asked })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ name: 'home/turn.requested', data: expect.objectContaining({ conversationId: 'home', reason: 'helper_report', workItemIds: ['item-live'] }) }))
    // A retry converges on the same message: still muted, nothing new asked.
    expect(await deliverWorkReport(fake as never, rowIn(asked), 'needs_review', { send })).toMatchObject({ written: false, home: true, muted: true })
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('a report already asked in the home thread stays there, unmarked', async () => {
    const fake = fakeWithHome()
    const out = await deliverWorkReport(fake as never, rowIn('home'), 'failed', { send: vi.fn(async () => {}) })
    expect(out).toMatchObject({ home: true, conversationId: 'home', muted: true })
    expect(messages(fake)[0].ui_message.metadata).not.toHaveProperty('asked_in_conversation_id')
  })
})

describe('one helper result, one telling', () => {
  const CHAT_HOME: StartWorkInput = { ...CHAT_ROW, runKey: 'run-h', agentRunId: 'run-h', source: { agent_run_id: 'run-h', chat_conversation_id: 'conv-1' } }

  it('a helper RESULT reporting into the home thread sends NO push (the home turn decides)', async () => {
    const fake = seeded()
    fake.rows('chat_conversations')[0].is_home = true
    const work = await startWork(fake as never, CHAT_HOME)
    await work.finish({ summary: 'Recap drafted', deliverables: [{ type: 'document', id: 'doc-1', label: 'Q3 recap' }], review: REVIEW })
    expect(messages(fake)).toHaveLength(1)
    expect(hoisted.createNotification).not.toHaveBeenCalled()
  })

  it('a helper QUESTION or FAILURE reported home keeps its push: a quiet turn must never leave it unseen', async () => {
    const fake = seeded()
    fake.rows('chat_conversations')[0].is_home = true
    const asking = await startWork(fake as never, CHAT_HOME)
    await asking.needInput(['Which tone?'])
    expect(hoisted.createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'work_needs_you' }))
    hoisted.createNotification.mockClear()
    const failing = await startWork(fake as never, { ...CHAT_HOME, runKey: 'run-f', agentRunId: 'run-f', source: { agent_run_id: 'run-f', chat_conversation_id: 'conv-1' } })
    await failing.fail('Model timed out')
    expect(hoisted.createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'work_failed' }))
    expect(messages(fake).length).toBeGreaterThanOrEqual(2)
  })

  it('a helper whose owner has no home thread still gets its push (the only telling)', async () => {
    const fake = seeded()
    const work = await startWork(fake as never, CHAT_HOME)
    await work.finish({ summary: 'Recap drafted', deliverables: [], review: REVIEW })
    expect(hoisted.createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'work_needs_you' }))
  })
})

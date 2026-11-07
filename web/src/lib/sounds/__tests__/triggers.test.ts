// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const shared = vi.hoisted(() => ({ desktop: false, requests: [] as Array<{ sound: string; key: string }> }))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => shared.desktop }))
vi.mock('../alerts', () => ({
  playAlertSound: vi.fn(async (req: { sound: string; key: string }) => {
    shared.requests.push(req)
    return 'played'
  }),
}))

import {
  announceAttentionItem,
  announceNotification,
  announceWorkTransition,
  askKey,
  attentionAlert,
  notificationAlert,
  teammateArrivalSound,
  workTransitionAlert,
  type ArrivalKind,
} from '../triggers'
import { __resetTeammateWorkForTests, cardTeammateId, noteWorkRow } from '../teammate-work'
import { setNativeNotificationsDisabled } from '@/lib/native-notification-path'

const note = (over: Record<string, unknown> = {}) => ({
  id: 'n1',
  type: 'comment_added',
  body: null,
  target_type: null,
  target_id: null,
  is_read: false,
  metadata: {},
  ...over,
})

describe('notificationAlert: the most specific sound for each row', () => {
  it('an ordinary notification plays notification-alert, keyed by its id', () => {
    expect(notificationAlert(note())).toEqual({ sound: 'notification-alert', key: 'notification:n1' })
  })

  it('a row that arrives already read plays nothing', () => {
    expect(notificationAlert(note({ is_read: true }))).toBeNull()
  })

  it('a run parked on a question plays agent-alert, keyed by the question (shared with the chat picker)', () => {
    const req = notificationAlert(
      note({
        type: 'work_needs_you',
        body: '  Which repo should I use?  ',
        target_type: 'work_item',
        target_id: 'w1',
        metadata: { kind: 'work_run', status: 'needs_input' },
      }),
    )
    expect(req).toEqual({ sound: 'agent-alert', key: askKey('Which repo should I use?') })
  })

  it('a run the user started, finished and waiting on review, plays agent-complete', () => {
    for (const kind of ['work_run', 'coding_run']) {
      expect(
        notificationAlert(
          note({ type: 'work_needs_you', target_type: 'work_item', target_id: 'w2', metadata: { kind, status: 'needs_review' } }),
        ),
      ).toEqual({ sound: 'agent-complete', key: 'work:w2:needs_review' })
    }
  })

  it("a loop's deliverable (drafts ready) is an agent needing the user", () => {
    expect(
      notificationAlert(
        note({ type: 'work_needs_you', target_type: 'work_item', target_id: 'w3', metadata: { kind: 'email_drafts', status: 'needs_review' } }),
      ),
    ).toEqual({ sound: 'agent-alert', key: 'work:w3:needs_review' })
  })

  it('a failed run plays agent-alert, never a success chime', () => {
    expect(
      notificationAlert(note({ type: 'work_failed', target_type: 'work_item', target_id: 'w4', metadata: { kind: 'coding_run' } })),
    ).toEqual({ sound: 'agent-alert', key: 'work:w4:failed' })
  })

  it("a loop digest (cards to review) is the agent's; a sequence update is a plain notification", () => {
    expect(notificationAlert(note({ type: 'flow_run_output', target_type: 'work_item', target_id: 'w5' }))?.sound).toBe(
      'agent-alert',
    )
    expect(notificationAlert(note({ type: 'flow_run_output', target_type: 'sequence', target_id: 's1' }))?.sound).toBe(
      'notification-alert',
    )
  })

  it('announceNotification hands the request to the alert layer', () => {
    shared.requests.length = 0
    announceNotification(note({ id: 'n9' }))
    announceNotification(note({ id: 'n10', is_read: true }))
    expect(shared.requests).toEqual([{ sound: 'notification-alert', key: 'notification:n9' }])
  })
})

describe('attention cards', () => {
  beforeEach(() => {
    shared.requests.length = 0
    shared.desktop = false
    setNativeNotificationsDisabled(false)
  })
  afterEach(() => vi.restoreAllMocks())

  it('cards of one run share a key; a card without a run key uses its id', () => {
    expect(attentionAlert({ id: 'c1', status: 'pending', run_key: 'fire-1' })).toEqual({
      sound: 'agent-alert',
      key: 'attention-run:fire-1',
    })
    expect(attentionAlert({ id: 'c2', status: 'pending', run_key: null })).toEqual({
      sound: 'agent-alert',
      key: 'attention:c2',
    })
    expect(attentionAlert({ id: 'c3', status: 'accepted' })).toBeNull()
  })

  it('plays in a browser, even in a background tab', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    announceAttentionItem({ id: 'c1', status: 'pending', run_key: 'fire-1' })
    expect(shared.requests).toHaveLength(1)
  })

  it('desktop, window focused: plays', () => {
    shared.desktop = true
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    announceAttentionItem({ id: 'c1', status: 'pending' })
    expect(shared.requests).toHaveLength(1)
  })

  it('desktop, no window focused: silent — the run\'s notification is a native banner with its own sound', () => {
    shared.desktop = true
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    announceAttentionItem({ id: 'c1', status: 'pending' })
    expect(shared.requests).toHaveLength(0)
    // …unless native banners are off (older shell, permission denied): toasts then.
    setNativeNotificationsDisabled(true)
    announceAttentionItem({ id: 'c1', status: 'pending' })
    expect(shared.requests).toHaveLength(1)
  })
})

describe('work ledger transitions', () => {
  const run = (over: Record<string, unknown> = {}) => ({
    id: 'w1',
    kind: 'coding_run',
    status: 'done',
    origin: 'user',
    source: {},
    ...over,
  })

  it('a run the user started finishing straight from running plays agent-complete', () => {
    expect(workTransitionAlert(run(), run({ status: 'running' }))).toEqual({
      sound: 'agent-complete',
      key: 'work:w1:done',
    })
    // Rows from before migration 280 have no origin: they are the user's.
    expect(workTransitionAlert(run({ origin: undefined }), run({ status: 'queued', origin: undefined }))).not.toBeNull()
  })

  it('stays silent for everything a notification already covers, or nobody asked for', () => {
    // A review closing is the user's own act.
    expect(workTransitionAlert(run(), run({ status: 'needs_review' }))).toBeNull()
    // needs_input / needs_review / failed play from their notification rows.
    expect(workTransitionAlert(run({ status: 'needs_review' }), run({ status: 'running' }))).toBeNull()
    expect(workTransitionAlert(run({ status: 'failed' }), run({ status: 'running' }))).toBeNull()
    expect(workTransitionAlert(run({ status: 'canceled' }), run({ status: 'running' }))).toBeNull()
    // Not the user's run.
    expect(workTransitionAlert(run({ origin: 'loop' }), run({ status: 'running', origin: 'loop' }))).toBeNull()
    expect(workTransitionAlert(run({ origin: 'attempt' }), run({ status: 'running' }))).toBeNull()
    expect(workTransitionAlert(run({ kind: 'flow_run' }), run({ status: 'running', kind: 'flow_run' }))).toBeNull()
    // Muted by its producer.
    expect(workTransitionAlert(run({ source: { quiet: true } }), run({ status: 'running' }))).toBeNull()
    // No edge: an UPDATE that doesn't change status (a step beat), or no old row.
    expect(workTransitionAlert(run(), run())).toBeNull()
    expect(workTransitionAlert(run(), null)).toBeNull()
    expect(workTransitionAlert(run(), { id: 'w1' })).toBeNull()
  })

  // bots-v4.md Phase 3: the drafting pass finishes done (no review, so no
  // notice). Its row is inserted with no origin and carries the column's
  // default, 'user' (migration 280), so origin doesn't silence it: its kind
  // does. `email_drafts` isn't one of USER_RUN_KINDS (work_run, coding_run),
  // the only kinds whose finishing chimes, so it's as silent as any loop pass.
  it('an email drafting pass finishing done with its drafts is silent (not a kind that chimes)', () => {
    const pass = (over: Record<string, unknown> = {}) =>
      run({ kind: 'email_drafts', origin: 'user', ai_team_member_id: 'tm-corr', ...over })
    expect(workTransitionAlert(pass(), pass({ status: 'running' }))).toBeNull()
    // The same row as a work run would chime: it's the kind, not the origin.
    expect(workTransitionAlert(pass({ kind: 'work_run' }), pass({ kind: 'work_run', status: 'running' }))).not.toBeNull()
  })

  it('announceWorkTransition hands the edge to the alert layer', () => {
    shared.requests.length = 0
    announceWorkTransition(run(), run({ status: 'running' }))
    announceWorkTransition(run(), run())
    expect(shared.requests).toEqual([{ sound: 'agent-complete', key: 'work:w1:done' }])
  })
})

// ── bots-v2 Phase 6: a teammate's arrivals sound like what they are ─────────

describe('teammateArrivalSound: the one place a teammate arrival picks its sound', () => {
  const arrival = (kind: ArrivalKind, over: Record<string, unknown> = {}) =>
    teammateArrivalSound({ kind, teammateId: 'tm-1', fallback: 'agent-alert', ...over })

  it('a question waiting on you, finished work to review and a new card each have their own sound', () => {
    expect(arrival('question')).toBe('agent-alert-questions')
    expect(arrival('review')).toBe('agent-alert-hopful')
    expect(arrival('card')).toBe('agent-alert-arivel')
  })

  it('no teammate: today\'s sound, whatever arrived', () => {
    for (const kind of ['question', 'review', 'card', 'done', 'failed'] as const) {
      expect(arrival(kind, { teammateId: null })).toBe('agent-alert')
      expect(arrival(kind, { teammateId: null, fallback: 'agent-complete' })).toBe('agent-complete')
    }
  })

  it('a failure, or a run finished with nothing to review, keeps today\'s sound', () => {
    expect(arrival('failed')).toBe('agent-alert')
    expect(arrival('done', { fallback: 'agent-complete' })).toBe('agent-complete')
  })
})

describe("notificationAlert: a teammate's work item", () => {
  const needsYou = (status: string, over: Record<string, unknown> = {}) =>
    note({
      type: 'work_needs_you',
      target_type: 'work_item',
      target_id: 'w1',
      metadata: { kind: 'work_run', status },
      ...over,
    })
  const teammate = { teammateId: 'tm-1' }

  it('a question it is waiting on plays agent-alert-questions, keyed by the question as before', () => {
    const req = notificationAlert(needsYou('needs_input', { body: ' Which repo should I use? ' }), teammate)
    expect(req).toEqual({ sound: 'agent-alert-questions', key: askKey('Which repo should I use?') })
    // No question text: the work item's key, as before.
    expect(notificationAlert(needsYou('needs_input'), teammate)).toEqual({
      sound: 'agent-alert-questions',
      key: 'work:w1:needs_input',
    })
  })

  it('finished work to review plays agent-alert-hopful, keyed by the item as before', () => {
    // A run the user started (agent-complete without a teammate) …
    expect(notificationAlert(needsYou('needs_review'), teammate)).toEqual({
      sound: 'agent-alert-hopful',
      key: 'work:w1:needs_review',
    })
    // … and a loop's deliverable (agent-alert without one).
    expect(
      notificationAlert(needsYou('needs_review', { metadata: { kind: 'skill_run', status: 'needs_review' } }), teammate),
    ).toEqual({ sound: 'agent-alert-hopful', key: 'work:w1:needs_review' })
  })

  it("an email pass's row is any teammate's: its sound", () => {
    const emailPass = needsYou('needs_review', { metadata: { kind: 'email_drafts', status: 'needs_review' } })
    expect(notificationAlert(emailPass, { teammateId: 'tm-1' })).toEqual({
      sound: 'agent-alert-hopful',
      key: 'work:w1:needs_review',
    })
  })

  it("a row with no teammate, or one this window hasn't seen, plays today's sound", () => {
    expect(notificationAlert(needsYou('needs_review'), { teammateId: null })?.sound).toBe(
      'agent-complete',
    )
    expect(notificationAlert(needsYou('needs_review'), null)?.sound).toBe('agent-complete')
    expect(notificationAlert(needsYou('needs_input', { body: 'Which repo?' }), null)?.sound).toBe('agent-alert')
  })

  it("a teammate's failure and its loop digest keep today's sounds", () => {
    expect(
      notificationAlert(note({ type: 'work_failed', target_type: 'work_item', target_id: 'w1', metadata: {} }), teammate),
    ).toEqual({ sound: 'agent-alert', key: 'work:w1:failed' })
    expect(
      notificationAlert(note({ type: 'flow_run_output', target_type: 'work_item', target_id: 'w1' }), teammate)?.sound,
    ).toBe('agent-alert')
  })
})

describe('announceNotification reads whose the work item is from the rows this window has seen', () => {
  beforeEach(() => {
    shared.requests.length = 0
    __resetTeammateWorkForTests()
  })

  it("a teammate's row seen on the ledger channel: its sound", () => {
    noteWorkRow({ id: 'w7', kind: 'work_run', ai_team_member_id: 'tm-1' })
    announceNotification(
      note({ id: 'n7', type: 'work_needs_you', target_type: 'work_item', target_id: 'w7', metadata: { kind: 'work_run', status: 'needs_review' } }),
    )
    expect(shared.requests).toEqual([{ sound: 'agent-alert-hopful', key: 'work:w7:needs_review' }])
  })

  it("a row without a teammate and a row never seen: today's sounds; an email pass's row is any teammate's", () => {
    noteWorkRow({ id: 'w8', kind: 'work_run', ai_team_member_id: null })
    noteWorkRow({ id: 'w9', kind: 'email_drafts', ai_team_member_id: 'tm-2' })
    const review = (id: string, kind: string) =>
      note({ id: `n-${id}`, type: 'work_needs_you', target_type: 'work_item', target_id: id, metadata: { kind, status: 'needs_review' } })
    announceNotification(review('w8', 'work_run'))
    announceNotification(review('w9', 'email_drafts'))
    announceNotification(review('w10', 'work_run'))
    expect(shared.requests).toEqual([
      { sound: 'agent-complete', key: 'work:w8:needs_review' },
      { sound: 'agent-alert-hopful', key: 'work:w9:needs_review' },
      { sound: 'agent-complete', key: 'work:w10:needs_review' },
    ])
  })

  it('one arrival seen by the ledger channel and the notification is one sound, under the key it always had', () => {
    // The recorder moves the row (realtime UPDATE), then writes the notification.
    const prev = { id: 'w11', kind: 'work_run', status: 'running', origin: 'user', ai_team_member_id: 'tm-1', source: {} }
    const next = { ...prev, status: 'needs_review' }
    noteWorkRow(next)
    announceWorkTransition(next, prev)
    expect(shared.requests).toEqual([])
    announceNotification(
      note({ id: 'n11', type: 'work_needs_you', target_type: 'work_item', target_id: 'w11', metadata: { kind: 'work_run', status: 'needs_review' } }),
    )
    // The same key as before Phase 6, so the alert layer's dedupe (another
    // window, a replay) still makes it one sound.
    expect(shared.requests).toEqual([{ sound: 'agent-alert-hopful', key: 'work:w11:needs_review' }])
  })
})

describe('cards from a teammate', () => {
  beforeEach(() => {
    shared.requests.length = 0
    shared.desktop = false
    setNativeNotificationsDisabled(false)
    __resetTeammateWorkForTests()
  })
  afterEach(() => vi.restoreAllMocks())

  it('a card attributable to a teammate plays agent-alert-arivel, keyed as before', () => {
    expect(attentionAlert({ id: 'c1', status: 'pending', run_key: 'fire-1' }, 'tm-1')).toEqual({
      sound: 'agent-alert-arivel',
      key: 'attention-run:fire-1',
    })
    expect(attentionAlert({ id: 'c2', status: 'pending' }, 'tm-1')).toEqual({
      sound: 'agent-alert-arivel',
      key: 'attention:c2',
    })
  })

  it("a teammate's loop fire: its cards find the teammate on the fire's row", () => {
    // Triage's fire row, inserted as the fire starts (run_key `<fire>:<flow>`).
    noteWorkRow({ id: 'loop-1', kind: 'flow_run', run_key: 'fire-1:flow-1', ai_team_member_id: 'tm-triage' })
    announceAttentionItem({ id: 'c1', status: 'pending', run_key: 'fire-1', source_flow_run_id: null, payload: {} })
    expect(shared.requests).toEqual([{ sound: 'agent-alert-arivel', key: 'attention-run:fire-1' }])
  })

  it('a card whose run link points at a teammate\'s run is that teammate\'s', () => {
    noteWorkRow({ id: 'loop-2', kind: 'flow_run', run_key: null, flow_run_id: 'fr-2', ai_team_member_id: 'tm-rec' })
    announceAttentionItem({ id: 'c3', status: 'pending', run_key: null, source_flow_run_id: 'fr-2' })
    expect(shared.requests.map((r) => r.sound)).toEqual(['agent-alert-arivel'])
  })

  // bots-v4.md decision 9: a card is its raiser's; the teammate a work proposal
  // names to do the work owns nothing, so its card names no teammate here.
  it('a work proposal naming a teammate to do the work, with no raiser known, keeps agent-alert', () => {
    expect(cardTeammateId({ run_key: null, payload: { assignee_ai_member_id: 'tm-writer' } as never })).toBeNull()
    announceAttentionItem({ id: 'c2', status: 'pending', run_key: null, payload: { assignee_ai_member_id: 'tm-writer' } })
    expect(shared.requests).toEqual([{ sound: 'agent-alert', key: expect.any(String) }])
    // Its raiser is who it's attributed to, whoever it proposes.
    expect(cardTeammateId({ payload: { raised_by_ai_member_id: 'tm-triage', assignee_ai_member_id: 'tm-writer' } as never })).toBe('tm-triage')
  })

  it("a card from a person's own loop, or one nothing names, keeps agent-alert", () => {
    noteWorkRow({ id: 'loop-3', kind: 'flow_run', run_key: 'fire-3:flow-3', ai_team_member_id: null })
    announceAttentionItem({ id: 'c4', status: 'pending', run_key: 'fire-3' })
    announceAttentionItem({ id: 'c5', status: 'pending', run_key: 'fire-unknown' })
    // A run key that merely looks like a fire, on a row that isn't a loop's.
    noteWorkRow({ id: 'w-x', kind: 'work_run', run_key: 'fire-6:x', ai_team_member_id: 'tm-1' })
    announceAttentionItem({ id: 'c6', status: 'pending', run_key: 'fire-6' })
    expect(shared.requests).toEqual([
      { sound: 'agent-alert', key: 'attention-run:fire-3' },
      { sound: 'agent-alert', key: 'attention-run:fire-unknown' },
      { sound: 'agent-alert', key: 'attention-run:fire-6' },
    ])
  })

  it("a fire that ran a teammate's loop AND a person's own: the person's cards keep agent-alert", () => {
    // One fire fans out to two loops, one after the other: Triage's, then the person's own.
    noteWorkRow({ id: 'loop-t', kind: 'flow_run', run_key: 'fire-9:flow-triage', ai_team_member_id: 'tm-triage' })
    announceAttentionItem({ id: 'c-t', status: 'pending', run_key: 'fire-9' })
    noteWorkRow({ id: 'loop-p', kind: 'flow_run', run_key: 'fire-9:flow-mine', ai_team_member_id: null })
    // A later payload of either row does not undo it.
    noteWorkRow({ id: 'loop-t', kind: 'flow_run', run_key: 'fire-9:flow-triage', ai_team_member_id: 'tm-triage' })
    announceAttentionItem({ id: 'c-p', status: 'pending', run_key: 'fire-9' })
    expect(attentionAlert({ id: 'c-p', status: 'pending', run_key: 'fire-9' })).toEqual({
      sound: 'agent-alert',
      key: 'attention-run:fire-9',
    })
    // Before the second loop's row, the fire was Triage's alone.
    expect(shared.requests[0]).toEqual({ sound: 'agent-alert-arivel', key: 'attention-run:fire-9' })
  })

  it('the person’s loop first, then a teammate’s: the fire is mixed, so its cards keep agent-alert', () => {
    noteWorkRow({ id: 'loop-p', kind: 'flow_run', run_key: 'fire-10:flow-mine', ai_team_member_id: null })
    noteWorkRow({ id: 'loop-t', kind: 'flow_run', run_key: 'fire-10:flow-triage', ai_team_member_id: 'tm-triage' })
    expect(attentionAlert({ id: 'c1', status: 'pending', run_key: 'fire-10' })).toEqual({
      sound: 'agent-alert',
      key: 'attention-run:fire-10',
    })
    // Two teammates' loops in one fire are mixed too.
    noteWorkRow({ id: 'loop-a', kind: 'flow_run', run_key: 'fire-11:flow-a', ai_team_member_id: 'tm-triage' })
    noteWorkRow({ id: 'loop-b', kind: 'flow_run', run_key: 'fire-11:flow-b', ai_team_member_id: 'tm-rec' })
    expect(attentionAlert({ id: 'c2', status: 'pending', run_key: 'fire-11' })).toMatchObject({ sound: 'agent-alert' })
    // The teammate a work proposal names to do the work doesn't make it anyone's (decision 9).
    expect(attentionAlert({ id: 'c3', status: 'pending', run_key: 'fire-11', payload: { assignee_ai_member_id: 'tm-writer' } })).toMatchObject({
      sound: 'agent-alert',
    })
  })

  it('a card that names who raised it (bots v3 1a) is that teammate’s, even in a mixed fire', () => {
    noteWorkRow({ id: 'loop-p', kind: 'flow_run', run_key: 'fire-13:flow-mine', ai_team_member_id: null })
    noteWorkRow({ id: 'loop-t', kind: 'flow_run', run_key: 'fire-13:flow-triage', ai_team_member_id: 'tm-triage' })
    expect(
      attentionAlert({ id: 'c1', status: 'pending', run_key: 'fire-13', payload: { raised_by_ai_member_id: 'tm-triage' } }),
    ).toMatchObject({ sound: 'agent-alert-arivel' })
  })

  it('a row re-stamped with its teammate (the same row, a later payload) is not a second owner', () => {
    noteWorkRow({ id: 'loop-s', kind: 'flow_run', run_key: 'fire-12:flow-1', ai_team_member_id: null })
    noteWorkRow({ id: 'loop-s', kind: 'flow_run', run_key: 'fire-12:flow-1', ai_team_member_id: 'tm-triage' })
    expect(attentionAlert({ id: 'c1', status: 'pending', run_key: 'fire-12' })).toMatchObject({ sound: 'agent-alert-arivel' })
  })

  it("desktop, no window focused: a teammate's card stays silent too (the banner sounds)", () => {
    shared.desktop = true
    vi.spyOn(document, 'hasFocus').mockReturnValue(false)
    announceAttentionItem({ id: 'c7', status: 'pending', payload: { raised_by_ai_member_id: 'tm-1' } })
    expect(shared.requests).toHaveLength(0)
  })
})

describe("a teammate's run finishing with nothing to review", () => {
  it('still plays agent-complete', () => {
    const run = { id: 'w1', kind: 'work_run', origin: 'user', ai_team_member_id: 'tm-1', source: {} }
    expect(workTransitionAlert({ ...run, status: 'done' }, { ...run, status: 'running' })).toEqual({
      sound: 'agent-complete',
      key: 'work:w1:done',
    })
  })
})

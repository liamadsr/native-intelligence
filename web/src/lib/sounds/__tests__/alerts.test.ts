// @vitest-environment jsdom
/**
 * The alert gates, with two "windows": two fresh copies of the sound modules
 * (vi.resetModules) sharing what real windows share — the origin's Web Locks,
 * its localStorage and its BroadcastChannels. Each copy gets its own engine
 * mock, so a window can be one that can't play yet (never clicked).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

interface FakeEngine {
  canPlay: boolean
}

const shared = vi.hoisted(() => ({ plays: [] as string[], desktop: false, engines: [] as FakeEngine[] }))

vi.mock('@/lib/platform', () => ({ isDesktopApp: () => shared.desktop }))

/** A fresh engine mock for the next module copy (a mock factory's result
 *  outlives vi.resetModules; a new doMock does not). */
function mockEngineForNextWindow() {
  vi.doMock('../engine', () => {
    const engine: FakeEngine = { canPlay: true }
    shared.engines.push(engine)
    return {
      canPlaySoundsNow: () => engine.canPlay,
      playSound: (name: string) => {
        shared.plays.push(name)
        return { name, started: Promise.resolve(true), ended: Promise.resolve(), stop: () => {} }
      },
    }
  })
}

/** A LockManager with the parts the sound code uses: exclusive locks,
 *  ifAvailable, holding for as long as the callback's promise, and query. */
class FakeLocks {
  held = new Set<string>()
  async request(name: string, options: { ifAvailable?: boolean }, callback: (lock: unknown) => unknown) {
    if (this.held.has(name)) {
      if (options.ifAvailable) return callback(null)
      throw new Error(`test lock manager: ${name} is contended`)
    }
    this.held.add(name)
    try {
      return await callback({ name })
    } finally {
      this.held.delete(name)
    }
  }
  async query() {
    return { held: [...this.held].map((name) => ({ name })) }
  }
}

type AlertsModule = typeof import('../alerts')
type QuietModule = typeof import('../quiet')
type SettingsModule = typeof import('../settings')
type TriggersModule = typeof import('../triggers')
type TeammatesModule = typeof import('../teammate-work')

interface Win {
  alerts: AlertsModule
  quiet: QuietModule
  settings: SettingsModule
  /** The paths' sound choice and this window's memory of whose rows are (bots-v2 Phase 6). */
  triggers: TriggersModule
  teammates: TeammatesModule
  engine: FakeEngine
}

const FAST = {
  NOTIFICATION_GRACE_MS: 40,
  KEY_HOLD_MS: 150,
  RECENT_KEY_TTL_MS: 60_000,
  AGENT_PRECEDENCE_MS: 400,
  COOLDOWN_MS: 120,
}

async function openWindow(): Promise<Win> {
  vi.resetModules()
  mockEngineForNextWindow()
  const enginesBefore = shared.engines.length
  const alerts = await import('../alerts')
  Object.assign(alerts.ALERT_TIMING, FAST)
  const quiet = await import('../quiet')
  const settings = await import('../settings')
  const triggers = await import('../triggers')
  const teammates = await import('../teammate-work')
  expect(shared.engines.length).toBe(enginesBefore + 1)
  return { alerts, quiet, settings, triggers, teammates, engine: shared.engines[shared.engines.length - 1] }
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

let locks: FakeLocks
const opened: Win[] = []

async function win(): Promise<Win> {
  const w = await openWindow()
  opened.push(w)
  return w
}

describe('playAlertSound', () => {
  beforeEach(() => {
    shared.plays.length = 0
    shared.engines.length = 0
    window.localStorage.clear()
    locks = new FakeLocks()
    Object.defineProperty(navigator, 'locks', { value: locks, configurable: true })
  })

  afterEach(async () => {
    for (const w of opened.splice(0)) {
      w.alerts.__resetAlertsForTests()
      w.quiet.__resetSoundQuietForTests()
    }
    // Let held claims lapse so nothing leaks into the next test.
    await wait(FAST.KEY_HOLD_MS + 20)
    Reflect.deleteProperty(navigator, 'locks')
  })

  it('plays an agent sound', async () => {
    const a = await win()
    await expect(a.alerts.playAlertSound({ sound: 'agent-alert', key: 'attention:1' })).resolves.toBe('played')
    expect(shared.plays).toEqual(['agent-alert'])
  })

  it('plays nothing when Sound effects is off', async () => {
    const a = await win()
    a.settings.setSoundEffectsEnabled(false)
    await expect(a.alerts.playAlertSound({ sound: 'agent-alert', key: 'attention:1' })).resolves.toBe('off')
    expect(shared.plays).toEqual([])
  })

  it('one sound per event across windows', async () => {
    const a = await win()
    const b = await win()
    const outcomes = await Promise.all([
      a.alerts.playAlertSound({ sound: 'agent-complete', key: 'work:w1:done' }),
      b.alerts.playAlertSound({ sound: 'agent-complete', key: 'work:w1:done' }),
    ])
    expect(outcomes.sort()).toEqual(['duplicate', 'played'])
    expect(shared.plays).toEqual(['agent-complete'])
  })

  it('a replay of the same event after the claim lapsed stays silent (reload, late window)', async () => {
    const a = await win()
    await expect(a.alerts.playAlertSound({ sound: 'agent-complete', key: 'work:w9:done' })).resolves.toBe('played')
    await wait(FAST.KEY_HOLD_MS + FAST.COOLDOWN_MS + 20)
    const b = await win()
    await expect(b.alerts.playAlertSound({ sound: 'agent-complete', key: 'work:w9:done' })).resolves.toBe('duplicate')
    expect(shared.plays).toEqual(['agent-complete'])
  })

  it('a question: one sound for one arrival, but the same question asked again later chimes again', async () => {
    const a = await win()
    const b = await win()
    // One arrival seen by the notification path and the chat path at once.
    const outcomes = await Promise.all([
      a.alerts.playAlertSound({ sound: 'agent-alert', key: 'ask:abc' }),
      b.alerts.playAlertSound({ sound: 'agent-alert', key: 'ask:abc' }),
    ])
    expect(outcomes.sort()).toEqual(['duplicate', 'played'])
    // Minutes later (well inside the recent-key memory) it is asked again.
    await wait(FAST.KEY_HOLD_MS + FAST.COOLDOWN_MS + 20)
    await expect(b.alerts.playAlertSound({ sound: 'agent-alert', key: 'ask:abc' })).resolves.toBe('played')
    expect(shared.plays).toEqual(['agent-alert', 'agent-alert'])
  })

  it('a window that cannot play yet (never clicked) claims nothing: the window that can plays', async () => {
    const idle = await win()
    const active = await win()
    idle.engine.canPlay = false
    // The idle tab hears it first and bows out without taking the claim …
    await expect(idle.alerts.playAlertSound({ sound: 'agent-complete', key: 'work:w3:done' })).resolves.toBe(
      'unavailable',
    )
    // … so neither the event lock nor the recent-key memory holds it.
    await expect(active.alerts.playAlertSound({ sound: 'agent-complete', key: 'work:w3:done' })).resolves.toBe(
      'played',
    )
    expect(shared.plays).toEqual(['agent-complete'])
  })

  it('a window that cannot play takes no cooldown either', async () => {
    const idle = await win()
    const active = await win()
    idle.engine.canPlay = false
    const outcomes = await Promise.all([
      idle.alerts.playAlertSound({ sound: 'agent-alert', key: 'attention:u1' }),
      active.alerts.playAlertSound({ sound: 'agent-alert', key: 'attention:u2' }),
    ])
    expect(outcomes).toEqual(['unavailable', 'played'])
    expect(shared.plays).toEqual(['agent-alert'])
  })

  it('a notification plays after its grace', async () => {
    const a = await win()
    await expect(a.alerts.playAlertSound({ sound: 'notification-alert', key: 'notification:n1' })).resolves.toBe(
      'played',
    )
    expect(shared.plays).toEqual(['notification-alert'])
  })

  it('the most specific sound wins: an agent sound supersedes a notification about the same happening', async () => {
    const a = await win()
    const note = a.alerts.playAlertSound({ sound: 'notification-alert', key: 'notification:n1' })
    // The agent path hears it a moment later — still inside the grace.
    await wait(5)
    await expect(a.alerts.playAlertSound({ sound: 'agent-alert', key: 'attention-run:r1' })).resolves.toBe('played')
    await expect(note).resolves.toBe('superseded')
    expect(shared.plays).toEqual(['agent-alert'])
  })

  it('…and across windows (the agent path won in the other window)', async () => {
    const a = await win()
    const b = await win()
    await expect(a.alerts.playAlertSound({ sound: 'agent-complete', key: 'work:w2:done' })).resolves.toBe('played')
    await expect(b.alerts.playAlertSound({ sound: 'notification-alert', key: 'notification:n2' })).resolves.toBe(
      'superseded',
    )
    expect(shared.plays).toEqual(['agent-complete'])
  })

  it('stays quiet while this window holds the mic, and the event is spent', async () => {
    const a = await win()
    const release = a.quiet.holdSoundQuiet('dictation')
    await expect(a.alerts.playAlertSound({ sound: 'agent-alert', key: 'attention:q1' })).resolves.toBe('quiet')
    release()
    await expect(a.alerts.playAlertSound({ sound: 'agent-alert', key: 'attention:q1' })).resolves.toBe('duplicate')
    expect(shared.plays).toEqual([])
  })

  it('stays quiet while ANOTHER window records (its hold is a Web Lock)', async () => {
    const a = await win()
    const b = await win()
    const release = a.quiet.holdSoundQuiet('capture')
    await wait(0)
    await expect(b.alerts.playAlertSound({ sound: 'agent-alert', key: 'attention:q2' })).resolves.toBe('quiet')
    release()
    await wait(0)
    await expect(b.alerts.playAlertSound({ sound: 'agent-alert', key: 'attention:q3' })).resolves.toBe('played')
    expect(shared.plays).toEqual(['agent-alert'])
  })

  it('a burst of distinct events is one chime (cooldown)', async () => {
    const a = await win()
    const b = await win()
    const outcomes = await Promise.all([
      a.alerts.playAlertSound({ sound: 'agent-alert', key: 'attention:c1' }),
      b.alerts.playAlertSound({ sound: 'agent-alert', key: 'attention:c2' }),
      a.alerts.playAlertSound({ sound: 'agent-alert', key: 'attention:c3' }),
    ])
    expect(outcomes.filter((o) => o === 'played')).toHaveLength(1)
    expect(outcomes.filter((o) => o === 'coalesced')).toHaveLength(2)
    await wait(FAST.COOLDOWN_MS + 20)
    await expect(a.alerts.playAlertSound({ sound: 'agent-alert', key: 'attention:c4' })).resolves.toBe('played')
  })

  it('without Web Locks, windows still pick one (BroadcastChannel claim)', async () => {
    Reflect.deleteProperty(navigator, 'locks')
    const a = await win()
    const b = await win()
    const outcomes = await Promise.all([
      a.alerts.playAlertSound({ sound: 'agent-alert', key: 'attention:bc1' }),
      b.alerts.playAlertSound({ sound: 'agent-alert', key: 'attention:bc1' }),
    ])
    expect(outcomes.filter((o) => o === 'played')).toHaveLength(1)
    expect(shared.plays).toEqual(['agent-alert'])
  })
  // ── bots-v2 Phase 6: an AI teammate's arrivals, through the same gates ─────

  /** A teammate's work item waiting on review, as its notification row. */
  const review = (id: string) => ({
    id: `n-${id}`,
    type: 'work_needs_you',
    target_type: 'work_item',
    target_id: id,
    metadata: { kind: 'work_run', status: 'needs_review' },
  })
  /** The window saw the row on its ledger channel (whose it is). */
  const sawTeammateRow = (w: Win, id: string) =>
    w.teammates.noteWorkRow({ id, kind: 'work_run', ai_team_member_id: 'tm-1' })
  const announce = (w: Win, id: string) => w.alerts.playAlertSound(w.triggers.notificationAlert(review(id))!)

  it("a teammate's arrival in two windows is one sound, its own", async () => {
    const a = await win()
    const b = await win()
    sawTeammateRow(a, 'w1')
    sawTeammateRow(b, 'w1')
    const outcomes = await Promise.all([announce(a, 'w1'), announce(b, 'w1')])
    expect(outcomes.sort()).toEqual(['duplicate', 'played'])
    expect(shared.plays).toEqual(['agent-alert-hopful'])
  })

  it("…and still one sound when one window missed the row (it plays today's sound, under the same key)", async () => {
    const a = await win()
    const b = await win()
    sawTeammateRow(a, 'w2')
    const outcomes = await Promise.all([announce(b, 'w2'), announce(a, 'w2')])
    expect(outcomes.sort()).toEqual(['duplicate', 'played'])
    expect(shared.plays).toHaveLength(1)
  })

  it("a teammate's sound plays nothing when Sound effects is off", async () => {
    const a = await win()
    a.settings.setSoundEffectsEnabled(false)
    sawTeammateRow(a, 'w3')
    await expect(announce(a, 'w3')).resolves.toBe('off')
    expect(shared.plays).toEqual([])
  })

  it("a teammate's sound stays quiet while the mic is live, and the event is spent", async () => {
    const a = await win()
    sawTeammateRow(a, 'w4')
    const release = a.quiet.holdSoundQuiet('voice-mode')
    await expect(announce(a, 'w4')).resolves.toBe('quiet')
    release()
    await expect(announce(a, 'w4')).resolves.toBe('duplicate')
    expect(shared.plays).toEqual([])
  })

  it("a teammate's card and its question in one burst are one chime (cooldown)", async () => {
    const a = await win()
    const card = a.triggers.attentionAlert({ id: 'c1', status: 'pending', run_key: 'fire-9' }, 'tm-1')!
    const question = a.triggers.notificationAlert(
      { id: 'n-q', type: 'work_needs_you', body: 'Which list?', target_type: 'work_item', target_id: 'w5', metadata: { status: 'needs_input' } },
      { teammateId: 'tm-1' },
    )!
    expect([card.sound, question.sound]).toEqual(['agent-alert-arivel', 'agent-alert-questions'])
    const outcomes = await Promise.all([a.alerts.playAlertSound(card), a.alerts.playAlertSound(question)])
    expect(outcomes.sort()).toEqual(['coalesced', 'played'])
    expect(shared.plays).toHaveLength(1)
  })

  it("a teammate's sound is an agent sound: a plain notification about the same happening is superseded", async () => {
    const a = await win()
    const b = await win()
    sawTeammateRow(a, 'w6')
    await expect(announce(a, 'w6')).resolves.toBe('played')
    await expect(b.alerts.playAlertSound({ sound: 'notification-alert', key: 'notification:n6' })).resolves.toBe(
      'superseded',
    )
    expect(shared.plays).toEqual(['agent-alert-hopful'])
  })
})

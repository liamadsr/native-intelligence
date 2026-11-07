import { describe, expect, it } from 'vitest'
import {
  JEV_TIER_MODE,
  ROUTE_EXCERPT_MAX,
  attachmentKind,
  chatThreadModel,
  chatThreadPolicy,
  chatThreadReasoning,
  countCodeFences,
  helperRouteForModel,
  countListItems,
  modelRouteMetadata,
  parseModelRoute,
  parseTurnRouteSignals,
  routeChatTurn,
  routeHelperModel,
  routeHelperTask,
  strongHintLine,
  tierModel,
  tierPolicy,
  tierReasoning,
  turnRouteSignals,
} from '../model-route'
import { DEFAULT_CHAT_POLICY, FLASH_CHAT_POLICY, MAIN_MODEL, STRONG_MODEL, chatModelPolicy, deepseekSurfacePolicy } from '../models'
import { helperTierFixtures, modelTierFixtures, type ModelTierFixture } from '../decisions/__tests__/model-tier-fixtures'

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  image: 'image/png',
  text: 'text/plain',
}

/** What auto selection does with a fixture in the main chat: its tier, or 'strong' when it hands off. */
function autoTier(fx: ModelTierFixture): 'fast' | 'think' | 'strong' {
  const files = (fx.attachments ?? []).map((k, i) => ({ fileName: `f${i}.${k}`, mimeType: MIME[k] ?? 'application/octet-stream' }))
  const route = routeChatTurn(turnRouteSignals(fx.text, files), 'person')
  return route.strongHint ? 'strong' : route.tier
}

describe('model-route: the rules against the labelled fixtures', () => {
  const results = modelTierFixtures.map((fx) => ({ fx, got: autoTier(fx) }))

  it('has about sixty fixtures across the seven categories', () => {
    expect(modelTierFixtures.length).toBeGreaterThanOrEqual(58)
    const counts = Object.fromEntries(['email', 'calendar', 'crm', 'research', 'coding', 'complex', 'chit_chat'].map((c) => [c, modelTierFixtures.filter((f) => f.category === c).length]))
    expect(counts).toEqual({ email: 11, calendar: 8, crm: 9, research: 10, coding: 8, complex: 11, chit_chat: 8 })
    expect(new Set(modelTierFixtures.map((f) => f.name)).size).toBe(modelTierFixtures.length)
  })

  it('never picks Strong on email, calendar or CRM', () => {
    const strong = results.filter((r) => ['email', 'calendar', 'crm'].includes(r.fx.category) && r.got === 'strong')
    expect(strong.map((r) => r.fx.name)).toEqual([])
  })

  it('recalls at least 80% of the Strong coding and complex-analysis requests', () => {
    const wanted = results.filter((r) => ['coding', 'complex'].includes(r.fx.category) && r.fx.expected === 'strong')
    const hit = wanted.filter((r) => r.got === 'strong')
    expect(hit.length / wanted.length).toBeGreaterThanOrEqual(0.8)
  })

  it('picks Strong for no request that does not need it (false Strong at most 2%)', () => {
    const notStrong = results.filter((r) => r.fx.expected !== 'strong')
    const falseStrong = notStrong.filter((r) => r.got === 'strong')
    expect(falseStrong.length / notStrong.length).toBeLessThanOrEqual(0.02)
  })

  it('never thinks on a short confirmation', () => {
    for (const text of ['yes', 'thanks!', 'send it', 'ok go ahead', 'Sounds good.', 'lgtm', 'do it']) {
      expect(routeChatTurn(turnRouteSignals(text), 'person').tier, text).toBe('fast')
    }
  })

  it('agrees with the labels on most of the set (a regression floor, not the bar)', () => {
    const right = results.filter((r) => r.got === r.fx.expected).length
    expect(right / results.length).toBeGreaterThanOrEqual(0.85)
  })
})

describe('model-route: helper tasks', () => {
  it('matches the labelled helper tasks (Think by default for a background helper)', () => {
    for (const fx of helperTierFixtures) {
      const route = routeHelperTask(fx.task, { turnExcerpt: fx.turn, defaultTier: 'think' })
      expect(route.tier, fx.name).toBe(fx.expected)
    }
  })

  it('reads "use the best model" in the task or in the person\'s own message', () => {
    expect(routeHelperTask('Write the plan, using the best model.', { defaultTier: 'think' })).toMatchObject({ tier: 'strong', signals: ['best_model'] })
    expect(routeHelperTask('Write the plan.', { turnExcerpt: 'please use your strongest model', defaultTier: 'think' }).tier).toBe('strong')
    expect(routeHelperTask('Write the plan.', { turnExcerpt: 'thanks', defaultTier: 'think' })).toMatchObject({ tier: 'think', undecided: true })
  })

  it('a quick helper with no clear signal keeps its caller\'s default and says so', () => {
    expect(routeHelperTask('Plan the agenda for the team day.', { defaultTier: 'fast' })).toMatchObject({ tier: 'fast', undecided: true, signals: ['default'] })
  })
})

describe('model-route: routeChatTurn', () => {
  it('fixes the device ask, and runs server, relayed and signal-less turns Fast', () => {
    expect(routeChatTurn(turnRouteSignals('think hard about this'), 'device')).toMatchObject({ tier: 'fast', by: 'fixed', signals: ['device_ask'] })
    expect(routeChatTurn(turnRouteSignals('think hard about this'), 'server')).toMatchObject({ tier: 'fast', by: 'rule', signals: ['server_turn'] })
    expect(routeChatTurn(turnRouteSignals('think hard about this'), 'relay')).toMatchObject({ tier: 'fast', signals: ['relay_turn'] })
    expect(routeChatTurn(null, 'person')).toMatchObject({ tier: 'fast', signals: ['no_signals'], strongHint: null })
  })

  it('thinks on each clear signal', () => {
    const think = (text: string, files: unknown[] = []) => routeChatTurn(turnRouteSignals(text, files), 'person')
    expect(think('Take your time and be thorough here.').signals).toContain('explicit_ask')
    expect(think('x'.repeat(4001)).signals).toContain('long_message')
    expect(think('look', [{ mimeType: 'image/png' }, { mimeType: 'image/png' }]).signals).toContain('attachments')
    expect(think('analyze this', [{ fileName: 'a.csv' }]).signals).toContain('document_analysis')
    expect(think('read this', [{ fileName: 'a.csv' }]).tier).toBe('fast')
    expect(think('1. a\n2. b\n3. c').signals).toContain('many_asks')
    expect(think("that's wrong, try again").signals).toContain('retry')
  })

  it('never puts the thread on Strong: coding is a hint, the tier stays Fast or Think', () => {
    const route = routeChatTurn(turnRouteSignals('Fix this: SELECT a, b FROM t WHERE x = 1'), 'person')
    expect(route.tier).toBe('fast')
    expect(route.strongHint).toBe('coding')
    expect(route.signals).toContain('sql')
    const both = routeChatTurn(turnRouteSignals('Think carefully. Is this diff safe?\ndiff --git a/x b/x\n@@ -1 +1 @@'), 'person')
    expect(both).toMatchObject({ tier: 'think', strongHint: 'coding' })
    expect(strongHintLine('coding')).toMatch(/strong model/)
    expect(strongHintLine('best_model')).toMatch(/best model/)
  })

  it('marks a mid-length turn without signals undecided (Fast), and asks Jev only past 280 characters or with an analysis verb', () => {
    const long = routeChatTurn(turnRouteSignals('I keep wondering whether our onboarding sequence is the reason people churn in the second month, and what we might change about it to keep more of them around, since the numbers lately have not looked great and the team is not sure where to begin with it at all, so I wanted your take before the planning week comes around'), 'person')
    expect(long).toMatchObject({ tier: 'fast', undecided: true, askJev: true })
    expect(routeChatTurn(turnRouteSignals('hi'), 'person')).toMatchObject({ undecided: false, askJev: false, signals: ['short'] })
  })

  it('logs its reasoning: high for Fast and Think alike (Flash always thinks)', () => {
    expect(routeChatTurn(turnRouteSignals('yes'), 'person').reasoning).toBe('high')
    expect(routeChatTurn(turnRouteSignals('think hard'), 'person').reasoning).toBe('high')
  })

  it('ships Jev in shadow', () => {
    expect(JEV_TIER_MODE).toBe('shadow')
  })
})

describe('model-route: signals off the wire', () => {
  it('computes the signals in the browser: head and tail excerpt, long code blocks, list items, file kinds', () => {
    const text = `${'a'.repeat(2000)}think hard`
    const sig = turnRouteSignals(text, [{ fileName: 'x.pdf' }, { mimeType: 'image/jpeg' }, null, { fileName: 'b.xlsx' }])
    expect(sig.chars).toBe(text.length)
    expect(sig.excerpt.length).toBe(ROUTE_EXCERPT_MAX)
    expect(sig.excerpt.endsWith('think hard')).toBe(true)
    expect(sig.attachmentKinds).toEqual(['pdf', 'image', 'xlsx'])
    expect(countCodeFences('```\n' + 'x\n'.repeat(10) + '```')).toBe(1)
    expect(countCodeFences('```\nshort\n```')).toBe(0)
    expect(countListItems('- a\n* b\n1. c\n2) d\nplain')).toBe(4)
    expect(attachmentKind({ fileName: 'notes.md' })).toBe('text')
    expect(attachmentKind({})).toBe('other')
  })

  it('shape-guards a ctx route and drops anything malformed', () => {
    expect(parseTurnRouteSignals(null)).toBeNull()
    expect(parseTurnRouteSignals({ excerpt: 'x', chars: -1, codeFences: 0, listItems: 0 })).toBeNull()
    expect(parseTurnRouteSignals({ excerpt: 'x', chars: 1, codeFences: 0, listItems: 0, attachmentKinds: ['pdf', 'BAD KIND', 3] })).toEqual({
      excerpt: 'x',
      chars: 1,
      attachmentKinds: ['pdf'],
      codeFences: 0,
      listItems: 0,
    })
    expect(parseTurnRouteSignals({ excerpt: 'y'.repeat(5000), chars: 5000, codeFences: 0, listItems: 0 })!.excerpt.length).toBe(ROUTE_EXCERPT_MAX)
  })

  it('shape-guards a reported model_route', () => {
    expect(parseModelRoute({ tier: 'strong', by: 'cap', signals: ['daily_cap', 'Not OK', 5], reasoning: 'high' })).toEqual({ tier: 'strong', by: 'cap', signals: ['daily_cap'], reasoning: 'high' })
    expect(parseModelRoute({ tier: 'max', by: 'rule', signals: [] })).toBeNull()
    expect(parseModelRoute({ tier: 'fast', by: 'person', signals: [] })).toBeNull()
    expect(modelRouteMetadata({ tier: 'fast', by: 'rule', signals: Array.from({ length: 20 }, (_, i) => `s${i}`) }).signals).toHaveLength(12)
    // The main agent's choice: `by: 'agent'` and a roster key; an unknown key is dropped.
    expect(parseModelRoute({ tier: 'strong', by: 'agent', signals: ['chose_opus'], reasoning: 'adaptive', model: 'opus' })).toEqual({ tier: 'strong', by: 'agent', signals: ['chose_opus'], reasoning: 'adaptive', model: 'opus' })
    expect(parseModelRoute({ tier: 'fast', by: 'agent', signals: [], model: 'gpt-99' })).toEqual({ tier: 'fast', by: 'agent', signals: [] })
    expect(modelRouteMetadata({ tier: 'fast', by: 'agent', signals: [], model: 'haiku' })).toEqual({ tier: 'fast', by: 'agent', signals: [], model: 'haiku' })
  })
})

describe('model-route: the tiers\' models', () => {
  it('Fast is Flash with thinking off, Think is Flash at high, Strong is STRONG_MODEL with no reasoning', () => {
    expect(tierModel('fast')).toBe('deepseek-v4-flash')
    expect(tierModel('think')).toBe('deepseek-v4-flash')
    expect(tierModel('strong')).toBe(STRONG_MODEL)
    expect(tierPolicy('fast')).toEqual(FLASH_CHAT_POLICY)
    expect(tierPolicy('think')).toEqual(chatModelPolicy('deepseek-v4-flash', 'standard'))
    expect(tierPolicy('think')).toMatchObject({ reasoning: 'high', gateway: { only: ['wafer', 'alibaba'] } })
    expect(tierPolicy('strong')).toEqual({ contextWindowTokens: 1_000_000 })
    expect(tierReasoning('strong')).toBe('adaptive')
  })
})

describe('model-route: the main chat\'s thread runs MAIN_MODEL', () => {
  it('every tier runs Haiku 5.5 with adaptive thinking; a device ask keeps its tier\'s Flash', () => {
    for (const tier of ['fast', 'think'] as const) {
      expect(chatThreadModel(tier)).toBe(MAIN_MODEL)
      expect(chatThreadPolicy(tier)).toEqual(DEFAULT_CHAT_POLICY)
      expect(chatThreadReasoning(tier)).toBe('adaptive')
    }
    // A device ask keeps Flash, with thinking off: its route has 60 s for up to 12 steps.
    expect(chatThreadModel('fast', { device: true })).toBe('deepseek-v4-flash')
    expect(chatThreadPolicy('fast', { device: true })).toEqual(deepseekSurfacePolicy('deepseek-v4-flash', 'off'))
    expect(chatThreadPolicy('fast', { device: true })).not.toEqual(FLASH_CHAT_POLICY)
    expect(chatThreadReasoning('fast', { device: true })).toBe('none')
  })
})

describe('model-route: a helper\'s model', () => {
  it('the main agent\'s choice decides (by agent), whatever the rules would say', () => {
    expect(routeHelperTask('Fix this SQL: select a, b from t', { defaultTier: 'think', requested: 'haiku' })).toEqual({
      tier: 'fast',
      by: 'agent',
      signals: ['chose_haiku'],
      reasoning: 'adaptive',
      model: 'haiku',
      undecided: false,
    })
    expect(routeHelperTask('find the CFO of Acme', { defaultTier: 'think', requested: 'opus' })).toMatchObject({ tier: 'strong', by: 'agent', model: 'opus' })
    expect(routeHelperTask('find the CFO of Acme', { defaultTier: 'think', requested: 'flash-thinking' })).toMatchObject({ tier: 'think', reasoning: 'high', model: 'flash-thinking' })
  })

  it('a route with no key runs its tier\'s model', () => {
    expect(routeHelperModel({ tier: 'fast' })).toBe('flash')
    expect(routeHelperModel({ tier: 'think' })).toBe('flash-thinking')
    expect(routeHelperModel({ tier: 'strong' })).toBe('sonnet')
    expect(routeHelperModel({ tier: 'strong', model: 'gpt-terra' })).toBe('gpt-terra')
    expect(helperRouteForModel('gpt-luna', 'cap', ['x'])).toEqual({ tier: 'fast', by: 'cap', signals: ['x'], reasoning: 'low', model: 'gpt-luna' })
  })
})

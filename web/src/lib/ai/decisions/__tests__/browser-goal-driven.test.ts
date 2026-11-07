import { describe, expect, it } from 'vitest'
import { browserTaskSchema, taskCompleted } from '@/lib/browser-agent/task-contract'
import { browserInputSchema, browserNext, type BrowserInput } from '../tasks/browser-next'
import type { Evaluation } from '../contracts'
import { browserEvaluation } from './browser-evaluation-result'

function input(): BrowserInput {
  return browserInputSchema.parse({
    task: { goal: 'Find a one-way trip from JFK to LAX on October 6, 2026 around 6 PM and show prices. Do not book.', goalDriven: true },
    history: [],
    observation: { protocol: 'dial8-browser-decision-v1', documentId: 'doc', observationId: 1,
      interactionEpoch: 0, observedAt: 1, url: 'https://example.com/search', title: 'Travel search',
      text: 'Select origin', readyState: 'complete', loading: false,
      viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, scrollWidth: 800, scrollHeight: 1800 },
      elements: [
        { ref: 'e1', role: 'combobox', name: 'Where else?', dialog: 'Select origin', value: '', canType: true,
          disabled: false, sensitive: false, forbidden: false, context: 'Departure airport', destination: '' },
        { ref: 'e2', role: 'combobox', name: 'Where else?', dialog: 'Select destination', value: 'LAX', canType: true,
          disabled: false, sensitive: false, forbidden: false, context: 'Arrival airport', destination: '' },
        { ref: 'e3', role: 'button', name: 'Search', value: '', canType: false,
          disabled: false, sensitive: false, forbidden: false, context: '', destination: '' },
      ],
    },
  })
}
const typing = { action: { choice: 'type_e1', probability: .6, confidence: .2 } }

describe('goal-driven browser task contract', () => {
  it('accepts an internal complete goal without requiring a generated plan or typed-value inventory', () => {
    const task = browserTaskSchema.parse({ goal: 'Search for Ada Lovelace and open the article.', goalDriven: true })
    expect(task).toEqual({ goal: 'Search for Ada Lovelace and open the article.', goalDriven: true,
      bindings: [], completion: [], maxSteps: 24, timeoutMs: 45000 })
    expect(browserTaskSchema.safeParse({ goal: task.goal }).success).toBe(false)
    expect(browserTaskSchema.safeParse({ goal: task.goal, goalDriven: false }).success).toBe(false)
  })

  it('rejects competing milestone semantics and still validates optional literal predicates', () => {
    const task = input().task
    expect(browserTaskSchema.safeParse({ ...task, milestones: [{ goal: 'Open the form.', bindingNames: [] }] }).success).toBe(false)
    expect(browserTaskSchema.safeParse({ ...task, completion: [{ kind: 'text_absent', value: 'Loading' }] }).success).toBe(false)
    expect(browserTaskSchema.safeParse({ ...task, completion: [{ kind: 'heading', value: 'Results' }] }).success).toBe(true)
  })

  it('preserves legacy positive checks, milestone references and supplied-binding requirements', () => {
    const task = browserTaskSchema.parse({ goal: 'Open an article.', completion: [{ kind: 'heading', value: 'Ada Lovelace' }] })
    expect(task).not.toHaveProperty('goalDriven')
    expect(browserTaskSchema.safeParse({ goal: 'Search Berlin', bindings: [],
      milestones: [{ goal: 'Berlin is selected.', bindingNames: ['destination'] }] }).success).toBe(false)
  })
})

describe('goal-driven field selection', () => {
  it('omits a refused typing choice while retaining its click and other actions', () => {
    const fixture = { ...input(), unavailableTypeRefs: ['e1'] }
    const prepared = browserNext.prepare(fixture)!
    if (prepared.questions.action.type !== 'choice') throw new Error('Expected action choices')
    expect(prepared.questions.action.criteria).not.toHaveProperty('type_e1')
    expect(prepared.questions.action.criteria).toHaveProperty('click_e1')
    expect(prepared.questions.action.criteria).toHaveProperty('type_e2')
    expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: 'type_e1' } }), fixture)).toBeNull()
  })
  it('does not offer scrolling of the page behind a blocking dialog', () => {
    const fixture = input()
    fixture.observation.scrollSurface = { scope: 'blocked', name: 'Preferences', width: 800, height: 600,
      scrollX: 0, scrollY: 0, scrollWidth: 800, scrollHeight: 600 }
    const prepared = browserNext.prepare(fixture)!
    if (prepared.questions.action.type !== 'choice') throw new Error('Expected action choices')
    expect(prepared.questions.action.criteria).not.toHaveProperty('scroll_down')
    expect(prepared.questions.action.criteria).not.toHaveProperty('scroll_up')
    expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: 'scroll_down' } }), fixture)).toBeNull()
  })

  it('offers only directions available inside the observed dialog scroll region', () => {
    const fixture = input()
    fixture.observation.scrollSurface = { scope: 'dialog', name: 'Preferences', width: 600, height: 300,
      scrollX: 0, scrollY: 400, scrollWidth: 600, scrollHeight: 700 }
    const prepared = browserNext.prepare(fixture)!
    if (prepared.questions.action.type !== 'choice') throw new Error('Expected action choices')
    expect(prepared.questions.action.criteria).not.toHaveProperty('scroll_down')
    expect(prepared.questions.action.criteria).toHaveProperty('scroll_up')
    expect(JSON.parse(prepared.state).scrollSurface).toEqual(fixture.observation.scrollSurface)
  })

  it('offers exact observed editable fields without bindings, with direct dialog and current-value context', () => {
    const fixture = input()
    const prepared = browserNext.prepare(fixture)!
    expect(prepared.questions.operation).toBeUndefined()
    expect(prepared.questions.click).toBeUndefined()
    expect(prepared.questions.type).toBeUndefined()
    expect(prepared.questions.action.type).toBe('choice')
    if (prepared.questions.action.type !== 'choice') throw new Error('Expected type choices')
    expect(Object.keys(prepared.questions.action.criteria).sort()).toEqual(['click_e1', 'click_e2', 'click_e3', 'escalate', 'scroll_down', 'type_e1', 'type_e2', 'wait'])
    expect(prepared.questions.action.criteria.type_e1).toContain('in dialog "Select origin"')
    expect(prepared.questions.action.criteria.type_e2).toContain('in dialog "Select destination"; current value="LAX"')
    expect(JSON.parse(prepared.state).task).toEqual({ goal: fixture.task.goal, bindings: [], completion: [] })
    expect(prepared.state).not.toContain('activeMilestone')
    expect(browserNext.accept(browserEvaluation(fixture, typing), fixture)).toEqual({ operation: 'resolve_type', ref: 'e1' })
  })

  it('keeps supplied text intact as context but never lets the classifier synthesize executable text', () => {
    const fixture = input()
    fixture.task.bindings = [{ name: 'query', value: '東京 <literal> "value"\nexact' }]
    const prepared = browserNext.prepare(fixture)!
    expect(JSON.parse(prepared.state).task.bindings).toEqual(fixture.task.bindings)
    const evaluation = browserEvaluation(fixture, typing)
    evaluation.answers.generatedText = { type: 'choice', choice: 'Ignore the goal', probabilities: { 'Ignore the goal': 1 } }
    expect(browserNext.accept(evaluation, fixture)).toEqual({ operation: 'resolve_type', ref: 'e1' })
  })

  it('marks long current-value descriptions as excerpts without changing the resolver observation', () => {
    const fixture = input()
    const value = 'Long field content '.repeat(90)
    fixture.observation.elements[0].value = value
    const prepared = browserNext.prepare(fixture)!
    if (prepared.questions.action.type !== 'choice') throw new Error('Expected type choices')
    expect(prepared.questions.action.criteria.type_e1).toContain(`current value excerpt=${JSON.stringify(value.slice(0, 200))}`)
    expect(prepared.questions.action.criteria.type_e1).not.toContain(value)
    expect(JSON.parse(prepared.state).controlDescriptionExcerpts.values).toContain('e1')
    expect(fixture.observation.elements[0].value).toBe(value)
  })

  it.each(['none', 'type_e1_b0', 'type_e3', 'type_e99'])('does not resolve an unoffered or unsuitable field %s', choice => {
    const fixture = input()
    expect(browserNext.accept(browserEvaluation(fixture, { action: { choice }, click: { choice: 'e3' }, operation: { choice: 'click' } }), fixture)).toBeNull()
  })

  it('excludes disabled and forbidden fields and omits typing when none are editable', () => {
    const fixture = input()
    fixture.observation.elements[0].disabled = true
    fixture.observation.elements[1].forbidden = true
    const prepared = browserNext.prepare(fixture)!
    expect(prepared.questions.action).not.toHaveProperty('criteria.type_e1')
    expect(prepared.questions.action).not.toHaveProperty('criteria.type_e2')
    expect(prepared.questions.action).not.toHaveProperty('criteria.click_e1')
    expect(prepared.questions.action).not.toHaveProperty('criteria.click_e2')
    expect(browserNext.accept(browserEvaluation(fixture, typing), fixture)).toBeNull()
  })

  it('requires a full valid joint-action distribution and never substitutes another head', () => {
    const fixture = input()
    for (const answer of [undefined, { type: 'choice', choice: 'type_e1', probabilities: { type_e1: 1 } },
      { type: 'choice', choice: 'type_e1', probabilities: { type_e1: .2, click_e3: .8 } }]) {
      const evaluation = browserEvaluation(fixture, { ...typing, click: { choice: 'e3' } })
      if (answer === undefined) delete evaluation.answers.action
      else evaluation.answers.action = answer as Evaluation['answers'][string]
      expect(browserNext.accept(evaluation, fixture)).toBeNull()
    }
  })

  it('preserves strict sensitive-control checks on the complete joint action', () => {
    const fixture = input()
    fixture.observation.elements[0].sensitive = true
    for (const partial of [{ probability: .84, confidence: .99 }, { probability: .99, confidence: .79 }]) {
      expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: 'type_e1', ...partial } }), fixture)).toBeNull()
    }
    expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: 'type_e1', probability: .85, confidence: .8 } }), fixture))
      .toEqual({ operation: 'resolve_type', ref: 'e1' })
  })

  it('preserves offered click/scroll actions and rejects scrolling beyond observed bounds', () => {
    const fixture = input()
    expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: 'click_e3' } }), fixture))
      .toEqual({ operation: 'click', ref: 'e3' })
    expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: 'scroll_down' } }), fixture)).toEqual({ operation: 'scroll_down' })
    expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: 'scroll_up' } }), fixture)).toBeNull()
  })

  it('keeps structured field-binding actions executable without invoking the new text resolver', () => {
    const fixture = input()
    delete fixture.task.goalDriven
    fixture.task.bindings = [{ name: 'origin', value: 'JFK' }, { name: 'destination', value: 'LAX' }]
    fixture.task.milestones = [{ goal: 'The origin JFK is selected.', bindingNames: ['origin'] },
      { goal: 'The destination LAX is selected.', bindingNames: ['destination'] }]
    expect(browserNext.accept(browserEvaluation(fixture, { operation: { choice: 'type' }, type: { choice: 'e1_b0' } }), fixture))
      .toEqual({ operation: 'type', ref: 'e1', binding: 0 })
    expect(browserNext.accept(browserEvaluation(fixture, { completion: { choice: 'complete' } }), fixture)).toEqual({ operation: 'advance' })
  })
})

describe('goal-driven final completion', () => {
  it('offers an independent whole-goal check and accepts only strictly confident completion', () => {
    const fixture = input()
    const prepared = browserNext.prepare(fixture)!
    expect(prepared.questions.completion.instructions).toContain('ENTIRE task.goal')
    expect(prepared.questions.action).not.toHaveProperty('criteria.done')
    // A weak complete vote never acts directly: the route reviews completion
    // first and runs the chosen step only if the goal is not done.
    for (const partial of [{ probability: .84, confidence: .99 }, { probability: .99, confidence: .79 }]) {
      expect(browserNext.accept(browserEvaluation(fixture, { ...typing, completion: { choice: 'complete', ...partial } }), fixture))
        .toEqual({ operation: 'review_completion', next: { operation: 'resolve_type', ref: 'e1' } })
      expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: 'escalate' }, completion: { choice: 'complete', ...partial } }), fixture)).toBeNull()
    }
    expect(browserNext.accept(browserEvaluation(fixture, { completion: { choice: 'complete', probability: .85, confidence: .8 } }), fixture))
      .toEqual({ operation: 'done' })
  })

  it('never completes from URL/title alone or during loading, including unsolicited complete answers', () => {
    for (const variant of ['empty', 'loading', 'readyState'] as const) {
      const fixture = input()
      if (variant === 'empty') { fixture.observation.text = ''; fixture.observation.elements = [] }
      else if (variant === 'loading') fixture.observation.loading = true
      else fixture.observation.readyState = 'loading'
      expect(taskCompleted(fixture.task, fixture.observation)).toBe(false)
      expect(browserNext.prepare(fixture)!.questions.completion).toBeUndefined()
      const evaluation = browserEvaluation(fixture)
      evaluation.answers.completion = { type: 'choice', choice: 'complete', probabilities: { complete: 1, incomplete: 0 } }
      expect(browserNext.accept(evaluation, fixture)).toEqual({ operation: 'escalate' })
    }
  })

  it('requires every optional literal even after a confident semantic answer', () => {
    const fixture = input()
    fixture.task.completion = [{ kind: 'heading', value: 'Search results' }]
    const evaluation = browserEvaluation(fixture, { completion: { choice: 'complete' } })
    expect(browserNext.accept(evaluation, fixture)).toBeNull()
    fixture.observation.evidence = { headings: [{ name: 'Search results', level: 1 }], dialogs: [], dialogsComplete: true }
    expect(browserNext.accept(evaluation, fixture)).toEqual({ operation: 'done' })
  })

  it('fails closed when the required independent completion head is absent or malformed', () => {
    const fixture = input()
    const evaluation = browserEvaluation(fixture, typing)
    delete evaluation.answers.completion
    expect(browserNext.accept(evaluation, fixture)).toBeNull()
    evaluation.answers.completion = { type: 'choice', choice: 'incomplete', probabilities: { incomplete: 1 } }
    expect(browserNext.accept(evaluation, fixture)).toBeNull()
  })
})

describe('native dropdowns', () => {
  const dropdown = (options: { index: number; label: string; selected?: true }[], extra = {}) => ({ ref: 'e4', role: 'combobox', name: 'Cabin class',
    value: options.find(option => option.selected)?.label ?? '', canType: false, disabled: false, sensitive: false, forbidden: false,
    context: 'Cabin class', destination: '', options, optionsTruncated: false, ...extra })
  function withDropdown(options: { index: number; label: string; selected?: true }[], extra = {}, goal?: string) {
    const fixture = input()
    fixture.observation.elements.push(dropdown(options, extra))
    if (goal) fixture.task.goal = goal
    return browserInputSchema.parse(fixture)
  }
  const cabins = [{ index: 0, label: 'Economy', selected: true as const }, { index: 1, label: 'Premium economy' }, { index: 3, label: 'Business' }]

  it('offers each other observed option as one action and never a useless click on the dropdown', () => {
    const fixture = withDropdown(cabins)
    const action = browserNext.prepare(fixture)!.questions.action
    if (action.type !== 'choice') throw new Error('Expected action choice')
    expect(Object.keys(action.criteria)).toEqual(expect.arrayContaining(['select_e4_1', 'select_e4_3']))
    expect(action.criteria).not.toHaveProperty('select_e4_0')
    expect(action.criteria).not.toHaveProperty('click_e4')
    expect(String(action.criteria.select_e4_3)).toBe('Choose "Business" in e4 ("Cabin class").')
    expect(browserNext.prepare(fixture)!.state).toContain('native dropdown, set by choosing an offered option')
  })

  it('accepts a chosen option with its real index and rejects options that were not offered', () => {
    const fixture = withDropdown(cabins)
    expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: 'select_e4_3' } }), fixture))
      .toEqual({ operation: 'select', ref: 'e4', option: 3 })
    for (const forged of ['select_e4_0', 'select_e4_2', 'select_e9_1']) {
      expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: forged } }), fixture)).toBeNull()
    }
  })

  it('keeps the strict confidence bar for a sensitive dropdown', () => {
    const fixture = withDropdown(cabins, { sensitive: true })
    expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: 'select_e4_1', probability: .84 } }), fixture)).toBeNull()
    expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: 'select_e4_1', probability: .9, confidence: .9 } }), fixture))
      .toEqual({ operation: 'select', ref: 'e4', option: 1 })
  })

  it('keeps only the requested options from a long list so it cannot crowd out the page', () => {
    const countries = Array.from({ length: 100 }, (_, index) => ({ index, label: index === 77 ? 'United States' : `Country ${index}` }))
    const fixture = withDropdown(countries, { name: 'Country', optionsTruncated: true }, 'Set the billing country to United States and continue.')
    const action = browserNext.prepare(fixture)!.questions.action
    if (action.type !== 'choice') throw new Error('Expected action choice')
    const offered = Object.keys(action.criteria).filter(key => key.startsWith('select_'))
    expect(offered).toContain('select_e4_77')
    expect(offered.length).toBeLessThanOrEqual(40)
    expect(Object.keys(action.criteria)).toContain('click_e3')
    expect(browserNext.prepare(fixture)!.state).toContain('option list truncated')
  })

  it('treats a sensitive option as sensitive even on a neutral dropdown', () => {
    const fixture = withDropdown([{ index: 0, label: 'Choose', selected: true }, { index: 1, label: 'Archive' }, { index: 2, label: 'Delete permanently' }])
    expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: 'select_e4_2', probability: .6, confidence: .6 } }), fixture)).toBeNull()
    expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: 'select_e4_1', probability: .6, confidence: .6 } }), fixture))
      .toEqual({ operation: 'select', ref: 'e4', option: 1 })
  })

  it('matches options despite case, spacing and punctuation, and says when nothing matched', () => {
    const times = Array.from({ length: 96 }, (_, index) => ({ index, label: `${Math.floor(index / 4) % 12 || 12}:${String((index % 4) * 15).padStart(2, '0')} ${index < 48 ? 'AM' : 'PM'}` }))
    let fixture = withDropdown(times, { name: 'Time' }, 'Book a table for two at 7:30pm tonight.')
    let action = browserNext.prepare(fixture)!.questions.action
    if (action.type !== 'choice') throw new Error('Expected action choice')
    const pm730 = times.find(time => time.label === '7:30 PM')!.index
    expect(action.criteria).toHaveProperty(`select_e4_${pm730}`)
    fixture = withDropdown(times, { name: 'Time' }, 'Book a table for two this evening.')
    action = browserNext.prepare(fixture)!.questions.action
    if (action.type !== 'choice') throw new Error('Expected action choice')
    expect(Object.keys(action.criteria).some(key => key.startsWith('select_'))).toBe(false)
    expect(browserNext.prepare(fixture)!.state).toContain('none of its observed options matched the request')
  })

  it('keeps dropdown choices within a byte budget even with long dialog names', () => {
    const fixture = input()
    const options = Array.from({ length: 40 }, (_, index) => ({ index, label: `Option ${index} with a reasonably long label` }))
    for (const ref of ['e4', 'e5', 'e6']) fixture.observation.elements.push({ ...dropdown(options), ref, name: 'N'.repeat(300), dialog: 'D'.repeat(300) })
    const parsed = browserInputSchema.parse(fixture)
    const prepared = browserNext.prepare(parsed)!
    const action = prepared.questions.action
    if (action.type !== 'choice') throw new Error('Expected action choice')
    const dropdownBytes = new TextEncoder().encode(JSON.stringify(Object.entries(action.criteria).filter(([key]) => key.startsWith('select_')))).length
    expect(dropdownBytes).toBeLessThanOrEqual(6500)
    expect(new TextEncoder().encode(prepared.state).length + new TextEncoder().encode(JSON.stringify(action)).length).toBeLessThanOrEqual(28000)
  })
})

describe('real keys and embedded frames', () => {
  function keyed(extra: Record<string, unknown> = {}) {
    const fixture = input()
    fixture.observation.elements[0] = { ...fixture.observation.elements[0], dialog: undefined, focused: true, value: 'JFK' }
    return browserInputSchema.parse({ ...fixture, observation: { ...fixture.observation, trustedInput: true, ...extra } })
  }
  const criteria = (fixture: BrowserInput) => {
    const action = browserNext.prepare(fixture)!.questions.action
    if (action.type !== 'choice') throw new Error('Expected action choice')
    return action.criteria
  }

  it('offers Enter only on the focused editable field, and only with real input', () => {
    expect(criteria(keyed())).toHaveProperty('key_enter_e1')
    expect(String(criteria(keyed()).key_enter_e1)).toContain('current value "JFK"')
    expect(criteria(keyed({ trustedInput: false }))).not.toHaveProperty('key_enter_e1')
    const unfocused = keyed()
    delete unfocused.observation.elements[0].focused
    expect(criteria(unfocused)).not.toHaveProperty('key_enter_e1')
  })

  it('offers Escape only when a dialog or expanded control is open', () => {
    expect(criteria(keyed())).not.toHaveProperty('key_escape')
    const expanded = keyed()
    expanded.observation.elements[1] = { ...expanded.observation.elements[1], expanded: 'true' }
    expect(criteria(expanded)).toHaveProperty('key_escape')
    expect(browserNext.accept(browserEvaluation(expanded, { action: { choice: 'key_escape' } }), expanded)).toEqual({ operation: 'press_key', key: 'Escape' })
  })

  it('maps Enter to the focused field and keeps the strict bar for a sensitive one', () => {
    const fixture = keyed()
    expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: 'key_enter_e1' } }), fixture)).toEqual({ operation: 'press_key', key: 'Enter', ref: 'e1' })
    fixture.observation.elements[0].sensitive = true
    expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: 'key_enter_e1', probability: .6, confidence: .6 } }), fixture)).toBeNull()
  })

  it('accepts a control inside an embedded frame and names the frame in its description', () => {
    const fixture = input()
    fixture.observation.elements.push({ ref: 'f0e2', role: 'button', name: 'Reserve', value: '', canType: false, disabled: false, sensitive: false,
      forbidden: false, context: '', destination: '', frame: 'f0', point: { x: 140, y: 230 } })
    const parsed = browserInputSchema.parse({ ...fixture, observation: { ...fixture.observation, frames: [{ key: 'f0', path: [0],
      origin: 'https://widget.example', url: 'https://widget.example/book', documentId: 'doc-0', observationId: 4, interactionEpoch: 0, x: 100, y: 200 }] } })
    expect(criteria(parsed)).toHaveProperty('click_f0e2')
    expect(browserNext.prepare(parsed)!.state).toContain('inside embedded frame \\"https://widget.example\\"')
    expect(browserNext.accept(browserEvaluation(parsed, { action: { choice: 'click_f0e2' } }), parsed)).toEqual({ operation: 'click', ref: 'f0e2' })
  })
})


describe('a large date picker', () => {
  // Measured on Google Flights (prod, 10-07): the open calendar is one dialog
  // whose text-derived name fills the 300-character limit, with a day button
  // per date. Repeating that name in every click choice made one question
  // ~24 KB, so every step escalated with question_budget before Jev was asked.
  const dialog = ('Enter a date or use the arrow keys to change the current date.One wayRound tripOne wayResetOctoberSMTWTFS1234567' +
    '$2998$3619$39710$35311$40312$39713$35214$24715$25716$31717$24418$35919$26320$24921$19022$21923$19324$20525$25926$20527$18028$12929' +
    '$13930$15231$129NovemberSMTWTFS1$2142$1863$1444$1395$1396$').slice(0, 300)
  const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  const control = (ref: string, role: string, name: string, extra: Record<string, unknown> = {}) => ({ ref, role, name, value: '',
    canType: false, disabled: false, sensitive: false, forbidden: false, context: '', destination: '', dialog, ...extra })
  function calendar() {
    const days = Array.from({ length: 94 }, (_, index) => {
      const date = new Date(Date.UTC(2026, 9, 7 + index))
      const label = `${weekday[date.getUTCDay()]}, ${date.toLocaleString('en-US', { month: 'long', timeZone: 'UTC' })} ${date.getUTCDate()}, 2026`
      return control(`e${index + 7}`, 'button', `${label}, departure date, ${100 + index * 3} US dollars`)
    })
    const field = { name: 'Departure', role: 'textbox', value: '', dialog, disabled: false, nameTruncated: false, valueTruncated: false }
    return browserInputSchema.parse({
      task: { goal: 'On the Google Flights page for a one-way trip from New York to Los Angeles, set the departure date to Saturday October 10, 2026, keep the trip as One way for 2 adults, then view the results and list the morning options by price.', goalDriven: true },
      history: ['type e2', 'click e4', 'click e5'],
      observation: { protocol: 'dial8-browser-decision-v1', documentId: 'doc', observationId: 30, interactionEpoch: 4, observedAt: 1,
        url: 'https://www.google.com/travel/flights?tfs=abc', title: 'Find Cheap Flights Worldwide & Book Your Ticket - Google Flights',
        text: Array.from({ length: 40 }, (_, row) => `${row} $${200 + row} ${row + 1} $${210 + row}`).join('\n'), readyState: 'complete', loading: false,
        viewport: { width: 1000, height: 800, scrollX: 0, scrollY: 0, scrollWidth: 1000, scrollHeight: 800 },
        evidence: { headings: [], dialogs: [{ name: dialog, visible: true }], dialogsComplete: false,
          currentFields: [field, { ...field, name: 'One way', role: 'combobox', value: 'One way', expanded: 'false' }],
          currentFieldsScope: 'rendered_form_state', currentFieldsTruncated: false },
        elements: [
          control('e1', 'textbox', 'Departure', { canType: true }), control('e2', 'combobox', 'One way'),
          control('e3', 'button', 'Reset'), control('e4', 'button', 'Done. Search for one-way flights, departing on'),
          control('e5', 'button', 'Previous month'), control('e6', 'button', 'Next month'), ...days,
        ] },
    })
  }

  it('keeps one decision within the model budget and still offers the requested date and Done', () => {
    const fixture = calendar()
    expect(fixture.observation.elements).toHaveLength(100)
    const prepared = browserNext.prepare(fixture)!
    const bytes = (value: string) => new TextEncoder().encode(value).length
    // The exact check run-decision applies before asking Jev.
    const largest = Math.max(...Object.values(prepared.questions).map(question => bytes(JSON.stringify(question))))
    expect(bytes(prepared.state) + largest).toBeLessThanOrEqual(28000)
    expect(JSON.parse(prepared.state)).not.toHaveProperty('stateBudgetExceeded')
    const action = prepared.questions.action
    if (action.type !== 'choice') throw new Error('Expected action choice')
    const october10 = fixture.observation.elements.find(element => element.name.startsWith('Saturday, October 10, 2026'))!
    expect(action.criteria).toHaveProperty(`click_${october10.ref}`)
    expect(action.criteria).toHaveProperty('click_e4')
    expect(action.criteria).toHaveProperty('type_e1')
    expect(action.criteria).toHaveProperty('scroll_down' in action.criteria ? 'scroll_down' : 'escalate')
    expect(action.instructions).toMatch(/Only the \d+ most relevant of 101 click\/type actions are offered/)
    // A trimmed choice is not offered, but its control is still described.
    const offered = Object.keys(action.criteria).filter(key => key.startsWith('click_')).map(key => key.slice(6))
    const trimmed = fixture.observation.elements.find(element => !offered.includes(element.ref))!
    expect(JSON.parse(prepared.state).controls).toHaveProperty(trimmed.ref)
    expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: `click_${trimmed.ref}` } }), fixture)).toBeNull()
    expect(browserNext.accept(browserEvaluation(fixture, { action: { choice: `click_${october10.ref}` } }), fixture))
      .toEqual({ operation: 'click', ref: october10.ref })
  })

  it('offers fewer actions, not none, when the controls alone need most of the input', () => {
    const fixture = calendar()
    fixture.observation.elements = fixture.observation.elements.map((element, index) => ({ ...element,
      name: `${element.name} `.padEnd(150, String.fromCharCode(97 + index % 26)) }))
    const prepared = browserNext.prepare(fixture)!
    const bytes = (value: string) => new TextEncoder().encode(value).length
    const largest = Math.max(...Object.values(prepared.questions).map(question => bytes(JSON.stringify(question))))
    expect(bytes(prepared.state) + largest).toBeLessThanOrEqual(28000)
    const action = prepared.questions.action
    if (action.type !== 'choice') throw new Error('Expected action choice')
    expect(action.criteria).toHaveProperty('type_e1')
    // About 3 KB is left after the state: the highest-ranked days (the
    // requested Saturday first) and the field, not a question_budget escalation.
    const clicks = Object.keys(action.criteria).filter(key => key.startsWith('click_'))
    expect(clicks.length).toBeGreaterThanOrEqual(3)
    expect(clicks[0]).toBe('click_e10')
    expect(fixture.observation.elements.find(element => element.ref === 'e10')!.name).toMatch(/^Saturday, October 10, 2026/)
    expect(bytes(JSON.stringify(action))).toBeLessThan(14000 - 1000)
  })

  it('leaves a small page exactly as before: every control offered, no note', () => {
    const action = browserNext.prepare(input())!.questions.action
    if (action.type !== 'choice') throw new Error('Expected action choice')
    // Same choices and order as before the byte budget (ranked: e2's value LAX matches the goal).
    expect(Object.keys(action.criteria).filter(key => /^(click|type)_/.test(key))).toEqual(['click_e2', 'click_e1', 'click_e3', 'type_e2', 'type_e1'])
    expect(action.instructions).not.toContain('most relevant of')
    expect(action.criteria.click_e1).toBe('Click combobox "Where else?" in dialog "Select origin".')
  })
})

import { describe, expect, it, vi } from 'vitest'
import { executeBrowserTask, type TaskExecutorPorts } from '../task-executor'
import { browserTaskSchema, taskCompleted, type BrowserObservation } from '../task-contract'
import { appendBrowserEvidence } from '../browser-evidence'
import { compactBrowserTaskResult } from '../task-result-summary'

const obs: BrowserObservation = { protocol: 'dial8-browser-decision-v1', documentId: 'doc', observationId: 1, interactionEpoch: 0,
  observedAt: Date.now(), url: 'https://example.com/', title: '', text: 'Search', elements: [{ ref: 'e1', name: 'Search', role: 'button',
    value: '', canType: false, disabled: false, forbidden: false, sensitive: false, context: '', destination: '' }] }
const task = { goal: 'Search', completion: [{ kind: 'text', value: 'Results' }] }
function ports() {
  const abort = new AbortController()
  return { abort, navigate: vi.fn(async (_url: string) => {}), snapshot: vi.fn(async () => obs), decide: vi.fn<TaskExecutorPorts['decide']>(async observation => ({ decision: { status: 'accepted' as const,
    value: observation.text.includes('Results') || observation.text === 'One way' ? { operation: 'done' } : { operation: 'click', ref: 'e1' }, inferenceId: 'id', version: 'v1' }, deadline: Date.now() + 45000 })),
    act: vi.fn(async () => ({ ok: true })), blockedSites: (): readonly string[] => [], approve: vi.fn(async () => true),
    alive: () => true, signal: abort.signal, deadline: Date.now() + 45000 }
}
describe('bounded browser executor', () => {
  it('records the control behind each action choice, accepted or not, without typed values', async () => {
    const page: BrowserObservation = { ...obs, elements: [
      { ...obs.elements[0], ref: 'e7', name: 'Saturday, October 10, 2026, 353 US dollars' },
      { ...obs.elements[0], ref: 'e8', role: 'textbox', name: 'Departure', canType: true, focused: true, value: 'Wed, Oct 7' },
      { ...obs.elements[0], ref: 'e9', role: 'combobox', name: 'Cabin', options: [{ index: 0, label: 'Economy', selected: true }, { index: 1, label: 'Business' }] },
    ], trustedInput: true }
    const p = ports()
    p.snapshot.mockResolvedValue(page)
    const answers = (choice: string) => ({ timingMs: { preparation: 0, authorization: 0, cache: 0, budget: 0, provider: 0, acceptance: 0, accounting: 0, total: 0 },
      answers: { action: { choice, probability: .4, confidence: .3 } } })
    p.decide
      .mockResolvedValueOnce({ decision: { status: 'accepted', value: { operation: 'click', ref: 'e7' }, inferenceId: 'id', version: 'v30', metrics: answers('click_e7') }, deadline: p.deadline })
      .mockResolvedValueOnce({ decision: { status: 'accepted', value: { operation: 'select', ref: 'e9', option: 1 }, inferenceId: 'id', version: 'v30' }, deadline: p.deadline })
      .mockResolvedValueOnce({ decision: { status: 'accepted', value: { operation: 'type', ref: 'e8', value: 'Oct 10' }, inferenceId: 'id', version: 'v30' }, deadline: p.deadline })
      .mockResolvedValueOnce({ decision: { status: 'accepted', value: { operation: 'press_key', key: 'Enter', ref: 'e8' }, inferenceId: 'id', version: 'v30' }, deadline: p.deadline })
      .mockResolvedValue({ decision: { status: 'escalate', reason: 'uncertain', metrics: answers('click_e7') }, deadline: p.deadline })
    const result = await executeBrowserTask({ goal: 'Set the departure date to Oct 10', goalDriven: true }, p)
    expect(result.trace.map(step => step.target)).toEqual([
      { ref: 'e7', role: 'button', name: 'Saturday, October 10, 2026, 353 US dollars' },
      { ref: 'e9', role: 'combobox', name: 'Cabin', option: 'Business' },
      { ref: 'e8', role: 'textbox', name: 'Departure' },
      { ref: 'e8', role: 'textbox', name: 'Departure', key: 'Enter' },
      // An uncertain step still says which control Jev leaned to.
      ...result.trace.slice(4).map(() => ({ ref: 'e7', role: 'button', name: 'Saturday, October 10, 2026, 353 US dollars' })),
    ])
    expect(result.trace.at(-1)?.metrics?.answers?.action).toEqual({ choice: 'click_e7', probability: .4, confidence: .3 })
    expect(JSON.stringify(result.trace)).not.toContain('Oct 10"')
    expect(JSON.stringify(result.trace)).not.toContain('Wed, Oct 7')
    // The parent model never receives the trace.
    expect(compactBrowserTaskResult(result)).not.toHaveProperty('trace')
  })

  it.each(['text_unchanged', 'text_not_supplied'] as const)('reobserves after %s without performing a write or claiming success', async reason => {
    const p = ports()
    p.decide.mockResolvedValueOnce({ decision: { status: 'accepted', value: { operation: 'reobserve', reason }, inferenceId: 'id', version: 'v21' }, deadline: p.deadline })
      .mockResolvedValue({ decision: { status: 'escalate', reason: 'test_finished' }, deadline: p.deadline })
    expect(await executeBrowserTask({ goal: 'Complete the form', goalDriven: true }, p)).toMatchObject({ status: 'escalate', reason: 'test_finished', steps: 0 })
    expect(p.act).not.toHaveBeenCalled()
    expect(p.decide.mock.calls[1][2]).toContain('Text resolver supplied no different authorized value; inspect another supported way to progress.')
    expect(p.snapshot.mock.calls.length).toBeGreaterThan(1)
  })
  it('bounds refusal re-plans and honors Stop before any next selection', async () => {
    const p = ports()
    p.decide.mockResolvedValue({ decision: { status: 'accepted', value: { operation: 'reobserve', reason: 'text_unchanged' }, inferenceId: 'id', version: 'v21' }, deadline: p.deadline })
    expect(await executeBrowserTask({ goal: 'Complete the form', goalDriven: true }, p)).toMatchObject({ status: 'escalate', reason: 'text_replan_budget' })
    expect(p.decide).toHaveBeenCalledTimes(4)
    expect(p.act).not.toHaveBeenCalled()
    const stopped = ports()
    stopped.decide.mockImplementation(async () => { stopped.abort.abort(); return { decision: { status: 'accepted', value: { operation: 'reobserve', reason: 'text_unchanged' }, inferenceId: 'id', version: 'v21' }, deadline: stopped.deadline } })
    expect(await executeBrowserTask({ goal: 'Complete the form', goalDriven: true }, stopped)).toMatchObject({ status: 'cancelled' })
    expect(stopped.decide).toHaveBeenCalledOnce()
  })
  it('hands repeated scroll round trips back for review instead of spending the whole step budget', async () => {
    const p = ports()
    let y = 0
    const viewport = { width: 600, height: 322, scrollX: 0, scrollY: 0, scrollWidth: 600, scrollHeight: 3000 }
    p.snapshot.mockImplementation(async () => ({ ...obs, viewport: { ...viewport, scrollY: y } }))
    p.decide.mockImplementation(async () => ({ decision: { status: 'accepted',
      value: { operation: y === 0 ? 'scroll_down' : 'scroll_up' }, inferenceId: 'id', version: 'v12' }, deadline: p.deadline }))
    p.act.mockImplementation(async () => { y = y === 0 ? 225 : 0; return { ok: true } })
    expect(await executeBrowserTask({ goal: 'Read the list', goalDriven: true }, p))
      .toMatchObject({ status: 'escalate', reason: 'reading_limit' })
    expect(p.act).toHaveBeenCalledTimes(3)
    expect(p.decide).toHaveBeenCalledTimes(4)
  })
  it('reports actual before/after scroll ranges to the next decision', async () => {
    const p = ports()
    const viewport = { width: 1000, height: 600, scrollX: 0, scrollY: 0, scrollWidth: 1000, scrollHeight: 3000 }
    p.snapshot.mockResolvedValue({ ...obs, viewport })
    p.decide.mockResolvedValueOnce({ decision: { status: 'accepted', value: { operation: 'scroll_down' }, inferenceId: 'id', version: 'v12' }, deadline: p.deadline })
      .mockResolvedValue({ decision: { status: 'escalate', reason: 'test_finished' }, deadline: p.deadline })
    p.act.mockImplementation(async () => {
      p.snapshot.mockResolvedValue({ ...obs, observationId: 2, viewport: { ...viewport, scrollY: 420 } })
      return { ok: true }
    })
    await executeBrowserTask({ goal: 'Read the list', goalDriven: true }, p)
    expect(p.decide.mock.calls[1][2]).toEqual(['Scrolled down (page): y=0 -> 420; surface height=600.'])
  })
  it('returns collected reading evidence and the final verified observation without duplicate payloads', async () => {
    const p = ports()
    const previous = { ...obs, documentId: 'earlier', url: 'https://example.com/first', text: 'Earlier result',
      elements: [{ ...obs.elements[0], role: 'link', name: 'Earlier article', destination: 'https://example.com/article-one' }] }
    const final = { ...obs, text: 'Results',
      elements: [{ ...obs.elements[0], role: 'link', name: 'Final article', destination: 'https://example.com/article-two' }] }
    const evidenceLedger = appendBrowserEvidence(undefined, previous, 0)
    p.snapshot.mockResolvedValue(final)
    p.decide.mockResolvedValue({ decision: { status: 'accepted', value: { operation: 'done' }, inferenceId: 'id', version: 'v11' },
      deadline: p.deadline, evidenceLedger })
    const result = await executeBrowserTask({ goal: 'Read both articles', goalDriven: true }, p)
    expect(result.status).toBe('verified')
    const serialized = JSON.stringify(result.evidenceLedger)
    expect(serialized).toContain('https://example.com/article-one')
    expect(serialized).toContain('https://example.com/article-two')
    expect(result).not.toHaveProperty('linkEvidence')
    expect(result).not.toHaveProperty('evidence')
    expect(p.act).not.toHaveBeenCalled()
  })
  it('rejects malformed returned evidence before a native action', async () => {
    const p = ports()
    p.decide.mockResolvedValue({ decision: { status: 'accepted', value: { operation: 'click', ref: 'e1' }, inferenceId: 'id', version: 'v11' },
      deadline: p.deadline, evidenceLedger: { forged: true } as never })
    expect(await executeBrowserTask({ goal: 'Read results', goalDriven: true }, p))
      .toMatchObject({ status: 'escalate', reason: 'invalid_evidence',
        diagnostics: { lastEvidenceFailure: { issueCode: 'invalid_value', section: 'ledger' } } })
    expect(p.act).not.toHaveBeenCalled()
  })
  it('records bounded evidence failure categories without leaking rejected content', async () => {
    const p = ports()
    const ledger = appendBrowserEvidence(undefined, obs, 0)
    ledger.pages[0].links.push({ name: 'private rejected name', url: 'javascript:private-value', firstSeenStep: 0, position: 0 })
    p.decide.mockResolvedValue({ decision: { status: 'accepted', value: { operation: 'click', ref: 'e1' }, inferenceId: 'id', version: 'v11' },
      deadline: p.deadline, evidenceLedger: ledger })
    const result = await executeBrowserTask({ goal: 'Read results', goalDriven: true }, p)
    expect(result).toMatchObject({ status: 'escalate', reason: 'invalid_evidence',
      diagnostics: { lastEvidenceFailure: { issueCode: 'custom', section: 'link' } } })
    expect(JSON.stringify(result)).not.toContain('private')
    expect(p.act).not.toHaveBeenCalled()
  })
  it('types goal-resolved text on the exact observed field and retains helper accounting', async () => {
    const p = ports()
    p.snapshot.mockResolvedValue({ ...obs, elements: [{ ...obs.elements[0], canType: true, role: 'textbox' }] })
    const metrics = { invoked: true, model: 'model', timingMs: { authorization: 1, budget: 1, generation: 50, accounting: 1, total: 53 }, usage: { known: false, costSource: 'unknown' as const } }
    p.decide.mockResolvedValueOnce({ decision: { status: 'accepted', value: { operation: 'type', ref: 'e1', value: 'JFK' }, inferenceId: 'id', version: 'v10' }, textMetrics: metrics, deadline: p.deadline })
      .mockResolvedValue({ decision: { status: 'escalate', reason: 'test_finished' }, deadline: p.deadline })
    const result = await executeBrowserTask({ goal: 'Find flights from JFK', goalDriven: true }, p)
    expect(p.act).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'type', ref: 'e1', text: 'JFK', documentId: 'doc', observationId: 1 }))
    expect(result.trace[0].textMetrics).toEqual(metrics)
    expect(p.decide.mock.calls[1][2]).not.toContain('JFK') // history contains field identity, not generated values
  })
  it('chooses an observed dropdown option as a guarded form write', async () => {
    const p = ports()
    const select = { ...obs.elements[0], role: 'combobox', name: 'Cabin', options: [{ index: 0, label: 'Economy', selected: true as const }, { index: 2, label: 'Business' }] }
    p.snapshot.mockResolvedValue({ ...obs, elements: [select] })
    p.decide.mockResolvedValueOnce({ decision: { status: 'accepted', value: { operation: 'select', ref: 'e1', option: 2 }, inferenceId: 'id', version: 'v28' }, deadline: p.deadline })
      .mockResolvedValue({ decision: { status: 'escalate', reason: 'test_finished' }, deadline: p.deadline })
    const result = await executeBrowserTask({ goal: 'Choose business class', goalDriven: true }, p)
    expect(p.act).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'select', ref: 'e1', option: 2, documentId: 'doc', observationId: 1 }))
    expect(result).toMatchObject({ status: 'escalate', reason: 'test_finished' })
    expect(p.decide.mock.calls[1][2]).toEqual(['Chose "Business" in combobox "Cabin".'])
    const forged = ports()
    forged.snapshot.mockResolvedValue({ ...obs, elements: [select] })
    forged.decide.mockResolvedValue({ decision: { status: 'accepted', value: { operation: 'select', ref: 'e1', option: 1 }, inferenceId: 'id', version: 'v28' }, deadline: forged.deadline })
    expect(await executeBrowserTask({ goal: 'Choose business class', goalDriven: true }, forged)).toMatchObject({ status: 'escalate', reason: 'invalid_target' })
    expect(forged.act).not.toHaveBeenCalled()
  })
  it('sends Enter only for the observed focused field, and only with real input', async () => {
    const p = ports()
    const field = { ...obs.elements[0], role: 'textbox', name: 'Query', canType: true, focused: true as const }
    p.snapshot.mockResolvedValue({ ...obs, trustedInput: true, elements: [field] })
    p.decide.mockResolvedValueOnce({ decision: { status: 'accepted', value: { operation: 'press_key', key: 'Enter', ref: 'e1' }, inferenceId: 'id', version: 'v29' }, deadline: p.deadline })
      .mockResolvedValue({ decision: { status: 'escalate', reason: 'test_finished' }, deadline: p.deadline })
    await executeBrowserTask({ goal: 'Search', goalDriven: true }, p)
    expect(p.act).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'press_key', key: 'Enter', ref: 'e1', documentId: 'doc', observationId: 1 }))
    expect(p.decide.mock.calls[1][2]).toEqual(['Pressed Enter in textbox "Query".'])
    for (const observation of [{ ...obs, trustedInput: false, elements: [field] }, { ...obs, trustedInput: true, elements: [{ ...field, focused: undefined }] }]) {
      const refused = ports()
      refused.snapshot.mockResolvedValue(observation)
      refused.decide.mockResolvedValue({ decision: { status: 'accepted', value: { operation: 'press_key', key: 'Enter', ref: 'e1' }, inferenceId: 'id', version: 'v29' }, deadline: refused.deadline })
      expect(await executeBrowserTask({ goal: 'Search', goalDriven: true }, refused)).toMatchObject({ status: 'escalate', reason: 'invalid_target' })
      expect(refused.act).not.toHaveBeenCalled()
    }
  })
  it('asks approval before Enter sends or submits something consequential', async () => {
    const p = ports()
    p.approve.mockResolvedValue(false)
    const composer = { ...obs.elements[0], role: 'textbox', name: 'Message', canType: true, focused: true as const, enterSensitive: true as const }
    p.snapshot.mockResolvedValue({ ...obs, trustedInput: true, elements: [composer] })
    p.decide.mockResolvedValue({ decision: { status: 'accepted', value: { operation: 'press_key', key: 'Enter', ref: 'e1' }, inferenceId: 'id', version: 'v29' }, deadline: p.deadline })
    expect(await executeBrowserTask({ goal: 'Reply to Sam', goalDriven: true }, p)).toMatchObject({ status: 'cancelled', reason: 'approval_declined' })
    expect(p.approve).toHaveBeenCalledWith(expect.stringContaining('Press Enter in Message'))
    expect(p.act).not.toHaveBeenCalled()
  })
  it('acts inside an embedded frame through its own observation and every enclosing one', async () => {
    const p = ports()
    const frames = [
      { key: 'f0', path: [3], origin: 'https://outer.example', url: 'https://outer.example/', documentId: 'outer', observationId: 5, interactionEpoch: 1, x: 400, y: 200 },
      { key: 'f1', path: [3, 0], origin: 'https://widget.example', url: 'https://widget.example/book', documentId: 'inner', observationId: 9, interactionEpoch: 2, x: 410, y: 230 },
    ]
    const reserve = { ...obs.elements[0], ref: 'f1e4', name: 'Reserve', frame: 'f1', point: { x: 450, y: 260 } }
    p.snapshot.mockResolvedValue({ ...obs, trustedInput: true, frames, elements: [obs.elements[0], reserve] })
    p.decide.mockResolvedValueOnce({ decision: { status: 'accepted', value: { operation: 'click', ref: 'f1e4' }, inferenceId: 'id', version: 'v29' }, deadline: p.deadline })
      .mockResolvedValue({ decision: { status: 'escalate', reason: 'test_finished' }, deadline: p.deadline })
    await executeBrowserTask({ goal: 'Reserve a table', goalDriven: true }, p)
    expect(p.act).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ operation: 'click', ref: 'e4', documentId: 'inner', observationId: 9,
      interactionEpoch: 2, frame: { path: [3, 0], point: { x: 450, y: 260 }, ancestors: [
        { documentId: 'doc', observationId: 1, interactionEpoch: 0 }, { documentId: 'outer', observationId: 5, interactionEpoch: 1 }] } }))
    const restricted = ports()
    restricted.snapshot.mockResolvedValue({ ...obs, frames: [{ ...frames[0], key: 'f0', origin: 'https://js.stripe.com', path: [0] }],
      elements: [{ ...reserve, ref: 'f0e4', frame: 'f0' }] })
    restricted.decide.mockResolvedValue({ decision: { status: 'accepted', value: { operation: 'click', ref: 'f0e4' }, inferenceId: 'id', version: 'v29' }, deadline: restricted.deadline })
    expect(await executeBrowserTask({ goal: 'Pay', goalDriven: true }, restricted)).toMatchObject({ status: 'escalate', reason: 'restricted_frame' })
    expect(restricted.act).not.toHaveBeenCalled()
  })
  it('asks approval for a sensitive option and names it in the prompt', async () => {
    const p = ports()
    const select = { ...obs.elements[0], role: 'combobox', name: 'Bulk action', options: [{ index: 0, label: 'Choose', selected: true as const }, { index: 3, label: 'Delete permanently' }] }
    p.snapshot.mockResolvedValue({ ...obs, elements: [select] })
    p.approve.mockResolvedValue(false)
    p.decide.mockResolvedValue({ decision: { status: 'accepted', value: { operation: 'select', ref: 'e1', option: 3 }, inferenceId: 'id', version: 'v28' }, deadline: p.deadline })
    expect(await executeBrowserTask({ goal: 'Clean up the list', goalDriven: true }, p)).toMatchObject({ status: 'cancelled', reason: 'approval_declined' })
    expect(p.approve).toHaveBeenCalledWith(expect.stringContaining('Bulk action → Delete permanently'))
    expect(p.act).not.toHaveBeenCalled()
  })
  it.each(['legacy', 'not_editable', 'unresolved'] as const)('refuses an invalid resolved typing action: %s', async condition => {
    const p = ports()
    p.snapshot.mockResolvedValue({ ...obs, elements: [{ ...obs.elements[0], canType: condition !== 'not_editable' }] })
    p.decide.mockResolvedValue({ decision: { status: 'accepted', value: condition === 'unresolved'
      ? { operation: 'resolve_type', ref: 'e1' } as never : { operation: 'type', ref: 'e1', value: 'JFK' }, inferenceId: 'id', version: 'v10' }, deadline: p.deadline })
    expect(await executeBrowserTask(condition === 'legacy' ? task : { goal: 'Find flights from JFK', goalDriven: true }, p))
      .toMatchObject({ status: 'escalate', reason: 'invalid_target' })
    expect(p.act).not.toHaveBeenCalled()
  })
  it('opens the permitted start page before any read or decision', async () => {
    const p = ports()
    p.snapshot.mockResolvedValue({ ...obs, url: 'about:blank', text: '', elements: [] })
    const navigate = vi.fn(async () => {
      expect(p.snapshot).not.toHaveBeenCalled()
      expect(p.decide).not.toHaveBeenCalled()
      p.snapshot.mockResolvedValue({ ...obs, text: 'Results' })
    })
    expect(await executeBrowserTask({ ...task, startUrl: obs.url }, { ...p, navigate }))
      .toMatchObject({ status: 'verified', steps: 0 })
    expect(navigate).toHaveBeenCalledExactlyOnceWith(obs.url)
    expect(p.decide.mock.calls[0][0].url).toBe(obs.url)
    expect(p.act).not.toHaveBeenCalled()
  })
  it('refuses a blocked start page and never decides on the old page after failed navigation', async () => {
    const p = { ...ports(), blockedSites: () => ['other.com'] }, navigate = vi.fn(async () => { throw new Error('network error') })
    const blocked = await executeBrowserTask({ ...task, startUrl: 'https://www.other.com/flights?from=NYC' }, { ...p, navigate })
    expect(blocked).toMatchObject({ status: 'escalate', reason: 'site_blocked', blockedSite: 'other.com',
      message: expect.stringContaining('blocked the agent on other.com') })
    expect(blocked.url).toBeUndefined()
    expect(blocked.evidence).toBeUndefined()
    expect(navigate).not.toHaveBeenCalled()
    expect(p.snapshot).not.toHaveBeenCalled()
    expect(await executeBrowserTask({ ...task, startUrl: obs.url }, { ...p, navigate }))
      .toMatchObject({ status: 'escalate' })
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(p.snapshot).not.toHaveBeenCalled()
    expect(p.decide).not.toHaveBeenCalled()
    expect(p.act).not.toHaveBeenCalled()
  })
  it.each([
    { text: 'incomplete snapshot' },
    { url: obs.url, title: 'Old browser', text: 'Search', count: 1 },
    { url: obs.url, title: '', text: '', count: 0, loading: true },
    { url: obs.url, title: '', text: '', count: 0, protocol: 'unknown-protocol' },
    { url: obs.url, title: '', text: '', count: -1 },
    { url: 'invalid url', title: '', text: '', count: 0 },
  ])('treats a malformed, loading or plain text snapshot as unavailable: %j', snapshot => {
    const p = ports()
    p.snapshot.mockResolvedValue(snapshot as unknown as BrowserObservation)
    return expect(executeBrowserTask(task, p)).resolves.toMatchObject({ status: 'escalate', reason: 'browser_observation_unavailable' })
  })
  it('ends an initial read failure as unknown when no navigation was requested', async () => {
    const p = ports()
    p.snapshot.mockRejectedValue(new Error('page is mid-load'))
    expect(await executeBrowserTask(task, p)).toMatchObject({ status: 'escalate', reason: 'transport_or_write_outcome_unknown' })
    expect(p.snapshot).toHaveBeenCalledTimes(1)
    expect(p.decide).not.toHaveBeenCalled()
    expect(p.act).not.toHaveBeenCalled()
  })
  it('reuses the initial valid observation when no navigation is requested', async () => {
    const p = ports()
    p.snapshot.mockResolvedValue({ ...obs, text: 'Results' })
    p.decide.mockImplementation(async observation => {
      expect(p.snapshot).toHaveBeenCalledTimes(1)
      expect(observation.text).toBe('Results')
      return { decision: { status: 'accepted', value: { operation: 'done' }, inferenceId: 'id', version: 'v1' }, deadline: p.deadline }
    })
    expect(await executeBrowserTask(task, p)).toMatchObject({ status: 'verified' })
    expect(p.snapshot).toHaveBeenCalledTimes(2) // initial observation plus fresh completion verification
  })
  it('does not navigate when stopped before the task starts', async () => {
    const p = ports(), navigate = vi.fn(async () => {})
    p.abort.abort()
    expect(await executeBrowserTask({ ...task, startUrl: obs.url }, { ...p, navigate })).toMatchObject({ status: 'cancelled' })
    expect(navigate).not.toHaveBeenCalled()
    expect(p.snapshot).not.toHaveBeenCalled()
    expect(p.decide).not.toHaveBeenCalled()
    expect(p.act).not.toHaveBeenCalled()
  })
  it('rejects invalid, executable and credential-bearing starting URLs without throwing during safeParse', () => {
    for (const startUrl of ['not a url', 'javascript:alert(1)', 'file:///tmp/test', 'https://user:password@example.com/']) {
      expect(browserTaskSchema.safeParse({ ...task, startUrl }).success).toBe(false)
    }
  })
  it('verifies completion from the next snapshot and returns compact evidence', async () => {
    const p = ports(); p.snapshot.mockResolvedValueOnce(obs).mockResolvedValue({ ...obs, text: 'Results: 10' })
    const result = await executeBrowserTask(task, p)
    expect(result).toMatchObject({ status: 'verified', steps: 1, evidence: 'Results: 10' })
    expect(p.act).toHaveBeenCalledTimes(1)
    expect(p.act.mock.calls[0]).toMatchObject([{ documentId: 'doc', observationId: 1, ref: 'e1' }])
  })
  it('rechecks the classified reading inventory despite unrelated layout, text and heading-index changes', async () => {
    const p = ports()
    const evidence = { headings: [], dialogs: [], dialogsComplete: true,
      documentLinks: [{ title: 'Observed article', destination: 'https://example.com/article', order: 4, section: 'Articles' }],
      documentLinksScope: 'rendered_heading_links' as const, documentLinksTruncated: false }
    const before = { ...obs, evidence }
    const after = { ...before, observationId: 2, text: 'Unrelated dynamic banner', elements: [],
      evidence: { ...evidence, headings: [{ name: 'New unrelated heading', level: 2 }],
        documentLinks: [{ ...evidence.documentLinks[0], order: 20 }] } }
    p.snapshot.mockResolvedValueOnce(before).mockResolvedValue(after)
    p.decide.mockResolvedValue({ decision: { status: 'accepted', value: { operation: 'done' }, inferenceId: 'id', version: 'reading' },
      completionBasis: 'completion_inventory_v1', deadline: p.deadline })
    expect(await executeBrowserTask({ goal: 'Read the article title and link', goalDriven: true }, p))
      .toMatchObject({ status: 'verified', freshReadings: { observedAt: after.observedAt, evidence: after.evidence } })
    expect(p.decide).toHaveBeenCalledOnce()
    expect(p.act).not.toHaveBeenCalled()
  })
  it.each(['document', 'destination', 'title', 'field', 'loading'] as const)('never reuses reading DONE after a changed %s', async change => {
    const p = ports()
    const evidence = { headings: [], dialogs: [], dialogsComplete: true,
      documentLinks: [{ title: 'Observed article', destination: 'https://example.com/article', order: 4, section: 'Articles' }],
      documentLinksScope: 'rendered_heading_links' as const, documentLinksTruncated: false,
      currentFields: [{ role: 'textbox', name: 'Query', value: 'Requested query', nameTruncated: false, valueTruncated: false, disabled: false }],
      currentFieldsScope: 'rendered_form_state' as const, currentFieldsTruncated: false }
    const before = { ...obs, evidence }
    const after = structuredClone(before)
    if (change === 'document') after.documentId = 'other-document'
    if (change === 'destination') after.evidence.documentLinks[0].destination = 'https://example.com/other'
    if (change === 'title') after.evidence.documentLinks[0].title = 'Other title'
    if (change === 'field') after.evidence.currentFields[0].value = 'Other query'
    if (change === 'loading') after.loading = true
    p.snapshot.mockResolvedValueOnce(before).mockResolvedValue(after)
    p.decide.mockResolvedValueOnce({ decision: { status: 'accepted', value: { operation: 'done' }, inferenceId: 'id', version: 'reading' },
      completionBasis: 'completion_inventory_v1', deadline: p.deadline }).mockResolvedValue({ decision: { status: 'escalate', reason: 'changed' }, deadline: p.deadline })
    const result = await executeBrowserTask({ goal: 'Read the article title and link', goalDriven: true }, p)
    expect(result.status).not.toBe('verified')
    // The changed page is still returned, as the latest unverified reading.
    expect(result.freshReadings?.documentId).toBe(change === 'document' ? 'other-document' : 'doc')
    expect(p.act).not.toHaveBeenCalled()
  })
  it('never takes DONE as proof', async () => {
    const p: TaskExecutorPorts = { ...ports(), decide: async () => ({ decision: { status: 'accepted', value: { operation: 'done' }, inferenceId: 'id', version: 'v' }, deadline: Date.now() + 1000 }) }
    expect(await executeBrowserTask(task, p)).toMatchObject({ status: 'escalate', reason: 'completion_changed' })
    expect(p.act).not.toHaveBeenCalled()
  })
  it('rereads an accepted milestone without executing a native action or claiming the whole task is done', async () => {
    const p = ports()
    const milestoneTask = { goal: 'Show matching results', milestones: [
      { goal: 'Form is ready', bindingNames: [] }, { goal: 'Matching results are visible', bindingNames: [] },
    ], completion: [] }
    p.decide.mockResolvedValueOnce({ decision: { status: 'accepted', value: { operation: 'advance' }, inferenceId: 'a', version: 'v6' }, deadline: p.deadline })
      .mockResolvedValueOnce({ decision: { status: 'escalate', reason: 'uncertain' }, deadline: p.deadline })
    const result = await executeBrowserTask(milestoneTask, p)
    expect(result).toMatchObject({ status: 'escalate', reason: 'uncertain', steps: 0 })
    expect(result.trace.map(step => step.operation)).toEqual(['advance', 'escalate'])
    expect(p.snapshot.mock.calls.length).toBeGreaterThan(1)
    expect(p.act).not.toHaveBeenCalled()
  })
  it('does not reuse semantic DONE when the final page changed', async () => {
    const p = ports()
    const milestoneTask = { goal: 'Show matching results', milestones: [{ goal: 'Matching results are visible', bindingNames: [] }], completion: [], maxSteps: 1 }
    p.snapshot.mockResolvedValueOnce({ ...obs, text: 'Matching results' }).mockResolvedValue({ ...obs, text: 'Different date results' })
    p.decide.mockResolvedValue({ decision: { status: 'accepted', value: { operation: 'done' }, inferenceId: 'a', version: 'v6' }, deadline: p.deadline })
    expect(await executeBrowserTask(milestoneTask, p)).toMatchObject({ status: 'escalate', reason: 'completion_changed' })
    expect(p.act).not.toHaveBeenCalled()
  })
  it('does not mistake an open menu containing the desired option for a completed selection', async () => {
    const tripTask = { goal: 'Select One way', completion: [
      { kind: 'text', value: 'One way' }, { kind: 'text_absent', value: 'Round trip' },
    ] }
    const p = ports()
    let clicks = 0
    p.snapshot.mockImplementation(async () => ({ ...obs, text: clicks === 0 ? 'Round trip' : clicks === 1 ? 'Round trip One way Multi-city' : 'One way' }))
    p.act.mockImplementation(async () => { clicks++; return { ok: true } })
    expect(await executeBrowserTask(tripTask, p)).toMatchObject({ status: 'verified', steps: 2 })
    expect(p.act).toHaveBeenCalledTimes(2)
    const parsed = browserTaskSchema.parse(tripTask)
    expect(taskCompleted(parsed, { ...obs, text: 'One way ' + 'x'.repeat(11992) })).toBe(false)
    expect(browserTaskSchema.safeParse({ goal: 'Done', completion: [{ kind: 'text_absent', value: 'Round trip' }] }).success).toBe(false)
  })
  it('does not replay an uncertain write', async () => {
    const p = ports(); p.act.mockRejectedValue(new Error('native timeout'))
    expect(await executeBrowserTask(task, p)).toMatchObject({ status: 'escalate', reason: 'transport_or_write_outcome_unknown' })
    expect(p.act).toHaveBeenCalledTimes(1)
  })
  it('refreshes evidence after uncertainty without claiming the semantic goal is complete', async () => {
    const p = ports()
    p.snapshot.mockResolvedValueOnce(obs).mockResolvedValueOnce(obs)
      .mockResolvedValue({ ...obs, text: 'Results: 10' })
    const decide = p.decide
    let decisions = 0
    const withEscalation: TaskExecutorPorts = { ...p, decide: async () => {
      if (decisions++ === 0) return decide(obs, 0, [], p.signal)
      return { decision: { status: 'escalate', reason: 'uncertain' }, deadline: p.deadline }
    } }
    expect(await executeBrowserTask(task, withEscalation)).toMatchObject({
      status: 'escalate', reason: 'uncertain', steps: 1, evidence: 'Results: 10',
    })
    expect(p.act).toHaveBeenCalledTimes(1)
    // Still incomplete on a fresh read: retain escalation rather than claiming success.
    decisions = 0
    p.snapshot.mockResolvedValue(obs)
    expect(await executeBrowserTask(task, withEscalation)).toMatchObject({ status: 'escalate', reason: 'uncertain' })
  })
  it('inspects an uncertain write but requires semantic verification before claiming success', async () => {
    const p = ports(); p.act.mockRejectedValue(new Error('response lost after click'))
    p.snapshot.mockResolvedValueOnce(obs).mockResolvedValue({ ...obs, text: 'Results for Berlin' })
    expect(await executeBrowserTask(task, p)).toMatchObject({ status: 'escalate', evidence: 'Results for Berlin' })
    expect(p.act).toHaveBeenCalledTimes(1)
  })
  it('cancellation during inference prevents the next action', async () => {
    const p = ports(); p.decide.mockImplementation(async () => {
      p.abort.abort(); return { decision: { status: 'accepted', value: { operation: 'click', ref: 'e1' }, inferenceId: 'id', version: 'v' }, deadline: Date.now() + 1000 }
    })
    expect(await executeBrowserTask(task, p)).toMatchObject({ status: 'cancelled' })
    expect(p.act).not.toHaveBeenCalled()
  })
  it('never follows a link into a blocked site, and checks selected control sensitivity', async () => {
    const p = { ...ports(), blockedSites: () => ['other.com'] }
    p.snapshot.mockResolvedValue({ ...obs, elements: [{ ...obs.elements[0], destination: 'https://m.other.com/' }] })
    expect(await executeBrowserTask(task, p)).toMatchObject({ status: 'escalate', reason: 'site_blocked',
      blockedSite: 'other.com', url: obs.url, evidence: obs.text })
    expect(p.act).not.toHaveBeenCalled()
    // A link to any other site is followed.
    p.snapshot.mockResolvedValue({ ...obs, elements: [{ ...obs.elements[0], destination: 'https://elsewhere.com/' }] })
    p.decide.mockResolvedValueOnce({ decision: { status: 'accepted', value: { operation: 'click', ref: 'e1' }, inferenceId: 'id', version: 'v' }, deadline: p.deadline })
      .mockResolvedValueOnce({ decision: { status: 'escalate', reason: 'test_finished' }, deadline: p.deadline })
    expect(await executeBrowserTask(task, p)).toMatchObject({ status: 'escalate', reason: 'test_finished' })
    expect(p.act).toHaveBeenCalledTimes(1)
    p.snapshot.mockResolvedValue({ ...obs, elements: [{ ...obs.elements[0], sensitive: true, name: 'Send' }] })
    p.approve.mockResolvedValue(false)
    expect(await executeBrowserTask(task, p)).toMatchObject({ status: 'cancelled', reason: 'approval_declined' })
    expect(p.approve).toHaveBeenCalledWith(expect.stringContaining('Send'))
  })
  it('never decides on, acts on or returns a page from a blocked site', async () => {
    const p = { ...ports(), blockedSites: () => ['example.com'] }
    const result = await executeBrowserTask(task, p)
    expect(result).toMatchObject({ status: 'escalate', reason: 'site_blocked', blockedSite: 'example.com' })
    expect(p.decide).not.toHaveBeenCalled()
    expect(p.act).not.toHaveBeenCalled()
    expect(p.approve).not.toHaveBeenCalled()
    // Nothing read there comes back.
    expect(result.url).toBeUndefined()
    expect(result.evidence).toBeUndefined()
    expect(result.freshReadings).toBeUndefined()
  })
  it('stops when a click lands on a blocked site, keeping only what the allowed page showed', async () => {
    const p = { ...ports(), blockedSites: () => ['linkedin.com'] }
    const landed = { ...obs, observationId: 2, url: 'https://www.linkedin.com/feed/', text: 'Private feed' }
    p.act.mockImplementation(async () => { p.snapshot.mockResolvedValue(landed); return { ok: true } })
    const result = await executeBrowserTask(task, p)
    expect(result).toMatchObject({ status: 'escalate', reason: 'site_blocked', blockedSite: 'linkedin.com', url: obs.url })
    expect(JSON.stringify(result)).not.toContain('Private feed')
    expect(p.decide).toHaveBeenCalledTimes(1)
    expect(p.decide.mock.calls[0][0].url).toBe(obs.url)
  })
  it('stops at the next step when the site is blocked mid-task', async () => {
    let sites: string[] = []
    const p = { ...ports(), blockedSites: () => sites }
    p.act.mockImplementation(async () => { sites = ['example.com']; return { ok: true } })
    expect(await executeBrowserTask(task, p)).toMatchObject({ status: 'escalate', reason: 'site_blocked', blockedSite: 'example.com' })
    expect(p.decide).toHaveBeenCalledTimes(1)
  })
  it('stops when the desktop kept the tab from opening a blocked site', async () => {
    let kept: string | null = null
    const p = { ...ports(), blockedNavigation: () => kept }
    p.act.mockImplementation(async () => { kept = 'linkedin.com'; return { ok: true } })
    expect(await executeBrowserTask(task, p)).toMatchObject({ status: 'escalate', reason: 'site_blocked', blockedSite: 'linkedin.com', url: obs.url })
    expect(p.act).toHaveBeenCalledTimes(1)
  })
  it('resets the stale budget only after a successful action, retaining both known rejections', async () => {
    const p = ports()
    let actions = 0, successes = 0
    p.act.mockImplementation(async () => {
      actions++
      if (actions % 3 !== 0) return { ok: false, code: 'stale_observation' }
      successes++
      return { ok: true }
    })
    p.snapshot.mockImplementation(async () => ({ ...obs, text: successes === 2 ? 'Results' : `Search ${successes}` }))
    const result = await executeBrowserTask(task, p)
    expect(result).toMatchObject({ status: 'verified', steps: 6 })
    expect(p.act).toHaveBeenCalledTimes(6)
    expect(result.trace.slice(0, 6).map(row => row.actionStatus)).toEqual(['rejected', 'rejected', 'succeeded', 'rejected', 'rejected', 'succeeded'])
    expect(result.trace.filter(row => row.actionStatus === 'rejected').every(row => row.actionCode === 'stale_observation')).toBe(true)
    expect(result.trace.filter(row => row.actionStatus === 'succeeded').every(row => row.actionCode === undefined)).toBe(true)
  })
  it('still stops on the third consecutive stale rejection after earlier progress', async () => {
    const p = ports()
    p.act.mockResolvedValueOnce({ ok: true }).mockResolvedValue({ ok: false, code: 'stale_observation' } as { ok: boolean })
    const result = await executeBrowserTask(task, p)
    expect(result).toMatchObject({ status: 'escalate', reason: 'stale_observation', steps: 4 })
    expect(p.act).toHaveBeenCalledTimes(4)
    expect(result.trace.map(row => row.actionStatus)).toEqual(['succeeded', 'rejected', 'rejected', 'rejected'])
  })
  it.each(['throw', 'unrecognized_code'] as const)('does not retry an unknown action outcome after stale recovery: %s', async mode => {
    const p = ports()
    p.act.mockResolvedValueOnce({ ok: false, code: 'stale_observation' } as { ok: boolean })
    if (mode === 'throw') p.act.mockRejectedValue(new Error('private native transport detail'))
    else p.act.mockResolvedValue({ ok: false, code: 'private native failure detail' } as { ok: boolean })
    const result = await executeBrowserTask(task, p)
    expect(result.status).toBe('escalate')
    expect(p.act).toHaveBeenCalledTimes(2)
    expect(result.trace[1]).toMatchObject({ actionStatus: mode === 'throw' ? 'unknown' : 'rejected', actionMs: expect.any(Number) })
    expect(result.trace[1].actionCode).toBe(mode === 'throw' ? undefined : 'unknown')
    expect(JSON.stringify(result.trace)).not.toContain('private native')
  })
  it('caps stale predictions and rejects malformed native observations', async () => {
    const p = ports(); p.act.mockResolvedValue({ ok: false, code: 'stale_observation' } as { ok: boolean })
    expect(await executeBrowserTask(task, p)).toMatchObject({ status: 'escalate', steps: 3 })
    expect(p.act).toHaveBeenCalledTimes(3)
    p.snapshot.mockResolvedValue({ text: 'legacy snapshot' } as BrowserObservation)
    expect(await executeBrowserTask(task, p)).toMatchObject({ reason: 'browser_observation_unavailable' })
  })
})

// Replays of measured failures: navigation reached the answer, but Jev's strict
// completion head never accepted, so the task ran out and dropped its findings.
describe('unverified tasks keep their progress for the parent', () => {
  const results = { ...obs, url: 'https://www.google.com/search?q=browser-use+Jev+ultrafast', title: 'Search results',
    text: 'jev-ultrafast - a browser agent from the Browser Use team', elements: [],
    viewport: { width: 1000, height: 600, scrollX: 0, scrollY: 0, scrollWidth: 1000, scrollHeight: 6000 },
    evidence: { headings: [], dialogs: [], dialogsComplete: true, documentLinksScope: 'rendered_heading_links' as const, documentLinksTruncated: false,
      documentLinks: [
        { title: 'jev-ultrafast - GitHub', destination: 'https://github.com/browser-use/jev-ultrafast', order: 0, section: 'Results' },
        { title: 'What Is Jev-Ultrafast Agent?', destination: 'https://www.activepieces.com/blog/jev', order: 1, section: 'Results' },
        { title: 'Jev ultrafast benchmark', destination: 'https://example.com/jev-benchmark', order: 2, section: 'Results' },
      ] } }
  const scrolled = (y: number) => ({ ...results, observationId: y + 1, viewport: { ...results.viewport, scrollY: y } })

  it('hands back the results page after repeated scrolling instead of exhausting the budget (aaedec14)', async () => {
    const p = { ...ports() }
    let y = 0
    p.snapshot.mockImplementation(async () => scrolled(y))
    let ledger: ReturnType<typeof appendBrowserEvidence> | undefined
    p.decide.mockImplementation(async (observation, step) => {
      ledger = appendBrowserEvidence(ledger, observation, step)
      return { decision: { status: 'accepted', value: { operation: 'scroll_down' }, inferenceId: 'id', version: 'v27' }, deadline: p.deadline, evidenceLedger: ledger }
    })
    p.act.mockImplementation(async () => { y += 500; return { ok: true } })
    const result = await executeBrowserTask({ goal: 'Search Google for "browser-use Jev ultrafast" and report the first three organic results with links', goalDriven: true }, p)
    expect(result).toMatchObject({ status: 'escalate', reason: 'reading_limit', steps: 3 })
    expect(p.decide).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(result.evidenceLedger)).toContain('https://github.com/browser-use/jev-ultrafast')
    const compact = compactBrowserTaskResult(result) as Record<string, unknown>
    expect(compact).toMatchObject({ next: expect.stringContaining('Not verified'), sourceReferences: { citations: [
      '[jev-ultrafast - GitHub](<https://github.com/browser-use/jev-ultrafast>)',
      '[What Is Jev-Ultrafast Agent?](<https://www.activepieces.com/blog/jev>)',
      '[Jev ultrafast benchmark](<https://example.com/jev-benchmark>)',
    ] } })
    expect(compact).not.toHaveProperty('trace')
  })

  it('returns flight rows read before the step budget ran out (076386a2)', async () => {
    const p = { ...ports() }
    let page = 0
    const flights = (n: number) => ({ ...obs, documentId: 'flights', observationId: n + 1, url: 'https://www.google.com/travel/flights/search?tfs=x',
      title: 'JFK to LAX', text: `Search results page ${n}`, evidence: { headings: [], dialogs: [], dialogsComplete: true,
        documentRecordsScope: 'rendered_semantic_records' as const, documentRecordsTruncated: false,
        documentRecords: [{ kind: 'listitem' as const, text: '6:50 PM - 10:08 PM American JFK-LAX Nonstop 6 hr 18 min $367', textTruncated: false, order: 0 },
          { kind: 'listitem' as const, text: '7:55 PM - 11:20 PM Delta JFK-LAX Nonstop 6 hr 25 min $367', textTruncated: false, order: 1 }] } })
    p.snapshot.mockImplementation(async () => flights(page))
    let ledger: ReturnType<typeof appendBrowserEvidence> | undefined
    p.decide.mockImplementation(async (observation, step) => {
      ledger = appendBrowserEvidence(ledger, observation, step)
      return { decision: { status: 'accepted', value: { operation: 'click', ref: 'e1' }, inferenceId: 'id', version: 'v27' }, deadline: p.deadline, evidenceLedger: ledger }
    })
    p.act.mockImplementation(async () => { page++; return { ok: true } })
    const result = await executeBrowserTask({ goal: 'Find one-way JFK to LAX flights around 6 PM and list options and prices', goalDriven: true, maxSteps: 3 }, p)
    expect(result).toMatchObject({ status: 'escalate', reason: 'step_budget' })
    expect(JSON.stringify(result.evidenceLedger)).toContain('6:50 PM - 10:08 PM American JFK-LAX Nonstop 6 hr 18 min $367')
    expect(result.freshReadings?.evidence?.documentRecords).toHaveLength(2)
  })

  it('reports a deadline as unfinished work and keeps what was read', async () => {
    const p = { ...ports() }
    // The abort lands after the deadline, never on it: a timer can fire a
    // millisecond early on a loaded machine, which would read as a user stop.
    p.deadline = Date.now() + 100
    p.snapshot.mockResolvedValue(results)
    const ledger = appendBrowserEvidence(undefined, results, 0)
    p.decide.mockResolvedValueOnce({ decision: { status: 'accepted', value: { operation: 'wait' }, inferenceId: 'id', version: 'v27' }, deadline: p.deadline, evidenceLedger: ledger })
      .mockImplementation(async (_observation, _step, _history, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      }))
    setTimeout(() => p.abort.abort(), 150) // The relay aborts its controller at the task deadline.
    const result = await executeBrowserTask({ goal: 'Report the first three results', goalDriven: true }, p)
    expect(result).toMatchObject({ status: 'escalate', reason: 'deadline' })
    expect(JSON.stringify(result.evidenceLedger)).toContain('https://github.com/browser-use/jev-ultrafast')
  })

  it('says a write may have run when the deadline interrupts it', async () => {
    const p = { ...ports() }
    // No real timers: the deadline is far off until the write is under way,
    // then the clock passes it and the relay aborts. A wall-clock deadline
    // could lapse before the write starts on a loaded machine (reading as a
    // plain deadline), or the abort could land before it (a user stop).
    p.deadline = Date.now() + 30_000
    p.snapshot.mockResolvedValue({ ...results, elements: [{ ...obs.elements[0] }] })
    p.decide.mockResolvedValue({ decision: { status: 'accepted', value: { operation: 'click', ref: 'e1' }, inferenceId: 'id', version: 'v27' }, deadline: p.deadline })
    const realNow = Date.now
    const clock = vi.spyOn(Date, 'now')
    p.act.mockImplementation(() => new Promise((_resolve, reject) => {
      p.abort.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      queueMicrotask(() => {
        clock.mockImplementation(() => p.deadline + 1) // the task deadline passes mid-write
        p.abort.abort() // and the relay aborts its controller at it
      })
    }))
    clock.mockImplementation(() => realNow.call(Date))
    try {
      expect(await executeBrowserTask({ goal: 'Open the first result', goalDriven: true }, p))
        .toMatchObject({ status: 'escalate', reason: 'transport_or_write_outcome_unknown' })
      expect(p.act).toHaveBeenCalledTimes(1)
    } finally {
      clock.mockRestore()
    }
  })

  it('does not count scrolling inside a dialog or picker as reading', async () => {
    const p = { ...ports() }
    let y = 0
    const surface = { scope: 'dialog' as const, name: 'Departure date', width: 400, height: 300, scrollX: 0, scrollWidth: 400, scrollHeight: 5000 }
    p.snapshot.mockImplementation(async () => ({ ...scrolled(0), observationId: y + 1, scrollSurface: { ...surface, scrollY: y } }))
    let decisions = 0
    p.decide.mockImplementation(async () => (++decisions <= 5
      ? { decision: { status: 'accepted', value: { operation: 'scroll_down' }, inferenceId: 'id', version: 'v27' }, deadline: p.deadline }
      : { decision: { status: 'escalate', reason: 'test_finished' }, deadline: p.deadline }) as never)
    p.act.mockImplementation(async () => { y += 250; return { ok: true } })
    expect(await executeBrowserTask({ goal: 'Pick 6 October in the date picker', goalDriven: true }, p))
      .toMatchObject({ status: 'escalate', reason: 'test_finished' })
    expect(p.act).toHaveBeenCalledTimes(5)
  })

  it('counts only consecutive scrolls toward the reading limit', async () => {
    const p = { ...ports() }
    let y = 0, clicks = 0
    p.snapshot.mockImplementation(async () => ({ ...scrolled(y), observationId: y + clicks * 7 + 1, text: `view ${y} after ${clicks} clicks`,
      elements: [{ ...obs.elements[0] }] }))
    const plan = ['scroll_down', 'scroll_down', 'click', 'scroll_down', 'scroll_down', 'scroll_down']
    let decided: string | undefined
    p.decide.mockImplementation(async () => {
      decided = plan.shift()
      return decided ? { decision: { status: 'accepted', value: decided === 'click' ? { operation: 'click', ref: 'e1' } : { operation: 'scroll_down' },
        inferenceId: 'id', version: 'v27' }, deadline: p.deadline } as never : { decision: { status: 'escalate', reason: 'test_finished' }, deadline: p.deadline }
    })
    p.act.mockImplementation(async () => { if (decided === 'click') clicks++; else y += 500; return { ok: true } })
    const result = await executeBrowserTask({ goal: 'Open the second page of results and read it', goalDriven: true }, p)
    expect(result).toMatchObject({ status: 'escalate', reason: 'test_finished' })
    expect(p.act).toHaveBeenCalledTimes(6)
  })
})

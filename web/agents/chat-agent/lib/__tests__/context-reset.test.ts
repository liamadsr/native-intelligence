/**
 * The context reset (../context-reset.ts, ../../instructions/context-reset.ts,
 * ../../hooks/context-reset.ts): once the history holds a new summary, or after
 * a clear, the next turn starts with only the core tools and no packs loaded.
 * Never on a trim that kept the history, never mid-turn, never twice for one
 * summary, never a throw.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const stateStore = new Map<string, unknown>()
vi.mock('eve/context', () => ({
  defineState: <T,>(name: string, initial: () => T) => ({
    get: () => (stateStore.has(name) ? (stateStore.get(name) as T) : initial()),
    update: (fn: (prev: T) => T) => {
      const prev = stateStore.has(name) ? (stateStore.get(name) as T) : initial()
      stateStore.set(name, fn(prev))
    },
  }),
}))
vi.mock('eve/hooks', () => ({ defineHook: (def: unknown) => def }))
vi.mock('eve/instructions', () => ({ defineDynamic: (def: unknown) => def, defineInstructions: (def: unknown) => def }))

const { SUMMARY_MARKER, resetIfSummarized, summaryFingerprint } = await import('../context-reset')
const { default: hook } = await import('../../hooks/context-reset')
const { default: resolver } = await import('../../instructions/context-reset')
const { addDiscoveredTools, discoveredToolNames, resetDiscoveredTools } = await import('../discovered-tools')
const { claimPacks, loadedPackAreas } = await import('../expertise')

const onHook = (hook as unknown as { events: Record<string, () => Promise<void>> }).events
const onTurn = (resolver as unknown as { events: Record<string, (e: unknown, ctx: unknown) => Promise<unknown>> }).events

const pack = (area: string) => ({ area, name: area, playbookSkill: null, toolNames: [], cardKinds: [], markdown: 'm' })
const user = (text: string) => ({ role: 'user', content: text })
const assistant = (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] })
/** A history as eve leaves it after a summary: the marker, the summary, the kept tail. */
const summarized = (summary: string, ...tail: unknown[]) => [user(SUMMARY_MARKER), assistant(summary), ...tail]
const turnStart = (messages: unknown[]) => onTurn['turn.started']({}, { messages })

beforeEach(() => {
  stateStore.clear()
  addDiscoveredTools(['send_email', 'list_contacts'])
  claimPacks([pack('email')])
})

describe('the discovered-tools state', () => {
  it('adds without duplicates and resets to nothing', () => {
    addDiscoveredTools(['send_email', 'create_document'])
    expect(discoveredToolNames()).toEqual(['send_email', 'list_contacts', 'create_document'])
    resetDiscoveredTools()
    expect(discoveredToolNames()).toEqual([])
  })
})

describe('summaryFingerprint', () => {
  it('reads eve’s summary off the history, string or text parts', () => {
    const fp = summaryFingerprint(summarized('We drafted the Acme reply.', user('next')))
    expect(fp).toMatch(/^\d+:[0-9a-f]+$/)
    expect(summaryFingerprint([{ role: 'user', content: [{ type: 'text', text: SUMMARY_MARKER }] }, { role: 'assistant', content: 'We drafted the Acme reply.' }])).toBe(fp)
    expect(summaryFingerprint(summarized('Something else entirely.'))).not.toBe(fp)
  })

  it('is null with no summary, or a marker with nothing after it', () => {
    expect(summaryFingerprint([user('hi'), assistant('hello')])).toBeNull()
    expect(summaryFingerprint([user(SUMMARY_MARKER)])).toBeNull()
    expect(summaryFingerprint([user(SUMMARY_MARKER), user('no summary')])).toBeNull()
    expect(summaryFingerprint([])).toBeNull()
  })
})

describe('the turn-start reset', () => {
  it('a new summary: the turn starts with core tools and no packs, and adds no instructions', async () => {
    expect(await turnStart(summarized('First summary.', user('hi')))).toBeNull()
    expect(discoveredToolNames()).toEqual([])
    expect(loadedPackAreas()).toEqual([])
  })

  it('never twice for one summary: what the next turns search for stays', async () => {
    const history = summarized('First summary.', user('hi'))
    await turnStart(history)
    addDiscoveredTools(['create_document'])
    await turnStart([...history, assistant('ok'), user('again')])
    expect(discoveredToolNames()).toEqual(['create_document'])
  })

  it('a trim that kept the history (same summary, or none) keeps the tools', async () => {
    const history = summarized('First summary.', user('hi'))
    await turnStart(history)
    addDiscoveredTools(['send_email'])
    // eve emitted compaction.completed for a trim: the summary is unchanged.
    await turnStart([...history, assistant('trimmed tool results'), user('more')])
    expect(discoveredToolNames()).toEqual(['send_email'])
    // A session that has never summarized keeps its tools too.
    stateStore.clear()
    addDiscoveredTools(['send_email'])
    expect(resetIfSummarized([user('hi'), assistant('hello'), user('again')])).toBe(false)
    expect(discoveredToolNames()).toEqual(['send_email'])
  })

  it('a later summary resets again, and a reopened area brings its pack back', async () => {
    await turnStart(summarized('First summary.'))
    addDiscoveredTools(['send_email'])
    claimPacks([pack('email')])
    await turnStart(summarized('Second summary, after more work.'))
    expect(discoveredToolNames()).toEqual([])
    expect(claimPacks([pack('email')]).map((p) => p.area)).toEqual(['email'])
  })

  it('a clear resets the next turn, even with no summary in the history', async () => {
    await onHook['context.cleared']()
    expect(discoveredToolNames()).toEqual(['send_email', 'list_contacts'])
    await turnStart([user('fresh start')])
    expect(discoveredToolNames()).toEqual([])
    addDiscoveredTools(['find_contact'])
    await turnStart([user('fresh start'), assistant('ok'), user('next')])
    expect(discoveredToolNames()).toEqual(['find_contact'])
  })

  it('never throws on a history it can’t read', async () => {
    expect(await turnStart([null, 7, { role: 'user' }] as unknown[])).toBeNull()
    expect(discoveredToolNames()).toEqual(['send_email', 'list_contacts'])
  })
})

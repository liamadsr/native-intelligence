// @vitest-environment jsdom
/**
 * The call's live notes in the call (./call-live-notes.tsx): nothing drawn
 * with nothing to show; the summary and a plain status line while the agent
 * writes, after an update, after a turn that failed; Open shows the whole
 * capture. A guest's view is closed until opened, then the lines said, each
 * with its speaker, under the agent's notes once it has written any.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { CallLiveNotesView, GuestCallNotesView } from '../call-live-notes'

let host: HTMLDivElement
let root: Root
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const NOW = Date.parse('2026-11-13T15:00:00Z')
const SUMMARY = '## Summary\nThe pilot starts Monday.\n\n## Next Steps\n- Rosa sends the contract <!-- proposal:abc -->'

describe('the members’ live notes', () => {
  it('nothing to show: nothing drawn', () => {
    act(() => root.render(<CallLiveNotesView notes={null} />))
    expect(host.innerHTML).toBe('')
    act(() => root.render(<CallLiveNotesView notes={{ summary: '', state: null }} />))
    expect(host.innerHTML).toBe('')
  })

  it('the summary, its status, and Open', () => {
    let opened = 0
    act(() => root.render(<CallLiveNotesView notes={{ summary: SUMMARY, state: { phase: 'ready', at: '2026-11-13T14:58:00Z', reason: null } }} onOpen={() => opened++} now={NOW} />))
    const section = host.querySelector('[data-team-call-live-notes]')!
    expect(section.getAttribute('data-team-call-live-notes')).toBe('ready')
    expect(section.textContent).toContain('The pilot starts Monday.')
    expect(section.textContent).toContain('Rosa sends the contract')
    expect(section.textContent).not.toContain('proposal:')
    expect(host.querySelector('[data-team-call-live-notes-status]')!.textContent).toBe('Updated 2 minutes ago')
    act(() => (host.querySelector('[data-team-call-live-notes-open]') as HTMLButtonElement).click())
    expect(opened).toBe(1)
  })

  it('working before the first notes, and a turn that failed', () => {
    act(() => root.render(<CallLiveNotesView notes={{ summary: '', state: { phase: 'working', at: null, reason: null } }} now={NOW} />))
    expect(host.textContent).toContain('Writing as people speak')
    expect(host.textContent).toContain('The first notes show here')
    act(() => root.render(<CallLiveNotesView notes={{ summary: SUMMARY, state: { phase: 'failed', at: null, reason: null } }} now={NOW} />))
    expect(host.textContent).toContain('The next update catches up')
    expect(host.textContent).toContain('The pilot starts Monday.')
  })

  it('the call’s words not being written: one plain line saying why, the summary still there; gone once they are', () => {
    act(() => root.render(<CallLiveNotesView notes={{ summary: '', state: null, feed: 'refused' }} now={NOW} />))
    const line = host.querySelector('[data-team-call-notes-health]')!
    expect(line.getAttribute('role')).toBe('status')
    expect(line.textContent).toBe('Notes aren’t being written right now: the transcription service refused our key.')
    act(() => root.render(<CallLiveNotesView notes={{ summary: SUMMARY, state: { phase: 'ready', at: '2026-11-13T14:58:00Z', reason: null }, feed: 'no_words' }} now={NOW} />))
    expect(host.querySelector('[data-team-call-notes-health]')!.textContent).toMatch(/no words are coming back/)
    expect(host.textContent).toContain('The pilot starts Monday.')
    act(() => root.render(<CallLiveNotesView notes={{ summary: SUMMARY, state: { phase: 'ready', at: '2026-11-13T14:58:00Z', reason: null }, feed: null }} now={NOW} />))
    expect(host.querySelector('[data-team-call-notes-health]')).toBeNull()
  })

  it('the live summary stopped: why, in plain words', () => {
    act(() => root.render(<CallLiveNotesView notes={{ summary: SUMMARY, state: { phase: 'stopped', at: null, reason: 'usage' } }} now={NOW} />))
    expect(host.querySelector('[data-team-call-live-notes-status]')!.textContent).toBe('The live summary stopped: the host’s plan has run out of AI usage.')
  })
})

describe('a guest’s view', () => {
  it('closed until opened, then only what was said', () => {
    act(() => root.render(<GuestCallNotesView state="closed" lines={[]} onToggle={() => undefined} />))
    expect(host.querySelector('[data-guest-notes-body]')).toBeNull()
    expect(host.textContent).toContain('Show the notes of this call')
    act(() =>
      root.render(
        <GuestCallNotesView state="ready" lines={[{ at: '2026-11-13T14:59:00Z', speaker: 'Dana Ortiz', text: 'Welcome, Sam.' }]} onToggle={() => undefined} />,
      ),
    )
    const body = host.querySelector('[data-guest-notes-body]')!
    expect(body.textContent).toBe('Dana Ortiz Welcome, Sam.')
    expect(host.querySelector('[data-guest-notes-summary]')).toBeNull()
  })

  it('the agent’s notes first, then what was said since they joined', () => {
    act(() =>
      root.render(
        <GuestCallNotesView
          pad
          state="ready"
          summary={[
            { kind: 'heading', text: 'Decisions' },
            { kind: 'bullet', text: 'Keep the pilot at three partners.' },
          ]}
          lines={[{ at: '2026-11-13T14:59:00Z', speaker: 'Dana Ortiz', text: 'Welcome, Sam.' }]}
          onToggle={() => undefined}
        />,
      ),
    )
    expect(host.querySelector('[data-guest-notes-summary]')!.textContent).toBe('Decisions•Keep the pilot at three partners.')
    expect(host.querySelector('[data-guest-notes-said]')!.textContent).toContain('since you joined')
    const body = host.querySelector('[data-guest-notes-body]')!.textContent!
    expect(body.indexOf('Decisions')).toBeLessThan(body.indexOf('Welcome, Sam.'))
    expect(host.textContent).toContain('Of this call')
  })
})

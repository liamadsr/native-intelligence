// @vitest-environment jsdom
/**
 * Case editor — spec §8.2 screen 3.
 *
 * THE CHUNK DIVIDERS ARE THE ASSERTION THAT MATTERS. A live trial hands the
 * agent windows, not a transcript, and every chunk-indexed expectation on the
 * right pane (`after_chunk`, `before_chunk`) is written against those exact
 * boundaries. The pure helpers that place them are unit-tested directly, and
 * the rendered case is checked for the boundary going STALE the moment the
 * script is edited: chunks are re-frozen server-side by `updateEvalCase`, so a
 * divider that kept its position after an edit would be pointing at a window
 * that no longer exists — and pointing it at the wrong line is worse than not
 * drawing it, because the numbers beside it are load-bearing.
 *
 * THE SECOND THING WORTH A TEST is the PATCH body. `UpdateCaseSchema` is
 * `.strict()` and takes neither `polarity` nor `modes`; a save that sent
 * either would 400 the whole edit. Both are on screen (they qualify every
 * expectation) and both must stay out of the wire shape.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { EvalCaseRow } from '@/lib/evals/types'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A save, a queued run and an adopted run are transient successes — toasts, the
// house channel, not a line in a footer that no longer exists. `vi.hoisted`
// because `vi.mock`'s factory is lifted above every const in the file.
const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock('sonner', () => ({ toast: { success: toastSuccess, error: toastError } }))

import {
  EvalCasePage,
  chunkBoundaries,
  formatTimestamp,
  nextItemKey,
  selfSpeakers,
} from '../case-page'

// ── Fixture ──────────────────────────────────────────────────────────────

/**
 * A three-line case whose script is FROZEN INTO TWO WINDOWS: segments 0-1,
 * then segment 2. Two windows and not one is the whole point — a single-chunk
 * fixture could not tell a divider drawn in the right place from a divider
 * drawn after every line.
 */
function caseRow(overrides: Partial<EvalCaseRow> = {}): EvalCaseRow {
  return {
    id: 'case-1',
    suite_id: 'suite-1',
    workspace_id: 'ws-1',
    name: 'Prospect stalls on pricing',
    capture_id: 'cap-1',
    capture_is_eval: true,
    script: [
      { t_ms: 0, speaker: 'Me', stream: 'mic', text: 'Thanks for making time.' },
      { t_ms: 4000, speaker: 'Dana', stream: 'system', text: 'What does this cost?' },
      { t_ms: 20000, speaker: 'Me', stream: 'mic', text: 'It is ninety-nine a seat.' },
    ],
    chunks: [
      {
        index: 0,
        t_ms_start: 0,
        t_ms_end: 4000,
        segment_indices: [0, 1],
        text: '[Me]: Thanks for making time.\n[Dana]: What does this cost?',
      },
      {
        index: 1,
        t_ms_start: 20000,
        t_ms_end: 20000,
        segment_indices: [2],
        text: '[Me]: It is ninety-nine a seat.',
      },
    ],
    expected: {
      proposals: [
        {
          key: 'pricing_followup',
          entity_type: 'action',
          change_type: 'create',
          gist: 'Send the pricing one-pager',
          severity: 'gate',
        },
      ],
      summary: 'Names the pricing objection.',
    },
    modes: ['batch', 'live'],
    polarity: 'positive',
    seeded_from_capture_id: null,
    visibility: 'workspace',
    created_by: null,
    sort_order: 0,
    created_at: '2026-09-04T12:00:00.000Z',
    updated_at: '2026-09-04T12:00:00.000Z',
    ...overrides,
  }
}

/** What GET /cases/[id] serves for the fixture: the script's own two labels. */
const LOADED_PARTICIPANTS = [
  { speaker_label: 'Me', display: 'Me', is_self: true },
  { speaker_label: 'Dana', display: 'Dana', is_self: false },
]

// ── Harness ──────────────────────────────────────────────────────────────

let container: HTMLDivElement
let root: Root
const fetchMock = vi.fn()

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  fetchMock.mockReset()
  toastSuccess.mockReset()
  toastError.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    // The GET returns the template capture's participants alongside the row.
    // The editor initialises its draft from them, because `participants` on a
    // PATCH REPLACES the list — a draft that started empty would delete every
    // speaker the case already had on the first save that mentions them.
    json: async () => ({ case: caseRow(), participants: LOADED_PARTICIPANTS }),
  })
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function text(): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ').trim()
}

async function mount(props: Partial<Parameters<typeof EvalCasePage>[0]> = {}) {
  await act(async () => {
    root.render(
      <EvalCasePage caseId="case-1" suiteName="Sales Discovery" onBack={() => {}} {...props} />,
    )
  })
  await act(async () => {})
}

/** A textarea by its aria-label — every editable field on this screen has one. */
function field(label: string): HTMLTextAreaElement {
  const el = container.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)
  if (!el) throw new Error(`no field labelled ${label}`)
  return el
}

/** Type into a controlled React input without a synthetic-event helper. */
function type(el: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim() === label,
  )
  if (!found) throw new Error(`no button labelled ${label}`)
  return found as HTMLButtonElement
}

/**
 * One item of a `ToggleGroup`. Radix strips `value` before it reaches the DOM,
 * so each item carries an `aria-label` equal to its value — and pressed-ness
 * is read off `data-state`, the one attribute both group types agree on (a
 * single group renders `aria-checked`, a multiple one `aria-pressed`).
 */
function toggleItem(value: string): HTMLButtonElement {
  const found = container.querySelector<HTMLButtonElement>(`[aria-label="${value}"]`)
  if (!found) throw new Error(`no toggle item for ${value}`)
  return found
}

function isPressed(el: HTMLElement): boolean {
  return el.getAttribute('data-state') === 'on'
}

// ── Pure helpers ─────────────────────────────────────────────────────────

describe('formatTimestamp', () => {
  it('renders mm:ss with a zero-padded seconds field', () => {
    expect(formatTimestamp(0)).toBe('0:00')
    expect(formatTimestamp(4000)).toBe('0:04')
    expect(formatTimestamp(65_000)).toBe('1:05')
    expect(formatTimestamp(600_000)).toBe('10:00')
  })

  it('floors partial seconds and never renders a negative offset', () => {
    expect(formatTimestamp(1999)).toBe('0:01')
    expect(formatTimestamp(-5)).toBe('0:00')
  })
})

describe('chunkBoundaries', () => {
  it('keys the divider on the LAST segment of each window', () => {
    const map = chunkBoundaries(caseRow().chunks)
    // Not after segment 0: that is mid-window, and a divider there would say
    // the agent got "Thanks for making time" on its own.
    expect(map.has(0)).toBe(false)
    expect(map.get(1)).toBe(0)
    expect(map.get(2)).toBe(1)
  })

  it('ignores a window with no segments rather than drawing it at index 0', () => {
    const map = chunkBoundaries([
      { index: 0, segment_indices: [] },
      { index: 1, segment_indices: [3] },
    ])
    expect(map.size).toBe(1)
    expect(map.get(3)).toBe(1)
  })
})

describe('selfSpeakers', () => {
  it('is the mic stream, which is what the accent colour keys on', () => {
    const selves = selfSpeakers(caseRow().script)
    expect(selves.has('Me')).toBe(true)
    expect(selves.has('Dana')).toBe(false)
  })
})

describe('nextItemKey', () => {
  it('never collides with a key already in the group', () => {
    // The key IS `check_key` downstream — the column the compare view joins
    // two runs on — so a duplicate would merge two expectations into one.
    const items = [{ key: 'proposal_1', gist: 'a' }, { key: 'proposal_2', gist: 'b' }]
    expect(nextItemKey('proposals', items)).toBe('proposal_3')
    expect(nextItemKey('proposals', [{ key: 'proposal_3', gist: 'c' }])).toBe('proposal_2')
  })

  it('gives the forbidden group its own stem', () => {
    expect(nextItemKey('forbidden_proposals', [])).toBe('forbidden_1')
    expect(nextItemKey('rubric', [])).toBe('rubric_1')
  })
})

// ── The screen ───────────────────────────────────────────────────────────

describe('EvalCasePage — the transcript pane', () => {
  it('renders every line with its mm:ss offset and speaker', async () => {
    await mount()
    const rendered = text()
    expect(rendered).toContain('0:00')
    expect(rendered).toContain('0:04')
    expect(rendered).toContain('0:20')
    expect(rendered).toContain('Dana')
    expect(field('Line 1 — Me').value).toBe('Thanks for making time.')
  })

  it('colours the mic speaker in the accent and leaves the others muted', async () => {
    await mount()
    const labels = [...container.querySelectorAll('span[title]')].filter((el) =>
      (el.getAttribute('title') ?? '').includes('·'),
    )
    const me = labels.find((el) => el.textContent === 'Me')
    const dana = labels.find((el) => el.textContent === 'Dana')
    expect(me?.className).toContain('text-primary')
    expect(dana?.className).toContain('text-muted-foreground')
  })

  it('draws one divider per frozen window, labelled by flush number', async () => {
    await mount()
    const rendered = text()
    expect(rendered).toContain('flush 1')
    expect(rendered).toContain('flush 2')
    expect(rendered).not.toContain('flush 3')
    expect(rendered).toContain('2 flushes')
  })

  it('marks the dividers stale the moment the script is edited', async () => {
    // The boundaries are recomputed by `updateEvalCase`, not here. Keeping
    // them crisp after an edit would point a load-bearing number at a window
    // that no longer exists.
    await mount()
    expect(text()).not.toContain('recomputed on save')
    await act(async () => {
      type(field('Line 2 — Dana'), 'What does this actually cost, all in?')
    })
    expect(text()).toContain('recomputed on save')
  })

  it('appends a segment past the silence rule so it lands in a new window', async () => {
    await mount()
    await act(async () => {
      button('Add line').click()
    })
    // 20000 + 4000: past the gate's 3s both-streams-quiet rule, which is what
    // a real turn boundary produces. A +1s append would extend the last window
    // instead of opening a new one.
    expect(text()).toContain('0:24')
    // The stream ALTERNATES off the previous line, so a pair appended by hand
    // reads as a turn — the gate only flushes when both streams have been
    // quiet, and two lines on one stream never produce a boundary.
    const streams = [...container.querySelectorAll('span[title]')]
      .map((el) => el.getAttribute('title'))
      .filter((title): title is string => Boolean(title?.includes(' · ')))
    expect(streams[2]).toBe('Me · mic')
    expect(streams[3]).toBe('Me · system')
  })
})

describe('EvalCasePage — the expected pane', () => {
  it('renders each group with its items and severity', async () => {
    await mount()
    const rendered = text()
    expect(rendered).toContain('Proposals')
    expect(rendered).toContain('Forbidden')
    expect(rendered).toContain('Nudges')
    expect(rendered).toContain('Rubric')
    expect(rendered).toContain('pricing_followup')
    expect(field('What the agent should propose — pricing_followup').value).toBe(
      'Send the pricing one-pager',
    )
    expect(field('Summary').value).toBe('Names the pricing objection.')
  })

  it('shows an empty group as prose, not as a blank list', async () => {
    await mount()
    expect(text()).toContain('Nothing forbidden.')
  })

  it('renders the gate severity as pressed on a gate item', async () => {
    await mount()
    expect(isPressed(toggleItem('gate'))).toBe(true)
    expect(isPressed(toggleItem('soft'))).toBe(false)
  })

  it('shows polarity and modes as labelled toggle groups', async () => {
    // Both QUALIFY every expectation below them, and `UpdateCaseSchema` takes
    // both, so both are editable in place — as house toggle groups, not as
    // one-off pill buttons.
    await mount()
    expect(container.querySelector('[aria-label="Polarity"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Modes"]')).not.toBeNull()
    expect(isPressed(toggleItem('positive'))).toBe(true)
    expect(isPressed(toggleItem('batch'))).toBe(true)
    expect(isPressed(toggleItem('live'))).toBe(true)
  })

  it('names a negative control, because it inverts every expectation beside it', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ case: caseRow({ polarity: 'negative' }) }),
    })
    await mount()
    expect(text()).toContain('Negative control')
  })
})

describe('EvalCasePage — saving', () => {
  it('starts clean: Save is disabled until something changes', async () => {
    await mount()
    expect(button('Save changes').disabled).toBe(true)
    await act(async () => {
      type(field('Summary'), 'Names the objection and the next step.')
    })
    expect(button('Save changes').disabled).toBe(false)
  })

  it('PATCHes only keys UpdateCaseSchema accepts, and sends polarity and modes', async () => {
    await mount()
    await act(async () => {
      type(field('Line 2 — Dana'), 'What does this actually cost?')
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ case: caseRow({ name: 'Prospect stalls on pricing' }) }),
    })
    await act(async () => {
      button('Save changes').click()
    })
    await act(async () => {})

    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
    expect(call).toBeTruthy()
    expect(call?.[0]).toBe('/api/account/evals/cases/case-1')
    const body = JSON.parse(call?.[1].body as string) as Record<string, unknown>
    expect(body).toHaveProperty('script')
    expect(body).toHaveProperty('expected')
    // `polarity` and `modes` QUALIFY every expectation on the case, so
    // `UpdateCaseSchema` takes both and the editor sends them.
    expect(body.polarity).toBe('positive')
    expect(body.modes).toEqual(['batch', 'live'])
    // The schema is .strict(), so anything it does NOT declare 400s the whole
    // edit rather than being quietly dropped. Nothing extra may ride along.
    const ALLOWED = ['name', 'script', 'expected', 'participants', 'polarity', 'modes']
    for (const key of Object.keys(body)) expect(ALLOWED).toContain(key)
    // And nothing that did not change is sent as an explicit undefined key.
    expect(Object.keys(body)).not.toContain('name')
  })

  it('flips polarity and toggles modes, and both reach the PATCH', async () => {
    await mount()
    // Positive → negative control. A case whose polarity cannot be fixed after
    // authoring has to be deleted and rewritten.
    await act(async () => {
      toggleItem('negative').click()
    })
    expect(isPressed(toggleItem('negative'))).toBe(true)

    await act(async () => {
      toggleItem('live').click()
    })

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ case: caseRow({ polarity: 'negative', modes: ['batch'] }) }),
    })
    await act(async () => {
      button('Save changes').click()
    })
    await act(async () => {})

    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
    const body = JSON.parse(call?.[1].body as string) as Record<string, unknown>
    expect(body.polarity).toBe('negative')
    expect(body.modes).toEqual(['batch'])
  })

  it('refuses to turn off the LAST mode — the schema floors it at one', async () => {
    await mount()
    await act(async () => {
      toggleItem('live').click()
    })
    // One left. Sending `[]` would 400 the whole edit, and a case that runs in
    // no mode is graded by nothing, so emptying the group is ignored.
    expect(isPressed(toggleItem('batch'))).toBe(true)
    await act(async () => {
      toggleItem('batch').click()
    })
    expect(isPressed(toggleItem('batch'))).toBe(true)
  })

  it('re-adds a mode in canonical order, and going back to the loaded set is not dirty', async () => {
    await mount()
    // Off, then on again. Two things must hold: the array comes back
    // ['batch','live'] rather than ['live','batch'] (so two cases with the
    // same modes look the same), and returning to the loaded value clears the
    // dirty flag rather than leaving a no-op save armed.
    await act(async () => {
      toggleItem('live').click()
    })
    expect(button('Save changes').disabled).toBe(false)
    await act(async () => {
      toggleItem('live').click()
    })
    expect(button('Save changes').disabled).toBe(true)
  })

  it('rehydrates from the saved row, so re-frozen chunks land immediately', async () => {
    await mount()
    await act(async () => {
      type(field('Line 3 — Me'), 'Ninety-nine a seat, billed annually.')
    })
    expect(text()).toContain('recomputed on save')

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        case: caseRow({
          script: [
            ...caseRow().script.slice(0, 2),
            {
              t_ms: 20000,
              speaker: 'Me',
              stream: 'mic',
              text: 'Ninety-nine a seat, billed annually.',
            },
          ],
        }),
      }),
    })
    await act(async () => {
      button('Save changes').click()
    })
    await act(async () => {})

    expect(toastSuccess).toHaveBeenCalledWith('Saved. Flush boundaries recomputed.')
    expect(text()).not.toContain('recomputed on save')
    expect(button('Save changes').disabled).toBe(true)
  })

  it('surfaces the route’s own message rather than a generic failure', async () => {
    await mount()
    await act(async () => {
      type(field('Summary'), 'x')
    })
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ error: 'expected: Unrecognized key "proposal"' }),
    })
    await act(async () => {
      button('Save changes').click()
    })
    await act(async () => {})
    expect(text()).toContain('Unrecognized key')
  })
})

describe('EvalCasePage — running this case', () => {
  /** Open the header's ⋯ menu and click one of its items. Radix opens on
   *  pointerdown, not click, and portals the content to document.body. */
  async function menuItem(label: string): Promise<HTMLElement> {
    const trigger = [...container.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'More actions',
    ) as HTMLButtonElement
    if (!trigger) throw new Error('no ⋯ menu')
    await act(async () => {
      trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      trigger.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
      trigger.click()
    })
    await act(async () => {})
    const item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) =>
      (el.textContent ?? '').includes(label),
    ) as HTMLElement
    if (!item) throw new Error(`no menu item ${label}`)
    return item
  }

  it('posts case_ids scoped to this case in batch mode', async () => {
    await mount()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ run: { id: 'run-1' }, adopted: false }),
    })
    const item = await menuItem('Run batch on this case')
    await act(async () => {
      item.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
      item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
      item.click()
    })
    await act(async () => {})

    const call = fetchMock.mock.calls.find(([url]) => url === '/api/account/evals/runs')
    expect(call).toBeTruthy()
    const body = JSON.parse(call?.[1].body as string)
    expect(body).toEqual({ suite_id: 'suite-1', mode: 'batch', case_ids: ['case-1'] })
    expect(toastSuccess).toHaveBeenCalledWith('Batch run queued.')
  })

  it('plays this case live from the header, scoped to this case', async () => {
    await mount()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ run: { id: 'run-1' }, adopted: false }),
    })
    await act(async () => {
      button('Play this case').click()
    })
    await act(async () => {})

    const call = fetchMock.mock.calls.find(([url]) => url === '/api/account/evals/runs')
    const body = JSON.parse(call?.[1].body as string)
    expect(body).toEqual({ suite_id: 'suite-1', mode: 'live', case_ids: ['case-1'] })
  })

  it('says it is following the existing run when the live-run index adopted one', async () => {
    // A 202 with `adopted: true` is the unique index refusing a second live
    // run of this suite+mode. It is convergence, not an error.
    await mount()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 202,
      json: async () => ({ run: { id: 'run-0' }, adopted: true }),
    })
    await act(async () => {
      button('Play this case').click()
    })
    await act(async () => {})
    expect(toastSuccess).toHaveBeenCalledWith(
      expect.stringContaining('already has a live run going'),
    )
  })

  it('refuses to run an unsaved script, which would grade the stored one', async () => {
    await mount()
    await act(async () => {
      type(field('Line 1 — Me'), 'Different opener entirely.')
    })
    expect(button('Play this case').disabled).toBe(true)
  })
})

describe('EvalCasePage — loading', () => {
  it('offers a way out rather than a blank pane when the case is gone', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Case not found' }),
    })
    const onBack = vi.fn()
    await mount({ onBack })
    expect(text()).toContain('Case not found')
    await act(async () => {
      button('Close').click()
    })
    expect(onBack).toHaveBeenCalled()
  })
})

// ── Pasting a real transcript ────────────────────────────────────────────

/**
 * The dialog renders through a Radix portal, so it lands on `document.body`
 * rather than inside `container` — every helper above is scoped to the page
 * and would miss it. These four are the same helpers, aimed at the document.
 */
function docText(): string {
  return (document.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}

function docField(label: string): HTMLTextAreaElement {
  const el = document.querySelector<HTMLTextAreaElement>(`[aria-label="${label}"]`)
  if (!el) throw new Error(`no field labelled ${label}`)
  return el
}

function docButton(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim() === label,
  )
  if (!found) throw new Error(`no button labelled ${label}`)
  return found as HTMLButtonElement
}

/** A toggle item inside the dialog. Radix strips `value`, so items carry an
 *  `aria-label` — and the page behind the dialog has toggles of its own, so
 *  this deliberately reads the LAST match, which is the portal's. */
function dialogToggle(value: string): HTMLButtonElement {
  const all = [...document.querySelectorAll<HTMLButtonElement>(`[aria-label="${value}"]`)]
  const found = all[all.length - 1]
  if (!found) throw new Error(`no toggle item for ${value}`)
  return found
}

/** Open the dialog and paste `value` into it. */
async function paste(value: string) {
  await act(async () => {
    button('Paste transcript').click()
  })
  await act(async () => {
    type(docField('Transcript to paste'), value)
  })
}

const HUD_PASTE = [
  'You: Quick one before we wrap. Can you send the security questionnaire this week?',
  'Remote 1: Yes. I will have it to you by Thursday.',
  'You: Perfect, thanks.',
].join('\n')

describe('EvalCasePage — paste transcript', () => {
  it('opens the dialog from the transcript header', async () => {
    await mount()
    expect(docText()).not.toContain('Paste lines like')
    await act(async () => {
      button('Paste transcript').click()
    })
    expect(docText()).toContain('Paste transcript')
    expect(docField('Transcript to paste')).toBeTruthy()
  })

  it('summarises the paste and preselects You in the speaker picker', async () => {
    await mount()
    await paste(HUD_PASTE)
    expect(docText()).toContain('3 lines · 2 speakers')
    // `You` is the HUD's own word for the local mic, which is the one speaker
    // we can identify without asking.
    expect(isPressed(dialogToggle('You'))).toBe(true)
    expect(isPressed(dialogToggle('Remote 1'))).toBe(false)
    expect(isPressed(dialogToggle('Nobody'))).toBe(false)
  })

  it('keeps Append and Replace disabled until something parses', async () => {
    await mount()
    await act(async () => {
      button('Paste transcript').click()
    })
    expect(docButton('Append').disabled).toBe(true)
    expect(docButton('Replace transcript').disabled).toBe(true)

    await act(async () => {
      type(docField('Transcript to paste'), 'just some notes I typed out')
    })
    expect(docText()).toContain('Nothing looked like a transcript line')
    expect(docButton('Append').disabled).toBe(true)

    await act(async () => {
      type(docField('Transcript to paste'), HUD_PASTE)
    })
    expect(docButton('Append').disabled).toBe(false)
  })

  it('Replace swaps the whole script, labelled and streamed for self-binding', async () => {
    await mount()
    await paste(HUD_PASTE)
    await act(async () => {
      docButton('Replace transcript').click()
    })

    // The fixture's three lines are gone, replaced by the paste's three.
    expect(field('Line 1 — local_1').value).toBe(
      'Quick one before we wrap. Can you send the security questionnaire this week?',
    )
    expect(field('Line 2 — remote_1').value).toBe('Yes. I will have it to you by Thursday.')
    expect(field('Line 3 — local_1').value).toBe('Perfect, thanks.')

    // The isolation contract: exactly one `local_1` on the MIC stream, which is
    // the only shape `selfSpeakerLabel` will bind to the owner's member row.
    const streams = [...container.querySelectorAll('span[title]')]
      .map((el) => el.getAttribute('title'))
      .filter((t): t is string => Boolean(t?.includes(' · ')))
    expect(streams).toEqual(['local_1 · mic', 'remote_1 · system', 'local_1 · mic'])

    expect(toastSuccess).toHaveBeenCalledWith('Imported 3 lines from 2 speakers')
  })

  it('Append extends the script after the last line, monotonically', async () => {
    await mount()
    await paste(HUD_PASTE)
    await act(async () => {
      docButton('Append').click()
    })

    // The three fixture lines are still there, with three more after them.
    expect(field('Line 1 — Me').value).toBe('Thanks for making time.')
    expect(field('Line 4 — local_1').value).toContain('Quick one before we wrap.')
    // The fixture's own speakers are `Me`/`Dana` on mic/system, so the pasted
    // `Remote 1` takes the first free remote label.
    expect(field('Line 5 — remote_1').value).toBe('Yes. I will have it to you by Thursday.')

    // Every offset moves forward, and the seam clears the gate's silence rule
    // so the join is a flush boundary rather than a window spanning it.
    const offsets = [...container.querySelectorAll('span.tabular-nums')]
      .map((el) => el.textContent ?? '')
      .filter((t) => /^\d+:\d\d$/.test(t))
      .map((t) => {
        const [m, sec] = t.split(':')
        return Number(m) * 60 + Number(sec)
      })
    expect(offsets).toHaveLength(6)
    for (let i = 1; i < offsets.length; i++) {
      expect(offsets[i]).toBeGreaterThan(offsets[i - 1])
    }
    // 0:20 (the fixture's last) + 3.5s turn gap → 0:23.
    expect(offsets[3]).toBe(23)
  })

  /**
   * `participants` on a PATCH REPLACES the capture's list — the documented
   * contract on both tool schemas, and the only shape that can REMOVE a
   * speaker. That makes the CLIENT responsible for sending a whole list, which
   * is what these three assert: Replace sends only the pasted speakers (the
   * removal), Append sends the loaded list merged with the pasted one (nobody
   * is lost), and a save that changed nothing else sends no list at all.
   */
  it('Replace sends ONLY the pasted speakers, so a dropped speaker is really dropped', async () => {
    await mount()
    await paste(HUD_PASTE)
    await act(async () => {
      docButton('Replace transcript').click()
    })
    await act(async () => {
      button('Save changes').click()
    })
    await act(async () => {})

    const call = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/account/evals/cases/case-1' && init?.method === 'PATCH',
    )
    const body = JSON.parse(call?.[1].body as string)
    // No `Me`/`Dana`: the paste replaced the script, so it replaces the roster.
    expect(body.participants).toEqual([
      { speaker_label: 'local_1', display: 'You', is_self: true },
      { speaker_label: 'remote_1', display: 'Remote 1', is_self: false },
    ])
  })

  it('Append sends the FULL merged list, so the existing speakers survive', async () => {
    await mount()
    await paste(HUD_PASTE)
    await act(async () => {
      docButton('Append').click()
    })
    await act(async () => {
      button('Save changes').click()
    })
    await act(async () => {})

    const call = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/account/evals/cases/case-1' && init?.method === 'PATCH',
    )
    const body = JSON.parse(call?.[1].body as string)
    // Dana survives because the CLIENT sent her — the server replaces wholesale.
    expect(body.participants).toEqual([
      ...LOADED_PARTICIPANTS,
      { speaker_label: 'local_1', display: 'You', is_self: true },
      { speaker_label: 'remote_1', display: 'Remote 1', is_self: false },
    ])
  })

  it('sends NO participants on an ordinary save, which would rewrite them for nothing', async () => {
    await mount()
    await act(async () => {
      type(field('Line 1 — Me'), 'A different opener.')
    })
    await act(async () => {
      button('Save changes').click()
    })
    await act(async () => {})

    const call = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/account/evals/cases/case-1' && init?.method === 'PATCH',
    )
    const body = JSON.parse(call?.[1].body as string)
    expect('participants' in body).toBe(false)
  })

  it('puts everyone on the system stream when the self is Nobody', async () => {
    await mount()
    await paste(HUD_PASTE)
    await act(async () => {
      dialogToggle('Nobody').click()
    })
    await act(async () => {
      docButton('Replace transcript').click()
    })
    const streams = [...container.querySelectorAll('span[title]')]
      .map((el) => el.getAttribute('title'))
      .filter((t): t is string => Boolean(t?.includes(' · ')))
    expect(streams).toEqual(['remote_1 · system', 'remote_2 · system', 'remote_1 · system'])
  })
})

// ── A case swapped under the same mounted editor ──────────────────────────

describe('switching caseId', () => {
  /**
   * The Recently-viewed popover can jump straight from one eval case to
   * another, and `EvalsView` renders ONE `EvalCasePage` with no `key` — so the
   * instance is reused. If the new id's fetch fails and the old row is still
   * mounted, the editor renders case A's script and grading contract under
   * case B's id, and the next Save PATCHes A's content onto B.
   */
  it('drops the previous case when a load for a new id fails', async () => {
    await mount()
    expect(text()).toContain('Thanks for making time.')

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Case not found' }),
    })
    await act(async () => {
      root.render(
        <EvalCasePage caseId="case-2" suiteName="Sales Discovery" onBack={() => {}} />,
      )
    })
    await act(async () => {})

    // Not case A's script, and no editor to save case A's content from.
    expect(text()).not.toContain('Thanks for making time.')
    expect(container.querySelector('[aria-label="Line 1 — Me"]')).toBeNull()
  })
})

describe('EvalCasePage — the call goal (live sidekick)', () => {
  it('edits expected.goal and PATCHes it with the rest of expected', async () => {
    await mount()
    await act(async () => {
      type(field('Goal'), 'Get to a signed pilot')
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ case: caseRow() }),
    })
    await act(async () => {
      button('Save changes').click()
    })
    await act(async () => {})
    const call = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH')
    const body = JSON.parse(call?.[1].body as string) as { expected: Record<string, unknown> }
    expect(body.expected.goal).toBe('Get to a signed pilot')
  })
})

import { describe, it, expect } from 'vitest'
import {
  ASSISTANT_PERSONA,
  BASE_SYSTEM_PROMPT,
  BATCH_SUMMARY_REQUIRED,
  BATCH_USER_NOTES_GUIDANCE,
  LIVE_ASSIST_BASE_PROMPT,
  LIVE_NOTES_PAIRING_PROMPT,
  RECIPE_PREAMBLE,
  liveTurnBudgetPrompt,
} from '../prompts'
import { WEB_ACCESS_GUIDANCE } from '@/lib/ai/web-access-prompt'
import { composeLiveAgentSystemPrompt } from '../turn-composition'
import {
  RIDERS,
  RIDER_IDS,
  cutRiders,
  isRiderId,
  normalizeRiderOmissions,
  selectRiderOmissions,
  type RiderId,
  type RiderScope,
} from '../riders'

/**
 * Prompt riders (live sidekick Phase 7 PR 3): sections a turn carries only when
 * it needs them. These pin the anchors to the real constants, the no-omission
 * identity, the text that must survive every combination, and the selection
 * rules (fail open to the full prompt).
 */

const TEXT: Record<RiderScope, string> = {
  base: BASE_SYSTEM_PROMPT,
  assist: LIVE_ASSIST_BASE_PROMPT,
  persona: ASSISTANT_PERSONA,
}

const count = (hay: string, needle: string) => hay.split(needle).length - 1

/** Every subset of the registry (2³ for v1). */
const ALL_OMIT_SETS: RiderId[][] = (() => {
  const out: RiderId[][] = []
  for (let mask = 0; mask < 1 << RIDER_IDS.length; mask++) {
    out.push(RIDER_IDS.filter((_, i) => mask & (1 << i)))
  }
  return out
})()

/** A section of a constant: from `start` (inclusive) to `end` (exclusive), or to the end. */
function section(text: string, start: string, end?: string): string {
  const s = text.indexOf(start)
  expect(s, start).toBeGreaterThanOrEqual(0)
  if (end === undefined) return text.slice(s)
  const e = text.indexOf(end, s)
  expect(e, end).toBeGreaterThan(s)
  return text.slice(s, e).trimEnd()
}

/** The text every combination must keep verbatim, per base. */
const MUST_SURVIVE = {
  base: [
    section(BASE_SYSTEM_PROMPT, '## Ownership — MY action items', '## What to Capture'),
    section(BASE_SYSTEM_PROMPT, '- **propose_change** — ', '\n- **propose_mcp_call**'),
    section(BASE_SYSTEM_PROMPT, '## Voice ID and Speaker Names', '## Ownership'),
  ],
  assist: [
    section(LIVE_ASSIST_BASE_PROMPT, '## Voice ID and Speaker Names', '## One Hard Exception'),
    section(LIVE_ASSIST_BASE_PROMPT, '## One Hard Exception'),
    section(LIVE_ASSIST_BASE_PROMPT, '## How You Speak', '## Ground Everything You Say'),
  ],
  persona: [
    section(ASSISTANT_PERSONA, 'One hard exception:', '\n\nYou are NOT required'),
    // The commitment paragraph and the one after it sit right past the talk
    // cut's end anchor: they must never be pulled into it.
    section(ASSISTANT_PERSONA, 'A commitment is a commitment whatever the context.', '\n\n'),
    section(ASSISTANT_PERSONA, 'You are NOT required', '\n\n'),
  ],
}

/** composeLiveAgentSystemPrompt as it was before riders (the reference the no-omit path is held to). */
function fullPrompt(i: {
  recipe: { system_prompt: string | null } | null
  assistOnly: boolean
  webAccess: boolean
  notesRole: boolean
  isBatch: boolean
  batchUserNotes: string
}): string {
  return (
    (i.assistOnly ? LIVE_ASSIST_BASE_PROMPT : BASE_SYSTEM_PROMPT) +
    (i.webAccess ? '\n\n' + WEB_ACCESS_GUIDANCE : '') +
    '\n\n' +
    RECIPE_PREAMBLE +
    '\n\n' +
    (i.recipe?.system_prompt || ASSISTANT_PERSONA) +
    (i.notesRole ? '\n\n' + LIVE_NOTES_PAIRING_PROMPT : '') +
    (i.isBatch ? '\n\n' + BATCH_SUMMARY_REQUIRED : '') +
    (i.isBatch && i.batchUserNotes ? '\n\n' + BATCH_USER_NOTES_GUIDANCE : '') +
    (i.isBatch ? '' : '\n\n' + liveTurnBudgetPrompt(i.assistOnly))
  )
}

/** Every composition input combination (turn shape × base × persona × web × user notes). */
const COMBOS = (() => {
  const out: Array<Parameters<typeof fullPrompt>[0]> = []
  for (const assistOnly of [false, true])
    for (const recipe of [null, { system_prompt: 'A RECIPE PERSONA' }, { system_prompt: '' }])
      for (const webAccess of [false, true])
        for (const shape of ['copilot', 'notes', 'batch'] as const)
          for (const batchUserNotes of ['', 'my notes']) {
            if (assistOnly && shape !== 'copilot') continue
            out.push({ recipe, assistOnly, webAccess, notesRole: shape === 'notes', isBatch: shape === 'batch', batchUserNotes })
          }
  return out
})()

describe('the rider registry', () => {
  it('every anchor resolves exactly once in its constant, the end after the start', () => {
    for (const rider of RIDERS) {
      for (const cut of rider.cuts) {
        const text = TEXT[cut.in]
        expect(count(text, cut.start), `${rider.id} ${cut.in} start ${JSON.stringify(cut.start)}`).toBe(1)
        expect(count(text, cut.end), `${rider.id} ${cut.in} end ${JSON.stringify(cut.end)}`).toBe(1)
        expect(text.indexOf(cut.end), `${rider.id} ${cut.in}`).toBeGreaterThan(text.indexOf(cut.start))
      }
    }
  })

  it('ids are unique and isRiderId / normalizeRiderOmissions accept only them, in registry order', () => {
    expect(new Set(RIDER_IDS).size).toBe(RIDER_IDS.length)
    expect(RIDER_IDS).toEqual(['packages', 'mcp-propose', 'talk'])
    for (const id of RIDER_IDS) expect(isRiderId(id)).toBe(true)
    for (const bad of ['ownership', '', 'Talk', 1, null, undefined]) expect(isRiderId(bad)).toBe(false)
    expect(normalizeRiderOmissions(['talk', 'x', 'packages', 'talk'])).toEqual(['packages', 'talk'])
    expect(normalizeRiderOmissions('talk')).toEqual([])
    expect(normalizeRiderOmissions(undefined)).toEqual([])
  })

  it('each cut removes whole blank-line-joined segments, or one whole line of the core kit', () => {
    for (const rider of RIDERS) {
      for (const cut of rider.cuts) {
        const text = TEXT[cut.in]
        const out = cutRiders(text, [rider.id], cut.in)
        expect(out.length, `${rider.id} ${cut.in}`).toBeLessThan(text.length)
        expect(out, `${rider.id} ${cut.in}`).not.toContain('\n\n\n')
        expect(out.startsWith(text.slice(0, 40))).toBe(true)
        expect(out.endsWith(text.slice(-40))).toBe(true)
        // What remains is the original's segments, in order, less some — or,
        // for a core-kit line cut, a segment with whole lines gone.
        const linesSubsequence = (small: string, big: string) => {
          const b = big.split('\n')
          let k = 0
          for (const line of small.split('\n')) {
            while (k < b.length && b[k] !== line) k++
            if (k === b.length) return false
            k++
          }
          return true
        }
        const before = text.split('\n\n')
        const after = out.split('\n\n')
        let j = 0
        for (const seg of after) {
          while (j < before.length && before[j] !== seg && !linesSubsequence(seg, before[j])) j++
          expect(j, `${rider.id} ${cut.in}: ${seg.slice(0, 60)}`).toBeLessThan(before.length)
          j++
        }
        expect(after.length, `${rider.id} ${cut.in}`).toBeLessThanOrEqual(before.length)
      }
    }
  })

  it('a cut whose anchors are missing cuts nothing (a recipe text, or text the cut already removed)', () => {
    expect(cutRiders('A RECIPE PERSONA', ['talk', 'packages', 'mcp-propose'], 'persona')).toBe('A RECIPE PERSONA')
    const once = cutRiders(BASE_SYSTEM_PROMPT, ['packages'], 'base')
    expect(cutRiders(once, ['packages'], 'base')).toBe(once)
  })
})

/** What one cut removes from its constant. */
function removed(cut: { in: RiderScope; start: string; end: string }): string {
  const text = TEXT[cut.in]
  const from = text.indexOf(cut.start)
  return text.slice(from, text.indexOf(cut.end, from))
}

// A cut runs from its start up to its end, so anything later written between
// the two would vanish silently on every turn that omits the rider. These pin
// the SHAPE of what each cut removes: a new line or paragraph inside a cut
// fails here, and whoever added it decides whether it belongs to the rider.
describe('each cut removes exactly what it is meant to', () => {
  const cut = (id: RiderId, i: number) => RIDERS.find((r) => r.id === id)!.cuts[i]

  it('packages: one section, its own heading only (both bases)', () => {
    for (const i of [0, 1]) {
      const body = removed(cut('packages', i))
      expect(body.startsWith('## Attached Context Packages')).toBe(true)
      expect(count(body, '\n## ')).toBe(0)
    }
  })

  it('mcp-propose: the one propose_mcp_call core-kit line, and the one External MCP proposals paragraph', () => {
    const line = removed(cut('mcp-propose', 0)).trimEnd()
    expect(line.startsWith('- **propose_mcp_call** — ')).toBe(true)
    expect(line).not.toContain('\n')
    const para = removed(cut('mcp-propose', 1)).trimEnd()
    expect(para.startsWith('**External MCP proposals:**')).toBe(true)
    expect(para).not.toContain('\n\n')
  })

  it('talk: the one say_to_user core-kit line in the base', () => {
    const line = removed(cut('talk', 0))
    expect(line.startsWith('\n- **say_to_user** — ')).toBe(true)
    expect(line.slice(1)).not.toContain('\n')
  })

  it("talk: exactly the built-in persona's live section, heading through the ask_user paragraph", () => {
    const paragraphs = removed(cut('talk', 1)).split('\n\n').filter((p) => p.trim())
    expect(paragraphs[0].startsWith('## While the conversation is live, be useful in it')).toBe(true)
    expect(paragraphs.at(-1)).toContain('ask_user')
    // Eight segments today (fixture segments 69-76). A ninth means a paragraph
    // was added inside the live section: decide whether notes and batch turns
    // should lose it too, then update this count.
    expect(paragraphs).toHaveLength(8)
  })
})

describe('no omissions: the full prompt, byte for byte', () => {
  it('cutRiders with nothing to omit returns each constant itself', () => {
    for (const scope of ['base', 'assist', 'persona'] as const) {
      expect(cutRiders(TEXT[scope], [], scope)).toBe(TEXT[scope])
      expect(cutRiders(TEXT[scope], undefined, scope)).toBe(TEXT[scope])
    }
  })

  it('composeLiveAgentSystemPrompt is unchanged for every base and persona combination', () => {
    expect(COMBOS.length).toBeGreaterThan(30)
    for (const c of COMBOS) {
      const want = fullPrompt(c)
      expect(composeLiveAgentSystemPrompt(c), JSON.stringify(c)).toBe(want)
      expect(composeLiveAgentSystemPrompt({ ...c, omit: [] }), JSON.stringify(c)).toBe(want)
    }
  })

  it('the riders never touch the exported constants', () => {
    for (const omit of ALL_OMIT_SETS) {
      for (const c of COMBOS) composeLiveAgentSystemPrompt({ ...c, omit })
    }
    expect(TEXT.base).toBe(BASE_SYSTEM_PROMPT)
    expect(BASE_SYSTEM_PROMPT).toContain('## Attached Context Packages')
    expect(BASE_SYSTEM_PROMPT).toContain('- **say_to_user** — ')
    expect(LIVE_ASSIST_BASE_PROMPT).toContain('## Attached Context Packages')
    expect(ASSISTANT_PERSONA).toContain('## While the conversation is live, be useful in it')
  })
})

describe('every omission combination keeps what must survive', () => {
  it.each(ALL_OMIT_SETS.map((omit) => [omit.join('+') || '(none)', omit] as const))('%s', (_label, omit) => {
    for (const c of COMBOS) {
      const prompt = composeLiveAgentSystemPrompt({ ...c, omit })
      const label = `${omit.join('+')} ${JSON.stringify(c)}`
      for (const text of MUST_SURVIVE[c.assistOnly ? 'assist' : 'base']) expect(prompt, label).toContain(text)
      // The persona's self-harm exception, on the built-in persona.
      if (!c.recipe?.system_prompt) for (const text of MUST_SURVIVE.persona) expect(prompt, label).toContain(text)
      // A recipe's own text is never cut.
      if (c.recipe?.system_prompt) expect(prompt, label).toContain(c.recipe.system_prompt)
      // The shared layers are untouched.
      expect(prompt.includes(WEB_ACCESS_GUIDANCE), label).toBe(c.webAccess)
      expect(prompt, label).toContain(RECIPE_PREAMBLE)
      expect(prompt.includes(LIVE_NOTES_PAIRING_PROMPT), label).toBe(c.notesRole)
      expect(prompt, label).not.toContain('\n\n\n')

      // What each rider cuts is gone exactly when omitted.
      const base = c.assistOnly ? LIVE_ASSIST_BASE_PROMPT : BASE_SYSTEM_PROMPT
      expect(prompt.includes('## Attached Context Packages'), label).toBe(!omit.includes('packages'))
      if (!c.assistOnly) {
        expect(prompt.includes('- **propose_mcp_call** — '), label).toBe(!omit.includes('mcp-propose'))
        expect(prompt.includes('**External MCP proposals:**'), label).toBe(!omit.includes('mcp-propose'))
        expect(prompt.includes('- **say_to_user** — Speak a short heads-up'), label).toBe(!omit.includes('talk'))
      } else {
        // The assist base keeps its own say_to_user (it IS the output channel).
        expect(prompt, label).toContain('- **say_to_user** — Speak to the user on their live display')
      }
      if (!c.recipe?.system_prompt) {
        expect(prompt.includes('## While the conversation is live, be useful in it'), label).toBe(!omit.includes('talk'))
      }
      expect(prompt.startsWith(cutRiders(base, omit, c.assistOnly ? 'assist' : 'base')), label).toBe(true)
    }
  })
})

describe('selectRiderOmissions', () => {
  const live = { turnType: 'copilot', assistOnly: false, hasPackages: true, hasMcpBlock: true, builtInPersona: true } as const

  it('a copilot turn with packages and an MCP block keeps everything', () => {
    expect(selectRiderOmissions(live)).toEqual([])
  })

  it('packages: dropped only when the manifest is known empty', () => {
    expect(selectRiderOmissions({ ...live, hasPackages: false })).toEqual(['packages'])
    expect(selectRiderOmissions({ ...live, assistOnly: true, hasPackages: false })).toEqual(['packages'])
    expect(selectRiderOmissions({ ...live, hasPackages: undefined })).toEqual([])
    expect(selectRiderOmissions({ ...live, hasPackages: null })).toEqual([])
  })

  it('mcp-propose: dropped on a writer with no MCP block; never listed for assist-only (its base has no such lines)', () => {
    expect(selectRiderOmissions({ ...live, hasMcpBlock: false })).toEqual(['mcp-propose'])
    expect(selectRiderOmissions({ ...live, hasMcpBlock: undefined })).toEqual([])
    expect(selectRiderOmissions({ ...live, assistOnly: true, hasMcpBlock: false })).toEqual([])
    expect(selectRiderOmissions({ ...live, assistOnly: true, hasMcpBlock: true })).toEqual([])
  })

  it('talk: dropped on notes and batch turns, kept on a copilot or an unknown turn type', () => {
    expect(selectRiderOmissions({ ...live, turnType: 'notes' })).toEqual(['talk'])
    expect(selectRiderOmissions({ ...live, turnType: 'batch', hasPackages: false })).toEqual(['packages', 'talk'])
    // A recipe persona still loses the base's say_to_user line (the persona text is never cut).
    expect(selectRiderOmissions({ ...live, turnType: 'notes', builtInPersona: false })).toEqual(['talk'])
    expect(selectRiderOmissions({ ...live, turnType: undefined })).toEqual([])
    expect(selectRiderOmissions({ ...live, turnType: 'something' as never })).toEqual([])
  })

  it('fails open to the full prompt when the base is unknown', () => {
    expect(
      selectRiderOmissions({ turnType: 'batch', assistOnly: undefined, hasPackages: false, hasMcpBlock: false, builtInPersona: true }),
    ).toEqual([])
    expect(
      selectRiderOmissions({ turnType: 'batch', assistOnly: null, hasPackages: false, hasMcpBlock: false, builtInPersona: true }),
    ).toEqual([])
  })

  it('everything known absent on a batch: all three, in registry order', () => {
    expect(
      selectRiderOmissions({ turnType: 'batch', assistOnly: false, hasPackages: false, hasMcpBlock: false, builtInPersona: true }),
    ).toEqual(['packages', 'mcp-propose', 'talk'])
  })
})

/**
 * PAIRED LIVE NOTES — the second agent that runs beside an assist-only copilot.
 *
 * The product rule (2026-09-24): an assist-only live copilot talks to the user
 * and writes nothing; it is PAIRED with a note-taker that writes the record live
 * and never talks. Same transcript windows, two agents, one capture. The
 * post-call pass still runs afterwards and finalizes the record.
 *
 * Three things have to hold for the split to be real rather than aspirational:
 *
 *   1. TOOLS — the note-taker's live tool map physically lacks the talk tools
 *      (the mirror of the copilot's strip). A prompt alone is not enforcement.
 *   2. PROMPT — the pairing rider tells the note-taker it never speaks and
 *      leaves the finishing work to the post-call pass.
 *   3. WIRING — the cloud route honors `live_role: 'notes'`, the copilot turn
 *      tells the client to pair (`pair_notes`), and the client fires the notes
 *      turn. Those are pinned on the source, like the assist-only tests are.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ASSIST_ONLY_EXCLUDED_TOOLS,
  LIVE_NOTES_EXCLUDED_TOOLS,
  PAIRED_COPILOT_ONLY_TOOLS,
  LIVE_COPILOT_ONLY_TOOLS,
} from '../read-tool-names'
import { LIVE_NOTES_PAIRING_PROMPT } from '../prompts'
import { buildDirectivesBlock } from '../directives'
import { createLiveAgentTools } from '../tools'
import { createSupabaseMock } from '@/test/supabase-mock'
import type { SupabaseClient } from '@supabase/supabase-js'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

// ── Tool stripping (the enforcement half) ──────────────────────────────────
describe('the paired note-taker live tool map', () => {
  const stagingTools = createLiveAgentTools(
    'user-1',
    createSupabaseMock({ tables: {} }) as unknown as SupabaseClient,
    'ws-1',
    'cap-1',
    null,
    null,
    'member-1',
    'Liam',
    null,
    {},
  )
  const notesNames = Object.keys(stagingTools).filter(
    (name) => !LIVE_NOTES_EXCLUDED_TOOLS.has(name),
  )

  it('withholds every tool that TALKS to the user', () => {
    for (const name of ['say_to_user', 'ask_user']) {
      expect(Object.keys(stagingTools), `${name} is not a real staging tool`).toContain(name)
      expect(notesNames, `${name} survived the notes strip`).not.toContain(name)
    }
  })

  it('keeps every tool that writes the record', () => {
    for (const name of ASSIST_ONLY_EXCLUDED_TOOLS) {
      expect(notesNames, `${name} was stripped from the note-taker`).toContain(name)
    }
  })

  it('is the mirror of the copilot strip — no tool is in both sets, and what neither names is a read', () => {
    const talk = [...LIVE_NOTES_EXCLUDED_TOOLS]
    expect(talk.some((t) => ASSIST_ONLY_EXCLUDED_TOOLS.has(t))).toBe(false)
    // The staging factory also carries a few always-on reads (search_projects,
    // list_workspace_members…). Those belong to BOTH agents; everything else in
    // the factory must be claimed by exactly one of the two strips — a new
    // staging tool that neither set names would silently reach both agents.
    // The copilot's relay to the note-taker (PAIRED_COPILOT_ONLY_TOOLS) is the
    // third claim: only the copilot holds it. load_skill (LIVE_COPILOT_ONLY_TOOLS)
    // is the fourth: the call playbook is for the agent that talks.
    for (const name of Object.keys(stagingTools)) {
      const claimed =
        LIVE_NOTES_EXCLUDED_TOOLS.has(name) ||
        ASSIST_ONLY_EXCLUDED_TOOLS.has(name) ||
        PAIRED_COPILOT_ONLY_TOOLS.has(name) ||
        LIVE_COPILOT_ONLY_TOOLS.has(name)
      expect(
        claimed || /^(search|list|get)_/.test(name),
        `${name} is neither a talk tool, a write tool, nor a read`,
      ).toBe(true)
    }
  })
})

// ── The prompt half ────────────────────────────────────────────────────────
describe('LIVE_NOTES_PAIRING_PROMPT', () => {
  it('records a directive the copilot relayed: it is the user’s ask, not the copilot’s words', () => {
    expect(LIVE_NOTES_PAIRING_PROMPT).toMatch(/Nothing the copilot said to the user is a fact about the conversation/)
    expect(LIVE_NOTES_PAIRING_PROMPT).toMatch(/"The copilot heard the user ask": that is the user's own request/)
    // The directive block uses exactly that label.
    expect(buildDirectivesBlock([{ id: 'a', source: 'copilot', text: 'x' }])).toContain('The copilot heard the user ask:')
    // …and never names the copilot's tool: the note-taker does not hold it.
    expect(LIVE_NOTES_PAIRING_PROMPT).not.toMatch(/direct_notes/)
  })

  it('tells the note-taker it never speaks, naming the withheld tools', () => {
    expect(LIVE_NOTES_PAIRING_PROMPT).toMatch(/You never speak/)
    for (const tool of LIVE_NOTES_EXCLUDED_TOOLS) {
      expect(LIVE_NOTES_PAIRING_PROMPT).toMatch(new RegExp(`\\b${tool}\\b`))
    }
  })

  it('leaves the finishing work to the post-call pass', () => {
    expect(LIVE_NOTES_PAIRING_PROMPT).toMatch(/post-call pass/i)
    expect(LIVE_NOTES_PAIRING_PROMPT).toMatch(/follow-up email draft/)
    expect(LIVE_NOTES_PAIRING_PROMPT).toMatch(/graded deal signal/)
  })

  it('keeps the record current rather than deferring everything', () => {
    expect(LIVE_NOTES_PAIRING_PROMPT).toMatch(/Keep the record current/)
  })
})

// ── Wiring (pinned on the source, like the assist-only tests) ──────────────
describe('paired live notes wiring', () => {
  it('the cloud route withholds the talk tools from a notes-role turn on the MAP', () => {
    // The cloud route's model call runs on eve: its tools MAP and system prompt
    // are built by the live-agent spec/tool routes from the turn type the route
    // mints into the run token.
    const src = read('src/app/api/ai/live-agent/route.ts')
    expect(src).toMatch(/turnType: liveTurnTypeFromRequest\(mode, live_role\)/)
    expect(read('src/lib/live-agent/ceiling.ts')).toMatch(/LIVE_NOTES_EXCLUDED_TOOLS\.has\(name\)/)
    expect(read('src/lib/live-agent/turn-composition.ts')).toMatch(/LIVE_NOTES_PAIRING_PROMPT/)
  })

  it('the cloud route resolves the BATCH persona for a notes-role turn and refuses an assist-only one', () => {
    const src = read('src/app/api/ai/live-agent/route.ts')
    // The notes role reuses the batch persona resolution + safety net: the
    // resolver runs with mode 'batch', and the assist-only net applies. The
    // route resolves it with the shared resolver the eve spec route uses.
    expect(src).toMatch(/const writesRecord = isBatch \|\| notesRole/)
    expect(src).toMatch(/const \{ recipe, assistOnly \} = await resolveLiveAgentPersona\(\{[\s\S]*?writesRecord,/)
    const resolver = read('src/lib/live-agent/turn-composition.ts')
    expect(resolver).toMatch(/mode: writesRecord \? 'batch' : 'live'/)
    expect(resolver).toMatch(/if \(writesRecord && isAssistOnlyAgent\(recipe\?\.agent_config\)\)/)
  })

  it('a copilot turn tells the client to pair, and the client fires the notes turn', () => {
    const route = read('src/app/api/ai/live-agent/route.ts')
    expect(route).toMatch(/pair_notes: assistOnly/)
    const hook = read('src/hooks/use-recording.ts')
    expect(hook).toMatch(/live_role: 'notes'/)
    expect(hook).toMatch(/pairNotesRef\.current = /)
  })
})

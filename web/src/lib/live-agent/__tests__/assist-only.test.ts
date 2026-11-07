/**
 * ASSIST-ONLY LIVE AGENTS — the split between "help me in this call" and
 * "write the record afterwards".
 *
 * The product rule (2026-09-14): a live agent flagged
 * `agent_config.capture_mode === 'assist_only'` gives real-time help ONLY. It
 * takes no notes and stages no proposals; a post-call batch pass does all of
 * that over the full transcript. Three things have to hold for that to be true
 * rather than aspirational, and this file pins each:
 *
 *   1. TOOLS — the live tool map physically lacks every capture tool. A prompt
 *      that merely asks the model not to write is not enforcement; the SDK will
 *      execute any tool that exists in the map.
 *   2. PROMPT — LIVE_ASSIST_BASE_PROMPT carries no summary/proposal mandate, so
 *      the model is never told to call a tool it does not have.
 *   3. BATCH — the pass that writes the record NEVER runs with an assist-only
 *      persona, and it runs at all after an assist-only live call.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  isAssistOnlyAgent,
  ASSIST_ONLY_EXCLUDED_TOOLS,
  narrowReadToolsByAgent,
  LIVE_AGENT_CORE_READ_TOOLS,
  LIVE_AGENT_READ_TOOLS,
} from '../read-tool-names'
import { ALL_CATEGORY_IDS } from '@/lib/ai/tool-registry'
import { LIVE_ASSIST_BASE_PROMPT, BASE_SYSTEM_PROMPT } from '../prompts'
import { shouldRunPostLiveBatch } from '../default-agent'
import { createLiveAgentTools } from '../tools'
import { createSupabaseMock } from '@/test/supabase-mock'
import type { SupabaseClient } from '@supabase/supabase-js'

const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

// ── isAssistOnlyAgent ──────────────────────────────────────────────────────
describe('isAssistOnlyAgent', () => {
  it('is true ONLY for the exact flag', () => {
    expect(isAssistOnlyAgent({ capture_mode: 'assist_only' })).toBe(true)
  })

  it('fails CLOSED — anything else is a normal note-taking agent', () => {
    expect(isAssistOnlyAgent(null)).toBe(false)
    expect(isAssistOnlyAgent(undefined)).toBe(false)
    expect(isAssistOnlyAgent({})).toBe(false)
    expect(isAssistOnlyAgent({ capture_mode: 'full' })).toBe(false)
    expect(isAssistOnlyAgent({ capture_mode: null })).toBe(false)
    // Shape garbage from an unconstrained jsonb column must not throw.
    expect(isAssistOnlyAgent({ capture_mode: 'ASSIST_ONLY' } as never)).toBe(false)
    expect(isAssistOnlyAgent({ capture_mode: 7 } as never)).toBe(false)
  })

  it('is orthogonal to the tool selection — both can be present', () => {
    expect(
      isAssistOnlyAgent({ enabled_tools: ['captures'], capture_mode: 'assist_only' }),
    ).toBe(true)
  })
})

// ── Tool stripping (the enforcement half) ──────────────────────────────────
describe('the assist-only live tool map', () => {
  // Build the REAL staging tool set, then apply the route's filter to it. Using
  // the real factory (rather than a hand-written list) is the point: a newly
  // added capture tool that nobody adds to ASSIST_ONLY_EXCLUDED_TOOLS shows up
  // here as a survivor, which is exactly the regression worth catching.
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
  const assistOnlyNames = Object.keys(stagingTools).filter(
    (name) => !ASSIST_ONLY_EXCLUDED_TOOLS.has(name),
  )

  it('withholds every tool that writes the record', () => {
    for (const name of [
      'write_summary',
      'update_summary',
      'propose_change',
      'record_commitment',
      'edit_proposal',
      'dismiss_proposal',
      'propose_mcp_call',
      'set_capture_title',
    ]) {
      expect(Object.keys(stagingTools), `${name} is not a real staging tool`).toContain(name)
      expect(assistOnlyNames, `${name} survived the assist-only strip`).not.toContain(name)
    }
  })

  it('keeps the tools that TALK to the user', () => {
    expect(assistOnlyNames).toContain('say_to_user')
    expect(assistOnlyNames).toContain('ask_user')
  })

  it('leaves NOTHING that mutates the capture', () => {
    // Nothing named like a write survives — catches a future staging tool added
    // to the factory but not to the excluded set.
    for (const name of assistOnlyNames) {
      expect(
        /^(write|update|propose|record|edit|dismiss|set)_/.test(name),
        `${name} looks like a write tool but survived the assist-only strip`,
      ).toBe(false)
    }
  })

  it('does NOT touch the READ ceiling — capture_mode is not a tool selection', () => {
    // An assist-only persona with every category on keeps the whole read
    // surface: assist-only strips WRITE tools only.
    const reads = narrowReadToolsByAgent(
      { capture_mode: 'assist_only', enabled_tools: [...ALL_CATEGORY_IDS], disabled_tools: [] },
      LIVE_AGENT_READ_TOOLS,
    )
    expect(reads.size).toBe(LIVE_AGENT_READ_TOOLS.size)
    expect(reads.has('get_package')).toBe(true)
    expect(reads.has('search_claims')).toBe(true)
    // …and an assist-only persona with NO selection is core-only like any other
    // persona row (Sequence step 1): capture_mode alone grants nothing.
    const bare = narrowReadToolsByAgent({ capture_mode: 'assist_only' }, LIVE_AGENT_READ_TOOLS)
    expect(bare).toEqual(new Set(LIVE_AGENT_CORE_READ_TOOLS))
  })
})

// ── The prompt half ────────────────────────────────────────────────────────
describe('LIVE_ASSIST_BASE_PROMPT', () => {
  it('names no capture tool it was not given', () => {
    for (const tool of ASSIST_ONLY_EXCLUDED_TOOLS) {
      expect(
        LIVE_ASSIST_BASE_PROMPT,
        `the prompt still mentions ${tool}, a tool this agent does not have`,
      ).not.toMatch(new RegExp(`\\b${tool}\\b`))
    }
  })

  it('carries none of the summary mandates the base prompt carries', () => {
    // Each of these IS in BASE_SYSTEM_PROMPT — asserted so the test fails if the
    // base prompt is rewritten and these regexes silently stop meaning anything.
    const mandates = [
      /An empty summary is a failure/,
      /## Summary Rules/,
      /Include a Summary section/,
      /## What to Capture/,
      /Proposal markers/,
    ]
    for (const re of mandates) {
      expect(BASE_SYSTEM_PROMPT, `${re} is no longer in the base prompt`).toMatch(re)
      expect(LIVE_ASSIST_BASE_PROMPT, `${re} leaked into the assist-only prompt`).not.toMatch(re)
    }
  })

  it('states plainly that a post-call pass writes the notes', () => {
    expect(LIVE_ASSIST_BASE_PROMPT).toMatch(/post-call pass/i)
    expect(LIVE_ASSIST_BASE_PROMPT).toMatch(/You Do Not Take Notes/)
  })

  it('KEEPS the mechanics that still govern this agent', () => {
    expect(LIVE_ASSIST_BASE_PROMPT, 'statelessness contract').toMatch(/STATELESS/)
    expect(LIVE_ASSIST_BASE_PROMPT, 'search_tools discovery').toMatch(/search_tools/)
    expect(LIVE_ASSIST_BASE_PROMPT, 'whole-workspace research').toMatch(
      /Research the Whole Workspace/i,
    )
    expect(LIVE_ASSIST_BASE_PROMPT, 'say_to_user semantics').toMatch(/say_to_user/)
    expect(LIVE_ASSIST_BASE_PROMPT, 'ask_user semantics').toMatch(/ask_user/)
    expect(LIVE_ASSIST_BASE_PROMPT, 'voice-ID / speaker rules').toMatch(/Speaker Assignments/)
    expect(LIVE_ASSIST_BASE_PROMPT, 'technical-label rule').toMatch(/system_\*/)
    expect(LIVE_ASSIST_BASE_PROMPT, 'packages pull').toMatch(/get_package/)
    expect(LIVE_ASSIST_BASE_PROMPT, 'self-harm carve-out').toMatch(/988/)
  })
  it('offers the relay to the note-taker for an explicit ask only (live-agent messaging L2)', () => {
    expect(LIVE_ASSIST_BASE_PROMPT).toMatch(/\*\*direct_notes\*\*/)
    expect(LIVE_ASSIST_BASE_PROMPT).toMatch(/Never use it for something you noticed yourself/)
  })
})

// ── shouldRunPostLiveBatch (the full matrix) ───────────────────────────────
describe('shouldRunPostLiveBatch', () => {
  it('live mode OFF always runs the batch — unchanged behavior', () => {
    expect(shouldRunPostLiveBatch({ liveMode: false })).toBe(true)
    expect(
      shouldRunPostLiveBatch({ liveMode: false, liveAgentAssistOnly: false, hasBatchDefault: false }),
    ).toBe(true)
    expect(
      shouldRunPostLiveBatch({ liveMode: false, liveAgentAssistOnly: true, hasBatchDefault: true }),
    ).toBe(true)
  })

  it('live mode ON with a note-taking agent and no edition batch persona: no batch', () => {
    expect(shouldRunPostLiveBatch({ liveMode: true })).toBe(false)
    expect(
      shouldRunPostLiveBatch({ liveMode: true, liveAgentAssistOnly: false, hasBatchDefault: false }),
    ).toBe(false)
  })

  it('EITHER condition alone is sufficient after a live call', () => {
    expect(
      shouldRunPostLiveBatch({ liveMode: true, liveAgentAssistOnly: true, hasBatchDefault: false }),
    ).toBe(true)
    expect(
      shouldRunPostLiveBatch({ liveMode: true, liveAgentAssistOnly: false, hasBatchDefault: true }),
    ).toBe(true)
    expect(
      shouldRunPostLiveBatch({ liveMode: true, liveAgentAssistOnly: true, hasBatchDefault: true }),
    ).toBe(true)
  })

  it('unknown hints degrade to today’s behavior, never to a spurious second pass', () => {
    expect(shouldRunPostLiveBatch({ liveMode: true, liveAgentAssistOnly: undefined })).toBe(false)
    expect(shouldRunPostLiveBatch({ liveMode: true, hasBatchDefault: undefined })).toBe(false)
  })
})

// ── Structural wiring ──────────────────────────────────────────────────────
describe('assist-only is wired into every runtime (structural)', () => {
  it('the cloud route strips the capture tools and swaps the base prompt — LIVE only', () => {
    const src = read('src/app/api/ai/live-agent/route.ts')
    // The route and the eve spec route resolve the flag with ONE resolver.
    expect(src, 'the route does not take the assist-only flag from the shared resolver').toMatch(
      /const \{ recipe, assistOnly \} = await resolveLiveAgentPersona\(/,
    )
    expect(read('src/lib/live-agent/turn-composition.ts'), 'the assist-only flag is not read at all').toMatch(
      /const assistOnly = !writesRecord && isAssistOnlyAgent\(recipe\?\.agent_config\)/,
    )
    // The cloud route's model call runs on eve: the tool MAP and the system
    // prompt are built by the live-agent spec/tool routes from the run token
    // the route mints, with the shared ceiling + composition modules.
    expect(src, 'the route no longer hands its turn type to the eve session').toMatch(
      /turnType: liveTurnTypeFromRequest\(mode, live_role\)/,
    )
    const ceiling = read('src/lib/live-agent/ceiling.ts')
    expect(ceiling, 'the tool MAP is not filtered — discovery-only gating is not enforcement').toMatch(
      /ASSIST_ONLY_EXCLUDED_TOOLS\.has\(name\)/,
    )
    const composition = read('src/lib/live-agent/turn-composition.ts')
    expect(composition, 'the assist-only base prompt is never substituted').toMatch(
      /assistOnly \? LIVE_ASSIST_BASE_PROMPT : BASE_SYSTEM_PROMPT/,
    )
  })

  it('a batch run NEVER carries an assist-only persona (server safety net)', () => {
    // The shared resolver both the cloud route and the eve spec route call.
    const src = read('src/lib/live-agent/turn-composition.ts')
    // `writesRecord` = a batch run OR a paired notes turn (2026-09-24): both
    // write the record, so both are held to the net.
    expect(src).toMatch(/if \(writesRecord && isAssistOnlyAgent\(recipe\?\.agent_config\)\)/)
    // …and an edition whose BATCH default is itself assist-only falls all the
    // way back to the built-in Assistant rather than writing nothing.
    expect(src).toMatch(/if \(isAssistOnlyAgent\(recipe\?\.agent_config\)\) recipe = null/)
  })

  it('the stop path gates the batch on shouldRunPostLiveBatch, not on live mode alone', () => {
    const src = read('src/hooks/recording-context.tsx')
    expect(src).toMatch(/const runBatch = shouldRunPostLiveBatch\(\{/)
    expect(src, 'the batch is still gated on !liveModeEnabledRef alone').not.toMatch(
      /if \(!liveModeEnabledRef\.current\) \{\s*\n\s*if \(hasStreamingPanel/,
    )
    // The handoff rule is untouched: both batch call sites still resolve the
    // persona through batchRecipeId().
    expect(src).toMatch(/recipeId: batchRecipeId\(\)/)
    expect(src).toMatch(/runApiBatchExtraction\(cid, batchRecipeId\(\) \?\? null\)/)
  })

  it('runPostExtraction still runs after the post-live batch', () => {
    const src = read('src/hooks/recording-context.tsx')
    // Three call sites: the panel-owned stream's completion listener, the
    // inline API batch's success tail, and the no-batch branch. The two batch
    // tails call it plain (the batch finalize emits capture.processed itself);
    // the no-batch branch asks index-content to close the record (A4), after
    // waiting for the live agent's detached finalizing turn.
    expect((src.match(/\brunPostExtraction\((capId|cid)\)/g) || []).length).toBe(2)
    expect(src).toMatch(
      /void waitForLiveAgentFinalizing\(\)\.then\(\(\) => runPostExtraction\(cid, \{ captureProcessed: true \}\)\)/,
    )
  })

  it('the capture panel tells the user who takes the notes', () => {
    const src = read('src/app/account/(dashboard)/views/capture-detail-panel.tsx')
    // Paired live notes (2026-09-24): the assist-only copilot runs beside the
    // edition's batch persona, which takes the notes live and finalizes them.
    expect(src).toMatch(
      /Real-time help only — \{liveNotesAgentName \?\? 'a paired note-taker'\} takes the notes live and finalizes them when the call ends/,
    )
    expect(src).toMatch(/setPostLiveBatchHints\(\{/)
  })

  it('the panel CLEARS the batch hints on unmount so they never leak across captures', () => {
    // The provider lives above the dashboard and survives navigation AND
    // workspace switches; this panel does not. Without the cleanup the hint
    // refs keep whatever the last mounted panel wrote, so a sales capture's
    // `hasBatchDefault: true` would still be set when the user switches to a
    // full/notes workspace and records with no panel open — a second,
    // unwanted extraction pass over a summary live mode already wrote.
    const src = read('src/app/account/(dashboard)/views/capture-detail-panel.tsx')
    expect(src, 'the hints effect has no cleanup — stale hints leak to the next capture').toMatch(
      /return \(\) => setPostLiveBatchHints\(\{ liveAgentAssistOnly: false, hasBatchDefault: false \}\)/,
    )
  })
})

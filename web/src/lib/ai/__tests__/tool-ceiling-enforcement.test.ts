/**
 * Workstream A regression suite (loop-closure Phase 2).
 *
 * Encodes the exact F1 bypass so it can never regress: a "report"-mode run
 * whose tool ceiling excludes accept_proposal must NOT be able to execute
 * accept_proposal even if the model emits a tool call for it (because
 * search_tools told it the tool was available). The fix is structural —
 * pickPermittedTools removes excluded tools from the map, so the SDK has
 * nothing to execute.
 *
 * See docs/loop-engine/LOOP-CLOSURE-PHASE2-PLAN.md, Part 1 (F1) + Workstream A.
 */
import { describe, it, expect, vi } from 'vitest'
import { generateText, tool, isStepCount } from 'ai'
import { MockLanguageModelV3 } from 'ai/test'
import { z } from 'zod'
import {
  pickPermittedTools,
  createSearchToolsTool,
  createPrepareStep,
} from '@/lib/ai/tool-discovery'
import { getMutatingToolNames } from '@/lib/ai/tool-registry'

// The report-mode ceiling as run-skill builds it — everything the Triage
// skill's categories expose, minus every mutating tool.
import { computeReportModeCeiling } from '@/lib/flows/run-skill'

const TRIAGE_CATEGORIES = ['actions', 'projects', 'captures', 'search', 'comments']

describe('pickPermittedTools — the security boundary', () => {
  const fakeTool = () =>
    tool({ description: 'x', inputSchema: z.object({}), execute: async () => ({ ok: true }) })

  it('drops every mutating tool from a report-mode map', () => {
    const ceiling = computeReportModeCeiling(TRIAGE_CATEGORIES)
    const mutating = getMutatingToolNames()

    // Build a map that includes some mutating tools (as the full createTools map would).
    const allTools: Record<string, ReturnType<typeof fakeTool>> = {
      search_tools: fakeTool(),
      list_actions: fakeTool(),
      get_action_suggestions: fakeTool(),
      accept_proposal: fakeTool(),
      dismiss_proposal: fakeTool(),
      create_action: fakeTool(),
      update_action: fakeTool(),
      add_comment: fakeTool(),
    }

    const permitted = pickPermittedTools(allTools, ceiling)

    // Every mutating tool present in the input map is gone from the output.
    for (const name of Object.keys(allTools)) {
      if (mutating.has(name)) {
        expect(permitted[name], `${name} must be dropped in report mode`).toBeUndefined()
      }
    }
    // Concretely: the tools that actually mutated the board in the F1 incident.
    expect(permitted.accept_proposal).toBeUndefined()
    expect(permitted.dismiss_proposal).toBeUndefined()
    expect(permitted.create_action).toBeUndefined()
    expect(permitted.update_action).toBeUndefined()

    // Read + allowed-write tools survive.
    expect(permitted.list_actions).toBeDefined()
    expect(permitted.get_action_suggestions).toBeDefined()
    expect(permitted.add_comment).toBeDefined()
    // search_tools always survives (the discovery meta-tool).
    expect(permitted.search_tools).toBeDefined()
  })

  it('is a pass-through when the ceiling is null/undefined (inherit-all)', () => {
    const allTools = { search_tools: fakeTool(), accept_proposal: fakeTool() }
    expect(pickPermittedTools(allTools, null)).toBe(allTools)
    expect(pickPermittedTools(allTools, undefined)).toBe(allTools)
  })

  it('always retains search_tools even if a hand-built ceiling omits it', () => {
    const allTools = { search_tools: fakeTool(), list_actions: fakeTool() }
    const permitted = pickPermittedTools(allTools, new Set(['list_actions']))
    expect(permitted.search_tools).toBeDefined()
    expect(permitted.list_actions).toBeDefined()
  })
})

describe('search_tools honesty — never advertise the unreachable', () => {
  it('does not list an out-of-ceiling tool as available', async () => {
    const ceiling = computeReportModeCeiling(TRIAGE_CATEGORIES)
    const st = createSearchToolsTool(ceiling)
    // Browse the actions category — accept_proposal lives here but is excluded.
    const res = (await st.execute!({ query: 'actions' }, {} as any)) as {
      tools: Array<{ name: string }>
      hint: string
    }
    const names = res.tools.map((t) => t.name)
    expect(names).not.toContain('accept_proposal')
    expect(names).not.toContain('dismiss_proposal')
    expect(names).not.toContain('create_action')
    // A read tool in the same category is still advertised.
    expect(names).toContain('list_actions')
  })

  it('with no ceiling, advertises the full category (chat inherit-all)', async () => {
    const st = createSearchToolsTool()
    const res = (await st.execute!({ query: 'actions' }, {} as any)) as {
      tools: Array<{ name: string }>
    }
    const names = res.tools.map((t) => t.name)
    expect(names).toContain('accept_proposal')
  })
})

describe('behavioral: a hallucinated excluded-tool call does not execute', () => {
  it('the SDK cannot run accept_proposal when it was filtered out of the map', async () => {
    const ceiling = computeReportModeCeiling(TRIAGE_CATEGORIES)

    const acceptSpy = vi.fn(async () => ({ success: true, applied: 'GEN-999' }))
    // The FULL map, as createTools would produce — includes the mutating tool.
    const allTools = {
      search_tools: createSearchToolsTool(ceiling),
      list_actions: tool({
        description: 'list',
        inputSchema: z.object({}),
        execute: async () => ({ actions: [] }),
      }),
      accept_proposal: tool({
        description: 'accept a proposal',
        inputSchema: z.object({ proposal_id: z.string() }),
        execute: acceptSpy,
      }),
    }
    // The fix: build the callable map FROM the ceiling.
    const tools = pickPermittedTools(allTools, ceiling)

    // A model that has "discovered" accept_proposal and emits a call for it —
    // then, on the retry step, stops with text (simulating recovery after the
    // tool-error is fed back).
    let step = 0
    const model = new MockLanguageModelV3({
      // Test mock — the exact provider result shape is cast; we only exercise
      // the tool-parse/execute path, not the SDK's result typing.
      doGenerate: (async () => {
        step += 1
        if (step === 1) {
          return {
            finishReason: 'tool-calls' as const,
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            content: [
              {
                type: 'tool-call' as const,
                toolCallId: 'call_1',
                toolName: 'accept_proposal',
                input: JSON.stringify({ proposal_id: 'abc' }),
              },
            ],
            warnings: [],
          }
        }
        return {
          finishReason: 'stop' as const,
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          content: [{ type: 'text' as const, text: 'Done.' }],
          warnings: [],
        }
      }) as any,
    })

    const activeTools = ['list_actions', 'search_tools']
    const result = await generateText({
      model,
      messages: [{ role: 'user', content: 'triage' }],
      tools,
      activeTools: activeTools as (keyof typeof tools)[],
      prepareStep: createPrepareStep(
        activeTools,
        new Set(Object.keys(tools)),
        ceiling,
      ) as any,
      stopWhen: isStepCount(4),
    })

    // THE ASSERTION: the excluded tool's handler never ran, even though the
    // model emitted a call for it. The board was not mutated.
    expect(acceptSpy).not.toHaveBeenCalled()
    // The SDK produced no tool RESULT for accept_proposal — the call was
    // rejected at parse time (the tool isn't in the map), not executed.
    const allToolResults = result.steps.flatMap((s) => s.toolResults ?? [])
    expect(allToolResults.some((r) => r.toolName === 'accept_proposal')).toBe(false)
    // And the run continued past the bad call rather than hanging (2 steps).
    expect(result.steps.length).toBe(2)
  })
})

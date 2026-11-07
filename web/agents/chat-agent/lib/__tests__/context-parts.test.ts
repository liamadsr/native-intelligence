import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

/**
 * The agent's own parts of a turn's context (lib/context-parts.ts): what the
 * side panel's Context card shows beside the conversation. Pinned:
 *   1. the estimates: four characters a token; the system prompt split at its
 *      "Available skills" section (last, or followed by another `## ` heading,
 *      or absent); a tool's name, description and plain JSON input schema
 *      (a `~standard` validator is left out); a recall's message text;
 *   2. the durable state: the prompt and the tools are keyed by the turn they
 *      were measured for (another turn's prompt → null; another turn's tools
 *      count 0), the memory is the session's latest recall; the static
 *      instructions and tools always count, their constants held within 10%
 *      of the files they stand for;
 *   3. a measurement never throws: without eve context the records do nothing
 *      and contextPartsFor answers null.
 *
 * eve/context is mocked with an in-memory state store (as usage-meter.test.ts),
 * switchable to "no eve context" (every get/update throws).
 */

const stateStore = new Map<string, unknown>()
const noContext = { current: false }
vi.mock('eve/context', () => ({
  defineState: <T,>(name: string, initial: () => T) => ({
    get: (): T => {
      if (noContext.current) throw new Error('no eve context')
      return stateStore.has(name) ? (stateStore.get(name) as T) : initial()
    },
    update: (fn: (prev: T) => T) => {
      if (noContext.current) throw new Error('no eve context')
      const prev = stateStore.has(name) ? (stateStore.get(name) as T) : initial()
      stateStore.set(name, fn(prev))
    },
  }),
}))

import {
  STATIC_INSTRUCTIONS_TOKENS as I,
  STATIC_TOOLS_TOKENS as T,
  contextPartsFor,
  estimateTokens,
  promptParts,
  recallTokens,
  recordMemorySize,
  recordPromptSize,
  recordToolsSize,
  toolDefinitionTokens,
} from '../context-parts'

/** The heading chat-run-rebuild.ts buildSkillsPromptSection opens the section with (22 characters). */
const SKILLS = '\n\n## Available skills\n'

beforeEach(() => {
  stateStore.clear()
  noContext.current = false
})

describe('estimateTokens', () => {
  it('counts four characters a token, rounding up', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcde')).toBe(2)
    expect(estimateTokens('x'.repeat(400))).toBe(100)
  })
})

describe('promptParts', () => {
  it('a prompt with no skills section is all system', () => {
    expect(promptParts('p'.repeat(40))).toEqual({ system: 10, skills: 0 })
    // A heading that only looks like it is not the section.
    expect(promptParts(`${'p'.repeat(36)}\n## Available skills`)).toEqual({ system: 14, skills: 0 })
  })

  it('splits out the skills section when it ends the prompt', () => {
    const section = `${SKILLS}${'s'.repeat(78)}` // 100 characters
    expect(promptParts(`${'p'.repeat(400)}${section}`)).toEqual({ system: 100, skills: 25 })
  })

  it('stops the section at the next `## ` heading, and counts what follows as system', () => {
    const section = `${SKILLS}${'s'.repeat(78)}` // 100 characters
    const canon = `\n\n## Canon documents\n${'c'.repeat(179)}` // 200 characters
    const focus = `\n\n## This conversation’s focus\n${'f'.repeat(169)}` // 200 characters
    expect(promptParts(`${'p'.repeat(400)}${section}${canon}${focus}`)).toEqual({ system: 200, skills: 25 })
  })

  it('a deeper heading inside the section stays in it', () => {
    const section = `${SKILLS}${'s'.repeat(30)}\n\n### Pack skills\n${'s'.repeat(30)}` // 100 characters
    expect(promptParts(`${'p'.repeat(40)}${section}`)).toEqual({ system: 10, skills: 25 })
  })
})

describe('toolDefinitionTokens', () => {
  it('counts each tool’s name, description and plain JSON input schema', () => {
    const schema = { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    const chars = 'search'.length + 'Find things in the workspace'.length + JSON.stringify(schema).length + 'ping'.length
    expect(
      toolDefinitionTokens({
        search: { description: 'Find things in the workspace', inputSchema: schema },
        // A tool with nothing but a name still costs its name.
        ping: {},
      }),
    ).toBe(Math.ceil(chars / 4))
  })

  it('leaves out a schema that is a validator object (`~standard`), not JSON', () => {
    const validator = z.object({ query: z.string() })
    expect('~standard' in validator).toBe(true)
    expect(toolDefinitionTokens({ search_tools: { description: 'abcd', inputSchema: validator } })).toBe(
      Math.ceil(('search_tools'.length + 4) / 4),
    )
  })

  it('a schema that will not serialize, a non-string description or a non-object entry costs only the name', () => {
    const circular: Record<string, unknown> = { type: 'object' }
    circular.self = circular
    expect(toolDefinitionTokens({ abcd: { description: 7, inputSchema: circular }, efgh: null, ijkl: 'x' })).toBe(3)
    expect(toolDefinitionTokens({})).toBe(0)
  })
})

describe('recallTokens', () => {
  it('counts the recalled messages’ text; anything else is 0', () => {
    expect(recallTokens({ messages: [{ id: 'a', content: 'x'.repeat(30) }, { id: 'b', content: 'y'.repeat(10) }] })).toBe(10)
    expect(recallTokens({ messages: [{ content: [{ type: 'text', text: 'not counted' }] }, null, { content: 'abcd' }] })).toBe(1)
    expect(recallTokens({ messages: [] })).toBe(0)
    expect(recallTokens({ messages: 'x' })).toBe(0)
    expect(recallTokens(null)).toBe(0)
    expect(recallTokens(undefined)).toBe(0)
  })
})

describe('contextPartsFor (durable state, by turn)', () => {
  const prompt = `${'p'.repeat(400)}${SKILLS}${'s'.repeat(78)}`

  it('answers the turn’s measured parts', () => {
    recordPromptSize('turn_1', prompt)
    recordToolsSize('turn_1', 14_000)
    recordMemorySize(300)
    expect(contextPartsFor('turn_1')).toEqual({ system: I + 100, skills: 25, tools: T + 14_000, memory: 300 })
  })

  it('null when the prompt was measured for another turn (or for none)', () => {
    recordPromptSize('turn_1', prompt)
    recordToolsSize('turn_2', 14_000)
    expect(contextPartsFor('turn_2')).toBeNull()
    recordPromptSize(null, prompt)
    expect(contextPartsFor('turn_1')).toBeNull()
    // Nothing measured at all.
    stateStore.clear()
    expect(contextPartsFor('turn_1')).toBeNull()
  })

  it('tools measured for another turn count 0; the turn’s own latest set counts', () => {
    recordToolsSize('turn_0', 9_000)
    recordPromptSize('turn_1', prompt)
    expect(contextPartsFor('turn_1')).toMatchObject({ tools: T })
    recordToolsSize('turn_1', 12_000)
    recordToolsSize('turn_1', 14_000)
    expect(contextPartsFor('turn_1')).toMatchObject({ tools: T + 14_000 })
  })

  it('the memory is the session’s latest recall, whichever turn recalled it', () => {
    recordMemorySize(300)
    recordPromptSize('turn_1', prompt)
    expect(contextPartsFor('turn_1')).toMatchObject({ memory: 300 })
    recordMemorySize(120)
    recordPromptSize('turn_2', prompt)
    expect(contextPartsFor('turn_2')).toMatchObject({ memory: 120 })
    expect(contextPartsFor('turn_1')).toBeNull()
  })

  it('a bad count reads as 0, a fraction as its floor', () => {
    recordPromptSize('turn_1', prompt)
    recordToolsSize('turn_1', -5)
    recordMemorySize(Number.NaN)
    expect(contextPartsFor('turn_1')).toEqual({ system: I + 100, skills: 25, tools: T, memory: 0 })
    recordToolsSize('turn_1', 12.7)
    recordMemorySize(Number.POSITIVE_INFINITY)
    expect(contextPartsFor('turn_1')).toMatchObject({ tools: T + 12, memory: 0 })
  })

  it('never throws without eve context: the records do nothing, the read is null', () => {
    noContext.current = true
    expect(() => recordPromptSize('turn_1', prompt)).not.toThrow()
    expect(() => recordToolsSize('turn_1', 14_000)).not.toThrow()
    expect(() => recordMemorySize(300)).not.toThrow()
    expect(contextPartsFor('turn_1')).toBeNull()
    noContext.current = false
    expect(stateStore.size).toBe(0)
  })
})

describe('the static parts stand for their files', () => {
  /** Within 10% of `measured`: the constant is updated when its file grows or shrinks past that. */
  const near = (constant: number, measured: number) => Math.abs(constant - measured) <= measured * 0.1

  it('STATIC_INSTRUCTIONS_TOKENS is ../instructions.md at four characters a token', () => {
    const md = readFileSync(path.resolve(__dirname, '../../instructions.md'), 'utf8')
    const measured = estimateTokens(md)
    expect(near(I, measured), `instructions.md is ~${measured} tokens now: update STATIC_INSTRUCTIONS_TOKENS`).toBe(true)
  })

  it('STATIC_TOOLS_TOKENS is the cloud’s static tools: name, description, input schema', async () => {
    // The tools as the cloud has them (the file tools are the Mac's: disabled here).
    // helpers.ts imports eve's vendored `workflow`, which vitest can't load: its
    // description and schema come from lib/helpers.ts, as the tool's do.
    const names = ['agent', 'ask_user', 'bash', 'mark_urgent', 'no_reply', 'read_file', 'update_plan', 'web_fetch', 'web_search', 'write_file']
    let chars = 0
    for (const name of names) {
      const tool = (await import(`../../tools/${name}.ts`)).default as { description?: unknown; inputSchema?: unknown } | undefined
      chars += name.length
      if (typeof tool?.description === 'string') chars += tool.description.length
      const schema = tool?.inputSchema
      if (schema && typeof schema === 'object') {
        // A validator zod can't print (web_fetch spreads eve's own) is left out: it is a URL field.
        try {
          chars += JSON.stringify('~standard' in schema ? z.toJSONSchema(schema as z.ZodType) : schema).length
        } catch {
          /* not counted */
        }
      }
    }
    const helpers = await import('../helpers')
    chars += 'helpers'.length + helpers.HELPERS_TOOL_DESCRIPTION.length + JSON.stringify(z.toJSONSchema(helpers.helpersInputSchema)).length
    const measured = Math.ceil(chars / 4)
    expect(near(T, measured), `the static tools are ~${measured} tokens now: update STATIC_TOOLS_TOKENS`).toBe(true)
  })
})

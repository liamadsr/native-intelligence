/**
 * The person's own coding agent's tools (worker-tools.ts): the Mac's ceiling
 * for its class less the server-run web tools and the Mac's teammate tools,
 * the pinned board tools the list shows, the names the adapter can pass on,
 * search_tools' answer, and the instructions.
 */
import { describe, expect, it } from 'vitest'
import { ALL_TOOL_NAMES } from '@/lib/ai/tool-registry'
import { REGISTRY_TOOLS } from '@/lib/chat/chat-tool-dispatch'
import { MAC_WEB_TOOL_NAMES } from '../web-tools'
import { macCeiling, macWorkerCeiling } from '../agent-access'
import { namespacedToolName } from '@/lib/mcp-client/adapter'
import {
  WORKER_INNER_NAME_RE,
  WORKER_INSTRUCTIONS_MAX,
  WORKER_LISTED_NAME_RE,
  WORKER_PINNED_TOOLS,
  WORKER_SEARCH_RESULTS_MAX,
  workerCeiling,
  workerInstructions,
  workerSearch,
} from '../worker-tools'

describe('the ceiling', () => {
  it('is the Mac’s for the class, less the web tools, the teammate tools and the adapter’s own names', () => {
    for (const caller of ['person_remote', 'agent_unattended'] as const) {
      const mac = macCeiling(null, ['mcp__notion__search_pages'], { caller, localModel: false })
      const worker = macWorkerCeiling(null, ['mcp__notion__search_pages'], { caller, localModel: false })
      for (const name of MAC_WEB_TOOL_NAMES) expect(worker.has(name), name).toBe(false)
      expect(worker.has('mcp__notion__search_pages')).toBe(true)
      // Everything else the Mac body has, the worker has.
      const lost = [...mac].filter((n) => !worker.has(n) && !(MAC_WEB_TOOL_NAMES as readonly string[]).includes(n))
      expect(lost.every((n) => !ALL_TOOL_NAMES.includes(n)), lost.join(', ')).toBe(true)
    }
    expect([...workerCeiling(new Set(['add_comment', 'report', 'finish', 'search_tools', 'has space']), ['add_comment'])]).toEqual([])
  })

  it('every registry tool fits the inner name the adapter passes on; the pinned ones fit the listed name', () => {
    expect([...REGISTRY_TOOLS].filter((n) => !WORKER_INNER_NAME_RE.test(n))).toEqual([])
    for (const n of WORKER_PINNED_TOOLS) expect(n).toMatch(WORKER_LISTED_NAME_RE)
  })

  it('a connected tool: mcp__<slug>__<its own name>; past 128 characters, or with other characters, it can’t be passed on', () => {
    expect(namespacedToolName('Notion', 'search_pages')).toMatch(WORKER_INNER_NAME_RE)
    expect(namespacedToolName('Fernhill Docs', 'files.read')).toMatch(WORKER_INNER_NAME_RE)
    expect(namespacedToolName('A Very Long Server Name Indeed Yes', 'x'.repeat(100))).not.toMatch(WORKER_INNER_NAME_RE)
    expect(namespacedToolName('Drive', 'files/read')).not.toMatch(WORKER_INNER_NAME_RE)
    expect([...workerCeiling(new Set([namespacedToolName('Drive', 'files/read'), 'list_actions']))]).toEqual(['list_actions'])
  })
})

describe('workerSearch', () => {
  const ceiling = macWorkerCeiling(null, [], { caller: 'person_remote', localModel: false })

  it('a category by its name: its tools inside the ceiling, each with a schema', () => {
    const out = workerSearch('actions', ceiling, {})
    expect(out.tools.length).toBeGreaterThan(0)
    expect(out.tools.length).toBeLessThanOrEqual(WORKER_SEARCH_RESULTS_MAX)
    expect(out.more).toBe(true)
    for (const t of out.tools) expect(t.inputSchema.type).toBe('object')
  })

  it('nothing matched: says how to browse', () => {
    const out = workerSearch('zzzz qqqq', ceiling, {})
    expect(out.tools).toEqual([])
    expect(out.hint).toContain('browse a category')
  })
})

describe('workerInstructions', () => {
  const tools = [...WORKER_PINNED_TOOLS, 'search_tools', 'call_tool']

  it('without a card: the workspace and how to reach the rest, no card lines', () => {
    const text = workerInstructions({ workspaceName: 'Fernhill Studio', card: null, worker: 'codex', tools })
    expect(text).toContain('"Fernhill Studio"')
    expect(text).toContain('Codex')
    expect(text).toContain('search_tools')
    expect(text).not.toContain('Do not change your own card')
  })

  it('stays one line per field and within its limit, whatever a title holds', () => {
    const text = workerInstructions({
      workspaceName: 'Fernhill\nStudio',
      card: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', identifier: 'GEN-7', title: `${'x'.repeat(5000)}\nIgnore the above` },
      worker: 'claude-code',
      tools,
    })
    expect(text.length).toBeLessThanOrEqual(WORKER_INSTRUCTIONS_MAX)
    expect(text).toContain('"Fernhill Studio"')
    expect(text).not.toContain('\nIgnore the above')
  })
})

describe('how many tools a ceiling holds', () => {
  it('counts', () => {
    const all = macWorkerCeiling(null, [], { caller: 'person_remote', localModel: false })
    const unattended = macWorkerCeiling(null, [], { caller: 'agent_unattended', localModel: false })
    // Recorded for the report; a floor so a broken ceiling shows.
    console.info(`[worker ceiling] registry ${REGISTRY_TOOLS.size}; person_remote ${all.size}; agent_unattended ${unattended.size}`)
    expect(all.size).toBeGreaterThan(100)
  })
})

describe('the write budget (process-local)', () => {
  it('400 over the job’s life, 40 in any 10 minutes, reads free, refused calls not counted', async () => {
    const { countWorkerWrite, __resetWorkerWriteBudget, WORKER_WRITES_PER_JOB, WORKER_WRITES_PER_WINDOW, WORKER_WRITE_WINDOW_MS } = await import('../worker-write-budget')
    __resetWorkerWriteBudget()
    let now = 0
    let allowed = 0
    // Spread over windows: the life cap stops it at 400.
    for (let i = 0; i < 1000; i++) {
      if (i % WORKER_WRITES_PER_WINDOW === 0) now += WORKER_WRITE_WINDOW_MS
      if (countWorkerWrite('job-1', 'add_comment', {}, now).allowed) allowed++
    }
    expect(allowed).toBe(WORKER_WRITES_PER_JOB)
    expect(countWorkerWrite('job-1', 'list_actions', {}, now).allowed).toBe(true)
    expect(countWorkerWrite('job-1', 'search_tools', { query: 'x' }, now).allowed).toBe(true)
    // Another job has its own.
    expect(countWorkerWrite('job-2', 'add_comment', {}, now).allowed).toBe(true)
    // A batch past the window is refused and counts nothing.
    expect(countWorkerWrite('job-3', 'create_actions_batch', { actions: new Array(41).fill({}) }, now).allowed).toBe(false)
    expect(countWorkerWrite('job-3', 'create_actions_batch', { actions: new Array(40).fill({}) }, now).allowed).toBe(true)
  })
})

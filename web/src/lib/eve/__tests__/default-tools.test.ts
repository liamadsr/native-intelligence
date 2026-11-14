/**
 * Every eve FRAMEWORK-DEFAULT tool is an explicit, reviewed decision on every
 * agent.
 *
 * eve gives each agent a default tool set that needs no file (bash, read_file,
 * …). An eve bump can ADD a default — 0.66 added `task_cancel`, and changed
 * `agent` to background mode; 0.76 removed `load_skill`, `task_cancel` and
 * `connection_search` again — and nothing in the per-agent lockdown tests
 * (which check individual sentinel files) would notice: the new tool would
 * simply appear on every mount. This suite reads eve's own default-source
 * registry (dist/src/framework/sources/registry.js) and fails when:
 *   - eve's default set differs from the set reviewed here (a bump added or
 *     removed one), or
 *   - an agent inherits a default it was not explicitly reviewed to inherit
 *     (every other default must be overridden or disableTool()'d by a file at
 *     agents/<name>/tools/<slug>.ts, whose content the per-agent
 *     harness-lockdown tests pin).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const repoRoot = resolve(__dirname, '../../../..')
const eveRoot = dirname(createRequire(import.meta.url).resolve('eve/package.json'))

/** The framework defaults as reviewed at eve 0.79.1. */
const REVIEWED_DEFAULTS = [
  'agent',
  'bash',
  'read_file',
  'web_fetch',
  'web_search',
  'write_file',
] as const

/**
 * Slots eve 0.76 retired. eve now adds its own tools in the reserved `eve__`
 * namespace from what the session can reach, not from the default registry:
 * `eve__skill` with a skill, `eve__search` / `eve__tool` with a deferred entry
 * or a connection, `eve__task_wait` / `eve__task_cancel` with a tool that runs
 * calls as tasks (the root-copy `agent`, a declared subagent's tool, a `task` or
 * `serve` workflow tool). A file at a retired slug is an ORDINARY authored tool
 * now (eve 0.66.3 needed `disableTool()` files at load_skill and task_cancel;
 * on 0.79.1 such a file fails the build: "disables a slot with no
 * lower-precedence source"), so none may exist.
 */
const RETIRED_SLOTS = ['load_skill', 'task_cancel', 'connection_search'] as const

/**
 * Defaults an agent deliberately INHERITS with no file. Everything else must
 * have a file at its slug. The coding-agent is the one agent whose job IS the
 * sandbox shell + filesystem (bound to its authored, egress-policied sandbox).
 */
const INHERITED: Record<string, readonly string[]> = {
  'chat-agent': [],
  'coding-agent': ['bash', 'read_file', 'write_file'],
  'live-agent': [],
  // No 'local-agent': it is no longer an agent of its own but the Mac host the
  // chat agent runs in (contract C2, scripts/local-agent/mac-body.sh). The Mac
  // body is chat-agent, whose files cover every default on both hosts; on the
  // Mac its bash/read_file/write_file are eve's own, bound to the host-folder
  // fence (agents/chat-agent/lib/__tests__/mac-body.test.ts pins that).
  'onboarding-researcher': [],
  'skill-runner': [],
  // One-shot generators: no tools at all, web included.
  utility: [],
  // OpenAI's web search on the person's plan, nothing else.
  'web-research': [],
  'work-agent': [],
}

function eveDefaultToolSlugs(): string[] {
  const registry = readFileSync(join(eveRoot, 'dist/src/framework/sources/registry.js'), 'utf8')
  const slugs = [...registry.matchAll(/logicalPath:`tools\/([a-z_]+)\.ts`/g)].map((m) => m[1])
  return [...new Set(slugs)].sort()
}

describe('eve framework-default tools', () => {
  it('eve’s default tool set is exactly the reviewed set (a bump that adds/removes a default fails here)', () => {
    expect(eveDefaultToolSlugs()).toEqual([...REVIEWED_DEFAULTS].sort())
  })

  describe.each(Object.keys(INHERITED))('agents/%s', (agent) => {
    const toolsDir = join(repoRoot, 'agents', agent, 'tools')

    it.each([...REVIEWED_DEFAULTS])(
      'default `%s` is either an explicit file or a reviewed inheritance',
      (slug) => {
        const hasFile = existsSync(join(toolsDir, `${slug}.ts`))
        const inherits = INHERITED[agent].includes(slug)
        expect(hasFile !== inherits, `${agent}: ${slug} must be EITHER a file OR listed as inherited`).toBe(true)
      },
    )

    it('has no skills/ or connections/ (so eve adds no eve__skill, eve__search or eve__tool)', () => {
      for (const dir of ['skills', 'connections']) {
        expect(existsSync(join(repoRoot, 'agents', agent, dir)), `${agent}/${dir} activates eve's catalog tools`).toBe(false)
      }
    })

    it.each([...RETIRED_SLOTS])('has no file at the retired `%s` slot (it would be an ordinary tool)', (slug) => {
      expect(existsSync(join(toolsDir, `${slug}.ts`)), `${agent}: tools/${slug}.ts`).toBe(false)
    })
  })
})

/**
 * The chat agent serves workspace skills through its OWN `load_skill`, minted
 * per turn in the dynamic tool map (agents/chat-agent/tools/workspace_tools.ts;
 * that the map holds it is asserted in
 * agents/chat-agent/lib/__tests__/workspace-tools.test.ts). eve 0.66.3 also had
 * a framework `load_skill`, which the chat agent disabled with a file. eve 0.76
 * removed it: framework skills load through `eve__skill`, which eve adds only
 * for an agent with skills. These pin that, so a bump that brings back a
 * framework tool under that name fails here.
 */
describe('the chat agent’s dynamic load_skill has the name to itself (eve dist pins)', () => {
  const distSrc = join(eveRoot, 'dist/src')

  it('eve’s skill tool is eve__skill, in its reserved namespace', () => {
    expect(readFileSync(join(distSrc, 'protocol/catalog-tools.js'), 'utf8')).toContain('SKILL_TOOL_NAME=`eve__skill`')
  })

  // Reads every .js file of eve's dist synchronously (~1,900 files): fast alone,
  // past 5 s on a busy machine running the full suite.
  it('eve treats `load_skill` only as a retired name (eval guidance, replay of old skill loads)', () => {
    const readers = jsFiles(distSrc)
      .filter((f) => readFileSync(f, 'utf8').includes('`load_skill`'))
      .map((f) => relative(distSrc, f))
      .filter((f) => !f.startsWith('chunks/'))
      .sort()
    expect(readers).toEqual(['evals/reported-tool-name.js', 'protocol/message-version.js'])
  }, 60_000)

  it('the chat agent has no framework slot file and names its own dynamic tool load_skill', () => {
    const agentDir = join(repoRoot, 'agents/chat-agent/tools')
    expect(existsSync(join(agentDir, 'load_skill.ts'))).toBe(false)
    expect(readFileSync(join(agentDir, 'workspace_tools.ts'), 'utf8')).toContain("const LOAD_SKILL_NAME = 'load_skill'")
  })
})

function jsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? jsFiles(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : [],
  )
}

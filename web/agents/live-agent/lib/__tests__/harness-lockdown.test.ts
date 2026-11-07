import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDisabledToolSentinel } from 'eve/tools'
import { isWebSearchToolDefinition } from 'eve/tools/web_search'
import rootCopyAgent from '../../tools/agent'
import bash from '../../tools/bash'
import readFile from '../../tools/read_file'
import writeFile from '../../tools/write_file'
import webFetch from '../../tools/web_fetch'
import webSearch from '../../tools/web_search'

/**
 * Structural harness contract for the live-agent mount (LIVE-AGENT-DESIGN §3.4),
 * against eve 0.79.1's ACTUAL default tool set (read off eve's own registry
 * below — glob/grep left the defaults at 0.39.0, ask_question at 0.65.0;
 * 0.76 removed load_skill and connection_search and moved task_cancel into
 * the reserved `eve__` namespace, added only with a task-running tool).
 *
 * A live turn reaches WORKSPACE data only through the ceiling-clamped proxies
 * (tools/workspace_tools.ts, ask_user.ts, say_to_user.ts). So:
 *   - every sandbox-backed default (bash, read_file, write_file) is a
 *     disableTool() sentinel — no sandbox is ever provisioned for a live turn;
 *   - the root-copy `agent` (a task since 0.69) is disabled, so eve adds no
 *     `eve__task_*` tools — a live session reads ONE response; pairing is two
 *     top-level sessions, never subagents (§7);
 *   - the web surface is EXACTLY the cloud route's: eve's provider web_search
 *     pinned to Exa (shadowed by a refusal on no-web turns — see
 *     workspace-tools.test.ts), and NO web_fetch — the route never had one, so
 *     giving unattended batch turns a fetch tool would widen their reach;
 *   - there are no skills/ or connections/ (so eve adds no `eve__skill`,
 *     `eve__search` or `eve__tool`), no subagents/, and no static
 *     instructions.md — the dynamic instructions
 *     resolver IS the whole system prompt (a static instructions.md would also
 *     get NO system cache breakpoint on the anthropic-direct path — eve-smoke
 *     RESULTS.md finding 2).
 *
 * Call playbooks (src/lib/live-agent/call-playbooks.ts) are NOT eve skills:
 * the copilot's `load_skill` is an ordinary staging tool, proxied like every
 * other workspace tool and clamped by the ceiling to copilot turns, so it
 * reads workspace rows only through the internal tool route. That is why
 * tools/load_skill.ts and skills/ stay forbidden below.
 */
const MOUNT = fileURLToPath(new URL('../../', import.meta.url))
const eveRoot = dirname(createRequire(import.meta.url).resolve('eve/package.json'))

function eveDefaultToolSlugs(): string[] {
  const registry = readFileSync(join(eveRoot, 'dist/src/framework/sources/registry.js'), 'utf8')
  return [...new Set([...registry.matchAll(/logicalPath:`tools\/([a-z_]+)\.ts`/g)].map((m) => m[1]))].sort()
}

describe('live-agent — every eve default is an explicit decision', () => {
  it('the default set is the one this lockdown was written against', () => {
    expect(eveDefaultToolSlugs()).toEqual(
      ['agent', 'bash', 'read_file', 'web_fetch', 'web_search', 'write_file'],
    )
  })

  it.each(['agent', 'bash', 'read_file', 'web_fetch', 'web_search', 'write_file'])(
    'tools/%s.ts exists (no default is silently inherited)',
    (slug) => {
      expect(existsSync(join(MOUNT, 'tools', `${slug}.ts`))).toBe(true)
    },
  )

  it('has no skills/, connections/ or subagents/ and no static instructions file', () => {
    for (const entry of ['skills', 'connections', 'subagents', 'instructions.md', 'instructions.ts']) {
      expect(existsSync(join(MOUNT, entry)), entry).toBe(false)
    }
    expect(readdirSync(join(MOUNT, 'instructions'))).toEqual(['live-turn.ts'])
  })

  it('glob/grep have NO file (re-adding one would opt the tool back in)', () => {
    // task_cancel / load_skill: retired slots (eve 0.76); a file there would be an ordinary tool.
    // The copilot's load_skill is the workspace proxy (see the block comment), never a file here.
    for (const slug of ['glob', 'grep', 'ask_question', 'task_cancel', 'load_skill']) {
      expect(existsSync(join(MOUNT, 'tools', `${slug}.ts`)), slug).toBe(false)
    }
  })
})

describe('live-agent — dynamic tools override authored ones (eval web isolation relies on it)', () => {
  /**
   * workspace_tools shadows web_search with a same-named REFUSAL on
   * no-web turns (eval captures, a failed spec fetch). That only works because
   * eve lets a dynamic tool replace a same-named static one, and swaps in the
   * provider's search only for an entry that is still the provider tool. Pin
   * both in eve's own dist: an upgrade that reorders them must fail here, not
   * silently let an eval turn reach Exa. Re-verify the override on upgrade.
   */
  it('eve is the version this override was verified against', () => {
    const pkg = JSON.parse(readFileSync(join(eveRoot, 'package.json'), 'utf8')) as { version: string }
    expect(pkg.version).toBe('0.79.1')
  })

  it('the step catalog sets dynamic tools over the static entries, so dynamic wins a name clash', () => {
    const catalog = readFileSync(join(eveRoot, 'dist/src/execution/catalog/step-catalog.js'), 'utf8')
    expect(catalog).toContain('function stepEntries(e,t){let n=new Map([...e.agentTools].filter(([,e])=>t(e)));')
    expect(catalog).toContain('for(let i of buildDynamicTools(e.ctx).filter(t))r.has(i.name)||(r.add(i.name),n.set(i.name,i));return n}')
  })

  it('the provider search is swapped in only for an entry that is still the execute-less provider tool', () => {
    const tools = readFileSync(join(eveRoot, 'dist/src/harness/tools.js'), 'utf8')
    expect(tools).toContain('for(let r of e.tools.values()){let i=r.behavior?.handling;if(i?.kind===`provider-tool`&&r.execute===void 0&&!t?.has(r.name))')
  })
})

describe('live-agent — disabled defaults', () => {
  it.each(
    Object.entries({
      bash,
      read_file: readFile,
      write_file: writeFile,
      agent: rootCopyAgent,
      web_fetch: webFetch,
    }),
  )(
    '%s is a disableTool() sentinel',
    (_name, mod) => {
      expect(isDisabledToolSentinel(mod)).toBe(true)
    },
  )
})

describe('live-agent — web tools', () => {
  it('web_search is eve’s provider tool pinned to Exa (the cloud route’s provider)', () => {
    expect(isDisabledToolSentinel(webSearch)).toBe(false)
    expect(isWebSearchToolDefinition(webSearch)).toBe(true)
    expect((webSearch as { provider: string }).provider).toBe('exa')
  })

  it('web_fetch is DISABLED — the cloud route never had a fetch tool (live or batch)', () => {
    expect(isDisabledToolSentinel(webFetch)).toBe(true)
  })

  it('the mount carries no web_fetch guard/cap copies (nothing left to guard)', () => {
    for (const lib of ['url-guard.ts', 'web-fetch-cap.ts']) {
      expect(existsSync(join(MOUNT, 'lib', lib)), lib).toBe(false)
    }
  })
})

import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDisabledToolSentinel } from 'eve/tools'
import rootCopyAgent from '../../tools/agent'
import { isWebSearchToolDefinition } from 'eve/tools/web_search'

/**
 * Structural harness contract for the skill-runner mount (mirrors chat-agent's
 * harness-lockdown test, which this agent previously lacked).
 *
 * A headless skill runner reaches WORKSPACE data only through the ceiling-
 * filtered proxies in tools/workspace_tools.ts. eve provisions a working sandbox
 * by default, so its sandbox-backed defaults — bash/read_file/write_file — are
 * LIVE unless each is disabled with disableTool(); they stay disabled
 * STRUCTURALLY, which also means no sandbox is ever provisioned for these
 * sessions.
 *
 * WEB IS NO LONGER PART OF THAT LOCKDOWN. web_search + web_fetch are ON by
 * default (no per-agent or per-skill toggle — matching how Anthropic's own agents
 * browse). The one off switch is the run spec's `webAccess: false` (the
 * USE_GATEWAY kill switch), under which tools/workspace_tools.ts stubs both —
 * that is pinned by web-access-gate.test.ts, not here; this file checks the two
 * slug files themselves. Web sits OUTSIDE the ceiling mechanism entirely: the
 * ceiling filters the workspace proxies, not the framework's provider/app tools. BOTH slugs were
 * disableTool() sentinels; both are now live — web_search pinned explicitly to
 * Exa, web_fetch as the SSRF-guarded, per-session-capped wrapper.
 *
 * TRAP this test guards indirectly: "web_search" must NEVER be added to a skill
 * spec's ceilingTools/coreToolNames — the resolver would mint a workspace PROXY
 * of that name colliding with eve's native provider tool.
 *
 * GLOB/GREP ARE NO LONGER DEFAULTS. eve dropped them from the default agent tool
 * set in 0.39.0, so a disableTool() file at those slugs is a no-op that breaks
 * startup. The lockdown asserts ABSENCE: re-adding tools/glob.ts or tools/grep.ts
 * would opt the tool back IN, which this must catch.
 */
import bash from '../../tools/bash'
import readFile from '../../tools/read_file'
import writeFile from '../../tools/write_file'
import webFetch from '../../tools/web_fetch'
import webSearch from '../../tools/web_search'
import { assertSafeWebUrl } from '../url-guard'
import {
  countWebFetch,
  __resetWebFetchCap,
  WEB_FETCH_PER_CONVERSATION_LIMIT,
} from '../web-fetch-cap'

const SANDBOX_BACKED_DISABLED = {
  bash,
  read_file: readFile,
  write_file: writeFile,
}

describe('skill-runner — sandbox-backed harness tools disabled', () => {
  for (const [name, mod] of Object.entries(SANDBOX_BACKED_DISABLED)) {
    it(`${name} is structurally disabled via disableTool()`, () => {
      expect(isDisabledToolSentinel(mod)).toBe(true)
    })
  }
})

describe('skill-runner — glob/grep are not default tools', () => {
  for (const slug of ['glob', 'grep']) {
    it(`${slug} has NO file at its slug (re-adding one would opt the tool back in)`, () => {
      const path = fileURLToPath(new URL(`../../tools/${slug}.ts`, import.meta.url))
      expect(existsSync(path)).toBe(false)
    })
  }
})

describe('skill-runner — web tools are live by default (off only via spec.webAccess, see web-access-gate.test.ts)', () => {
  it('web_search is a LIVE provider-managed tool pinned to Exa', () => {
    // Not a disable sentinel any more, and not eve's inherited default: an
    // explicit webSearch({ provider: 'exa' }) config.
    expect(isDisabledToolSentinel(webSearch)).toBe(false)
    expect(isWebSearchToolDefinition(webSearch)).toBe(true)
    expect((webSearch as { provider: string }).provider).toBe('exa')
  })

  it('web_fetch is LIVE (no longer a disableTool sentinel)', () => {
    expect(isDisabledToolSentinel(webFetch)).toBe(false)
    expect(typeof (webFetch as { execute?: unknown }).execute).toBe('function')
  })

  it('web_fetch keeps the workspace-data steer in its description', () => {
    // This tool sits next to the workspace proxies in the same session, so the
    // wrapper re-describes it to keep entity retrieval on the workspace tools.
    // Its presence also proves this slug is the authored guarded wrapper rather
    // than eve's bare built-in.
    expect(String((webFetch as { description?: unknown }).description)).toMatch(
      /NEVER for workspace data/i,
    )
  })
})

describe('skill-runner — web_fetch SSRF guard', () => {
  it('allows a normal public https URL', () => {
    expect(assertSafeWebUrl('https://example.com/path').ok).toBe(true)
  })
  it('blocks the AWS instance-metadata address', () => {
    expect(assertSafeWebUrl('http://169.254.169.254/latest/meta-data/').ok).toBe(false)
  })
  it('blocks private-range IPv4', () => {
    expect(assertSafeWebUrl('https://10.0.0.5/').ok).toBe(false)
    expect(assertSafeWebUrl('https://192.168.1.1/').ok).toBe(false)
    expect(assertSafeWebUrl('https://172.16.9.9/').ok).toBe(false)
  })
  it('blocks loopback IPv6', () => {
    expect(assertSafeWebUrl('https://[::1]/').ok).toBe(false)
  })
  it('blocks IPv4-mapped IPv6 (the URL parser rewrites it to hex) and trailing-dot blocked names', () => {
    expect(assertSafeWebUrl('https://[::ffff:127.0.0.1]/').ok).toBe(false)
    expect(assertSafeWebUrl('https://[::ffff:a9fe:a9fe]/latest/meta-data/').ok).toBe(false)
    expect(assertSafeWebUrl('https://[::ffff:10.0.0.5]/').ok).toBe(false)
    expect(assertSafeWebUrl('https://[64:ff9b::a9fe:a9fe]/').ok).toBe(false)
    expect(assertSafeWebUrl('https://[fe90::1]/').ok).toBe(false)
    expect(assertSafeWebUrl('https://ip6-localhost./').ok).toBe(false)
    expect(assertSafeWebUrl('https://metadata.google.internal./').ok).toBe(false)
    expect(assertSafeWebUrl('https://[::ffff:8.8.8.8]/').ok).toBe(true)
    expect(assertSafeWebUrl('https://[2606:4700::1111]/').ok).toBe(true)
  })
  it('blocks non-http(s) schemes', () => {
    expect(assertSafeWebUrl('file:///etc/passwd').ok).toBe(false)
  })
})

// Isolation coverage above proves the guard/cap FUNCTIONS work; these prove the
// tool's OWN execute actually routes through them BEFORE any network fetch —
// closing the "guard exists but isn't wired in" gap. A blocked/capped call must
// return a refusal result and NEVER reach eve's underlying fetch, so we assert on
// the deterministic refusal payload (no network is touched by these paths).
describe('skill-runner — web_fetch.execute wires guard + cap into the path', () => {
  beforeEach(() => __resetWebFetchCap())
  const exec = (webFetch as unknown as {
    execute: (i: unknown, c: unknown) => Promise<{ url: string; content: string }>
  }).execute
  const ctx = { session: { id: 'sess-exec' } }

  it('SSRF-blocked URL is refused by execute (never delegates to the fetch)', async () => {
    const out = await exec({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx)
    expect(out.content).toMatch(/Refused to fetch/i)
    expect(out.url).toBe('http://169.254.169.254/latest/meta-data/')
  })

  it('over-cap call is refused by execute with the limit message', async () => {
    for (let i = 0; i < WEB_FETCH_PER_CONVERSATION_LIMIT; i++) {
      countWebFetch('sess-exec')
    }
    const out = await exec({ url: 'https://example.com/' }, ctx)
    expect(out.content).toMatch(/reached its web-fetch limit/i)
  })
})

describe('skill-runner — eve built-in root-copy `agent` is structurally disabled', () => {
  // A root copy inherits every tool, auth and the sandbox; each agent keeps
  // it off on purpose — see tools/agent.ts for why.
  it('tools/agent.ts is a disableTool() sentinel', () => {
    expect(isDisabledToolSentinel(rootCopyAgent)).toBe(true)
  })

  // eve 0.76 removed the framework `load_skill` and moved `task_cancel` into
  // its reserved namespace (`eve__task_cancel`, added only when the agent has a
  // tool that runs calls as tasks; with `agent` off there is none). A file at
  // either old slug would now be an ORDINARY authored tool, so neither exists.
  it('has no tools/task_cancel.ts or tools/load_skill.ts slot file', () => {
    for (const slug of ['task_cancel', 'load_skill']) {
      expect(existsSync(fileURLToPath(new URL(`../../tools/${slug}.ts`, import.meta.url))), slug).toBe(false)
    }
  })
})

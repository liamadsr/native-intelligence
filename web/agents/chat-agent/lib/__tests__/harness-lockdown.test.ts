import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDisabledToolSentinel } from 'eve/tools'
import rootCopyAgent from '../../tools/agent'
import { isWebSearchToolDefinition } from 'eve/tools/web_search'

/**
 * Structural harness contract for the chat-agent root.
 *
 * The chat-agent has NO sandbox or coding surface — every workspace capability
 * comes through the workspace-tool proxies, gated by the persona ceiling. So the
 * SANDBOX-backed defaults (shell + filesystem) stay disabled STRUCTURALLY (a
 * disableTool() file at each slug), never left inert incidentally.
 *
 * WEB IS DIFFERENT NOW. web_search + web_fetch are ALWAYS ON for every Native Intelligence
 * agent (no toggle — matching how Anthropic's own agents browse). This test pins
 * the NEW contract: the sandbox tools are disabled, web_search is LIVE and PINNED
 * to Exa by an explicit `webSearch({ provider: 'exa' })` file (previously the slug
 * had no file at all and we inherited the framework default — the pin makes the
 * choice reviewable and removes the "no file" ambiguity between "we chose the
 * default" and "someone deleted the sentinel"), and web_fetch is LIVE but wrapped
 * with the SSRF url-guard and a per-conversation abuse cap.
 *
 * GLOB/GREP ARE NO LONGER DEFAULTS. eve dropped them from the default agent tool
 * set in 0.39.0, so a disableTool() file at those slugs is a no-op that breaks
 * startup. The lockdown flips to asserting ABSENCE: re-adding tools/glob.ts or
 * tools/grep.ts would opt the tool back IN, which this must catch.
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

// Sandbox-backed defaults: still disabled structurally.
const SANDBOX_BACKED_DISABLED = {
  bash,
  read_file: readFile,
  write_file: writeFile,
}

describe('chat-agent — sandbox-backed harness tools disabled', () => {
  for (const [name, mod] of Object.entries(SANDBOX_BACKED_DISABLED)) {
    it(`${name} is structurally disabled via disableTool()`, () => {
      expect(isDisabledToolSentinel(mod)).toBe(true)
    })
  }
})

describe('chat-agent — glob/grep are not default tools', () => {
  for (const slug of ['glob', 'grep']) {
    it(`${slug} has NO file at its slug (re-adding one would opt the tool back in)`, () => {
      const path = fileURLToPath(new URL(`../../tools/${slug}.ts`, import.meta.url))
      expect(existsSync(path)).toBe(false)
    })
  }
})

describe('chat-agent — web is always on', () => {
  it('web_search is a LIVE provider-managed tool pinned to Exa', () => {
    // Not a disable sentinel, and not eve's inherited default: an explicit
    // webSearch({ provider: 'exa' }) config. A stray disableTool() here (or a
    // silent flip to 'parallel') would change how every chat turn searches.
    expect(isDisabledToolSentinel(webSearch)).toBe(false)
    expect(isWebSearchToolDefinition(webSearch)).toBe(true)
    expect((webSearch as { provider: string }).provider).toBe('exa')
  })

  it('web_fetch is a LIVE tool, not a disabled sentinel', () => {
    expect(isDisabledToolSentinel(webFetch)).toBe(false)
    expect(typeof (webFetch as { execute?: unknown }).execute).toBe('function')
  })
})

describe('chat-agent — web_fetch SSRF guard', () => {
  it('allows a normal public https URL', () => {
    expect(assertSafeWebUrl('https://example.com/path').ok).toBe(true)
  })
  it('blocks the AWS instance-metadata address', () => {
    const r = assertSafeWebUrl('http://169.254.169.254/latest/meta-data/')
    expect(r.ok).toBe(false)
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

describe('chat-agent — web_fetch per-conversation cap', () => {
  beforeEach(() => __resetWebFetchCap())

  it('allows fetches up to the limit, then refuses', () => {
    const session = 'sess-A'
    for (let i = 0; i < WEB_FETCH_PER_CONVERSATION_LIMIT; i++) {
      expect(countWebFetch(session).allowed).toBe(true)
    }
    const over = countWebFetch(session)
    expect(over.allowed).toBe(false)
    expect(over.count).toBe(WEB_FETCH_PER_CONVERSATION_LIMIT)
  })

  it('counts each conversation independently', () => {
    expect(countWebFetch('sess-B').allowed).toBe(true)
    expect(countWebFetch('sess-C').count).toBe(1)
  })
})

// Isolation coverage above proves the guard/cap FUNCTIONS work; these prove the
// tool's OWN execute actually routes through them BEFORE any network fetch —
// closing the "guard exists but isn't wired in" gap. A blocked/capped call must
// return a refusal result and NEVER reach eve's underlying fetch, so we assert on
// the deterministic refusal payload (no network is touched by these paths).
describe('chat-agent — web_fetch.execute wires guard + cap into the path', () => {
  beforeEach(() => __resetWebFetchCap())
  const exec = (webFetch as unknown as {
    execute: (i: unknown, c: unknown) => Promise<{ url: string; content: string }>
  }).execute
  const ctx = { session: { id: 'sess-exec' } }

  it('SSRF-blocked URL is refused by execute (never delegates to the fetch)', async () => {
    const out = await exec({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx)
    // The guard's reason is surfaced as the model-visible content — proof the
    // execute path ran ensureSafeWebUrl and short-circuited on it.
    expect(out.content).toMatch(/Refused to fetch/i)
    expect(out.url).toBe('http://169.254.169.254/latest/meta-data/')
  })

  it('over-cap call is refused by execute with the limit message', async () => {
    // Exhaust the cap for this session, then the next execute must refuse.
    for (let i = 0; i < WEB_FETCH_PER_CONVERSATION_LIMIT; i++) {
      countWebFetch('sess-exec')
    }
    const out = await exec({ url: 'https://example.com/' }, ctx)
    expect(out.content).toMatch(/reached its web-fetch limit/i)
  })
})

describe('chat-agent — eve built-in root-copy `agent` is structurally disabled', () => {
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

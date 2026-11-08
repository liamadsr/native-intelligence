import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDisabledToolSentinel } from 'eve/tools'
import rootCopyAgent from '../../tools/agent'
import { isWebSearchToolDefinition } from 'eve/tools/web_search'

/**
 * Structural harness contract for the coding-agent mount (mirrors chat-agent's
 * harness-lockdown test, which this agent previously lacked).
 *
 * THIS AGENT IS THE INVERSE OF THE OTHERS. Its sandbox-backed defaults —
 * bash/read_file/write_file — are deliberately LIVE and bound to the authored
 * sandbox: editing the cloned repo in /workspace IS the point of the agent. So
 * this file asserts ABSENCE of a disable file at those slugs (a stray
 * disableTool() there would silently strip the agent of its whole coding
 * surface), rather than asserting sentinels.
 *
 * WEB IS NOW LIVE TOO. web_search + web_fetch are ALWAYS ON for every Native Intelligence agent
 * (no toggle — matching how Anthropic's own agents browse). BOTH slugs were
 * disableTool() sentinels justified as parity with the legacy sandbox CLI
 * runner's hardcoded Bash/Read/Edit/Write/Glob/Grep allowlist. That argument no
 * longer holds: an unattended run that hits an unfamiliar API or an opaque error
 * had no one to ask, so its only options were guessing or failing. web_search is
 * now pinned explicitly to Exa; web_fetch is the SSRF-guarded, per-session-capped
 * wrapper.
 *
 * WHAT ACTUALLY BOUNDS THIS AGENT is unchanged and still structural: sandbox
 * isolation + the sandbox network policy (lib/network-policy.ts, covered by
 * network-policy.test.ts), the scoped terminal tools (finish_run / post_progress,
 * covered by tools.test.ts), and the per-session output-token cap. Note that
 * web_fetch runs in the APP runtime, not the sandbox, so it is not a hole in that
 * network policy — the policy still governs what the repo's own build/test
 * commands may reach, and web_fetch cannot write to the sandbox.
 *
 * GLOB/GREP ARE NO LONGER DEFAULTS. eve dropped them from the default agent tool
 * set in 0.39.0. This agent WANTS them, so the contract is the opt-in export
 * (`export { glob as default } from 'eve/tools/glob'`), not a disable sentinel —
 * and today neither file exists, so neither tool is registered. Pinned below so a
 * change to that is a deliberate, reviewed edit.
 */
import webFetch from '../../tools/web_fetch'
import webSearch from '../../tools/web_search'
import finishRun from '../../tools/finish_run'
import postProgress from '../../tools/post_progress'
import { assertSafeWebUrl } from '../url-guard'
import {
  countWebFetch,
  __resetWebFetchCap,
  WEB_FETCH_PER_CONVERSATION_LIMIT,
} from '../web-fetch-cap'

/** Resolve a tool slug to its on-disk path in this agent's tools/ dir. */
const slugPath = (slug: string) =>
  fileURLToPath(new URL(`../../tools/${slug}.ts`, import.meta.url))

describe('coding-agent — the coding surface stays LIVE', () => {
  for (const slug of ['bash', 'read_file', 'write_file']) {
    it(`${slug} has NO file at its slug (the default stays live — this agent IS the coder)`, () => {
      // A disableTool() file here would remove the capability the agent exists
      // for; an override wrapper would need its own review. Either way, this
      // must be a deliberate edit, not a drive-by.
      expect(existsSync(slugPath(slug))).toBe(false)
    })
  }
})

describe('coding-agent — glob/grep are not registered', () => {
  for (const slug of ['glob', 'grep']) {
    it(`${slug} has NO file at its slug (0.39.0 dropped it from the defaults)`, () => {
      expect(existsSync(slugPath(slug))).toBe(false)
    })
  }
})

describe('coding-agent — the authored terminal tools stay live', () => {
  it('finish_run and post_progress are not disable sentinels', () => {
    expect(isDisabledToolSentinel(finishRun)).toBe(false)
    expect(isDisabledToolSentinel(postProgress)).toBe(false)
  })
})

describe('coding-agent — web is always on', () => {
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

  it('web_fetch is scoped to docs and disclaims the sandbox in its description', () => {
    // The wrapper's description is what stops the model reaching for web_fetch
    // when it means read_file. Its presence also proves this slug is the authored
    // guarded wrapper rather than eve's bare built-in.
    const description = String((webFetch as { description?: unknown }).description)
    expect(description).toMatch(/documentation/i)
    expect(description).toMatch(/CANNOT read or write/i)
  })
})

describe('coding-agent — web_fetch SSRF guard', () => {
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
describe('coding-agent — web_fetch.execute wires guard + cap into the path', () => {
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

describe('coding-agent — eve built-in root-copy `agent` is structurally disabled', () => {
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

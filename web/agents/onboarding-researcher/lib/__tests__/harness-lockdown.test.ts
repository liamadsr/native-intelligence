import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDisabledToolSentinel } from 'eve/tools'
import rootCopyAgent from '../../tools/agent'
import { isWebSearchToolDefinition } from 'eve/tools/web_search'

/**
 * Structural harness-lockdown test for the onboarding-researcher agent root.
 *
 * eve provisions a working sandbox by default (nothing to author), so its
 * sandbox-backed default tools — bash/read_file/write_file — are LIVE unless
 * each is overridden with disableTool(). This agent's designed surface is
 * web research plus the authored save/finish tools; none of the sandbox tools
 * belong in it. The invariant: every sandbox-backed default is disabled
 * STRUCTURALLY (a disableTool() file at its slug), never left inert
 * incidentally. This test fails if any such file is missing (the import throws)
 * or stops being a disable sentinel.
 *
 * WEB IS THIS AGENT'S PRIMARY SURFACE, and now it is pinned structurally too.
 * web_search + web_fetch are ALWAYS ON for every Dial8 agent (no toggle —
 * matching how Anthropic's own agents browse). Previously BOTH slugs had no file
 * at all: web_search inherited eve's framework default, and web_fetch was the
 * RAW built-in — this was the only agent with neither an SSRF guard nor an abuse
 * cap, despite fetching a hostname derived from a user-supplied email address.
 * The new contract, pinned below: web_search is an explicit
 * `webSearch({ provider: 'exa' })` config, and web_fetch is the guarded wrapper.
 *
 * GLOB/GREP ARE NO LONGER DEFAULTS. eve dropped them from the default agent tool
 * set in 0.39.0, so a disableTool() file at those slugs is a no-op that breaks
 * startup. The lockdown flips to asserting ABSENCE: re-adding tools/glob.ts or
 * tools/grep.ts would opt the tool back IN, which this must catch.
 */

// Import the tool slots by name; each must default-export a disableTool() sentinel.
import bash from '../../tools/bash'
import readFile from '../../tools/read_file'
import writeFile from '../../tools/write_file'
import webFetch from '../../tools/web_fetch'
import webSearch from '../../tools/web_search'
import enrichCompany from '../../tools/enrich_company'
import enrichMe from '../../tools/enrich_me'
import { assertSafeWebUrl } from '../url-guard'
import {
  countWebFetch,
  __resetWebFetchCap,
  WEB_FETCH_PER_CONVERSATION_LIMIT,
} from '../web-fetch-cap'

const SANDBOX_BACKED_DEFAULTS = {
  bash,
  read_file: readFile,
  write_file: writeFile,
}

describe('onboarding-researcher — sandbox-backed harness tools disabled', () => {
  for (const [name, mod] of Object.entries(SANDBOX_BACKED_DEFAULTS)) {
    it(`${name} is structurally disabled via disableTool()`, () => {
      expect(isDisabledToolSentinel(mod)).toBe(true)
    })
  }
})

describe('onboarding-researcher — glob/grep are not default tools', () => {
  for (const slug of ['glob', 'grep']) {
    it(`${slug} has NO file at its slug (re-adding one would opt the tool back in)`, () => {
      const path = fileURLToPath(new URL(`../../tools/${slug}.ts`, import.meta.url))
      expect(existsSync(path)).toBe(false)
    })
  }
})

describe('onboarding-researcher — web is always on', () => {
  it('web_search is a LIVE provider-managed tool pinned to Exa', () => {
    // Not a disable sentinel, and not eve's inherited default: an explicit
    // webSearch({ provider: 'exa' }) config. A stray disableTool() here would
    // gut the research protocol; a silent flip to 'parallel' would change every
    // signup research run's source of truth.
    expect(isDisabledToolSentinel(webSearch)).toBe(false)
    expect(isWebSearchToolDefinition(webSearch)).toBe(true)
    expect((webSearch as { provider: string }).provider).toBe('exa')
  })

  it('enrich_company is a LIVE authored tool (CRM company create + Exa enrichment)', () => {
    // The researcher's PRIMARY company step: it creates the company in the CRM
    // and enriches it through the app's own pipeline (one Exa Deep Search), so
    // onboarding and the CRM's Sparkles button write identical rows. A disable
    // sentinel here would silently drop the run back to piecing a profile
    // together from loose search highlights and saving nothing to the CRM.
    expect(isDisabledToolSentinel(enrichCompany)).toBe(false)
    expect(typeof (enrichCompany as { execute?: unknown }).execute).toBe('function')
    expect(String((enrichCompany as { description?: unknown }).description)).toMatch(
      /Exa Deep Search/i,
    )
  })

  it('enrich_me is a LIVE authored tool (the user\'s own contact card)', () => {
    // The person half of the same pipeline. It takes NO input at all — the
    // subject is the session principal — so the schema itself is part of the
    // lockdown: an object schema that ever grew a name/email/workspace field
    // would hand the model a lever to look up (and write about) someone else.
    expect(isDisabledToolSentinel(enrichMe)).toBe(false)
    expect(typeof (enrichMe as { execute?: unknown }).execute).toBe('function')
    const shape = (enrichMe as { inputSchema?: { shape?: Record<string, unknown> } }).inputSchema
    expect(Object.keys(shape?.shape ?? {})).toEqual([])
  })

  it('web_fetch is a LIVE tool, not a disabled sentinel', () => {
    expect(isDisabledToolSentinel(webFetch)).toBe(false)
    expect(typeof (webFetch as { execute?: unknown }).execute).toBe('function')
  })

  it('web_fetch is the GUARDED wrapper, not eve\'s raw built-in', () => {
    // The wrapper re-describes the tool with the protocol's sourcing rule. Its
    // presence is the cheap proof this slug is the authored definition rather
    // than the framework's bare one (which would carry no guard or cap).
    expect(String((webFetch as { description?: unknown }).description)).toMatch(
      /record its URL as the source/i,
    )
  })
})

describe('onboarding-researcher — web_fetch SSRF guard', () => {
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
describe('onboarding-researcher — web_fetch.execute wires guard + cap into the path', () => {
  beforeEach(() => __resetWebFetchCap())
  const exec = (webFetch as unknown as {
    execute: (i: unknown, c: unknown) => Promise<{ url: string; content: string }>
  }).execute
  const ctx = { session: { id: 'sess-exec' } }

  it('SSRF-blocked URL is refused by execute (never delegates to the fetch)', async () => {
    // The realistic attack here: a signup email whose domain part resolves to
    // (or literally IS) an internal address, walked straight into web_fetch by
    // step 1 of the research protocol.
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

describe('onboarding-researcher — eve built-in root-copy `agent` is structurally disabled', () => {
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

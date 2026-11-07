import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDisabledToolSentinel } from 'eve/tools'
import rootCopyAgent from '../../tools/agent'
import { isWebSearchToolDefinition } from 'eve/tools/web_search'

/**
 * Structural harness contract for the work-agent mount (mirrors chat-agent's
 * harness-lockdown test).
 *
 * The work-agent executes ONE approved piece of workspace work — its workspace
 * surface is the ceiling-filtered proxies + request_user_input + finish_work.
 * Everything else eve's default harness would grant is removed STRUCTURALLY with
 * disableTool():
 *  - sandbox-backed shell + filesystem (no coding surface, no sandbox ever
 *    provisioned for a work session).
 *
 * ASK_QUESTION IS NO LONGER A DEFAULT. eve 0.65 made it an opt-in workflow tool
 * (and made disableTool() on it a BUILD error), so the old disable sentinel is
 * gone and the lockdown flips to asserting ABSENCE: its park is NOT the
 * request_user_input shape the dispatcher classifies, so a model that picked it
 * would strand the run in a bare park (settled failed). Re-adding
 * tools/ask_question.ts would opt it back IN. Asking goes through
 * request_user_input alone.
 *
 * WEB IS NO LONGER PART OF THAT LOCKDOWN. web_search + web_fetch are ALWAYS ON
 * for every Dial8 agent (no toggle — matching how Anthropic's own agents browse),
 * and web sits OUTSIDE the ceiling mechanism entirely: the ceiling filters the
 * workspace proxies, not the framework's provider/app tools. web_fetch was
 * previously a disableTool() sentinel whose stated reason was the MISSING SSRF
 * guard ("no SSRF url-guard here"); the guard now exists in this agent's own lib/,
 * so the tool is live and wrapped. web_search had no file and is now pinned
 * explicitly to Exa.
 *
 * TRAP this test guards indirectly: "web_search" must NEVER be added to a work
 * spec's ceilingTools/coreToolNames — the resolver would mint a workspace PROXY
 * of that name colliding with eve's native provider tool.
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
import requestUserInput from '../../tools/request_user_input'
import finishWork from '../../tools/finish_work'
import delegateWork from '../../tools/delegate_work'
import { assertSafeWebUrl } from '../url-guard'
import {
  countWebFetch,
  __resetWebFetchCap,
  WEB_FETCH_PER_CONVERSATION_LIMIT,
} from '../web-fetch-cap'

const DISABLED = {
  bash,
  read_file: readFile,
  write_file: writeFile,
}

describe('work-agent — harness lockdown', () => {
  for (const [name, mod] of Object.entries(DISABLED)) {
    it(`${name} is structurally disabled via disableTool()`, () => {
      expect(isDisabledToolSentinel(mod)).toBe(true)
    })
  }

  for (const slug of ['glob', 'grep', 'ask_question']) {
    it(`${slug} has NO file at its slug (re-adding one would opt the tool back in)`, () => {
      const path = fileURLToPath(new URL(`../../tools/${slug}.ts`, import.meta.url))
      expect(existsSync(path)).toBe(false)
    })
  }

  it('request_user_input, finish_work and delegate_work stay live (not disable sentinels)', () => {
    expect(isDisabledToolSentinel(requestUserInput)).toBe(false)
    expect(isDisabledToolSentinel(finishWork)).toBe(false)
    expect(isDisabledToolSentinel(delegateWork)).toBe(false)
  })
})

describe('work-agent — web is always on', () => {
  it('web_search is a LIVE provider-managed tool pinned to Exa', () => {
    // Not a disable sentinel, and not eve's inherited default: an explicit
    // webSearch({ provider: 'exa' }) config.
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

describe('work-agent — web_fetch SSRF guard', () => {
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
describe('work-agent — web_fetch.execute wires guard + cap into the path', () => {
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

describe('work-agent — eve built-in root-copy `agent` is structurally disabled', () => {
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

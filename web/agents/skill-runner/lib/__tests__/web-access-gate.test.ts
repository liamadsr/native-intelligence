import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { isDisabledToolSentinel } from 'eve/tools'
import type { EveSpec } from '../spec-client'

/**
 * WS-3a — skill-run web access honors the app's USE_GATEWAY kill switch on the
 * eve path, exactly as the retired in-process gateway path did ('auto').
 *
 * The decision is made server-side (skill-run-rebuild.ts → spec.webAccess); the
 * skill-runner's tools resolver enforces it by returning refusal stubs named
 * `web_search` / `web_fetch`, which OVERRIDE the authored native web tools for
 * the session. Invariants:
 *   1. webAccess:true  → no web override; the native tools stand.
 *   2. webAccess:false → both web tools replaced by stubs that touch nothing.
 *   3. FAIL CLOSED: a spec without the field, or no spec at all (fetch failed),
 *      also gets the stubs — the switch could not be confirmed on.
 *   4. The stubs never dispatch to the workspace tool route.
 *   5. Workspace proxies are unaffected by the web decision.
 *   6. The stubbed set is not a hand-kept list: it must equal every LIVE
 *      authored tool file on this agent (besides the resolver itself), read
 *      from the filesystem. A renamed or new web tool fails here instead of
 *      silently turning the web back on under USE_GATEWAY=false. (Framework
 *      defaults with no file cannot sneak in either: default-tools.test.ts pins
 *      that the skill-runner inherits none.)
 */

const fetchEveSpec = vi.fn<(t: string) => Promise<EveSpec | null>>()
const dispatchWorkspaceTool = vi.fn<(name: string, token: string, input: unknown) => Promise<unknown>>(
  async () => ({ ok: true }),
)

vi.mock('../spec-client.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../spec-client')>()),
  fetchEveSpec: (t: string) => fetchEveSpec(t),
  dispatchWorkspaceTool: (name: string, token: string, input: unknown) =>
    dispatchWorkspaceTool(name, token, input),
  runTokenFromAuth: () => 'tok.sig',
}))

import workspaceTools from '../../tools/workspace_tools'
import { webAccessEnabled, NATIVE_WEB_TOOL_NAMES } from '../spec-client'

/** The dynamic resolver itself — a defineDynamic, not an authored tool. */
const RESOLVER_FILE = 'workspace_tools.ts'

/**
 * Authored tools that touch no web and so stay live with web access off: the
 * run's plan (update_plan, A4), which only writes the run's own job plan
 * through the skill-run tool route. Named here on purpose: a new authored tool
 * still lands in the web list below (and fails) until someone decides which
 * it is.
 */
const NON_WEB_AUTHORED = new Set(['update_plan'])

/** Every authored tool file on the skill-runner whose default export is LIVE
 *  (not a disableTool() sentinel), excluding the resolver. */
async function liveAuthoredToolNames(): Promise<string[]> {
  const dir = fileURLToPath(new URL('../../tools/', import.meta.url))
  const live: string[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts') || file === RESOLVER_FILE || NON_WEB_AUTHORED.has(file.replace(/\.ts$/, ''))) continue
    const mod = (await import(/* @vite-ignore */ `${dir}${file}`)) as { default: unknown }
    if (!isDisabledToolSentinel(mod.default)) live.push(file.replace(/\.ts$/, ''))
  }
  return live.sort()
}

type ToolFn = { description?: string; execute: (i: unknown) => unknown }
type Resolver = {
  events: {
    'session.started': (e: unknown, ctx: { session: { auth: unknown } }) => Promise<Record<string, ToolFn> | null>
  }
}
const resolver = workspaceTools as unknown as Resolver

async function sessionStart(spec: EveSpec | null) {
  fetchEveSpec.mockResolvedValue(spec)
  return resolver.events['session.started']({}, { session: { auth: {} } })
}

function spec(over: Partial<EveSpec> = {}): EveSpec {
  return {
    systemPrompt: 'p',
    model: 'deepseek/deepseek-v4-flash',
    mode: 'report',
    outputContract: 'prose',
    ceiling: ['list_actions'],
    ceilingTools: [{ name: 'list_actions', description: 'List actions.' }],
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('webAccessEnabled (fails closed)', () => {
  it('is true only for an explicit webAccess:true', () => {
    expect(webAccessEnabled({ webAccess: true })).toBe(true)
    expect(webAccessEnabled({ webAccess: false })).toBe(false)
    expect(webAccessEnabled({})).toBe(false)
    expect(webAccessEnabled(null)).toBe(false)
  })
})

describe('skill-runner workspace_tools — the web kill switch', () => {
  it('webAccess:true → no web override, only the workspace proxies', async () => {
    const tools = await sessionStart(spec({ webAccess: true }))
    expect(Object.keys(tools ?? {}).sort()).toEqual(['list_actions'])
  })

  it('the stubbed list is exactly the live authored tools on disk (every web tool, nothing else)', async () => {
    const live = await liveAuthoredToolNames()
    // Sanity: the derivation really sees today's two web tools.
    expect(live).toEqual(['web_fetch', 'web_search'])
    expect([...NATIVE_WEB_TOOL_NAMES].sort()).toEqual(live)
  })

  it('the non-web authored tools are live tools on disk, and the web switch never stubs them', async () => {
    for (const name of NON_WEB_AUTHORED) {
      const mod = (await import(/* @vite-ignore */ fileURLToPath(new URL(`../../tools/${name}.ts`, import.meta.url)))) as { default: unknown }
      expect(isDisabledToolSentinel(mod.default), name).toBe(false)
      const tools = await sessionStart(spec({ webAccess: false }))
      expect(tools, name).not.toHaveProperty(name)
    }
  })

  it('webAccess:false (USE_GATEWAY=false) → every live authored tool replaced by a refusal stub', async () => {
    const live = await liveAuthoredToolNames()
    const tools = await sessionStart(spec({ webAccess: false }))
    const stubbed = Object.keys(tools ?? {}).filter((k) => k !== 'list_actions').sort()
    expect(stubbed).toEqual(live)
    for (const name of live) {
      expect(tools![name].description).toMatch(/turned off/i)
      const out = await tools![name].execute({ query: 'x', url: 'https://example.com' })
      expect(out).toEqual({ error: 'Web access is turned off for this run.' })
    }
    // The stubs never reach the workspace tool route.
    expect(dispatchWorkspaceTool).not.toHaveBeenCalled()
  })

  it('a spec missing webAccess fails closed (stubs)', async () => {
    const tools = await sessionStart(spec())
    expect(tools).toHaveProperty('web_search')
    expect(tools).toHaveProperty('web_fetch')
  })

  it('no spec (fetch failed) → no workspace tools, web still fails closed', async () => {
    const tools = await sessionStart(null)
    expect(Object.keys(tools ?? {}).sort()).toEqual(await liveAuthoredToolNames())
  })

  it('a ceiling that names a web tool never gets a proxy for it (stub or native stands)', async () => {
    const withWeb = spec({
      webAccess: true,
      ceiling: ['list_actions', 'web_search'],
      ceilingTools: [
        { name: 'list_actions', description: 'List actions.' },
        { name: 'web_search', description: 'shadow' },
      ],
    })
    const tools = await sessionStart(withWeb)
    expect(Object.keys(tools ?? {})).toEqual(['list_actions'])
  })

  it('workspace proxies still dispatch through the tool route', async () => {
    const tools = await sessionStart(spec({ webAccess: false }))
    await tools!.list_actions.execute({ limit: 1 })
    expect(dispatchWorkspaceTool).toHaveBeenCalledWith('list_actions', 'tok.sig', { limit: 1 })
  })
})

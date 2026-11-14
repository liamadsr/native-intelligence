import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createStatelessClient, STATELESS_AUTH } from '@/lib/supabase/stateless'

// supabase-js's auth client, in Node, starts its token auto-refresh ticker
// (setInterval every 30 s) from initialize() whenever autoRefreshToken is on, and
// never stops it: the timer pins the client for the life of the process. The web
// server leaked one or more clients per authenticated request this way and ran
// out of heap about every six hours (2026-11-13).
const REFRESH_TICK_MS = 30_000

// A made-up project: creating a client calls nothing, and setup.ts refuses any
// request to the test host.
const URL = 'https://test.supabase.co'
const KEY = 'test-key'

type AuthInternals = { autoRefreshToken: boolean; persistSession: boolean; detectSessionInUrl: boolean }

function refreshTickerCalls(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter((call) => call[1] === REFRESH_TICK_MS)
}

describe('createStatelessClient', () => {
  const made: SupabaseClient[] = []
  afterEach(async () => {
    // A default client's ticker would keep running between tests otherwise.
    await Promise.all(made.splice(0).map((c) => c.auth.stopAutoRefresh()))
    vi.restoreAllMocks()
  })

  it('starts no refresh ticker, where a default client does', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    const plain = createClient(URL, KEY)
    made.push(plain)
    await plain.auth.initialize()
    // The library behaviour this guards against. If a supabase-js upgrade stops
    // starting the ticker in Node, this line fails: the guard may then be dropped.
    expect(refreshTickerCalls(setIntervalSpy)).toHaveLength(1)

    setIntervalSpy.mockClear()
    const stateless = createStatelessClient(URL, KEY)
    made.push(stateless)
    await stateless.auth.initialize()
    expect(refreshTickerCalls(setIntervalSpy)).toHaveLength(0)
  })

  it('keeps the auth settings off whatever options it is given', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const client = createStatelessClient(URL, KEY, {
      global: { headers: { Authorization: 'Bearer made-up' } },
      auth: { autoRefreshToken: true, persistSession: true },
    })
    made.push(client)
    await client.auth.initialize()

    expect(refreshTickerCalls(setIntervalSpy)).toHaveLength(0)
    const auth = client.auth as unknown as AuthInternals
    expect(auth.autoRefreshToken).toBe(false)
    expect(auth.persistSession).toBe(false)
    expect(auth.detectSessionInUrl).toBe(false)
    expect(STATELESS_AUTH).toEqual({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false })
  })

  it('passes the other options through', async () => {
    const fetchSpy = vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
    const client = createStatelessClient(URL, KEY, {
      global: { headers: { 'x-made-up': 'yes' }, fetch: fetchSpy as unknown as typeof fetch },
    })
    made.push(client)

    await client.from('made_up_table').select('id')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit]
    expect(new Headers(init.headers).get('x-made-up')).toBe('yes')
  })
})

// --- tripwire ------------------------------------------------------------------

const WEB = path.resolve(__dirname, '../../../..')

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue
      out.push(...sourceFiles(full))
    } else if (/\.(ts|tsx|mts|js|mjs)$/.test(entry.name) && !/\.test\.|\.spec\./.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

/** Value imports of supabase-js in a file: anything but `import type` / `type X` specifiers. */
function supabaseJsValueImports(source: string): string[] {
  const found: string[] = []
  const named = /import\s+(type\s+)?\{([^}]*)\}\s*from\s*['"]@supabase\/supabase-js['"]/g
  for (const m of source.matchAll(named)) {
    if (m[1]) continue
    const values = m[2].split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('type '))
    if (values.length) found.push(...values)
  }
  const other = [
    /import\s+(?!type\b)[\w$]+\s*(,\s*\{[^}]*\})?\s*from\s*['"]@supabase\/supabase-js['"]/g, // default
    /import\s+\*\s+as\s+[\w$]+\s+from\s*['"]@supabase\/supabase-js['"]/g, // namespace
    /require\(\s*['"]@supabase\/supabase-js['"]\s*\)/g,
    /import\(\s*['"]@supabase\/supabase-js['"]\s*\)(?!\s*\.)/g, // dynamic; `import('…').Type` is a type
  ]
  for (const re of other) for (const m of source.matchAll(re)) found.push(m[0])
  return found
}

describe('no server code creates a supabase-js client with the refresh ticker on', () => {
  it('src/ reaches supabase-js values only through src/lib/supabase/stateless.ts', () => {
    const helper = path.join(WEB, 'src/lib/supabase/stateless.ts')
    const offenders = sourceFiles(path.join(WEB, 'src'))
      .filter((f) => f !== helper)
      .flatMap((f) => supabaseJsValueImports(fs.readFileSync(f, 'utf8')).map((v) => `${path.relative(WEB, f)}: ${v}`))
    expect(offenders, 'use createStatelessClient from @/lib/supabase/stateless').toEqual([])
  })

  it('every createClient call in the agents turns autoRefreshToken off', () => {
    // The eve agents are bundled apart and cannot import src/: they pass the
    // settings themselves.
    const offenders: string[] = []
    for (const f of sourceFiles(path.join(WEB, 'agents'))) {
      const source = fs.readFileSync(f, 'utf8')
      const values = supabaseJsValueImports(source)
      if (!values.length) continue
      const calls = source.match(/(?<![\w.$])createClient\s*\(/g)?.length ?? 0
      const off = source.match(/autoRefreshToken:\s*false/g)?.length ?? 0
      if (values.some((v) => v !== 'createClient') || off < calls) {
        offenders.push(`${path.relative(WEB, f)}: imports ${values.join(', ')}; ${calls} createClient call(s), ${off} with autoRefreshToken: false`)
      }
    }
    expect(offenders).toEqual([])
  })
})

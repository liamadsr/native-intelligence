/**
 * A canon edit's provenance label (decision 16 as apply with undo: nothing
 * holds an edit). What the turn READ counts, never only what it cites: an
 * edit is labelled outside when a source it names is outside text, when its
 * run read outside text, or when it is an unattended turn with no run to
 * check (fail closed). The label says a kind and a domain, never an address.
 */
import { describe, expect, it, vi } from 'vitest'

const known = vi.hoisted(() => ({ set: new Set<string>() }))
vi.mock('@/lib/agent-events/known-senders', () => ({ knownSenders: vi.fn(async () => known.set) }))

import * as canonSources from '../canon-sources'
import { canonOutsideLabel, classifyCanonSources, normalizeCanonSources, runReadOutsideText, turnOutsideReads } from '../canon-sources'

function client(rows: Record<string, string[]>, opts: { outsideReads?: unknown; fail?: boolean } = {}) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in']) chain[m] = () => chain
      chain.maybeSingle = async () => (opts.fail ? { data: null, error: { message: 'x' } } : { data: { outside_reads: opts.outsideReads ?? [] }, error: null })
      chain.then = (resolve: (r: unknown) => unknown) => Promise.resolve({ data: (rows[table] ?? []).map((id) => ({ id })), error: null }).then(resolve)
      return chain
    },
  }
}

const CTX = { workspaceId: 'w', userId: 'u' }

describe('canonOutsideLabel', () => {
  it('names the first outside source by kind and domain only', () => {
    expect(canonOutsideLabel([{ kind: 'capture', id: 'c1' }, { kind: 'web', url: 'https://www.gong.example/pricing' }], ['trusted', 'outside'], { read: false })).toBe('a web page on gong.example')
    expect(canonOutsideLabel([{ kind: 'email', from: 'dana@northwind.example' }], ['outside'], { read: false })).toBe('an outside email from northwind.example')
    expect(canonOutsideLabel([{ kind: 'message' }], ['outside'], { read: false })).toBe('a message from outside the workspace')
    // A sender written with a display name keeps only its hostname (review nit).
    expect(canonOutsideLabel([{ kind: 'email', from: 'Ana <ana@Acme.com>' }], ['outside'], { read: false })).toBe('an outside email from acme.com')
    expect(JSON.stringify(canonOutsideLabel([{ kind: 'email', from: 'dana@northwind.example' }], ['outside'], { read: false }))).not.toContain('dana@')
  })
  it('a run that read outside text labels whatever it cites (a cited row id proves nothing)', () => {
    expect(canonOutsideLabel([{ kind: 'capture', id: 'c1' }], ['trusted'], { read: true, tools: ['web_fetch'] })).toBe('a web page')
    expect(canonOutsideLabel([], [], { read: true })).toBe('outside text')
  })
  it('nothing outside read or cited: no label', () => {
    expect(canonOutsideLabel([{ kind: 'capture', id: 'c1' }], ['trusted'], { read: false })).toBeNull()
    expect(canonOutsideLabel([], [], { read: false })).toBeNull()
  })
  it('there is no hold decision any more', () => {
    expect(Object.keys(canonSources)).not.toContain('decideCanonEditHold')
  })
})

describe('turnOutsideReads', () => {
  it('a turn of a run reads the run’s record, attended or not, with its tools', async () => {
    expect(await turnOutsideReads(client({}, { outsideReads: ['read_email'] }) as never, { workspaceId: 'w', attended: true, runId: 'r1' })).toEqual({ read: true, tools: ['read_email'] })
    expect(await turnOutsideReads(client({}, { outsideReads: [] }) as never, { workspaceId: 'w', attended: false, runId: 'r1' })).toEqual({ read: false, tools: [] })
    expect(await turnOutsideReads(client({}, { fail: true }) as never, { workspaceId: 'w', attended: true, runId: 'r1' })).toEqual({ read: true, tools: [] })
  })
  it('unattended with no run to check fails closed; a person’s own chat does not', async () => {
    expect((await turnOutsideReads(client({}) as never, { workspaceId: 'w', attended: false, runId: null })).read).toBe(true)
    expect((await turnOutsideReads(client({}) as never, { workspaceId: 'w', attended: true, runId: null })).read).toBe(false)
  })
})

describe('classifyCanonSources', () => {
  it('trusts an id only when it is a row in the workspace', async () => {
    const trust = await classifyCanonSources(
      client({ captures: ['c1'] }) as never,
      [
        { kind: 'capture', id: 'c1' },
        { kind: 'capture', id: 'forged' },
        { kind: 'claim' },
      ],
      { ...CTX, attended: false, runReadOutsideText: false },
    )
    expect(trust).toEqual(['trusted', 'unverified', 'unverified'])
  })

  it('a chat counts only with a person there; web, messages, files and apps never', async () => {
    const sources = normalizeCanonSources([{ kind: 'chat' }, { kind: 'web', url: 'https://x.example' }, { kind: 'message' }, { kind: 'file' }, { kind: 'connected_app' }])
    expect(await classifyCanonSources(client({}) as never, sources, { ...CTX, attended: true, runReadOutsideText: false })).toEqual(['trusted', 'outside', 'outside', 'outside', 'outside'])
    expect((await classifyCanonSources(client({}) as never, sources, { ...CTX, attended: false, runReadOutsideText: false }))[0]).toBe('unverified')
  })

  it('an email is trusted only from a known sender, and never once the run read outside text', async () => {
    known.set = new Set(['ana@acme.com'])
    const sources = normalizeCanonSources([{ kind: 'email', from: 'Ana@Acme.com' }, { kind: 'email', from: 'stranger@x.example' }])
    expect(await classifyCanonSources(client({}) as never, sources, { ...CTX, attended: true, runReadOutsideText: false })).toEqual(['trusted', 'outside'])
    expect(await classifyCanonSources(client({}) as never, sources, { ...CTX, attended: false, runReadOutsideText: true })).toEqual(['outside', 'outside'])
  })
})

describe('normalizeCanonSources', () => {
  it('drops unknown kinds and junk, keeps at most 10', () => {
    const out = normalizeCanonSources([{ kind: 'gossip' }, null, 'x', ...Array.from({ length: 12 }, (_, i) => ({ kind: 'capture', id: `c${i}` }))])
    expect(out).toHaveLength(10)
    expect(out[0]).toEqual({ kind: 'capture', id: 'c0' })
  })
})

describe('runReadOutsideText', () => {
  it('reads agent_run.outside_reads, and fails closed', async () => {
    expect(await runReadOutsideText(client({}, { outsideReads: ['web_fetch'] }) as never, 'w', 'run-1')).toBe(true)
    expect(await runReadOutsideText(client({}, { outsideReads: [] }) as never, 'w', 'run-1')).toBe(false)
    expect(await runReadOutsideText(client({}, { fail: true }) as never, 'w', 'run-1')).toBe(true)
    expect(await runReadOutsideText(client({}) as never, 'w', null)).toBe(false)
  })
})

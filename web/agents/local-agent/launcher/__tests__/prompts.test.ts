/**
 * Native prompts (C3): the launcher's broker against a fake desktop, and the
 * eve server's half over a real fd 3 socketpair (a child Node plays the eve
 * server and imports prompts.ts as the launcher would, with type stripping).
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Duplex } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PROMPT_TIMEOUT_MS,
  MAX_PROMPT_TIMEOUT_MS,
  PROMPT_FD_ENV,
  PROMPT_SLOT_GRACE_MS,
  PROMPT_ID,
  PROMPT_STDIO,
  type PromptLine,
  attachPromptBridge,
  createPromptBroker,
  normalizePrompt,
  parsePromptAnswer,
} from '../prompts'

function fakeDesktop() {
  const lines: PromptLine[] = []
  const logs: string[] = []
  const broker = createPromptBroker({ write: (l) => lines.push(l), log: (l) => logs.push(l) }, { idPrefix: 'p-test' })
  const answer = (id: string, allow: boolean) => broker.handleLine(JSON.stringify({ type: 'prompt_answer', id, allow }))
  return { broker, lines, logs, answer }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the launcher broker (fake desktop)', () => {
  it('writes one prompt line and matches the answer by id', async () => {
    const d = fakeDesktop()
    const push = d.broker.ask('push', { title: 'Fix the login redirect', body: 'Details' })
    expect(d.lines).toEqual([{ type: 'prompt', id: 'p-test-1', kind: 'push', detail: { title: 'Fix the login redirect', body: 'Details', timeoutMs: expect.any(Number) } }])
    expect(d.lines[0].detail.timeoutMs).toBeGreaterThan(DEFAULT_PROMPT_TIMEOUT_MS - 1_000)
    expect(d.lines[0].detail.timeoutMs).toBeLessThanOrEqual(DEFAULT_PROMPT_TIMEOUT_MS)
    expect(d.answer('p-test-1', true)).toBe(true)
    expect(await push).toEqual({ allowed: true, reason: 'allowed' })

    const fence = d.broker.ask('fence', { path: '/Users/p/code/lib', access: 'read', reason: 'compare' })
    expect(d.lines[1]).toMatchObject({ type: 'prompt', id: 'p-test-2', kind: 'fence', detail: { path: '/Users/p/code/lib', access: 'read', reason: 'compare' } })
    d.answer('p-test-2', false)
    expect(await fence).toEqual({ allowed: false, reason: 'denied' })
  })

  it('keeps one prompt on screen at a time (the desktop refuses a second) and sends the next after the answer', async () => {
    const d = fakeDesktop()
    const first = d.broker.ask('fence', { path: '/a', access: 'read' })
    const second = d.broker.ask('fence', { path: '/b', access: 'read' })
    expect(d.lines.map((l) => l.id)).toEqual(['p-test-1'])
    d.answer('p-test-1', true)
    expect(d.lines.map((l) => l.id)).toEqual(['p-test-1', 'p-test-2'])
    d.answer('p-test-2', true)
    expect([await first, await second].map((o) => o.allowed)).toEqual([true, true])
  })

  it('a timeout is a no, and an answer after it never acts (dropped, logged); the prompt keeps its slot until then', async () => {
    vi.useFakeTimers()
    const d = fakeDesktop()
    const first = d.broker.ask('fence', { path: '/a', access: 'read' }, { timeoutMs: 10_000 })
    const queued = d.broker.ask('fence', { path: '/b', access: 'read' }, { timeoutMs: 60_000 })
    expect(d.lines[0].detail.timeoutMs).toBe(10_000)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await first).toEqual({ allowed: false, reason: 'timeout' })
    expect(d.lines.map((l) => l.id)).toEqual(['p-test-1']) // still on screen: nothing else is sent
    expect(d.answer('p-test-1', true)).toBe(true)
    expect(d.logs.join('\n')).toMatch(/p-test-1 \(allow: true\) came after its timeout and was dropped/)
    // The queued prompt goes out with what is left of its own timeout.
    expect(d.lines.map((l) => l.id)).toEqual(['p-test-1', 'p-test-2'])
    expect(d.lines[1].detail.timeoutMs).toBe(50_000)
    d.answer('p-test-2', false)
    expect(await queued).toEqual({ allowed: false, reason: 'denied' })
  })

  it('a desktop that never answers holds the slot no longer than the timeout plus the grace', async () => {
    vi.useFakeTimers()
    const d = fakeDesktop()
    const first = d.broker.ask('push', { title: 'one' }, { timeoutMs: 10_000 })
    const second = d.broker.ask('push', { title: 'two' }, { timeoutMs: MAX_PROMPT_TIMEOUT_MS })
    await vi.advanceTimersByTimeAsync(10_000 + PROMPT_SLOT_GRACE_MS - 1)
    expect(await first).toEqual({ allowed: false, reason: 'timeout' })
    expect(d.lines).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(d.lines.map((l) => l.id)).toEqual(['p-test-1', 'p-test-2'])
    expect(d.logs.join('\n')).toMatch(/p-test-1 had no answer/)
    d.answer('p-test-1', true) // far too late, and no longer open: ignored
    d.answer('p-test-2', true)
    expect(await second).toEqual({ allowed: true, reason: 'allowed' })
  })

  it('a prompt that timed out in the queue is never shown', async () => {
    vi.useFakeTimers()
    const d = fakeDesktop()
    const first = d.broker.ask('push', { title: 'one' }, { timeoutMs: 60_000 })
    const queued = d.broker.ask('push', { title: 'two' }, { timeoutMs: 10_000 })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await queued).toEqual({ allowed: false, reason: 'timeout' })
    d.answer('p-test-1', true)
    expect(await first).toEqual({ allowed: true, reason: 'allowed' })
    expect(d.lines.map((l) => l.detail)).toEqual([{ title: 'one', timeoutMs: 60_000 }])
    expect(MAX_PROMPT_TIMEOUT_MS).toBe(1_800_000) // the maximum the desktop's own deadline covers
  })

  it("defaults to a 5 minute timeout and clamps the asked one to Rust's bounds, [10 s, 30 min]", async () => {
    vi.useFakeTimers()
    const d = fakeDesktop()
    const p = d.broker.ask('push', { title: 'x' })
    await vi.advanceTimersByTimeAsync(DEFAULT_PROMPT_TIMEOUT_MS - 1)
    d.answer('p-test-1', true)
    expect(await p).toEqual({ allowed: true, reason: 'allowed' })
    const tiny = d.broker.ask('push', { title: 'y' }, { timeoutMs: 1 })
    expect(d.lines[1].detail.timeoutMs).toBe(10_000)
    await vi.advanceTimersByTimeAsync(9_999)
    d.answer('p-test-2', true)
    expect(await tiny).toEqual({ allowed: true, reason: 'allowed' })
    void d.broker.ask('push', { title: 'z' }, { timeoutMs: 99 * 60_000 })
    expect(d.lines[2].detail.timeoutMs).toBe(MAX_PROMPT_TIMEOUT_MS)
    d.broker.close()
  })

  it('never shows a queued prompt with under 10 s left (Rust would wait 10 s): its own timer says no', async () => {
    vi.useFakeTimers()
    const d = fakeDesktop()
    const first = d.broker.ask('push', { title: 'one' }, { timeoutMs: 60_000 })
    const short = d.broker.ask('push', { title: 'two' }, { timeoutMs: 15_000 })
    const after = d.broker.ask('push', { title: 'three' }, { timeoutMs: 60_000 })
    await vi.advanceTimersByTimeAsync(6_000)
    d.answer('p-test-1', true)
    expect(d.lines.map((l) => l.id)).toEqual(['p-test-1', 'p-test-3'])
    expect(d.lines[1].detail.timeoutMs).toBe(54_000)
    expect(d.logs.join('\n')).toMatch(/p-test-2 had under 10 s left/)
    await vi.advanceTimersByTimeAsync(9_000)
    expect(await short).toEqual({ allowed: false, reason: 'timeout' })
    d.answer('p-test-3', false)
    expect([await first, await after].map((o) => o.reason)).toEqual(['allowed', 'denied'])
  })

  it('consumes prompt_answer lines only (malformed or unknown ones too) and leaves every other line to the launcher', () => {
    const d = fakeDesktop()
    for (const other of ['{"type":"start","request":"x"}', '{"type":"send","text":"prompt_answer","policy":"queue"}', '{"type":"stop"}', 'not json', '']) {
      expect(d.broker.handleLine(other)).toBe(false)
    }
    expect(d.broker.handleLine('{"type":"prompt_answer","id":"p-test-9","allow":true}')).toBe(true) // not open: ignored
    expect(d.broker.handleLine('{"type":"prompt_answer","id":"has space","allow":true}')).toBe(true)
    expect(d.broker.handleLine('{"type":"prompt_answer","id":"p-test-1","allow":"yes"}')).toBe(true)
    expect(d.logs).toHaveLength(3)
  })

  it.each([
    ['an empty push title', 'push', { title: '  \n ' }],
    ['a push title over 256 characters', 'push', { title: 'x'.repeat(257) }],
    ['a push body over 60,000 characters', 'push', { title: 't', body: 'x'.repeat(60_001) }],
    ['a relative fence path', 'fence', { path: 'code/lib', access: 'read' }],
    ['a fence path over 1,024 bytes', 'fence', { path: `/${'é'.repeat(600)}`, access: 'read' }],
    ['a fence access other than read', 'fence', { path: '/a', access: 'exec' }],
    ['a fence write (fence grants are read-only)', 'fence', { path: '/a', access: 'write' }],
    ['a fence reason over 300 characters', 'fence', { path: '/a', access: 'read', reason: 'x'.repeat(301) }],
    ['an unknown kind', 'camera', { path: '/a' }],
  ])('never shows %s', async (_label, kind, detail) => {
    const d = fakeDesktop()
    expect(await d.broker.ask(kind as 'push', detail as never)).toEqual({ allowed: false, reason: 'invalid' })
    expect(d.lines).toEqual([])
  })

  it('strips control characters from a push title, as the desktop would', () => {
    expect(normalizePrompt('push', { title: 'Fix\u0007 the\nbug ' })).toEqual({ detail: { title: 'Fix thebug' } })
  })

  it('close: everything unanswered is unavailable, later asks too, and a late answer changes nothing', async () => {
    const d = fakeDesktop()
    const open = d.broker.ask('push', { title: 'a' })
    const queued = d.broker.ask('push', { title: 'b' })
    d.broker.close()
    expect(await open).toEqual({ allowed: false, reason: 'unavailable' })
    expect(await queued).toEqual({ allowed: false, reason: 'unavailable' })
    expect(await d.broker.ask('push', { title: 'c' })).toEqual({ allowed: false, reason: 'unavailable' })
    expect(d.answer('p-test-1', true)).toBe(true)
    expect(d.lines).toHaveLength(1)
  })

  it('makes ids the desktop accepts, unique per launch', () => {
    const lines: PromptLine[] = []
    const a = createPromptBroker({ write: (l) => lines.push(l), log: () => {} })
    const b = createPromptBroker({ write: (l) => lines.push(l), log: () => {} })
    void a.ask('push', { title: 'x' })
    void b.ask('push', { title: 'y' })
    expect(lines.every((l) => PROMPT_ID.test(l.id))).toBe(true)
    expect(lines[0].id).not.toBe(lines[1].id)
    a.close()
    b.close()
  })

  it('parses prompt_answer lines strictly', () => {
    expect(parsePromptAnswer('{"type":"prompt_answer","id":"p-1","allow":false}')).toEqual({ type: 'prompt_answer', id: 'p-1', allow: false })
    for (const bad of ['{"type":"prompt_answer","id":"","allow":true}', '{"type":"prompt_answer","id":"p-1"}', '{"type":"prompt","id":"p-1","allow":true}', '[]', 'x']) {
      expect(parsePromptAnswer(bad)).toBeNull()
    }
  })
})

// ── The eve server's half, over a real fd 3 ──────────────────────────────────

const PROMPTS_URL = pathToFileURL(fileURLToPath(new URL('../prompts.ts', import.meta.url))).href

/** A child Node playing the eve server: it runs `body` (with askPerson in scope) and prints each result as a JSON line. */
function fakeServer(body: string, env: Record<string, string> = { [PROMPT_FD_ENV]: '3' }): { child: ChildProcess; results: Promise<unknown[]> } {
  // The channel and its timers are unref'd (the eve server's own work keeps it alive): this stand-in keeps itself alive.
  const script = `import { askPerson } from ${JSON.stringify(PROMPTS_URL)}\nconst out = (v) => process.stdout.write(JSON.stringify(v) + '\\n')\nconst keep = setInterval(() => {}, 60000)\n${body}\nclearInterval(keep)`
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    // Cast: Next's global types make ProcessEnv require NODE_ENV (not set here).
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } as Record<string, string> as NodeJS.ProcessEnv,
    stdio: PROMPT_STDIO,
  })
  let text = ''
  child.stdout!.on('data', (c: Buffer) => (text += c.toString('utf8')))
  let err = ''
  child.stderr!.on('data', (c: Buffer) => (err += c.toString('utf8')))
  const results = new Promise<unknown[]>((resolve, reject) =>
    child.once('exit', (code) => (code === 0 ? resolve(text.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))) : reject(new Error(`server exited ${code}: ${err}`)))),
  )
  return { child, results }
}

async function until<T>(get: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = get()
    if (v !== undefined) return v
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

describe('the eve server asks over fd 3 and the launcher answers from the desktop', { timeout: 30_000 }, () => {
  it('a fence ask reaches the desktop as a prompt line, and its answer comes back to the tool', async () => {
    const lines: PromptLine[] = []
    const server = fakeServer(`
      out(await askPerson('fence', { path: '/Users/p/code/lib', access: 'read', reason: 'compare' }))
      out(await askPerson('push', { title: 'Fix it' }))
    `)
    const bridge = attachPromptBridge({ channel: server.child.stdio[3] as Duplex, write: (l) => lines.push(l), log: () => {} })
    const first = await until(() => lines[0])
    expect(first).toMatchObject({ type: 'prompt', kind: 'fence', detail: { path: '/Users/p/code/lib', access: 'read', reason: 'compare' } })
    expect(first.detail.timeoutMs).toBeGreaterThan(DEFAULT_PROMPT_TIMEOUT_MS - 5_000) // the tool's wait, passed through
    expect(bridge.handleLine(JSON.stringify({ type: 'prompt_answer', id: first.id, allow: true }))).toBe(true)
    const second = await until(() => lines[1])
    expect(second).toMatchObject({ type: 'prompt', kind: 'push', detail: { title: 'Fix it' } })
    bridge.handleLine(JSON.stringify({ type: 'prompt_answer', id: second.id, allow: false }))
    expect(await server.results).toEqual([
      { allowed: true, reason: 'allowed' },
      { allowed: false, reason: 'denied' },
    ])
    bridge.close()
  })

  it('the job ending answers a waiting tool with unavailable', async () => {
    const lines: PromptLine[] = []
    const server = fakeServer(`out(await askPerson('push', { title: 'x' }))`)
    const bridge = attachPromptBridge({ channel: server.child.stdio[3] as Duplex, write: (l) => lines.push(l), log: () => {} })
    await until(() => lines[0])
    bridge.close()
    expect(await server.results).toEqual([{ allowed: false, reason: 'unavailable' }])
  })

  it('without the prompt channel (not launched by the desktop) every ask is a no', async () => {
    const server = fakeServer(`out(await askPerson('push', { title: 'x' }))`, {})
    expect(await server.results).toEqual([{ allowed: false, reason: 'unavailable' }])
  })
})

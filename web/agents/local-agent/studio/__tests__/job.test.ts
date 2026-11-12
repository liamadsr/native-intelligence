/**
 * A Studio product job on the Mac (../job.ts) with a fake fence and a fake app: the runner is unpacked once per
 * archive, every command runs in the sandbox (never on the host), a capture's file goes to the app with what it is,
 * a refresh films again only what the code changed, and a failure is reported to the app and answered in a sentence.
 * And the app client (../app-client.ts): the session token as a Bearer on every call, the capture described in a
 * base64url header, and a launch with no way to the app refused in one sentence. A made-up product.
 */
import { describe, expect, it, vi } from 'vitest'
import { studioAppClient, macStudioApp } from '../app-client'
import { baseName, runnerAnswer, runStudioJob, shellWord, STUDIO_DIR, type JobApp, type JobSandbox, type MacJob } from '../job'

const JOB = '7f3c2a10-1111-4222-8333-999999999999'
const KIT = { slug: 'planner', title: 'Planner', framework: 'vite', alias: {}, css: null, tailwind: null, discover: ['src'], components: {} }
const LISTED = [
  { id: 'card', name: 'Card', file: 'src/Card.tsx', group: 'src', help: '', curated: false, width: 320, height: 240, status: 'ok', key: 'aaaa1111' },
  { id: 'form', name: 'Form', file: 'src/Form.tsx', group: 'src', help: '', curated: false, width: 400, height: 180, status: 'ok', key: 'bbbb2222' },
]

/** A fake fence: files in a map, commands answered by `answers` (by runner command), all recorded. */
function fakeSandbox(answers: Record<string, unknown | ((cmd: string) => unknown)>) {
  const files = new Map<string, Uint8Array | string>()
  const commands: string[] = []
  const sandbox: JobSandbox = {
    async run({ command }) {
      commands.push(command)
      if (command.includes('tar -xzf')) return { exitCode: 0, stdout: '', stderr: '' }
      const which = Object.keys(answers).find((k) => command.includes(`'${k}'`))
      const answer = which ? answers[which] : { ok: false, error: 'no answer' }
      const value = typeof answer === 'function' ? (answer as (c: string) => unknown)(command) : answer
      return { exitCode: (value as { ok?: boolean }).ok ? 0 : 1, stdout: JSON.stringify(value) + '\n', stderr: '' }
    },
    async writeBinaryFile({ path, content }) {
      files.set(path, content)
    },
    async writeTextFile({ path, content }) {
      files.set(path, content)
    },
    async readTextFile({ path }) {
      const v = files.get(path)
      return typeof v === 'string' ? v : null
    },
    async readBinaryFile({ path }) {
      return path.endsWith('.webm') || path.endsWith('.png') ? new Uint8Array([1, 2, 3]) : null
    },
  }
  return { sandbox, files, commands }
}

/** A fake app handing out one job and recording what comes back. */
function fakeApp(job: MacJob) {
  const reports: Record<string, unknown>[] = []
  const uploads: { meta: Record<string, unknown>; bytes: Uint8Array; type: string }[] = []
  const app: JobApp = {
    getJob: vi.fn(async () => job),
    report: vi.fn(async (body) => {
      reports.push(body)
      return { status: 'done' }
    }),
    upload: vi.fn(async (meta, bytes, type) => {
      uploads.push({ meta, bytes, type })
      return { assetId: 'f'.repeat(64) }
    }),
  }
  return { app, reports, uploads }
}

const archive = async () => new Uint8Array([9, 9, 9])
const shot = { ok: true, kind: 'video', file: '/tmp/x/out-capture/planner-card.webm', poster: '/tmp/x/out-capture/planner-card-poster.png', name: 'Planner · Card.webm', width: 384, height: 304, aspect: 1.2632, seconds: 6, key: 'cccc3333', commit: null }

describe('runStudioJob', () => {
  it('captures in the fence and sends the file with what it is', async () => {
    const { sandbox, files, commands } = fakeSandbox({ capture: shot })
    const { app, uploads, reports } = fakeApp({ job: { id: JOB, kind: 'capture', title: null, capture: { component: 'card', options: { seconds: 6, props: { plan: 'Team' } } }, refresh: null }, kit: KIT })
    const said = await runStudioJob(JOB, { sandbox, app, archive })
    expect(said).toMatch(/in the Studio library/)
    // Unpacked into the scratch dir, then one command for the capture, both through the fence.
    expect(commands[0]).toContain(`cd ${STUDIO_DIR} && rm -rf runner && tar -xzf studio.tgz`)
    expect(commands[1]).toBe(`NODE_PATH=/workspace/node_modules node '${STUDIO_DIR}/runner/runner.cjs' 'capture' '${STUDIO_DIR}/jobs/${JOB}/capture.json' '${STUDIO_DIR}/jobs/${JOB}/out-capture'`)
    expect(JSON.parse(String(files.get(`${STUDIO_DIR}/jobs/${JOB}/capture.json`)))).toEqual({ kit: KIT, component: 'card', options: { seconds: 6, props: { plan: 'Team' } } })
    expect(uploads).toHaveLength(1)
    expect(uploads[0]).toMatchObject({ type: 'video/webm', meta: { job: JOB, component: 'card', kind: 'video', name: 'Planner · Card.webm', width: 384, height: 304, aspect: 1.2632, seconds: 6, key: 'cccc3333', commit: null } })
    expect(uploads[0]!.meta.item).toBeUndefined()
    expect(reports).toEqual([])
  })

  it('unpacks the runner once per archive', async () => {
    const { sandbox, commands } = fakeSandbox({ capture: shot })
    const { app } = fakeApp({ job: { id: JOB, kind: 'capture', title: null, capture: { component: 'card', options: {} }, refresh: null }, kit: KIT })
    await runStudioJob(JOB, { sandbox, app, archive })
    await runStudioJob(JOB, { sandbox, app, archive })
    expect(commands.filter((c) => c.includes('tar -xzf'))).toHaveLength(1)
  })

  it('onboards: reads the folder, lists its components and reports both', async () => {
    const { sandbox } = fakeSandbox({ onboard: { ok: true, kit: KIT, notes: ['a note'], commit: 'd'.repeat(40) }, list: { ok: true, components: LISTED, commit: 'd'.repeat(40) } })
    const { app, reports } = fakeApp({ job: { id: JOB, kind: 'onboard', title: 'Planner', capture: null, refresh: null }, kit: null })
    expect(await runStudioJob(JOB, { sandbox, app, archive })).toMatch(/2 components listed, 2 render/)
    expect(reports).toEqual([{ job: JOB, ok: true, kit: KIT, notes: ['a note'], components: LISTED, commit: 'd'.repeat(40) }])
  })

  it('refreshes only what the code changed, and says what happened to each layer', async () => {
    const { sandbox, commands } = fakeSandbox({ list: { ok: true, components: LISTED, commit: null }, capture: shot })
    const items = [
      { component: 'card', options: { seconds: 6 }, key: 'aaaa1111' },
      { component: 'form', options: { seconds: 4 }, key: 'old0old0' },
      { component: 'gone', options: {}, key: 'eeee5555' },
    ]
    const { app, reports, uploads } = fakeApp({ job: { id: JOB, kind: 'refresh', title: null, capture: null, refresh: { items } }, kit: KIT })
    expect(await runStudioJob(JOB, { sandbox, app, archive })).toBe('1 of 3 component layers were made again from the current code; 1 were already current.')
    expect(commands.filter((c) => c.includes("'capture'"))).toHaveLength(1)
    expect(uploads.map((u) => [u.meta.component, u.meta.item])).toEqual([['form', 1]])
    expect(reports[0]).toMatchObject({ job: JOB, ok: true, items: [{ item: 0, outcome: 'current' }, { item: 1, outcome: 'captured' }, { item: 2, outcome: 'the product no longer has this component' }] })
  })

  it('reports a runner failure to the app and answers it', async () => {
    const { sandbox } = fakeSandbox({ capture: { ok: false, error: "Card can't render outside the product: no provider" } })
    const { app, reports, uploads } = fakeApp({ job: { id: JOB, kind: 'capture', title: null, capture: { component: 'card', options: {} }, refresh: null }, kit: KIT })
    expect(await runStudioJob(JOB, { sandbox, app, archive })).toMatch(/failed: Card can't render/)
    expect(reports).toEqual([{ job: JOB, ok: false, error: "Card can't render outside the product: no provider" }])
    expect(uploads).toEqual([])
  })

  it('refuses a job the app answers with another id: nothing is unpacked, run, reported or sent', async () => {
    const { sandbox, commands, files } = fakeSandbox({ capture: shot })
    const other = 'b0b0b0b0-1111-4222-8333-999999999999'
    for (const id of [other, '../../escape']) {
      const { app, reports, uploads } = fakeApp({ job: { id, kind: 'capture', title: null, capture: { component: 'card', options: {} }, refresh: null }, kit: KIT })
      expect(await runStudioJob(JOB, { sandbox, app, archive })).toMatch(/another job than the one asked for/)
      expect([reports, uploads]).toEqual([[], []])
    }
    expect(commands).toEqual([])
    expect(files.size).toBe(0)
  })

  it('refuses a job for a product with no settings', async () => {
    const { sandbox } = fakeSandbox({})
    const { app, reports } = fakeApp({ job: { id: JOB, kind: 'list', title: null, capture: null, refresh: null }, kit: null })
    expect(await runStudioJob(JOB, { sandbox, app, archive })).toMatch(/onboard it first/)
    expect(reports[0]).toMatchObject({ ok: false })
  })
})

describe('the small parts', () => {
  it('quotes words for bash and reads the runner answer', () => {
    expect(shellWord("it's")).toBe(`'it'\\''s'`)
    expect(runnerAnswer({ exitCode: 0, stdout: 'Building\n{"ok":true,"x":1}\n', stderr: '' })).toEqual({ ok: true, x: 1 })
    expect(runnerAnswer({ exitCode: 137, stdout: '', stderr: 'Killed\n' })).toEqual({ ok: false, error: 'The runner stopped: Killed' })
    expect(baseName('/a/b/c.webm')).toBe('c.webm')
  })
})

describe('the app client', () => {
  it('sends the session token on every call and describes the capture in a header', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    let token = 'la1.first'
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify({ ok: true, assetId: 'a'.repeat(64) }), { status: 200 })
    }) as unknown as typeof globalThis.fetch
    const client = studioAppClient({ origin: 'https://app.example', token: () => token, fetch })
    await client.getJob(JOB)
    token = 'la1.second'
    await client.upload({ job: JOB, component: 'card' }, new Uint8Array([1]), 'video/webm')
    expect(calls[0]!.url).toBe(`https://app.example/api/local-agent/agent/studio?job=${JOB}`)
    expect(calls[0]!.init.headers).toMatchObject({ authorization: 'Bearer la1.first' })
    expect(calls[1]!.url).toBe('https://app.example/api/local-agent/agent/studio/capture')
    const headers = calls[1]!.init.headers as Record<string, string>
    expect(headers).toMatchObject({ authorization: 'Bearer la1.second', 'content-type': 'video/webm' })
    expect(JSON.parse(Buffer.from(headers['x-studio-capture']!, 'base64url').toString())).toEqual({ job: JOB, component: 'card' })
    expect(calls.every((c) => c.init.redirect === 'error')).toBe(true)
  })

  it("passes the app's refusal on as a sentence", async () => {
    const fetch = (async () => new Response(JSON.stringify({ error: 'This Studio product job is for another folder' }), { status: 409 })) as unknown as typeof globalThis.fetch
    await expect(studioAppClient({ origin: 'https://app.example', token: () => 'la1.x', fetch }).getJob(JOB)).rejects.toThrow(/another folder/)
  })

  it('refuses a launch with no way to the app', () => {
    expect(macStudioApp({})).toMatch(/cannot reach the app/)
  })
})

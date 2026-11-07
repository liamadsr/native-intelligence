import { describe, it, expect, beforeEach, vi } from 'vitest'

/**
 * Bridge contract for local agents (L0 contract §4/§5). Only a debug desktop
 * with dev.json has the local_agent_* commands, so every wrapper must answer
 * `unavailable` (never reject) on any other build, and never touch Tauri in
 * the browser. Args are camelCase; payloads are validated.
 *
 * Hermetic: @tauri-apps/api is mocked directly.
 */

const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  desktop: true,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: tauri.invoke }))
vi.mock('@tauri-apps/api/event', () => ({ listen: tauri.listen }))
vi.mock('@/lib/platform', () => ({ isDesktopApp: () => tauri.desktop }))

const { tauriBridge, toLocalAgentEvent, toLocalAgentStatus, LOCAL_AGENT_OFF_DESKTOP } = await import(
  '../tauri-bridge'
)

const agent = tauriBridge.localAgent

const grant = {
  id: 'g1',
  path: '/Users/me/code/site',
  label: 'site',
  mode: 'read',
  addedAt: '2026-10-20T10:00:00Z',
  isGit: true,
}
const job = {
  id: 'j1',
  grantId: 'g1',
  request: 'list the files',
  mode: 'read',
  sessionId: 'sess_1',
  streamIndex: 4,
  status: 'waiting',
  live: true,
  lastSeq: 12,
  runId: 'run-1',
  createdAt: '2026-10-20T10:01:00Z',
}
/** What the parser adds to `job` (no branch / commit / endedAt). */
const jobOut = { ...job, branch: null, commit: null, endedAt: null }

beforeEach(() => {
  tauri.invoke.mockReset()
  tauri.listen.mockReset()
  tauri.desktop = true
})

describe('local agent bridge: commands', () => {
  it('sends camelCase args to each command', async () => {
    tauri.invoke.mockResolvedValue(null)
    await agent.pickFolder()
    await agent.removeGrant('g1')
    await agent.send('j1', 'look at auth too', 'steer')
    await agent.stop('j1')
    await agent.resume('j1')
    await agent.resume('j1', 'la1.tok.sig')
    await agent.setModelToken('j1', 'la1.new.sig')
    tauri.invoke.mockResolvedValueOnce({ jobId: 'j2' })
    await agent.start('g1', 'read README.md')
    tauri.invoke.mockResolvedValueOnce([])
    await agent.events('j1', 0)
    expect(tauri.invoke.mock.calls).toEqual([
      ['local_agent_pick_folder', undefined],
      ['local_agent_remove_grant', { grantId: 'g1' }],
      ['local_agent_send', { jobId: 'j1', text: 'look at auth too', policy: 'steer' }],
      ['local_agent_stop', { jobId: 'j1' }],
      ['local_agent_resume', { jobId: 'j1' }],
      ['local_agent_resume', { jobId: 'j1', modelToken: 'la1.tok.sig' }],
      ['local_agent_set_model_token', { jobId: 'j1', modelToken: 'la1.new.sig' }],
      ['local_agent_start', { grantId: 'g1', request: 'read README.md' }],
      ['local_agent_events', { jobId: 'j1', sinceSeq: 0 }],
    ])
  })

  it('start takes the L1 args object; empty optionals are left out', async () => {
    const jobId = '7d3c2a10-1111-4222-8333-444455556666'
    tauri.invoke.mockResolvedValueOnce({ jobId, runId: 'run-9' })
    expect(
      await agent.start({
        grantId: 'g1',
        request: 'fix the typo',
        jobId,
        mode: 'edit',
        modelToken: 'la1.body.sig',
        resume: { eveSessionId: 'ses_1', streamIndex: 7 },
      }),
    ).toEqual({ ok: true, value: { jobId, runId: 'run-9' } })
    tauri.invoke.mockResolvedValueOnce({ jobId, runId: 'run-9' })
    await agent.start({ grantId: 'g1', request: 'look', jobId, modelToken: null, resume: null })
    expect(tauri.invoke.mock.calls).toEqual([
      [
        'local_agent_start',
        {
          grantId: 'g1',
          request: 'fix the typo',
          jobId,
          mode: 'edit',
          modelToken: 'la1.body.sig',
          resume: { eveSessionId: 'ses_1', streamIndex: 7 },
        },
      ],
      ['local_agent_start', { grantId: 'g1', request: 'look', jobId }],
    ])
  })

  it('start passes an edit job’s base branch as baseBranch (environments E3), only when there is one', async () => {
    const jobId = '7d3c2a10-1111-4222-8333-444455556666'
    tauri.invoke.mockResolvedValue({ jobId, runId: 'run-9' })
    await agent.start({ grantId: 'g1', request: 'fix it', jobId, mode: 'edit', baseBranch: 'develop' })
    await agent.start({ grantId: 'g1', request: 'fix it', jobId, mode: 'edit', baseBranch: null })
    await agent.start({ grantId: 'g1', request: 'fix it', jobId, mode: 'edit', baseBranch: '' })
    expect(tauri.invoke.mock.calls.map((c) => c[1])).toEqual([
      { grantId: 'g1', request: 'fix it', jobId, mode: 'edit', baseBranch: 'develop' },
      { grantId: 'g1', request: 'fix it', jobId, mode: 'edit' },
      { grantId: 'g1', request: 'fix it', jobId, mode: 'edit' },
    ])
    tauri.invoke.mockReset()
  })

  it('device → typed; a release build’s refusal reads as unavailable', async () => {
    tauri.invoke.mockResolvedValueOnce({
      deviceId: '0b5e2d6c-aaaa-4bbb-8ccc-dddddddddddd',
      name: 'Liam’s MacBook Pro',
      platform: 'macos',
      appVersion: '0.2.90',
    })
    expect(await agent.device()).toEqual({
      ok: true,
      value: {
        deviceId: '0b5e2d6c-aaaa-4bbb-8ccc-dddddddddddd',
        name: 'Liam’s MacBook Pro',
        platform: 'macos',
        appVersion: '0.2.90',
      },
    })
    expect(tauri.invoke).toHaveBeenLastCalledWith('local_agent_device', undefined)
    tauri.invoke.mockRejectedValueOnce('unavailable in this build')
    expect(await agent.device()).toEqual({ ok: false, unavailable: true, error: 'unavailable in this build' })
    tauri.invoke.mockResolvedValueOnce({ name: 'no id' })
    expect(await agent.device()).toMatchObject({ ok: false, unavailable: false })
  })

  it('resume answers the new run; an L0 desktop’s null reads as runId null', async () => {
    tauri.invoke.mockResolvedValueOnce({ jobId: 'j1', runId: 'run-2' })
    expect(await agent.resume('j1')).toEqual({ ok: true, value: { jobId: 'j1', runId: 'run-2' } })
    tauri.invoke.mockResolvedValueOnce(null)
    expect(await agent.resume('j1')).toEqual({ ok: true, value: { jobId: 'j1', runId: null } })
    tauri.invoke.mockResolvedValueOnce(null)
    expect(await agent.setModelToken('j1', 't')).toEqual({ ok: true, value: undefined })
  })

  it('status → typed, dropping malformed and duplicate grants and jobs', async () => {
    tauri.invoke.mockResolvedValueOnce({
      available: true,
      node: '/opt/homebrew/bin/node',
      agentDir: '/abs/agents/local-agent',
      built: true,
      grants: [grant, { id: 'g2' }, grant, null, { ...grant, id: 'g4', mode: 'edit', isGit: 'yes' }],
      jobs: [
        job,
        { id: 'j9', status: 'exploded' },
        // A failed job whose launcher still runs; bad live / lastSeq read as false / null.
        { ...job, id: 'j3', status: 'failed', sessionId: '', createdAt: 1_760_954_400 },
        { ...job, id: 'j4', live: 'yes', lastSeq: -1 },
        { ...job, id: 'j5', live: undefined, lastSeq: 2.5 },
      ],
    })
    const status = await agent.status()
    expect(tauri.invoke).toHaveBeenCalledWith('local_agent_status', undefined)
    expect(status).toEqual({
      available: true,
      reason: null,
      node: '/opt/homebrew/bin/node',
      agentDir: '/abs/agents/local-agent',
      built: true,
      grants: [{ ...grant, mode: 'read' }, { ...grant, id: 'g4', mode: 'edit', isGit: false }],
      jobs: [
        jobOut,
        {
          ...jobOut,
          id: 'j3',
          status: 'failed',
          sessionId: null,
          createdAt: new Date(1_760_954_400_000).toISOString(),
        },
        { ...jobOut, id: 'j4', live: false, lastSeq: null },
        { ...jobOut, id: 'j5', live: false, lastSeq: null },
      ],
    })
  })

  it('status passes the desktop’s own available:false and reason', async () => {
    tauri.invoke.mockResolvedValueOnce({ available: false, reason: 'no dev.json', built: false, grants: [], jobs: [] })
    expect(await agent.status()).toMatchObject({ available: false, reason: 'no dev.json', built: false })
  })

  it('status never rejects: missing command, a refusal, junk', async () => {
    tauri.invoke.mockRejectedValueOnce('Command local_agent_status not found')
    expect(await agent.status()).toMatchObject({
      available: false,
      reason: 'Command local_agent_status not found',
      grants: [],
      jobs: [],
    })
    tauri.invoke.mockRejectedValueOnce(new Error('state.json unreadable'))
    expect(await agent.status()).toMatchObject({ available: false, reason: 'state.json unreadable' })
    tauri.invoke.mockResolvedValueOnce({ nope: true })
    expect(await agent.status()).toMatchObject({ available: false, reason: 'local_agent_status: malformed answer' })
  })

  it('a missing command reads as unavailable, not a throw', async () => {
    tauri.invoke.mockRejectedValueOnce('Command local_agent_start not found')
    expect(await agent.start('g1', 'hi')).toEqual({
      ok: false,
      unavailable: true,
      error: 'Command local_agent_start not found',
    })
    tauri.invoke.mockRejectedValueOnce(new Error('local_agent_send not allowed. Permissions associated with this command: []'))
    expect(await agent.send('j1', 'x', 'queue')).toMatchObject({ ok: false, unavailable: true })
  })

  it('a command answering available:false (no dev.json) reads as unavailable', async () => {
    tauri.invoke.mockResolvedValueOnce({ available: false, reason: 'release build' })
    expect(await agent.pickFolder()).toEqual({ ok: false, unavailable: true, error: 'release build' })
  })

  it('a refusal is an error result with the desktop’s text', async () => {
    tauri.invoke.mockRejectedValueOnce('at most 3 running jobs')
    expect(await agent.start('g1', 'hi')).toEqual({ ok: false, unavailable: false, error: 'at most 3 running jobs' })
  })

  it('start needs a jobId; pickFolder is a grant or null', async () => {
    tauri.invoke.mockResolvedValueOnce({ jobId: 'j2' })
    expect(await agent.start('g1', 'hi')).toEqual({ ok: true, value: { jobId: 'j2', runId: null } })
    tauri.invoke.mockResolvedValueOnce({ id: 'j2' })
    expect(await agent.start('g1', 'hi')).toMatchObject({ ok: false, unavailable: false })
    tauri.invoke.mockResolvedValueOnce(null)
    expect(await agent.start('g1', 'hi')).toMatchObject({ ok: false, unavailable: false })

    tauri.invoke.mockResolvedValueOnce(null)
    expect(await agent.pickFolder()).toEqual({ ok: true, value: null })
    tauri.invoke.mockResolvedValueOnce({ id: 'g3', path: '/Users/me/notes' })
    expect(await agent.pickFolder()).toEqual({
      ok: true,
      value: { id: 'g3', path: '/Users/me/notes', label: 'notes', mode: 'read', addedAt: '', isGit: false },
    })
    tauri.invoke.mockResolvedValueOnce({ path: '/Users/me/notes' })
    expect(await agent.pickFolder()).toMatchObject({ ok: false, unavailable: false })
  })

  it('events: rows get the jobId and keep runId, bad rows drop, seq order', async () => {
    tauri.invoke.mockResolvedValueOnce([
      { seq: 3, runId: 'run-1', event: { kind: 'text', delta: 'lo' } },
      { seq: 2, runId: 'run-1', event: { kind: 'text', delta: 'hel' } },
      { seq: 4, runId: 'run-1', event: { kind: 'text', delta: 9 } },
      { seq: -1, event: { kind: 'text', delta: 'x' } },
      { seq: 1.5, event: { kind: 'text', delta: 'x' } },
      { event: { kind: 'text', delta: 'x' } },
      { seq: 5, runId: '', event: { kind: 'text', delta: '!' } },
      null,
    ])
    expect(await agent.events('j1', 0)).toEqual({
      ok: true,
      value: [
        { jobId: 'j1', seq: 2, runId: 'run-1', event: { kind: 'text', delta: 'hel' } },
        { jobId: 'j1', seq: 3, runId: 'run-1', event: { kind: 'text', delta: 'lo' } },
        { jobId: 'j1', seq: 5, event: { kind: 'text', delta: '!' } },
      ],
    })
    tauri.invoke.mockResolvedValueOnce({ events: [] })
    expect(await agent.events('j1', 0)).toMatchObject({ ok: false, unavailable: false })
  })

  it('never touches Tauri in the browser', async () => {
    tauri.desktop = false
    expect(await agent.status()).toMatchObject({ available: false, reason: LOCAL_AGENT_OFF_DESKTOP })
    const off = { ok: false, unavailable: true, error: LOCAL_AGENT_OFF_DESKTOP }
    expect(await agent.pickFolder()).toEqual(off)
    expect(await agent.removeGrant('g1')).toEqual(off)
    expect(await agent.start('g1', 'hi')).toEqual(off)
    expect(await agent.send('j1', 'hi', 'steer')).toEqual(off)
    expect(await agent.stop('j1')).toEqual(off)
    expect(await agent.resume('j1')).toEqual(off)
    expect(await agent.events('j1', 0)).toEqual(off)
    expect(await agent.device()).toEqual(off)
    expect(await agent.setModelToken('j1', 't')).toEqual(off)
    expect(await agent.start({ grantId: 'g1', request: 'hi', jobId: 'j1' })).toEqual(off)
    agent.onEvent(() => {})()
    expect(tauri.invoke).not.toHaveBeenCalled()
    expect(tauri.listen).not.toHaveBeenCalled()
  })
})

describe('local agent bridge: events', () => {
  it('toLocalAgentEvent keeps each known kind and drops wrong fields', () => {
    expect(toLocalAgentEvent({ kind: 'status', status: 'running' })).toEqual({ kind: 'status', status: 'running' })
    expect(toLocalAgentEvent({ kind: 'status', status: 'interrupted', reason: 'exit 1' })).toEqual({
      kind: 'status',
      status: 'interrupted',
      reason: 'exit 1',
    })
    expect(toLocalAgentEvent({ kind: 'status', status: 'paused' })).toBeNull()
    expect(toLocalAgentEvent({ kind: 'message', text: 'Done.' })).toEqual({ kind: 'message', text: 'Done.' })
    expect(toLocalAgentEvent({ kind: 'tool', callId: 'c1', name: 'bash', input: '{"command":"ls"}' })).toEqual({
      kind: 'tool',
      callId: 'c1',
      name: 'bash',
      input: '{"command":"ls"}',
    })
    // A non-string input/output becomes JSON text.
    expect(toLocalAgentEvent({ kind: 'tool', callId: 'c1', name: 'bash', input: { command: 'ls' } })).toMatchObject({
      input: '{"command":"ls"}',
    })
    expect(
      toLocalAgentEvent({ kind: 'tool_result', callId: 'c1', name: 'bash', ok: false, output: 'Operation not permitted' }),
    ).toEqual({ kind: 'tool_result', callId: 'c1', name: 'bash', ok: false, output: 'Operation not permitted' })
    expect(toLocalAgentEvent({ kind: 'tool_result', callId: 'c1', name: 'bash', output: 'x' })).toBeNull()
    expect(toLocalAgentEvent({ kind: 'tool', name: 'bash' })).toBeNull()
    expect(toLocalAgentEvent({ kind: 'report', text: 'Read 3 files' })).toEqual({ kind: 'report', text: 'Read 3 files' })
    expect(toLocalAgentEvent({ kind: 'ask', question: 'Which branch?' })).toEqual({ kind: 'ask', question: 'Which branch?' })
    expect(toLocalAgentEvent({ kind: 'finish', summary: 'All done' })).toEqual({ kind: 'finish', summary: 'All done' })
    expect(toLocalAgentEvent({ kind: 'error', message: 'model 401' })).toEqual({ kind: 'error', message: 'model 401' })
    expect(toLocalAgentEvent({ kind: 'text', delta: 3 })).toBeNull()
    expect(toLocalAgentEvent('text')).toBeNull()
    expect(toLocalAgentEvent({ kind: 7 })).toBeNull()
    expect(toLocalAgentEvent({ delta: 'x' })).toBeNull()
  })

  it('branch (the desktop’s own, after an edit job’s commit) is typed', () => {
    const raw = {
      kind: 'branch',
      branch: 'dial8/site-7d3c2a10',
      commit: 'abc1234',
      filesChanged: 3,
      insertions: 40,
      deletions: 2,
    }
    expect(toLocalAgentEvent(raw)).toEqual(raw)
    expect(toLocalAgentEvent({ ...raw, filesChanged: -1, insertions: '4' })).toEqual({
      ...raw,
      filesChanged: 0,
      insertions: 0,
    })
    expect(toLocalAgentEvent({ ...raw, branch: '' })).toBeNull()
    expect(toLocalAgentEvent({ ...raw, commit: undefined })).toBeNull()
  })

  it('an unknown kind passes through as other, keeping the event as sent', () => {
    const raw = { kind: 'plan', steps: ['read', 'write'] }
    const event = toLocalAgentEvent(raw)
    expect(event).toEqual({ kind: 'other', name: 'plan', raw })
    // A copy: the desktop's object is never shared.
    expect(event && event.kind === 'other' && event.raw).not.toBe(raw)
  })

  it('toLocalAgentStatus rejects a non-status', () => {
    expect(toLocalAgentStatus(null)).toBeNull()
    expect(toLocalAgentStatus({ grants: [] })).toBeNull()
  })

  it('toLocalAgentStatus reads the Mac’s model when the desktop says, and nothing when it doesn’t', () => {
    const base = { available: true, grants: [], jobs: [] }
    expect(toLocalAgentStatus({ ...base, localModel: true })?.localModel).toBe(true)
    expect(toLocalAgentStatus({ ...base, localModel: false })?.localModel).toBe(false)
    expect(toLocalAgentStatus({ ...base, model: { kind: 'local', server: 'ollama', model: 'llama3.1:8b' } })?.localModel).toBe(true)
    expect(toLocalAgentStatus({ ...base, model: { kind: 'relay' } })?.localModel).toBe(false)
    expect(toLocalAgentStatus({ ...base, localModel: 'yes' })).not.toHaveProperty('localModel')
    expect(toLocalAgentStatus(base)).not.toHaveProperty('localModel')
  })

  it('toLocalAgentStatus reads `baseBranch: true` (the desktop resolves an edit job’s base, E3), and nothing else as it', () => {
    const base = { available: true, grants: [], jobs: [] }
    expect(toLocalAgentStatus({ ...base, baseBranch: true })?.baseBranch).toBe(true)
    for (const v of [false, 'true', 1, undefined]) expect(toLocalAgentStatus({ ...base, baseBranch: v }), String(v)).not.toHaveProperty('baseBranch')
  })

  it('onEvent listens on local-agent://event, passes valid envelopes, and unsubscribes', async () => {
    let handler: ((e: { payload: unknown }) => void) | null = null
    const unlisten = vi.fn()
    tauri.listen.mockImplementation(async (event: string, cb: (e: { payload: unknown }) => void) => {
      expect(event).toBe('local-agent://event')
      handler = cb
      return unlisten
    })
    const got: unknown[] = []
    const off = agent.onEvent((e) => got.push(e))
    await vi.waitFor(() => expect(handler).not.toBeNull())
    handler!({ payload: { jobId: 'j1', seq: 1, runId: 'run-1', event: { kind: 'status', status: 'running' } } })
    handler!({ payload: { jobId: 'j1', seq: 2, runId: 'run-1', event: { kind: 'text', delta: 'Hi' } } })
    handler!({ payload: { jobId: 'j1', seq: 3, runId: 'run-1', event: { kind: 'bogus' } } })
    handler!({ payload: { jobId: 'j1', seq: 4, event: { kind: 'tool', name: 'bash' } } })
    handler!({ payload: { seq: 5, event: { kind: 'text', delta: 'x' } } })
    handler!({ payload: { jobId: 'j1', seq: '6', event: { kind: 'text', delta: 'x' } } })
    handler!({ payload: null })
    expect(got).toEqual([
      { jobId: 'j1', seq: 1, runId: 'run-1', event: { kind: 'status', status: 'running' } },
      { jobId: 'j1', seq: 2, runId: 'run-1', event: { kind: 'text', delta: 'Hi' } },
      { jobId: 'j1', seq: 3, runId: 'run-1', event: { kind: 'other', name: 'bogus', raw: { kind: 'bogus' } } },
    ])
    off()
    expect(unlisten).toHaveBeenCalledTimes(1)
    handler!({ payload: { jobId: 'j1', seq: 7, event: { kind: 'text', delta: 'late' } } })
    expect(got).toHaveLength(3)
  })

  it('onEvent tolerates a build without the event', async () => {
    tauri.listen.mockRejectedValue(new Error('no event'))
    const off = agent.onEvent(() => {})
    await vi.waitFor(() => expect(tauri.listen).toHaveBeenCalled())
    expect(() => off()).not.toThrow()
  })
})

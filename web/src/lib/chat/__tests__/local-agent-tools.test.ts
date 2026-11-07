/**
 * The Dial8 agent's local-agent tools (src/lib/chat/local-agent-tools.ts,
 * contract F3) over a faked library (src/lib/local-agent/store.ts and
 * transcript.ts, contract B):
 *   - start_local_agent: typed turns only, keyed on eve's ids (migration 332's
 *     scheme), mode read by default, author 'agent', the kill switch, a
 *     retried call reused, refusals the model reads;
 *   - message_local_agent: a home turn only answers an open question;
 *   - local_agents: no folder paths reach the model;
 *   - read_local_agent: inbound messages by author, the newest that fit;
 *   - stop_local_agent: stopping vs stopped.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const lib = vi.hoisted(() => ({
  listDevices: vi.fn(),
  listFolders: vi.fn(),
  listSessions: vi.fn(),
  createSession: vi.fn(),
  getSession: vi.fn(),
  addMessage: vi.fn(),
  requestStop: vi.fn(),
  readTranscript: vi.fn(),
  paused: vi.fn(async () => false),
}))
vi.mock('@/lib/local-agent/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/local-agent/store')>()
  return {
    ...actual,
    LocalAgentError: actual.LocalAgentError,
    listDevices: lib.listDevices,
    listFolders: lib.listFolders,
    listSessions: lib.listSessions,
    createSession: lib.createSession,
    getSession: lib.getSession,
    addMessage: lib.addMessage,
    requestStop: lib.requestStop,
  }
})
vi.mock('@/lib/local-agent/transcript', () => ({ readTranscript: lib.readTranscript }))
vi.mock('@/lib/work/agent-paused', () => ({
  AGENT_PAUSED_CODE: 'AGENT_PAUSED',
  AGENT_PAUSED_REASON: 'Agent work is switched off for this workspace (autonomy off)',
  helperStartPaused: lib.paused,
}))

import {
  LOCAL_AGENT_DATA_NOTE,
  READ_BUDGET_CHARS,
  listLocalAgents,
  localAgentIdempotencyKey,
  localAgentMessageKey,
  messageLocalAgent,
  readLocalAgent,
  sessionView,
  startLocalAgent,
  stopLocalAgent,
} from '../local-agent-tools'
import { LocalAgentError, type FolderRow, type SessionRow } from '@/lib/local-agent/store'
import type { ChatRunTokenClaims } from '../chat-run-token'

const svc = { marker: 'svc' } as never
const CONV = '6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7'
const FOLDER_ID = 'fd1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7'
const SESSION_ID = '5e1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7'
const claims = (over: Partial<ChatRunTokenClaims> = {}): ChatRunTokenClaims => ({ conversationId: CONV, workspaceId: 'ws-1', userId: 'user-1', exp: Date.now() + 60_000, ...over })
const launch = { callId: 'call-1', turnId: 'turn-1', sessionId: 'wrun_s1' }

const folder = (over: Partial<FolderRow> = {}): FolderRow => ({
  id: FOLDER_ID,
  deviceId: 'dev-1',
  grantId: 'g-1',
  label: 'dial8-website',
  path: '/Users/liam/code/dial8-website',
  mode: 'edit',
  isGit: true,
  deviceName: "Liam's MacBook Pro",
  online: true,
  ...over,
})

const session = (over: Partial<SessionRow> = {}): SessionRow => ({
  id: SESSION_ID,
  folderId: FOLDER_ID,
  folderLabel: 'dial8-website',
  deviceId: 'dev-1',
  deviceName: "Liam's MacBook Pro",
  conversationId: CONV,
  mode: 'read',
  request: 'Take a look at this repository',
  status: 'queued',
  lastSignal: null,
  lastSignalText: null,
  branch: null,
  commitSha: null,
  error: null,
  trackedJobId: 'tj-1',
  createdAt: '2026-10-20T22:00:00Z',
  updatedAt: '2026-10-20T22:00:00Z',
  endedAt: null,
  lastDeviceSeq: null,
  // Started from the person's typed turn (store.ts isAttendedSession).
  attended: true,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  // No queued answer leaks from one test into the next.
  lib.getSession.mockReset()
  lib.paused.mockResolvedValue(false)
  lib.createSession.mockResolvedValue({ session: session(), created: true, deviceOnline: true })
})

describe('start_local_agent', () => {
  it('keys the start on eve’s ids, the scheme migration 332 keys start_chat_helper by', () => {
    expect(localAgentIdempotencyKey(CONV, launch)).toBe(`local-agent:${CONV}:session:wrun_s1:turn:turn-1:call:call-1`)
  })

  it('creates the session for the token’s person, workspace and conversation, as the agent, read by default', async () => {
    const out = await startLocalAgent(svc, claims(), launch, { folder_id: FOLDER_ID, request: 'Take a look at this repository' })
    expect(lib.createSession).toHaveBeenCalledWith(svc, {
      userId: 'user-1',
      workspaceId: 'ws-1',
      folderId: FOLDER_ID,
      conversationId: CONV,
      request: 'Take a look at this repository',
      mode: 'read',
      startedBy: 'agent',
      idempotencyKey: `local-agent:${CONV}:session:wrun_s1:turn:turn-1:call:call-1`,
    })
    expect(out).toMatchObject({ status: 'queued', session_id: SESSION_ID, device_online: true, mode: 'read', work_item_id: 'tj-1' })
    expect(out).not.toHaveProperty('reused')
    expect(String(out.note)).toContain('reports back in this chat')
  })

  it('passes edit on, says a retried call reused its session, and says an offline Mac holds it', async () => {
    lib.createSession.mockResolvedValueOnce({ session: session({ mode: 'edit' }), created: false, deviceOnline: false })
    const out = await startLocalAgent(svc, claims(), launch, { folder_id: FOLDER_ID, request: 'Fix the typo', mode: 'edit' })
    expect(lib.createSession.mock.calls[0][1]).toMatchObject({ mode: 'edit' })
    expect(out).toMatchObject({ reused: true, device_online: false })
    expect(String(out.note)).toContain('offline')
  })

  it('never from a server, teammate, relayed or device turn: nothing is written', async () => {
    for (const over of [{ server: 'home_turn' }, { server: 'idle_compaction' }, { teammateId: 'tm' }, { relay: 'relay-1' }, { surface: 'device_ask' }] as Array<Partial<ChatRunTokenClaims>>) {
      const out = await startLocalAgent(svc, claims(over), launch, { folder_id: FOLDER_ID, request: 'x' })
      expect([JSON.stringify(over), out.code]).toEqual([JSON.stringify(over), 'TYPED_TURNS_ONLY'])
    }
    expect(lib.createSession).not.toHaveBeenCalled()
  })

  it('needs eve’s ids (no colon in a key part)', async () => {
    await expect(startLocalAgent(svc, claims(), { ...launch, turnId: 'a:b' }, { folder_id: FOLDER_ID, request: 'x' })).rejects.toThrow(/turn id/)
    await expect(startLocalAgent(svc, claims(), { ...launch, callId: '' }, { folder_id: FOLDER_ID, request: 'x' })).rejects.toThrow(/call id/)
  })

  it('autonomy off starts nothing', async () => {
    lib.paused.mockResolvedValueOnce(true)
    const out = await startLocalAgent(svc, claims(), launch, { folder_id: FOLDER_ID, request: 'x' })
    expect(out).toMatchObject({ status: 'refused', code: 'AGENT_PAUSED' })
    expect(lib.createSession).not.toHaveBeenCalled()
  })

  it('the library’s refusals come back as outputs the model reads; anything else throws', async () => {
    lib.createSession.mockRejectedValueOnce(new LocalAgentError('forbidden', "This folder is read-only on Liam's MacBook Pro; edits must be allowed on the Mac"))
    expect(await startLocalAgent(svc, claims(), launch, { folder_id: FOLDER_ID, request: 'x', mode: 'edit' })).toMatchObject({ status: 'refused', code: 'FORBIDDEN' })
    lib.createSession.mockRejectedValueOnce(new LocalAgentError('not_found', 'Folder not found'))
    const missing = await startLocalAgent(svc, claims(), launch, { folder_id: FOLDER_ID, request: 'x' })
    expect(missing).toMatchObject({ status: 'refused', code: 'NOT_FOUND' })
    expect(String(missing.reason)).toContain('local_agents')
    lib.createSession.mockRejectedValueOnce(new Error('insert failed'))
    await expect(startLocalAgent(svc, claims(), launch, { folder_id: FOLDER_ID, request: 'x' })).rejects.toThrow('insert failed')
  })
})

describe('message_local_agent', () => {
  beforeEach(() => {
    lib.addMessage.mockResolvedValue({ messageId: 'm-1', requeued: false })
  })

  it('a typed turn sends as the agent, steer by default', async () => {
    lib.getSession.mockResolvedValueOnce(session({ status: 'running' }))
    const out = await messageLocalAgent(svc, claims(), launch, { session_id: SESSION_ID, text: 'Stick to src/' })
    expect(lib.addMessage).toHaveBeenCalledWith(svc, {
      userId: 'user-1',
      sessionId: SESSION_ID,
      author: 'agent',
      text: 'Stick to src/',
      policy: 'steer',
      idempotencyKey: `local-agent-msg:${CONV}:session:wrun_s1:turn:turn-1:call:call-1`,
    })
    expect(out).toMatchObject({ status: 'sent', message_id: 'm-1' })
  })

  it('is keyed on eve’s ids, so a retried call sends once and answers as the first did', async () => {
    expect(localAgentMessageKey(CONV, launch)).toBe(`local-agent-msg:${CONV}:session:wrun_s1:turn:turn-1:call:call-1`)
    lib.getSession.mockResolvedValue(session({ status: 'running' }))
    const first = await messageLocalAgent(svc, claims(), launch, { session_id: SESSION_ID, text: 'Stick to src/' })
    lib.addMessage.mockResolvedValueOnce({ messageId: 'm-1', requeued: false, duplicate: true })
    const retry = await messageLocalAgent(svc, claims(), launch, { session_id: SESSION_ID, text: 'Stick to src/' })
    expect(retry).toEqual(first)
    expect(lib.addMessage.mock.calls.map((c) => (c[1] as { idempotencyKey: string }).idempotencyKey)).toEqual([
      localAgentMessageKey(CONV, launch),
      localAgentMessageKey(CONV, launch),
    ])
    // A duplicate answers as a delivery of the first message, whatever the session does now.
    lib.addMessage.mockResolvedValueOnce({ messageId: 'm-9', requeued: false, duplicate: true })
    expect(await messageLocalAgent(svc, claims(), launch, { session_id: SESSION_ID, text: 'x' })).toEqual({
      status: 'sent',
      session_id: SESSION_ID,
      message_id: 'm-9',
      note: first.note,
    })
  })

  it('needs eve’s ids (no colon in a key part)', async () => {
    await expect(messageLocalAgent(svc, claims(), { ...launch, sessionId: 'a:b' }, { session_id: SESSION_ID, text: 'x' })).rejects.toThrow(/session id/)
    expect(lib.getSession).not.toHaveBeenCalled()
    expect(lib.addMessage).not.toHaveBeenCalled()
  })

  it('a home turn answers an open question, and nothing else (decision 6)', async () => {
    lib.getSession.mockResolvedValueOnce(session({ status: 'waiting', lastSignal: 'finish' }))
    const refusedOut = await messageLocalAgent(svc, claims({ server: 'home_turn' }), launch, { session_id: SESSION_ID, text: 'Now do the next thing' })
    expect(refusedOut).toMatchObject({ status: 'refused', code: 'NOT_ASKING' })
    expect(lib.addMessage).not.toHaveBeenCalled()

    lib.getSession.mockResolvedValueOnce(session({ status: 'waiting', lastSignal: 'ask', lastSignalText: 'Which branch?' }))
    const sent = await messageLocalAgent(svc, claims({ server: 'home_turn' }), launch, { session_id: SESSION_ID, text: 'main', policy: 'queue' })
    expect(sent).toMatchObject({ status: 'sent' })
    expect(lib.addMessage).toHaveBeenCalledWith(svc, expect.objectContaining({ author: 'agent', policy: 'queue' }))
  })

  it('idle compaction, a teammate or the device never message one', async () => {
    for (const over of [{ server: 'idle_compaction' }, { teammateId: 'tm' }, { surface: 'device_ask' }] as Array<Partial<ChatRunTokenClaims>>) {
      expect(await messageLocalAgent(svc, claims(over), launch, { session_id: SESSION_ID, text: 'x' })).toMatchObject({ code: 'MAIN_CHAT_ONLY' })
    }
    expect(lib.getSession).not.toHaveBeenCalled()
  })

  it('an unknown session, an ended one, and a requeued interrupted one', async () => {
    lib.getSession.mockResolvedValueOnce(null)
    expect(await messageLocalAgent(svc, claims(), launch, { session_id: SESSION_ID, text: 'x' })).toMatchObject({ code: 'NOT_FOUND' })
    lib.getSession.mockResolvedValueOnce(session({ status: 'cancelled' }))
    lib.addMessage.mockRejectedValueOnce(new LocalAgentError('conflict', 'This local agent has been stopped; start a new one'))
    expect(await messageLocalAgent(svc, claims(), launch, { session_id: SESSION_ID, text: 'x' })).toMatchObject({ code: 'ENDED' })
    lib.getSession.mockResolvedValueOnce(session({ status: 'interrupted' }))
    lib.addMessage.mockResolvedValueOnce({ messageId: 'm-2', requeued: true })
    const out = await messageLocalAgent(svc, claims(), launch, { session_id: SESSION_ID, text: 'carry on' })
    expect(out).toMatchObject({ status: 'sent', requeued: true })
    expect(String(out.note)).toContain('reconnects')
  })
})

describe('local_agents', () => {
  it('devices, the person’s whole environment, and this chat’s sessions (live first), with no folder path', async () => {
    const other = folder({ id: 'other', label: 'notes', mode: 'read', isGit: false })
    lib.listDevices.mockResolvedValueOnce([{ id: 'dev-1', name: "Liam's MacBook Pro", platform: 'macos', appVersion: '0.3.0', lastSeenAt: '2026-10-20T22:00:00Z', online: true }])
    lib.listFolders.mockResolvedValueOnce([folder(), other])
    lib.listSessions.mockResolvedValueOnce([session({ id: 'old', status: 'cancelled' }), session({ status: 'running', lastSignal: 'ask', lastSignalText: 'Which branch?' })])
    const out = await listLocalAgents(svc, claims())
    expect(lib.listFolders).toHaveBeenCalledTimes(1)
    expect(lib.listFolders).toHaveBeenCalledWith(svc, 'user-1')
    expect(lib.listSessions).toHaveBeenCalledWith(svc, 'user-1', { conversationId: CONV })
    expect(out.devices).toEqual([{ device_id: 'dev-1', name: "Liam's MacBook Pro", online: true, last_seen: '2026-10-20T22:00:00Z' }])
    expect(out.folders).toEqual([
      { folder_id: FOLDER_ID, label: 'dial8-website', device: "Liam's MacBook Pro", online: true, edits_allowed: true, git: true },
      { folder_id: 'other', label: 'notes', device: "Liam's MacBook Pro", online: true, edits_allowed: false, git: false },
    ])
    expect(out).not.toHaveProperty('this_chat_folders')
    expect((out.sessions as Array<{ session_id: string; last_signal: unknown }>).map((s) => [s.session_id, s.last_signal])).toEqual([[SESSION_ID, 'ask'], ['old', null]])
    expect(JSON.stringify(out)).not.toContain('/Users/')
    expect(out.note).toBe(LOCAL_AGENT_DATA_NOTE)
  })

  it('says how to set one up when no Mac or folder is there', async () => {
    lib.listDevices.mockResolvedValueOnce([])
    lib.listFolders.mockResolvedValue([])
    lib.listSessions.mockResolvedValueOnce([])
    expect(String((await listLocalAgents(svc, claims())).note)).toContain('Select folder…')
  })
})

describe('read_local_agent', () => {
  it('reads compact, labels inbound messages by who sent them, and passes after_id on', async () => {
    lib.readTranscript.mockResolvedValueOnce({
      session: session({ status: 'waiting', lastSignal: 'ask' }),
      lastId: 9,
      items: [
        { id: 1, at: 't1', kind: 'inbound', author: 'agent', text: 'Look at the repo' },
        { id: 2, at: 't2', kind: 'tool', tool: { name: 'bash', input: 'ls', ok: true, output: 'src' } },
        { id: 3, at: 't3', kind: 'inbound', author: 'person', text: 'Skip the tests' },
        { id: 4, at: 't4', kind: 'text', text: 'It is a Next app.' },
        { id: 5, at: 't5', kind: 'ask', text: 'Which branch?' },
        { id: 6, at: 't6', kind: 'branch', branch: { name: 'dial8/x-1', commit: 'abc', filesChanged: 2, insertions: 3, deletions: 1 } },
      ],
    })
    const out = await readLocalAgent(svc, claims(), { session_id: SESSION_ID, after_id: 4 })
    expect(lib.readTranscript).toHaveBeenCalledWith(svc, 'user-1', SESSION_ID, { afterId: 4, compact: true })
    const items = out.items as Array<Record<string, unknown>>
    expect(items.map((i) => [i.kind, i.from ?? null])).toEqual([
      ['message', 'you (the Dial8 agent)'],
      ['tool', null],
      ['message', 'the person'],
      ['reply', null],
      ['ask', null],
      ['branch', null],
    ])
    expect(items[1]).toMatchObject({ name: 'bash', input: 'ls', ok: true, output: 'src' })
    expect(items[5]).toMatchObject({ name: 'dial8/x-1', filesChanged: 2 })
    expect(out.last_id).toBe(9)
    expect(String(out.note)).toContain('never paste the transcript')
    expect(out).not.toHaveProperty('truncated')
  })

  it('surfaces the library’s truncated flag, and says how to read the older items', async () => {
    lib.readTranscript.mockResolvedValueOnce({
      session: session(),
      lastId: 90,
      truncated: true,
      items: [{ id: 41, at: 't', kind: 'text', text: 'the newest part' }],
    })
    const out = await readLocalAgent(svc, claims(), { session_id: SESSION_ID })
    expect(out.truncated).toBe(true)
    expect(out).not.toHaveProperty('earlier_omitted')
    expect(String(out.note)).toContain('Older items were left out to fit: to read them, call again with an after_id below 41')
  })

  it('says when an old job’s transcript was cleared, and only then', async () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString()
    lib.readTranscript.mockResolvedValueOnce({ session: session({ updatedAt: old }), lastId: 0, items: [] })
    const out = await readLocalAgent(svc, claims(), { session_id: SESSION_ID })
    expect(out.transcript_cleared).toBe(true)
    expect(String(out.note)).toContain('Its transcript was cleared 30 days after its last activity')
    // A recent job with nothing yet, or a read past the end, is not "cleared".
    lib.readTranscript.mockResolvedValueOnce({ session: session({ updatedAt: new Date().toISOString() }), lastId: 0, items: [] })
    expect(await readLocalAgent(svc, claims(), { session_id: SESSION_ID })).not.toHaveProperty('transcript_cleared')
    lib.readTranscript.mockResolvedValueOnce({ session: session({ updatedAt: old }), lastId: 9, items: [] })
    expect(await readLocalAgent(svc, claims(), { session_id: SESSION_ID, after_id: 9 })).not.toHaveProperty('transcript_cleared')
  })

  it('keeps the newest items that fit, and counts the rest', async () => {
    const big = 'x'.repeat(4000)
    const items = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, at: 't', kind: 'text' as const, text: big }))
    lib.readTranscript.mockResolvedValueOnce({ session: session(), lastId: 12, items })
    const out = await readLocalAgent(svc, claims(), { session_id: SESSION_ID })
    const kept = out.items as Array<{ id: number }>
    expect(kept.at(-1)?.id).toBe(12)
    expect(JSON.stringify(kept).length).toBeLessThanOrEqual(READ_BUDGET_CHARS + 200)
    expect(out.earlier_omitted).toBe(12 - kept.length)
    expect(out.truncated).toBe(true)
  })

  it('an unknown session is a refusal the model reads', async () => {
    lib.readTranscript.mockRejectedValueOnce(new LocalAgentError('not_found', 'Local agent not found'))
    expect(await readLocalAgent(svc, claims(), { session_id: SESSION_ID })).toMatchObject({ status: 'refused', code: 'NOT_FOUND' })
  })
})

describe('stop_local_agent', () => {
  it('stopping a live one, stopped for a queued one', async () => {
    lib.requestStop.mockResolvedValueOnce(session({ status: 'running' }))
    expect(await stopLocalAgent(svc, claims(), { session_id: SESSION_ID })).toMatchObject({ status: 'stopping', session_status: 'running' })
    lib.requestStop.mockResolvedValueOnce(session({ status: 'cancelled' }))
    expect(await stopLocalAgent(svc, claims({ server: 'home_turn' }), { session_id: SESSION_ID })).toMatchObject({ status: 'stopped' })
    expect(lib.requestStop).toHaveBeenCalledWith(svc, 'user-1', SESSION_ID)
  })

  it('never from another server principal, a teammate or the device', async () => {
    for (const over of [{ server: 'idle_compaction' }, { teammateId: 'tm' }, { surface: 'device_ask' }] as Array<Partial<ChatRunTokenClaims>>) {
      expect(await stopLocalAgent(svc, claims(over), { session_id: SESSION_ID })).toMatchObject({ code: 'MAIN_CHAT_ONLY' })
    }
    expect(lib.requestStop).not.toHaveBeenCalled()
  })
})

describe('the teammate plan: one agent per folder, the offline fallback, the teammate’s name', () => {
  it('a start the folder’s agent takes as its next turn says so', async () => {
    lib.createSession.mockResolvedValue({ session: session({ status: 'running' }), created: false, deviceOnline: true, joined: true })
    const out = await startLocalAgent(svc, claims(), launch, { folder_id: FOLDER_ID, request: 'Now check the tests' })
    expect(out).toMatchObject({ joined: true, session_id: SESSION_ID, teammate: "Dial8 on Liam's MacBook Pro" })
    expect(out.reused).toBeUndefined()
    expect(out.note).toContain('as its next turn (one agent per folder)')
  })

  it('a folder another chat’s agent holds is refused, naming it, with how to free it', async () => {
    lib.createSession.mockRejectedValue(
      new LocalAgentError('conflict', "Dial8 on Liam's MacBook Pro is already working in dial8-website for another chat. One agent works in a folder at a time: wait for it to finish, or stop it first.", {
        code: 'FOLDER_BUSY', reason: 'other_chat', session: { id: SESSION_ID, teammate: "Dial8 on Liam's MacBook Pro", folder: 'dial8-website', status: 'running', mode: 'read' },
      }),
    )
    const out = await startLocalAgent(svc, claims(), launch, { folder_id: FOLDER_ID, request: 'Fix it', mode: 'edit' })
    expect(out).toMatchObject({ status: 'refused', code: 'FOLDER_BUSY' })
    // Only what names it: another chat's request and words stay there.
    expect(out.busy).toEqual({ session_id: SESSION_ID, teammate: "Dial8 on Liam's MacBook Pro", folder: 'dial8-website', status: 'running', mode: 'read' })
    expect(out.reason).toContain('stop_local_agent on that session_id')
  })

  it('an offline Mac whose folder is linked to a project’s repo offers a cloud run there, in that project’s environment, on the person’s yes', async () => {
    lib.createSession.mockResolvedValue({ session: session(), created: true, deviceOnline: false })
    const ENV = '9e1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7'
    const cloudFallback = vi.fn(async () => ({
      repo: 'liamadsr/dial8-website',
      projectId: 'proj-1',
      project: 'Website',
      environmentId: ENV,
      environment: 'Staging "beta"',
      networkAccess: 'restricted' as const,
    }))
    const out = await startLocalAgent(svc, claims(), launch, { folder_id: FOLDER_ID, request: 'Fix it', mode: 'edit' }, { cloudFallback })
    expect(cloudFallback).toHaveBeenCalledWith(svc, { userId: 'user-1', workspaceId: 'ws-1', folderId: FOLDER_ID })
    expect(out.cloud_fallback).toEqual({
      repo: 'liamadsr/dial8-website',
      project_id: 'proj-1',
      project: 'Website',
      environment_id: ENV,
      environment: 'Staging "beta"',
      network_access: 'restricted',
    })
    const note = String(out.note)
    expect(note).toContain('waits up to 6 hours')
    expect(note).toContain('linked to liamadsr/dial8-website')
    // It names the environment (as quoted data) and its network, and asks first.
    expect(note).toContain(`environment "Staging 'beta'" (restricted network)`)
    expect(note).toContain('Ask the person first, naming that environment and its network')
    expect(note).toContain('Only if they say yes')
    expect(note).toContain(`start_cloud_coding_run with project_id proj-1, environment_id ${ENV}`)
    // No name guess, and no hand-made action any more.
    expect(note).not.toContain('looks like')
    expect(note).not.toContain('list_bot_work')
  })

  it('no offer when the Mac is online, nothing matched, or the start was a retry', async () => {
    const cloudFallback = vi.fn(async () => null)
    lib.createSession.mockResolvedValue({ session: session(), created: true, deviceOnline: false })
    const offline = await startLocalAgent(svc, claims(), launch, { folder_id: FOLDER_ID, request: 'Fix it' }, { cloudFallback })
    expect(offline.cloud_fallback).toBeUndefined()
    expect(offline.note).not.toContain('cloud coding run')
    const never = vi.fn(async () => ({ repo: 'o/r', projectId: 'p', project: 'P', environmentId: 'e', environment: 'E', networkAccess: 'trusted' as const }))
    lib.createSession.mockResolvedValue({ session: session(), created: true, deviceOnline: true })
    await startLocalAgent(svc, claims(), launch, { folder_id: FOLDER_ID, request: 'Fix it' }, { cloudFallback: never })
    lib.createSession.mockResolvedValue({ session: session(), created: false, deviceOnline: false })
    await startLocalAgent(svc, claims(), launch, { folder_id: FOLDER_ID, request: 'Fix it' }, { cloudFallback: never })
    expect(never).not.toHaveBeenCalled()
  })

  it('a start and a typed turn’s message carry the person’s words; a home turn’s message carries none', async () => {
    lib.createSession.mockResolvedValue({ session: session(), created: true, deviceOnline: true })
    await startLocalAgent(svc, claims(), { ...launch, personWords: ['take a look'] }, { folder_id: FOLDER_ID, request: 'Fix it' })
    expect(lib.createSession.mock.calls.at(-1)![1]).toMatchObject({ personWords: ['take a look'] })
    lib.getSession.mockResolvedValue(session({ status: 'waiting', lastSignal: 'ask' }))
    lib.addMessage.mockResolvedValue({ messageId: 'm-1', requeued: false })
    await messageLocalAgent(svc, claims(), { ...launch, personWords: ['use main'] }, { session_id: SESSION_ID, text: 'Use main.' })
    expect(lib.addMessage.mock.calls.at(-1)![1]).toMatchObject({ personWords: ['use main'] })
    await messageLocalAgent(svc, claims({ server: 'home_turn' }), { ...launch, personWords: ['not theirs'] }, { session_id: SESSION_ID, text: 'Use main.' })
    expect(lib.addMessage.mock.calls.at(-1)![1]).not.toHaveProperty('personWords')
  })

  it('a home turn never answers a job no person watches (a loop’s): only the person does', async () => {
    lib.getSession.mockResolvedValue(session({ status: 'waiting', lastSignal: 'ask', lastSignalText: 'Which branch?', attended: false }))
    lib.addMessage.mockClear()
    const out = await messageLocalAgent(svc, claims({ server: 'home_turn' }), launch, { session_id: SESSION_ID, text: 'Use main.' })
    expect(out).toMatchObject({ status: 'refused', code: 'PERSON_ANSWERS' })
    expect(out.reason).toContain('only the person answers it')
    expect(lib.addMessage).not.toHaveBeenCalled()
    // A typed turn (the person is there) still may.
    lib.addMessage.mockResolvedValue({ messageId: 'm-1', requeued: false })
    expect(await messageLocalAgent(svc, claims(), launch, { session_id: SESSION_ID, text: 'Use main.' })).toMatchObject({ status: 'sent' })
    // A row with no marker at all (an older one) is no different: fail closed.
    lib.getSession.mockResolvedValue(session({ status: 'waiting', lastSignal: 'ask', attended: undefined }))
    expect(await messageLocalAgent(svc, claims({ server: 'home_turn' }), launch, { session_id: SESSION_ID, text: 'x' })).toMatchObject({ code: 'PERSON_ANSWERS' })
  })

  it('a session reads as the teammate on its Mac, with its pull request', () => {
    expect(sessionView(session({ mode: 'edit', branch: 'dial8/x-1', prUrl: 'https://github.com/o/r/pull/3' }))).toMatchObject({
      teammate: "Dial8 on Liam's MacBook Pro",
      pull_request: 'https://github.com/o/r/pull/3',
    })
    expect(sessionView(session({ deviceName: '' })).teammate).toBe('Dial8 on your Mac')
    expect(sessionView(session()).pull_request).toBeUndefined()
  })
})

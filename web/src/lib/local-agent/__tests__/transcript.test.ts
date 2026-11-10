import { describe, expect, it } from 'vitest'
import { foldEvents, readEvents, readTranscript, type TranscriptEventRow } from '../transcript'
import { DEVICE, FOLDER, OTHER, USER, WS, seeded } from './fake-db'

let id = 0
const ev = (kind: string, payload: Record<string, unknown>, source: 'device' | 'server' = 'device'): TranscriptEventRow => ({
  id: ++id,
  created_at: `2026-10-20T22:00:${String(id).padStart(2, '0')}Z`,
  source,
  run_id: source === 'device' ? 'r1' : null,
  seq: source === 'device' ? id : null,
  kind,
  payload,
})

describe('foldEvents', () => {
  it('compact merges text deltas into one message, takes the message text, truncates tool I/O and keeps only the last status', () => {
    id = 0
    const events = [
      ev('status', { kind: 'status', status: 'running' }),
      ev('inbound', { author: 'agent', text: 'Look at the repo', policy: 'queue', messageId: 'm1' }, 'server'),
      ev('text', { kind: 'text', delta: 'Hel' }),
      ev('text', { kind: 'text', delta: 'lo' }),
      ev('message', { kind: 'message', text: 'Hello.' }),
      ev('tool', { kind: 'tool', callId: 'c1', name: 'read_file', input: 'x'.repeat(1000) }),
      ev('tool_result', { kind: 'tool_result', callId: 'c1', name: 'read_file', ok: true, output: 'y'.repeat(1000) }),
      ev('ask', { kind: 'ask', question: 'Which branch?' }),
      ev('status', { kind: 'status', status: 'waiting' }),
    ]
    const items = foldEvents(events, true)
    expect(items.map((i) => i.kind)).toEqual(['inbound', 'text', 'tool', 'ask', 'status'])
    expect(items[0]).toMatchObject({ author: 'agent', text: 'Look at the repo' })
    expect(items[1].text).toBe('Hello.')
    expect(items[2].tool?.input.length).toBe(300)
    expect(items[2].tool?.output?.length).toBe(300)
    expect(items[2].tool?.ok).toBe(true)
    expect(items[4].status).toBe('waiting')
    expect(JSON.stringify(items)).not.toContain('callId')
  })

  it('full keeps each delta, every status, whole tool text, and no duplicate message', () => {
    id = 0
    const events = [
      ev('status', { status: 'running' }),
      ev('text', { delta: 'a' }),
      ev('text', { delta: 'b' }),
      ev('message', { text: 'ab' }),
      ev('tool', { callId: 'c', name: 'bash', input: 'z'.repeat(500) }),
      ev('status', { status: 'waiting' }),
      ev('message', { text: 'late whole message' }),
    ]
    const items = foldEvents(events, false)
    expect(items.map((i) => i.kind)).toEqual(['status', 'text', 'text', 'tool', 'status', 'text'])
    expect(items[3].tool?.input.length).toBe(500)
    expect(items[5].text).toBe('late whole message')
  })

  it('reads a branch card and a result whose call fell before the page', () => {
    id = 0
    const items = foldEvents(
      [
        ev('tool_result', { callId: 'gone', name: 'bash', ok: false, output: 'exit 1' }),
        ev('branch', { branch: 'dial8/fix-1', commit: 'abc123', filesChanged: 3, insertions: 10, deletions: 2 }),
      ],
      true,
    )
    expect(items[0]).toMatchObject({ kind: 'tool', tool: { name: 'bash', input: '', ok: false, output: 'exit 1' } })
    expect(items[1].branch).toEqual({ name: 'dial8/fix-1', commit: 'abc123', filesChanged: 3, insertions: 10, deletions: 2 })
  })
})

describe('readTranscript / readEvents', () => {
  const SID = '77777777-7777-4777-8777-777777777777'
  const db = () =>
    seeded({
      local_agent_session: [
        {
          id: SID, user_id: USER, workspace_id: WS, device_id: DEVICE, folder_id: FOLDER, conversation_id: null,
          status: 'running', mode: 'read', request: 'Look', current_turn: 1, lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
          expires_at: new Date(Date.now() + 3600_000).toISOString(), created_at: '2026-10-20T22:00:00Z', updated_at: '2026-10-20T22:00:00Z',
          run_id: 'r1', last_seq: 3, last_seq_run_id: 'r1',
        },
      ],
      local_agent_event: Array.from({ length: 5 }, (_, i) => ({
        id: i + 1, session_id: SID, user_id: USER, source: 'device', run_id: 'r1', seq: i, kind: 'text',
        payload: { kind: 'text', delta: `d${i}` }, created_at: `2026-10-20T22:00:0${i}Z`,
      })),
    })

  it('pages raw events after an id and carries lastDeviceSeq and runId', async () => {
    const svc = db()
    const page = await readEvents(svc as never, USER, SID, { afterId: 2 })
    expect(page?.events.map((e) => e.id)).toEqual([3, 4, 5])
    expect(page?.lastId).toBe(5)
    expect(page?.session.lastDeviceSeq).toEqual({ runId: 'r1', seq: 3 })
    expect(page?.session.runId).toBe('r1')
    expect(page?.session.folderLabel).toBe('native-intelligence')
  })

  it('compact without afterId reads the newest events, skipping deltas (a message carries the whole text)', async () => {
    const svc = db()
    svc.tables.local_agent_event.push(
      { id: 6, session_id: SID, user_id: USER, source: 'device', run_id: 'r1', seq: 5, kind: 'message', payload: { kind: 'message', text: 'First whole message.' }, created_at: '2026-10-20T22:00:06Z' },
      { id: 7, session_id: SID, user_id: USER, source: 'device', run_id: 'r1', seq: 6, kind: 'text', payload: { kind: 'text', delta: 'more' }, created_at: '2026-10-20T22:00:07Z' },
      { id: 8, session_id: SID, user_id: USER, source: 'device', run_id: 'r1', seq: 7, kind: 'message', payload: { kind: 'message', text: 'Second whole message.' }, created_at: '2026-10-20T22:00:08Z' },
    )
    const t = await readTranscript(svc as never, USER, SID, { compact: true, limit: 1 })
    expect(t.items.map((i) => i.text)).toEqual(['Second whole message.'])
    expect(t.lastId).toBe(8)
    const all = await readTranscript(svc as never, USER, SID, { compact: true })
    expect(all.items.map((i) => i.text)).toEqual(['First whole message.', 'Second whole message.'])
  })

  it('another person reads nothing', async () => {
    const svc = db()
    expect(await readEvents(svc as never, OTHER, SID)).toBeNull()
    await expect(readTranscript(svc as never, OTHER, SID)).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('foldEvents, the teammate plan', () => {
  it('the cloud body reads the teammate tools once (as the ask / report) and the pull request as one line', () => {
    id = 0
    const items = foldEvents(
      [
        ev('tool', { kind: 'tool', callId: 'c1', name: 'message_teammate', input: '{"text":"Which branch?"}' }),
        ev('tool_result', { kind: 'tool_result', callId: 'c1', name: 'message_teammate', ok: true, output: '{}' }),
        ev('ask', { question: 'Which branch?', via: 'message_teammate' }, 'server'),
        ev('report', { text: 'Reading tests', via: 'report_to_person' }, 'server'),
        ev('pull_request', { kind: 'pull_request', ok: true, url: 'https://github.com/o/r/pull/3', branch: 'dial8/x-1' }),
        ev('pull_request', { kind: 'pull_request', ok: false, pushed: true, error: 'gh failed' }),
        ev('pull_request', { kind: 'pull_request', ok: false, pushed: false, error: 'rejected' }),
        ev('pull_request', { kind: 'pull_request', ok: false, pushed: null }),
      ],
      true,
    )
    expect(items.map((i) => [i.kind, i.text])).toEqual([
      ['ask', 'Which branch?'],
      ['report', 'Reading tests'],
      ['pull_request', 'Pull request opened: https://github.com/o/r/pull/3'],
      ['pull_request', 'The branch was pushed, but no pull request was opened: gh failed'],
      ['pull_request', 'The push failed: rejected'],
      ['pull_request', "The push didn't finish: unknown reason"],
    ])
  })
})

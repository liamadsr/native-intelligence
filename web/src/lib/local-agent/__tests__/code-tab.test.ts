/**
 * The chat composer's Code tab as pure state (code-tab.ts): who sees it, the
 * choice per conversation and how a conversation opens, the agent picker's
 * sections, the folders, why it doesn't send, where a send goes, and where
 * each job draws in the thread.
 */
import { describe, expect, it } from 'vitest'
import {
  CODE_TAB_STORAGE_PREFIX,
  codeAgentLabel,
  codeAgentSections,
  codeBlocker,
  codeFolderOptions,
  codeJobOpen,
  codeJobWorking,
  codeJobsOf,
  codeMacOf,
  codeSendTarget,
  codeThreadLayout,
  defaultCodeAgent,
  hasMacEnvironment,
  isPickableAgent,
  openingCodeChoice,
  parseCodeTabChoice,
  readCodeTabChoice,
  resolveCodeFolder,
  threadHasCode,
  withCodeJob,
  writeCodeTabChoice,
  type CodeJob,
} from '../code-tab'
import { CODE_CLOUD_NEXT_REASON, CODE_FINISH_KIND, codeFinishMessageId } from '../code-thread'
import { cloud, mac } from '@/components/environments/__tests__/fixtures'

const STUDIO = mac({ id: 'env-studio', name: 'Studio Mac', deviceId: 'dev-studio', offeredWorkers: [{ id: 'claude-code', label: 'Claude Code' }] })
const loaded = { loaded: true }

describe('who sees the tabs', () => {
  it('a person with a Mac environment: the chat’s own, or one in the list; nobody else', () => {
    expect(hasMacEnvironment({ environment: STUDIO }, { environments: [] })).toBe(true)
    expect(hasMacEnvironment({ environment: cloud() }, { environments: [cloud(), STUDIO] })).toBe(true)
    expect(hasMacEnvironment({ environment: cloud() }, { environments: [cloud()] })).toBe(false)
    expect(hasMacEnvironment({ environment: null }, { environments: [] })).toBe(false)
  })

  it('the chat’s Mac is the list’s copy once read (the fresher), and none on a cloud environment', () => {
    const fresher = { ...STUDIO, worker: 'claude-code' }
    expect(codeMacOf({ environment: STUDIO }, { environments: [fresher] })).toBe(fresher)
    expect(codeMacOf({ environment: STUDIO }, { environments: [] })).toBe(STUDIO)
    expect(codeMacOf({ environment: cloud() }, { environments: [STUDIO] })).toBeNull()
  })
})

describe('the choice, per conversation', () => {
  const memory = () => {
    const m = new Map<string, string>()
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
  }

  it('is kept under the conversation’s id and read back, field by field', () => {
    const s = memory()
    writeCodeTabChoice('c-1', { tab: 'code', agent: 'claude-code', folderId: 'f-1' }, s)
    expect(s.m.has(`${CODE_TAB_STORAGE_PREFIX}c-1`)).toBe(true)
    expect(readCodeTabChoice('c-1', s)).toEqual({ tab: 'code', agent: 'claude-code', folderId: 'f-1' })
    expect(readCodeTabChoice('c-2', s)).toBeNull()
    expect(parseCodeTabChoice('{"tab":"code","agent":"Claude Code","folderId":7}')).toEqual({ tab: 'code', agent: null, folderId: null })
    expect(parseCodeTabChoice('{"tab":"design"}')).toBeNull()
    expect(parseCodeTabChoice('not json')).toBeNull()
  })

  it('no id yet, or storage that throws, keeps nothing and says nothing', () => {
    const throwing = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    expect(() => writeCodeTabChoice('c-1', { tab: 'code', agent: null, folderId: null }, throwing)).not.toThrow()
    expect(readCodeTabChoice('c-1', throwing)).toBeNull()
    const s = memory()
    writeCodeTabChoice(null, { tab: 'code', agent: null, folderId: null }, s)
    expect(s.m.size).toBe(0)
  })

  it('a conversation opens on its stored choice; else, with a Code job, on Code with the newest job’s agent and folder; else Chat with the defaults', () => {
    const jobs: CodeJob[] = [
      { sessionId: 's-1', requestId: 'r-1', worker: null, folderId: 'f-1', status: 'cancelled', createdAt: '2026-11-14T10:00:00Z' },
      { sessionId: 's-2', requestId: 'r-2', worker: 'claude-code', folderId: 'f-3', status: 'waiting', createdAt: '2026-11-14T11:00:00Z' },
    ]
    const defaults = { agent: 'codex', folderId: 'f-1' }
    expect(openingCodeChoice({ tab: 'chat', agent: null, folderId: null }, jobs, defaults)).toEqual({ tab: 'chat', agent: null, folderId: null })
    expect(openingCodeChoice(null, jobs, defaults)).toEqual({ tab: 'code', agent: 'claude-code', folderId: 'f-3' })
    expect(openingCodeChoice(null, [], defaults)).toEqual({ tab: 'chat', agent: 'codex', folderId: 'f-1' })
  })
})

describe('the agent picker', () => {
  it('Native Intelligence, then what the Mac offers, then what the registry knows and the Mac doesn’t', () => {
    const sections = codeAgentSections(STUDIO, null)
    expect(sections.native).toEqual({ id: null, label: 'Native Intelligence' })
    expect(sections.yours).toEqual([{ id: 'claude-code', label: 'Claude Code' }])
    expect(sections.needsConnection).toEqual([{ id: 'codex', label: 'Codex' }])
  })

  it('on that Mac, what it offers right now; anywhere else, what it last told the server', () => {
    const live = { deviceId: 'dev-studio', workers: [{ id: 'codex', label: 'Codex' }] }
    expect(codeAgentSections(STUDIO, live).yours.map((o) => o.id)).toEqual(['codex'])
    expect(codeAgentSections(STUDIO, { deviceId: 'dev-other', workers: [] }).yours.map((o) => o.id)).toEqual(['claude-code'])
  })

  it('nothing known about the Mac: every known agent needs connection', () => {
    const sections = codeAgentSections(mac({ offeredWorkers: null }), null)
    expect(sections.yours).toEqual([])
    expect(sections.needsConnection.map((o) => o.id)).toEqual(['claude-code', 'codex'])
    expect(codeAgentSections(null, null).needsConnection).toHaveLength(2)
  })

  it('the default is the Mac’s saved worker while it offers it, else Native Intelligence; only an offered agent may be picked', () => {
    const sections = codeAgentSections(STUDIO, null)
    expect(defaultCodeAgent({ ...STUDIO, worker: 'claude-code' }, sections)).toBe('claude-code')
    expect(defaultCodeAgent({ ...STUDIO, worker: 'codex' }, sections)).toBeNull()
    expect(defaultCodeAgent(STUDIO, sections)).toBeNull()
    expect(isPickableAgent(sections, null)).toBe(true)
    expect(isPickableAgent(sections, 'codex')).toBe(false)
    expect(codeAgentLabel('claude-code', sections)).toBe('Claude Code')
    expect(codeAgentLabel(null, sections)).toBe('Native Intelligence')
  })
})

describe('the folders, and why it doesn’t send', () => {
  it('a folder that allows edits and is a git repository can take a job; the rest say why', () => {
    expect(codeFolderOptions(STUDIO)).toEqual([
      { id: 'f-1', label: 'native-intelligence', usable: true, note: null },
      { id: 'f-2', label: 'notes', usable: false, note: 'Read-only: allow edits on your Mac' },
    ])
    expect(codeFolderOptions(mac({ folders: [{ id: 'f-9', label: 'drafts', mode: 'edit', isGit: false, baseBranch: null, repoFullName: null }] }))[0]).toMatchObject({ usable: false, note: 'Not a git repository' })
  })

  it('the chosen folder while it can take a job, else the first that can', () => {
    const options = codeFolderOptions(STUDIO)
    expect(resolveCodeFolder(options, 'f-1')).toBe('f-1')
    expect(resolveCodeFolder(options, 'f-2')).toBe('f-1')
    expect(resolveCodeFolder(options, null)).toBe('f-1')
    expect(resolveCodeFolder([], null)).toBeNull()
  })

  it('a cloud environment: the next-phase line; no Mac or no folder: what to do; else nothing', () => {
    expect(codeBlocker({ ...loaded, environment: cloud() }, null, null)).toBe(CODE_CLOUD_NEXT_REASON)
    expect(codeBlocker({ ...loaded, environment: null }, null, null)).toBe('Pick one of your Macs to code on.')
    expect(codeBlocker({ ...loaded, environment: STUDIO }, STUDIO, null)).toContain('Add a folder on Studio Mac')
    expect(codeBlocker({ ...loaded, environment: STUDIO }, STUDIO, 'f-1')).toBeNull()
    expect(codeBlocker({ loaded: false, environment: null }, null, null)).toBeNull()
  })
})

describe('the conversation’s jobs, and where a send goes', () => {
  const job = (over: Partial<CodeJob> = {}): CodeJob => ({ sessionId: 's-1', requestId: 'r-1', worker: 'claude-code', folderId: 'f-1', status: 'running', createdAt: '2026-11-14T10:00:00Z', ...over })

  it('only the person’s Code jobs, oldest first; a job updates in place, the same array when nothing changed', () => {
    const rows = [
      { id: 's-2', codeRequestId: 'r-2', worker: null, folderId: 'f-1', status: 'waiting' as const, createdAt: '2026-11-14T11:00:00Z' },
      { id: 's-x', folderId: 'f-1', status: 'running' as const, createdAt: '2026-11-14T09:00:00Z' },
      { id: 's-1', codeRequestId: 'r-1', worker: 'codex', folderId: 'f-1', status: 'cancelled' as const, createdAt: '2026-11-14T10:00:00Z' },
    ]
    const jobs = codeJobsOf(rows)
    expect(jobs.map((j) => j.sessionId)).toEqual(['s-1', 's-2'])
    expect(withCodeJob(jobs, { ...jobs[1] })).toBe(jobs)
    expect(withCodeJob(jobs, { ...jobs[1], status: 'running' })[1].status).toBe('running')
    expect(withCodeJob(jobs, job({ sessionId: 's-3', createdAt: '2026-11-14T12:00:00Z' })).map((j) => j.sessionId)).toEqual(['s-1', 's-2', 's-3'])
  })

  it('open until it ends; working while queued, starting or running', () => {
    expect(codeJobOpen('waiting')).toBe(true)
    expect(codeJobOpen('interrupted')).toBe(true)
    expect(codeJobOpen('expired')).toBe(false)
    expect(codeJobWorking('running')).toBe(true)
    expect(codeJobWorking('waiting')).toBe(false)
  })

  it('to the newest job while it is open, on the same agent, in the same folder; else a new job', () => {
    expect(codeSendTarget(job(), 'claude-code', 'f-1')).toEqual({ kind: 'message', sessionId: 's-1' })
    expect(codeSendTarget(job({ status: 'waiting' }), 'claude-code', 'f-1')).toEqual({ kind: 'message', sessionId: 's-1' })
    expect(codeSendTarget(job({ status: 'failed' }), 'claude-code', 'f-1')).toEqual({ kind: 'start' })
    expect(codeSendTarget(job(), null, 'f-1')).toEqual({ kind: 'start' })
    expect(codeSendTarget(job(), 'claude-code', 'f-2')).toEqual({ kind: 'start' })
    expect(codeSendTarget(null, 'claude-code', 'f-1')).toEqual({ kind: 'start' })
  })
})

describe('the thread', () => {
  const person = (id: string, meta: Record<string, unknown> | null) => ({ id, role: 'user', parts: [{ type: 'text', text: id }], metadata: meta ? { local_agent_code: meta } : {} })
  const finish = (sessionId: string, turn: number) => ({ id: codeFinishMessageId(sessionId, turn), role: 'assistant', parts: [{ type: 'text', text: 'Done.' }], metadata: { kind: CODE_FINISH_KIND, local_agent_session_id: sessionId } })
  const jobs: CodeJob[] = [{ sessionId: 's-1', requestId: 'r-1', worker: 'claude-code', folderId: 'f-1', status: 'waiting', createdAt: '2026-11-14T10:00:00Z' }]

  it('a job draws after the message that started it; its later messages and finish summaries draw nowhere else', () => {
    const thread = [
      person('chat-1', null),
      person('code-r-1', { requestId: 'r-1' }),
      finish('s-1', 1),
      person('code-r-2', { requestId: 'r-2', sessionId: 's-1' }),
      finish('s-1', 2),
      person('chat-2', null),
    ]
    const layout = codeThreadLayout(thread, jobs)
    expect([...layout.blockAfter]).toEqual([['code-r-1', 's-1']])
    expect([...layout.hidden].sort()).toEqual(['code-r-2', codeFinishMessageId('s-1', 1), codeFinishMessageId('s-1', 2)].sort())
    expect(threadHasCode(thread)).toBe(true)
    expect(threadHasCode([person('chat-1', null)])).toBe(false)
  })

  it('a message whose job isn’t known draws as any message does', () => {
    const thread = [person('code-r-9', { requestId: 'r-9' }), finish('s-9', 1), person('code-r-10', { requestId: 'r-10', sessionId: 's-9' })]
    const layout = codeThreadLayout(thread, jobs)
    expect(layout.blockAfter.size).toBe(0)
    expect(layout.hidden.size).toBe(0)
    expect(codeThreadLayout(thread, []).blockAfter.size).toBe(0)
  })
})

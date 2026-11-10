/**
 * Which tool calls bring untrusted outside text into a run (outside-text.ts):
 * the signal that holds a teammate memory entry as a suggestion.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  eveWebToolsIn,
  isOutsideTextTool,
  mailSendersIn,
  mayReadOutsideText,
  noteOutsideRead,
  outsideToolsInLog,
  readOutsideText,
  toolReadOf,
} from '../outside-text'

const none = async () => new Set<string>()

describe('toolReadOf (F3 review R1): every stream result, for loop runs and work runs alike', () => {
  const ev = (result: unknown) => ({ type: 'action.result', data: { result } })
  it("a delegated teammate's findings and a subagent's result are outside; the run's own question and finish are not", () => {
    expect(toolReadOf(ev({ kind: 'tool-result', callId: 'c', toolName: 'delegate_work', output: { summary: 'what I found on the web' } }))).toMatchObject({ outside: true })
    expect(toolReadOf(ev({ kind: 'subagent-result', callId: 'c', output: {} }))).toMatchObject({ outside: true })
    expect(toolReadOf(ev({ kind: 'tool-result', callId: 'c', toolName: 'request_user_input', output: { answer: 'yes' } }))).toMatchObject({ outside: false })
    expect(toolReadOf(ev({ kind: 'tool-result', callId: 'c', toolName: 'finish_work', output: { ok: true } }))).toMatchObject({ outside: false })
  })

  it('an external write (open_browser) is not internal; a workspace write is', () => {
    expect(toolReadOf(ev({ kind: 'tool-result', callId: 'c', toolName: 'open_browser', output: { ok: true } }))).toMatchObject({ outside: true })
    expect(toolReadOf(ev({ kind: 'tool-result', callId: 'c', toolName: 'create_action', output: { ok: true } }))).toMatchObject({ outside: false })
  })
})
const knows = (...addresses: string[]) => async () => new Set(addresses)

describe('outside-text tools', () => {
  it('the web, connected apps, files and ingests, research and the browser are outside text', () => {
    for (const name of ['web_search', 'web_fetch', 'mcp__linear__list_issues', 'get_attachment_content', 'ingest_reference', 'ingest_source',
      'research_my_company', 'find_prospects', 'get_prospecting_run_candidates', 'read_browser_page', 'run_browser_task', 'get_email_summary', 'ni_ingest_source']) {
      expect(isOutsideTextTool(name), name).toBe(true)
    }
  })
  it('the person’s own calls, documents, board, CRM and knowledge are not', () => {
    for (const name of ['get_capture_transcript', 'get_capture_content', 'get_document', 'list_actions', 'get_contact', 'search_claims', 'read_chat_file', 'list_emails', 'read_email']) {
      expect(isOutsideTextTool(name), name).toBe(false)
    }
    expect(mayReadOutsideText('read_email')).toBe(true)
    expect(mayReadOutsideText('list_actions')).toBe(false)
  })
})

describe('readOutsideText', () => {
  it('an outside-text tool always counts, unless the call failed', async () => {
    expect(await readOutsideText('web_fetch', { text: 'page' }, none)).toBe(true)
    expect(await readOutsideText('get_attachment_content', { success: false, error: 'gone' }, none)).toBe(false)
    expect(await readOutsideText('list_actions', { actions: [] }, none)).toBe(false)
  })
  it('mail counts only when a sender is unknown, or can’t be read', async () => {
    const out = { emails: [{ from: 'Dana Lee <dana@acme.com>', subject: 'hi' }, { from_email: 'Bob@Acme.com' }] }
    expect(await readOutsideText('list_emails', out, knows('dana@acme.com', 'bob@acme.com'))).toBe(false)
    expect(await readOutsideText('list_emails', out, knows('dana@acme.com'))).toBe(true)
    expect(await readOutsideText('read_email', { message: { from: 'Somebody' } }, knows('dana@acme.com'))).toBe(true)
    expect(await readOutsideText('list_emails', { emails: [] }, none)).toBe(false)
  })
  it('a failed lookup counts every sender as unknown', async () => {
    expect(await readOutsideText('read_email', { from: 'dana@acme.com' }, async () => { throw new Error('db down') })).toBe(true)
  })
  it('mailSendersIn reads each message once, its address lower-cased', () => {
    expect(mailSendersIn({ threads: [{ messages: [{ from: 'A <A@x.io>' }, { sender: { email: 'b@y.io' } }, { from: '' }] }] })).toEqual(['a@x.io', 'b@y.io', null])
  })
})

describe('recording', () => {
  it('noteOutsideRead calls the atomic append with the bare name, and never throws', async () => {
    const rpc = vi.fn(async () => ({ data: null, error: null }))
    await noteOutsideRead({ rpc } as never, { agentRunId: 'r', workspaceId: 'w', toolName: 'ni_ingest_source' })
    expect(rpc).toHaveBeenCalledWith('agent_run_note_outside_read', { p_run_id: 'r', p_workspace_id: 'w', p_tool: 'ingest_source' })
    await expect(noteOutsideRead({ rpc: async () => { throw new Error('down') } } as never, { agentRunId: 'r', workspaceId: 'w', toolName: 'web_fetch' })).resolves.toBeUndefined()
    await expect(noteOutsideRead({} as never, { agentRunId: 'r', workspaceId: 'w', toolName: 'web_fetch' })).resolves.toBeUndefined()
  })
  it('eveWebToolsIn finds the web tools a turn called, each once', () => {
    const events = [
      { type: 'actions.requested', data: { actions: [{ kind: 'tool-call', toolName: 'web_search' }, { kind: 'tool-call', toolName: 'list_actions' }] } },
      { type: 'actions.requested', data: { actions: [{ kind: 'tool-call', toolName: 'web_search' }, { kind: 'tool-call', toolName: 'web_fetch' }] } },
      { type: 'message.appended', data: { messageDelta: 'web_fetch' } },
    ]
    expect(eveWebToolsIn(events)).toEqual(['web_search', 'web_fetch'])
  })
  it('outsideToolsInLog reads the `[tool]` lines of a log tail, as the fallback for a lost note', () => {
    expect(outsideToolsInLog('hello\n[tool] list_actions, web_fetch\nweb_search in prose\n[tool] get_attachment_content\n')).toEqual(['web_fetch', 'get_attachment_content'])
    expect(outsideToolsInLog(null)).toEqual([])
  })
})

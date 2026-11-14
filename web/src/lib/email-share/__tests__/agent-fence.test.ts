/**
 * No agent path to shared mail (migration 646). A message carrying a share
 * holds the sharer's note (or "Shared an email") and the share's id, never the
 * mail; every agent that reads chat messages sees at most "an email was
 * shared":
 *   - read_team_chat_message (the main chat agent, MCP's
 *     ni_read_team_chat_message, a chat_message loop's step): the note and the
 *     notice, `email_shared: true`, and no mailbox read;
 *   - the team-chat agent's context lines (agent-turn.ts channelContext);
 *   - a guest's or a linked agent's turn reads no team chat at all.
 * And structurally: only the share routes import the share's reader, and
 * those refuse Bearer callers (MCP, devices). Made-up people throughout.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { NextRequest } from 'next/server'
import { memoryDb } from '@/test/memory-db'
import { createTeamChatTools } from '@/lib/ai/tools/team-chat'
import { EMAIL_SHARE_AGENT_NOTICE, emailShareAgentText } from '../types'
import { refuseBearer } from '../http'

vi.mock('@/lib/chat/eve-message-writer', () => ({ persistEveMessage: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

const WS = 'ws-northwind'
const CH = '11111111-1111-4111-8111-111111111111'
const SHARE_MSG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NOTE_MSG = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PLAIN = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SHARE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const SHARE_2 = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

const message = (id: string, over: Record<string, unknown>) => ({
  id,
  channel_id: CH,
  workspace_id: WS,
  author_kind: 'member',
  author_member_id: 'm-avery',
  agent_for_member_id: null,
  agent_name: null,
  thread_root_id: null,
  body: 'hello',
  attachments: [],
  created_at: '2026-11-14T15:00:00Z',
  edited_at: null,
  deleted_at: null,
  email_share_id: null,
  ...over,
})

function db() {
  return memoryDb({
    member: [{ id: 'm-avery', user_id: 'u-avery', workspace_id: WS, display_name: 'Avery Stone' }],
    team_chat_channel: [{ id: CH, workspace_id: WS, team_id: null, kind: 'channel', name: 'sales' }],
    team_chat_message: [
      message(SHARE_MSG, { body: 'Shared an email', email_share_id: SHARE, created_at: '2026-11-14T15:00:00Z' }),
      message(NOTE_MSG, { body: 'Can someone check the discount?', email_share_id: SHARE_2, created_at: '2026-11-14T15:01:00Z' }),
      message(PLAIN, { body: '@Juniper what did Dana say?', created_at: '2026-11-14T15:02:00Z' }),
    ],
    // The share rows hold ids only; even so, no agent path reads them.
    email_share: [{ id: SHARE, provider_thread_id: 'thr-1', message_ids: ['m1'] }],
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('read_team_chat_message on a shared email', () => {
  it('says an email was shared, keeps the note, and reads no mailbox', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const tools = createTeamChatTools('u-avery', db(), WS)
    const res = (await tools.read_team_chat_message.execute!({ message_id: NOTE_MSG }, EXEC)) as Record<string, unknown>
    const text = JSON.stringify(res)
    expect(res).toMatchObject({ success: true, message: { email_shared: true } })
    expect(text).toContain('Can someone check the discount?')
    expect(text).toContain('An email thread was shared here')
    expect(text).not.toContain('thr-1')
    expect(fetchSpy).not.toHaveBeenCalled()

    const bare = (await tools.read_team_chat_message.execute!({ message_id: SHARE_MSG }, EXEC)) as { message: { text: string } }
    expect(bare.message.text).toContain(EMAIL_SHARE_AGENT_NOTICE)
    expect(bare.message.text).not.toContain('Shared an email\n')
  })

  it('a guest’s or a linked agent’s turn reads nothing', async () => {
    const res = (await createTeamChatTools('u-avery', db(), WS, { omitGrants: true }).read_team_chat_message.execute!({ message_id: SHARE_MSG }, EXEC)) as Record<string, unknown>
    expect(res.success).toBe(false)
  })
})

describe('the team-chat agent’s context', () => {
  it('a shared email reads as the notice (and its note), never the mail', async () => {
    const { channelContext } = await import('@/lib/team-chat/agent-turn')
    const lines = await channelContext(db(), { id: CH, workspace_id: WS, kind: 'channel', name: 'sales' }, { id: PLAIN, created_at: '2026-11-14T15:02:00Z', thread_root_id: null })
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain(EMAIL_SHARE_AGENT_NOTICE)
    expect(lines[1]).toContain('Can someone check the discount?')
    expect(lines[1]).toContain(EMAIL_SHARE_AGENT_NOTICE)
  })

  it('emailShareAgentText: a plain message is untouched', () => {
    expect(emailShareAgentText('hello', null)).toBe('hello')
    expect(emailShareAgentText('Shared an email', SHARE)).toBe(EMAIL_SHARE_AGENT_NOTICE)
  })
})

describe('the share routes', () => {
  it('refuse Bearer callers (MCP clients, device tokens): shared mail opens in the app', async () => {
    const bearer = new NextRequest('https://app.example/api/account/email/shares/x', { headers: { authorization: 'Bearer eyJ.fake' } })
    const res = refuseBearer(bearer)
    expect(res?.status).toBe(403)
    expect(refuseBearer(new NextRequest('https://app.example/api/account/email/shares/x'))).toBeNull()
  })

  it('every share route checks the caller through shareCaller (Bearer refused) before anything else', () => {
    const root = join(process.cwd(), 'src/app/api/account/email/shares')
    const routes = walk(root).filter((f) => f.endsWith('route.ts'))
    expect(routes.length).toBe(4)
    for (const file of routes) {
      const src = readFileSync(file, 'utf8')
      const handlers = src.match(/export async function (GET|POST|DELETE|PATCH|PUT)\b/g) ?? []
      expect(handlers.length, file).toBeGreaterThan(0)
      expect(src.match(/await shareCaller\(request\)/g)?.length, file).toBe(handlers.length)
    }
  })
})

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (name === 'node_modules' || name === '.next' || name === '.eve') return []
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

describe('tripwire: only the share routes reach a share’s mail', () => {
  it('no agent, tool, MCP, loop, job or chat code imports the share reader', () => {
    const cwd = process.cwd()
    const files = [...walk(join(cwd, 'src')), ...walk(join(cwd, 'agents'))].filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes('__tests__'))
    const readers = /from ['"](@\/lib\/email-share\/(service|provider|http)|\.\.?\/(service|provider|http))['"]/
    const offenders = files.filter((f) => {
      const rel = relative(cwd, f)
      if (rel.startsWith('src/lib/email-share/') || rel.startsWith('src/app/api/account/email/shares/')) return false
      const src = readFileSync(f, 'utf8')
      return /email-share/.test(src) && readers.test(src)
    })
    expect(offenders.map((f) => relative(cwd, f))).toEqual([])
  })
})

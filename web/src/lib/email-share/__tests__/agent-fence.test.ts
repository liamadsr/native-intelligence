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
  it('refuse device tokens, and let the person’s own session through (the web app sends it as a Supabase Bearer)', async () => {
    const at = (authorization?: string) =>
      new NextRequest('https://app.example/api/account/email/shares/x', authorization ? { headers: { authorization } } : {})
    expect(refuseBearer(at('Bearer nid_madeupdevicetoken'))?.status).toBe(403)
    expect(refuseBearer(at('Bearer d8d_madeuplegacytoken'))?.status).toBe(403)
    // src/lib/workspace-fetch.ts attaches the session's access token to every /api/ call.
    expect(refuseBearer(at('Bearer eyJ.made.up'))).toBeNull()
    expect(refuseBearer(at())).toBeNull()
  })

  it('every share route checks the caller (Bearer refused) before it reaches the share layer', () => {
    const root = join(process.cwd(), 'src/app/api/account/email/shares')
    const routes = walk(root).filter((f) => f.endsWith('route.ts'))
    expect(routes.length).toBe(6)
    for (const file of routes) {
      const src = readFileSync(file, 'utf8')
      const handlers = [...src.matchAll(/export async function (GET|POST|DELETE|PATCH|PUT)\b/g)]
      expect(handlers.length, file).toBeGreaterThan(0)
      handlers.forEach((h, n) => {
        const body = src.slice(h.index, handlers[n + 1]?.index ?? src.length)
        // The caller check (device tokens refused): shareCaller, or (the link's page, any member of its workspace) refuseBearer then requireUser.
        const caller = body.indexOf('await shareCaller(request)')
        const page = body.indexOf('refuseBearer(request)') > -1 && body.indexOf('await requireUser()') > body.indexOf('refuseBearer(request)') ? body.indexOf('await requireUser()') : -1
        const check = caller > -1 ? caller : page
        const reach = body.search(
          /createEmailShare|readShareCard|readSharedThread|readSharedAttachment|revokeEmailShare|listThreadShares|listShareTargets|listMessageShares|createShareLink|revokeShareLink|resolveShareLink|defaultEmailShareDeps/,
        )
        expect(check, `${file} ${h[1]}`).toBeGreaterThan(-1)
        expect(reach, `${file} ${h[1]}`).toBeGreaterThan(check)
      })
    }
  })

  it('in the service, the access check runs before any mailbox call', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/email-share/service.ts'), 'utf8')
    const fn = (name: string) => {
      const at = src.indexOf(`export async function ${name}(`)
      expect(at, name).toBeGreaterThan(-1)
      const next = src.indexOf('\nexport ', at + 1)
      return src.slice(at, next === -1 ? src.length : next)
    }
    const before = (body: string, first: string | RegExp, then: RegExp, label: string) => {
      const a = typeof first === 'string' ? body.indexOf(first) : body.search(first)
      const b = body.search(then)
      expect(a, `${label}: ${String(first)}`).toBeGreaterThan(-1)
      expect(b, `${label}: ${String(then)}`).toBeGreaterThan(a)
    }
    // Who may read: the channel rule, then revoked, then the mailbox.
    const access = fn('shareAccess')
    before(access, "rpc('team_chat_can_read'", /deps\.mailbox\(/, 'shareAccess')
    before(access, 'if (share.revoked_at)', /deps\.mailbox\(/, 'shareAccess')
    expect(access).not.toMatch(/deps\.provider/)
    for (const name of ['readShareCard', 'readSharedThread', 'readSharedAttachment']) {
      const body = fn(name)
      before(body, 'await shareAccess(', /deps\.provider|cardSummary\(|\.mailbox\b/, name)
      before(body, "if ('ok' in access) return access", /deps\.provider|cardSummary\(/, name)
    }
    // Who may share: the post rule and the owner, then the mailbox.
    const share = fn('createEmailShare')
    before(share, "rpc('team_chat_can_post'", /deps\.mailbox\(/, 'createEmailShare')
    before(share, 'await ownThread(', /deps\.mailbox\(/, 'createEmailShare')
    before(share, 'await deps.mailbox(', /deps\.provider\.threadIds/, 'createEmailShare')
  })
})

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (name === 'node_modules' || name === '.next' || name === '.eve') return []
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

/** A reference to the share's reader, by any path form: alias, relative, dynamic import, require, the directory itself. */
const READER_REF = /email-share(?:\/(?:service|provider|http|sanitize|index)(?:\.[cm]?[jt]sx?)?)?['"`]/
/** The table's name as a string ('email_share', or inside a query string), never its column email_share_id. */
const TABLE_STRING = /(['"`])[^'"`\n]*\bemail_share(?:_link)?\b[^'"`\n]*\1/
/** The link binder (reads email_share_link, makes shares, never reads mail). */
const BINDER_REF = /email-share\/bind(?:\.[cm]?[jt]sx?)?['"`]/
/** The one place outside the share's own code that may bind pasted links: the message post route. */
const POST_ROUTE = 'src/app/api/account/team-chat/channels/[id]/messages/route.ts'

describe('tripwire: only the share routes reach a share’s mail', () => {
  it('catches every form of reaching for it (the patterns themselves)', () => {
    for (const line of [
      "import { readSharedThread } from '@/lib/email-share/service'",
      "import { liveSharedMessage } from '../../email-share/provider'",
      "import { shareCaller } from '../email-share/http.ts'",
      "const m = await import('@/lib/email-share/service')",
      "const m = require('../../lib/email-share/provider')",
      'const m = await import(`@/lib/email-share/service`)',
      "export * from '@/lib/email-share'",
    ]) {
      expect(READER_REF.test(line), line).toBe(true)
    }
    expect(READER_REF.test("import { EMAIL_SHARE_AGENT_NOTICE } from '@/lib/email-share/types'")).toBe(false)
    for (const line of ["svc.from('email_share')", 'svc.from("email_share").select()', "const q = 'select id from email_share where id = $1'", 'db.from(`email_share`)']) {
      expect(TABLE_STRING.test(line), line).toBe(true)
    }
    expect(TABLE_STRING.test("select('id, email_share_id')")).toBe(false)
    expect(TABLE_STRING.test("svc.from('email_share_link').select('token')")).toBe(true)
    expect(BINDER_REF.test("import { bindEmailShareLinks } from '@/lib/email-share/bind'")).toBe(true)
    expect(BINDER_REF.test("await import('../../lib/email-share/bind.ts')")).toBe(true)
  })

  it('no agent, tool, MCP, loop, job or chat code reaches the share reader or its table', () => {
    const cwd = process.cwd()
    const files = [...walk(join(cwd, 'src')), ...walk(join(cwd, 'agents'))].filter((f) => /\.(c|m)?(t|j)sx?$/.test(f))
    const allowed = (rel: string) => rel.startsWith('src/lib/email-share/') || rel.startsWith('src/app/api/account/email/shares/')
    const offenders: string[] = []
    for (const f of files) {
      const rel = relative(cwd, f)
      if (allowed(rel)) continue
      const src = readFileSync(f, 'utf8')
      if (READER_REF.test(src)) offenders.push(`${rel}: imports the share reader`)
      if (TABLE_STRING.test(src)) offenders.push(`${rel}: names the email_share or email_share_link table`)
      if (BINDER_REF.test(src) && rel !== POST_ROUTE) offenders.push(`${rel}: binds share links`)
    }
    expect(offenders).toEqual([])
  })
})

describe('the link binder', () => {
  it('reads link and share rows only: no mailbox read, no share reader', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/email-share/bind.ts'), 'utf8')
    expect(src).not.toMatch(/from ['"`]\.\/(service|provider|http|sanitize)['"`]/)
    expect(src).not.toMatch(/liveShared|liveThreadMessageIds|readEmailThread|gmail|graph\.microsoft/i)
    // Its only importer outside the share's code is the post route.
    const post = readFileSync(join(process.cwd(), POST_ROUTE), 'utf8')
    expect(BINDER_REF.test(post)).toBe(true)
  })
})

/**
 * Support chat's app side (migration 715): who our staff are, how a
 * customer's conversation shows in our list, when the routes answer for
 * staff, the welcome's words, and who a message notifies.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isSupportStaffUser, resetSupportStaffSync, supportIdentity, syncSupportStaff } from '../staff'
import { supportInboxChannel, type SupportInboxRow } from '../store'
import { isCustomerSupportView, isStaffSupportView } from '../access'
import { tidyWelcomeTemplate, welcomeWords } from '../welcome'
import { defaultNotifyLevel, notifyLevelOf, supportStaffRecipients, teamChatPlace, teamChatRecipients, type TeamChatNotifyCandidate } from '@/lib/team-chat/notify'

const ADMIN = 'sam@example.com'

beforeEach(() => {
  vi.stubEnv('ADMIN_EMAILS', ADMIN)
  resetSupportStaffSync()
})
afterEach(() => vi.unstubAllEnvs())

describe('who our support team is', () => {
  it('the deployment’s admins, by address, and nobody else', () => {
    expect(isSupportStaffUser({ email: 'Sam@Example.com' })).toBe(true)
    expect(isSupportStaffUser({ email: 'ana@example.com' })).toBe(false)
    expect(isSupportStaffUser(null)).toBe(false)
  })

  it('their name and picture: the account’s own, https pictures only, capped', () => {
    expect(supportIdentity({ email: ADMIN, user_metadata: { full_name: '  Sam   Lee ', avatar_url: 'https://example.com/a.png' } })).toEqual({
      display_name: 'Sam Lee',
      avatar_url: 'https://example.com/a.png',
    })
    expect(supportIdentity({ email: ADMIN, user_metadata: { avatar_url: 'http://example.com/a.png' } })).toEqual({ display_name: 'sam', avatar_url: null })
    expect(supportIdentity({ email: ADMIN, user_metadata: { name: 'x'.repeat(80) } }).display_name).toHaveLength(60)
  })

  function svc() {
    const upserts: unknown[] = []
    const client = {
      from: () => ({
        upsert: async (row: unknown) => {
          upserts.push(row)
          return { error: null }
        },
        select: async () => ({ data: [{ user_id: 'u-sam' }], error: null }),
        delete: () => ({ eq: async () => ({ error: null }) }),
      }),
      auth: { admin: { getUserById: async () => ({ data: { user: { email: ADMIN } } }) } },
    } as unknown as SupabaseClient
    return { client, upserts }
  }

  it('an admin is put on the team once, and not written again while nothing changed', async () => {
    const { client, upserts } = svc()
    const sam = { id: 'u-sam', email: ADMIN, user_metadata: { full_name: 'Sam' } }
    expect(await syncSupportStaff(client, sam)).toBe(true)
    expect(await syncSupportStaff(client, sam)).toBe(true)
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toMatchObject({ user_id: 'u-sam', display_name: 'Sam', avatar_url: null })
  })

  it('anyone else writes nothing', async () => {
    const { client, upserts } = svc()
    expect(await syncSupportStaff(client, { id: 'u-ana', email: 'ana@example.com', user_metadata: {} })).toBe(false)
    expect(upserts).toHaveLength(0)
  })
})

const ROW: SupportInboxRow = {
  channel_id: 'c1',
  workspace_id: 'w-ana',
  workspace_name: 'Ana’s Workspace',
  name: 'Native Intelligence Support x Ana Ruiz',
  customer_user_id: 'u-ana',
  customer_member_id: 'm-ana',
  customer_name: 'Ana Ruiz',
  customer_email: 'ana@example.com',
  created_at: '2026-11-23T10:00:00Z',
  last_message_at: null,
  unread: 2,
}

describe('our side’s list', () => {
  it('a customer’s conversation: theirs, every message counts, never muted', () => {
    const c = supportInboxChannel(ROW)
    expect(c).toMatchObject({ id: 'c1', kind: 'support', unread: 2, mentions: 0, notify: 'all', dm_member_id: null, last_message_at: ROW.created_at })
    expect(c.support).toMatchObject({ workspace_id: 'w-ana', customer_name: 'Ana Ruiz', customer_email: 'ana@example.com', customer_member_id: 'm-ana' })
  })

  it('a customer with no name is their address’s first part', () => {
    expect(supportInboxChannel({ ...ROW, customer_name: ' ' }).support?.customer_name).toBe('ana')
  })
})

describe('when the routes answer for our staff', () => {
  const staff = { workspaceId: 'w-ours', user: { email: ADMIN } }
  it('a support conversation in another workspace, for an admin', () => {
    expect(isStaffSupportView({ kind: 'support', workspace_id: 'w-ana' }, staff)).toBe(true)
  })
  it('never an ordinary channel, never our own workspace’s, never a non-admin', () => {
    expect(isStaffSupportView({ kind: 'channel', workspace_id: 'w-ana' }, staff)).toBe(false)
    expect(isStaffSupportView({ kind: 'support', workspace_id: 'w-ours' }, staff)).toBe(false)
    expect(isStaffSupportView({ kind: 'support', workspace_id: 'w-ana' }, { workspaceId: 'w-ours', user: { email: 'ana@example.com' } })).toBe(false)
    expect(isStaffSupportView(null, staff)).toBe(false)
  })
  it('the customer’s own is theirs, as an ordinary conversation', () => {
    expect(isCustomerSupportView({ kind: 'support', workspace_id: 'w-ana' }, { workspaceId: 'w-ana' })).toBe(true)
    expect(isCustomerSupportView({ kind: 'dm', workspace_id: 'w-ana' }, { workspaceId: 'w-ana' })).toBe(false)
  })
})

describe('the welcome', () => {
  it('names them as the database does: {name} an @-mention, {first_name} their first word', () => {
    expect(welcomeWords('Hi {name}! Glad you’re here, {first_name}.', 'Ana Ruiz')).toBe('Hi @Ana Ruiz! Glad you’re here, Ana.')
    expect(welcomeWords('Hi {name}', '  ')).toBe('Hi @there')
  })
  it('is held to its cap, trimmed', () => {
    expect(tidyWelcomeTemplate('  Hello\r\nthere  ')).toBe('Hello\nthere')
    expect(tidyWelcomeTemplate('   ')).toBeNull()
    expect(tidyWelcomeTemplate('x'.repeat(2001))).toBeNull()
    expect(tidyWelcomeTemplate(3)).toBeNull()
  })
})

describe('who a support message notifies', () => {
  const candidate = (over: Partial<TeamChatNotifyCandidate>): TeamChatNotifyCandidate => ({
    member_id: 'm-ana',
    user_id: 'u-ana',
    is_author: false,
    in_dm: false,
    mentioned: false,
    in_thread: false,
    asked: false,
    notify_level: null,
    can_read: true,
    read_past: false,
    ...over,
  })

  it('is every message by default, as a DM, and says “Support”', () => {
    expect(defaultNotifyLevel('support')).toBe('all')
    expect(notifyLevelOf('support', null)).toBe('all')
    expect(teamChatPlace({ kind: 'support', name: 'Native Intelligence Support x Ana Ruiz' })).toBe('Support')
  })

  it('our staff’s message reaches the customer; muted, it doesn’t', () => {
    const msg = { author_kind: 'support' as const, thread_root_id: null }
    expect(teamChatRecipients(msg, 'support', [candidate({})])).toEqual([{ memberId: 'm-ana', userId: 'u-ana', reason: 'all' }])
    expect(teamChatRecipients(msg, 'support', [candidate({ notify_level: 'muted' })])).toEqual([])
  })

  it('a customer’s message reaches each of our staff, in their first workspace', async () => {
    const tables: Record<string, unknown[]> = {
      support_staff: [{ user_id: 'u-sam' }, { user_id: 'u-kim' }],
      member: [
        { id: 'm-sam-1', user_id: 'u-sam', workspace_id: 'w-ours', created_at: '1' },
        { id: 'm-kim-1', user_id: 'u-kim', workspace_id: 'w-ours', created_at: '2' },
        { id: 'm-sam-2', user_id: 'u-sam', workspace_id: 'w-other', created_at: '3' },
      ],
    }
    const query = (rows: unknown[]) => {
      const q = { in: () => q, eq: () => q, order: async () => ({ data: rows, error: null }), then: (r: (v: unknown) => void) => r({ data: rows, error: null }) }
      return q
    }
    const svc = { from: (t: string) => ({ select: () => query(tables[t] ?? []) }) } as unknown as SupabaseClient
    expect(await supportStaffRecipients(svc)).toEqual([
      { memberId: 'm-sam-1', userId: 'u-sam', workspaceId: 'w-ours', reason: 'all' },
      { memberId: 'm-kim-1', userId: 'u-kim', workspaceId: 'w-ours', reason: 'all' },
    ])
  })

  it('never someone who muted that conversation', async () => {
    const rows: Record<string, unknown[]> = {
      support_staff: [{ user_id: 'u-sam' }, { user_id: 'u-kim' }],
      support_chat_read: [{ user_id: 'u-kim' }],
      member: [{ id: 'm-sam-1', user_id: 'u-sam', workspace_id: 'w-ours', created_at: '1' }],
    }
    const seen: string[][] = []
    const query = (table: string) => {
      const q = {
        in: (_c: string, ids: string[]) => {
          seen.push(ids)
          return q
        },
        eq: () => q,
        order: async () => ({ data: rows[table], error: null }),
        then: (r: (v: unknown) => void) => r({ data: rows[table], error: null }),
      }
      return q
    }
    const svc = { from: (t: string) => ({ select: () => query(t) }) } as unknown as SupabaseClient
    expect((await supportStaffRecipients(svc, 'c1')).map((r) => r.userId)).toEqual(['u-sam'])
    expect(seen).toEqual([['u-sam']])
  })

  it('nobody before 715 (no staff table)', async () => {
    const svc = { from: () => ({ select: async () => ({ data: null, error: { code: '42P01', message: 'relation does not exist' } }) }) } as unknown as SupabaseClient
    expect(await supportStaffRecipients(svc)).toEqual([])
  })
})

describe('714’s Edit, Rename and Delete never reach a support conversation', () => {
  it('the list never says can_manage for one, not even to its workspace’s owner (its customer)', async () => {
    const { canManageChannel } = await import('@/lib/team-chat/store')
    expect(canManageChannel({ kind: 'support', created_by: null }, { memberId: 'm-ana', role: 'owner' })).toBe(false)
    expect(canManageChannel({ kind: 'support', created_by: 'm-ana' }, { memberId: 'm-ana', role: 'admin' })).toBe(false)
    // Unchanged for the kinds 714 manages.
    expect(canManageChannel({ kind: 'channel', created_by: null }, { memberId: 'm-ana', role: 'owner' })).toBe(true)
  })

  it('the menu offers nothing for one, even if told it may', async () => {
    const { manageChoices } = await import('@/app/account/(dashboard)/views/team-chat-manage')
    expect(manageChoices({ kind: 'support', can_manage: true })).toEqual([])
    expect(manageChoices({ kind: 'channel', can_manage: true }).map((c) => c.what)).toEqual(['edit', 'delete'])
  })

  it('714’s team_chat_can_manage takes channels and meeting chats only, and 715 doesn’t restate it', async () => {
    const { migrationsInOrder } = await import('@/test/migration-sql')
    const all = migrationsInOrder()
    const last = all.filter((m) => /create or replace function public\.team_chat_can_manage\(/i.test(m.sql)).at(-1)
    expect(last?.num).toBe(714)
    const body = last!.sql.slice(last!.sql.search(/create or replace function public\.team_chat_can_manage\(/i))
    expect(body.slice(0, 2000)).toMatch(/kind in \('channel', 'meeting'\)/)
  })
})

describe('the dashboard asks once per browser session (719)', () => {
  it('claims the ask once, and asks anyway where storage fails', async () => {
    const { claimSupportDueAsk, SUPPORT_DUE_SESSION_KEY } = await import('../use-support-chat-due')
    const store = new Map<string, string>()
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) }
    expect(claimSupportDueAsk(storage)).toBe(true)
    expect(store.get(SUPPORT_DUE_SESSION_KEY)).toBe('1')
    expect(claimSupportDueAsk(storage)).toBe(false)
    const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => undefined }
    expect(claimSupportDueAsk(broken)).toBe(true)
    expect(claimSupportDueAsk(null)).toBe(true)
  })

  it('the existing accounts’ default welcome reads as for someone who has been here a while', async () => {
    const { DEFAULT_EXISTING_WELCOME } = await import('../welcome')
    expect(welcomeWords(DEFAULT_EXISTING_WELCOME, 'Ana Ruiz')).toBe('Hi @Ana Ruiz, you can now reach our team directly here. Ask us anything, and tell us about bugs or ideas any time.')
    // 719 seeds the same words.
    const { migrationsInOrder } = await import('@/test/migration-sql')
    expect(migrationsInOrder().find((m) => m.file === '719_support_chat_existing.sql')?.sql).toContain(`'${DEFAULT_EXISTING_WELCOME}'`)
  })
})

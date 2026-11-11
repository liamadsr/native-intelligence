/**
 * Migrations 560-561 (team chat, phase 2: messages reach you). Every new
 * function is a definer with a pinned search_path and explicit grants (the
 * candidates read is the service role's alone); the search reads only the
 * channels the CALLER may read, inside the function, and never a deleted
 * message; reading a channel or a thread reads its notifications; the widened
 * checks are exactly what the app writes. Run on DEV by
 * supabase/tests/560_team_chat_reach.sql (inside a rolled-back block); this
 * pins the files' text.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { NOTIFICATION_TYPES } from '@/lib/notifications'
import type { ReachClaimChannel, ReachRefType } from '@/lib/reach/notice'
import { TEAM_CHAT_NOTIFY_LEVELS } from '../notify'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const bodyOf = (sql: string) => sql.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')
const flat = (sql: string) => bodyOf(sql).replace(/\s+/g, ' ')

const REACH = read('560_team_chat_reach.sql')
const SEARCH = read('561_team_chat_search.sql')
const FILES = { reach: REACH, search: SEARCH }
const PROBES = readFileSync(join(process.cwd(), 'supabase/tests/560_team_chat_reach.sql'), 'utf8')

function fn(sql: string, name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`)
  expect(start, name).toBeGreaterThanOrEqual(0)
  return sql.slice(start, sql.indexOf('$$;', start))
}
const quoted = (list: string) => [...list.matchAll(/'([a-z_]+)'/g)].map((v) => v[1])

describe('migrations 560-561', () => {
  it('each is safe for a live database and the hand-applying transport, and reloads the API schema', () => {
    for (const [name, sql] of Object.entries(FILES)) {
      const body = bodyOf(sql)
      expect(sql, name).not.toContain('\\')
      // The only delete is the trigger's (a deleted message's notifications), inside its function.
      expect(body.replace(/as \$\$[\s\S]*?\$\$;/g, ''), name).not.toMatch(/drop table|delete from|truncate|drop column|drop function/i)
      // One transaction whatever applies it (plain psql too): begin first, then the lock timeout, the reload, commit last.
      expect(body, name).toMatch(/^\s*begin;\s*SET LOCAL lock_timeout = '5s';/)
      expect(body.trimEnd().endsWith("notify pgrst, 'reload schema';\n\ncommit;"), name).toBe(true)
      expect((body.match(/^(begin|commit);$/gm) ?? []).length, name).toBe(2)
      expect(body, name).not.toMatch(/concurrently|vacuum/i)
      expect(body, name).not.toMatch(/to anon/)
      expect(body, name).not.toMatch(/create index (?!if not exists)/)
      expect(body, name).not.toMatch(/add column (?!if not exists)/)
      for (const [, c] of body.matchAll(/add constraint (\w+)/g)) {
        expect(body, c).toContain(`drop constraint if exists ${c};`)
        // Added NOT VALID, then validated (no long lock on a live table).
        expect(body, c).toMatch(new RegExp(`add constraint ${c} check \\([\\s\\S]*?\\) not valid;`))
        expect(body, c).toContain(`validate constraint ${c};`)
      }
    }
  })

  it('every function is a definer with a pinned search_path, revoked from public and anon, granted to one role', () => {
    const fns: Array<[string, string, string]> = [
      [REACH, 'team_chat_set_notify', 'authenticated'],
      [REACH, 'team_chat_mark_read', 'authenticated'],
      [REACH, 'team_chat_mark_thread_read', 'authenticated'],
      [REACH, 'team_chat_notify_candidates', 'service_role'],
      [REACH, 'team_chat_readable_messages', 'service_role'],
      [SEARCH, 'team_chat_search', 'authenticated'],
    ]
    for (const [sql, name, role] of fns) {
      const body = fn(sql, name)
      expect(body, name).toContain('security definer')
      expect(body, name).toContain('set search_path = public, pg_temp')
      expect(flat(sql), name).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon`))
      expect(flat(sql), name).toMatch(new RegExp(`grant execute on function public\\.${name}\\([^)]*\\) to ${role};`))
    }
    // Who a message may notify is the server's question only.
    expect(flat(REACH)).toContain('revoke all on function public.team_chat_notify_candidates(uuid) from public, anon, authenticated;')
  })

  it('560: the level is one of the app’s, null the default, set only through the function (which asks team_chat_can_read)', () => {
    expect(quoted(/team_chat_member_notify_level check \(notify_level is null or notify_level in \(([^)]*)\)\)/.exec(flat(REACH))?.[1] ?? '')).toEqual([...TEAM_CHAT_NOTIFY_LEVELS])
    expect(bodyOf(REACH)).toContain('alter table public.team_chat_member add column if not exists notify_level text;')
    const set = fn(REACH, 'team_chat_set_notify')
    expect(set).toContain('if not public.team_chat_can_read(ch) then')
    // A first row is read up to where the count already ran from: the unread count doesn't move.
    expect(set).toContain('values (ch, me, ws, joined, level)')
    expect(set).toContain("case when ch_kind = 'dm' then 'all' else 'mentions' end")
    expect(flat(REACH)).not.toMatch(/grant (update|insert)[^;]* on (table )?public\.team_chat_member/)
  })

  it('560: notification.type and target_type are what the app writes; one per message per person', () => {
    const types = quoted(/notification_type_check check \(type = any \(array\[([^\]]*)\]\)\)/.exec(flat(REACH))?.[1] ?? '')
    // 572 widens it again (meeting_waiting, src/lib/meeting-links/__tests__/migration-572.test.ts).
    expect(types).toEqual(NOTIFICATION_TYPES.filter((t) => t !== 'meeting_waiting'))
    expect(quoted(/notification_target_type_check check \(target_type in \(([^)]*)\)\)/.exec(flat(REACH))?.[1] ?? '')).toContain('team_chat_message')
    expect(flat(REACH)).toContain("create unique index if not exists notification_team_chat_message_key on public.notification (recipient_id, target_id) where type = 'team_chat_message';")
  })

  it('560: reach_notice takes a team chat notification on email: exactly what the app claims', () => {
    const refs = quoted(/reach_notice_ref_type_check check \(ref_type in \(([^)]*)\)\)/.exec(flat(REACH))?.[1] ?? '')
    const app: Record<ReachRefType, true> = { tool_approval: true, guest_message: true, look_ahead: true, home_message: true, team_chat_notification: true }
    for (const r of Object.keys(app)) expect(refs).toContain(r)
    const channels = quoted(/reach_notice_channel_check check \(channel in \(([^)]*)\)\)/.exec(flat(REACH))?.[1] ?? '')
    const claims: Record<ReachClaimChannel, true> = { slack: true, sms: true, push: true, banner: true, email: true }
    expect([...channels].sort()).toEqual(Object.keys(claims).sort())
  })

  it('560 is the newest word on every check it widens (until 572 widens the notification ones again)', () => {
    const newest = (re: RegExp, before = Infinity) => [...migrationsInOrder()].filter((m) => m.num < before).reverse().find((m) => re.test(m.sql))!.file
    for (const check of ['reach_notice_ref_type_check', 'reach_notice_channel_check']) {
      expect(newest(new RegExp(`add constraint ${check}`, 'i')), check).toBe('560_team_chat_reach.sql')
    }
    for (const check of ['notification_type_check', 'notification_target_type_check']) {
      expect(newest(new RegExp(`add constraint ${check}`, 'i'), 572), check).toBe('560_team_chat_reach.sql')
    }
  })

  it('560: reading a channel or a thread reads the caller’s own notifications of it, nobody else’s', () => {
    const channel = fn(REACH, 'team_chat_mark_read')
    expect(channel).toContain('if not public.team_chat_can_read(ch) then')
    expect(channel).toContain("and n.group_key = 'team_chat:' || ch::text")
    expect(channel).toContain('where n.recipient_id = me')
    const thread = fn(REACH, 'team_chat_mark_thread_read')
    expect(thread).toContain('if ch is null or not public.team_chat_can_read(ch) then')
    expect(thread).toContain("and n.group_key = 'team_chat_thread:' || root::text")
    expect(thread).toContain('where n.recipient_id = me')
    // Both keep the read marks they always wrote.
    expect(channel).toContain('on conflict (channel_id, member_id) do update set last_read_at = excluded.last_read_at;')
    expect(thread).toContain('update public.team_chat_thread_member')
  })

  it('560: the candidates read never offers a deleted message or an archived channel, and says who may read it', () => {
    const c = fn(REACH, 'team_chat_notify_candidates')
    expect(c).toContain('and x.deleted_at is null')
    expect(c).toContain('and c.archived_at is null')
    expect(c).toContain('public.team_chat_member_can_read(m.channel_id, mem.id)')
    expect(c).toContain('mem.workspace_id = m.workspace_id')
  })

  it('561: the search reads only what the caller may read, inside the function, never a deleted message; the words never reach the query grammar', () => {
    const s = fn(SEARCH, 'team_chat_search')
    expect(s).toContain('public.team_chat_can_read(c.id)')
    expect(s).toContain('join readable rc on rc.id = x.channel_id')
    expect(s).toContain('and x.deleted_at is null')
    expect(s).toContain('me uuid := public.current_member_id(ws);')
    expect(s).toContain("regexp_split_to_table(lower(coalesce(left(q, 200), '')), '[^[:alnum:]]+')")
    expect(s).toContain('limit greatest(1, least(coalesce(lim, 8), 25))')
    // Full text over the same expression the index has (so the index serves it).
    expect(s).toContain("to_tsvector('english', x.body) @@ tsq")
    expect(flat(SEARCH)).toContain("create index if not exists team_chat_message_fts_idx on public.team_chat_message using gin (to_tsvector('english', body)) where deleted_at is null;")
  })

  it('560: a notification says its message as it is now: written only for a live message (locked for share), with its words; an edit rewrites it, a delete removes it', () => {
    const live = fn(REACH, 'team_chat_notification_live')
    expect(live).toContain('security definer')
    expect(live).toContain('for share;')
    expect(live).toContain('if not found or m.deleted_at is not null then')
    expect(live).toContain('return null;')
    expect(live).toContain('new.body := public.team_chat_notice_snippet(m.body,')
    expect(flat(REACH)).toContain("create trigger team_chat_notification_live before insert on public.notification for each row when (new.type = 'team_chat_message') execute function public.team_chat_notification_live();")
    const follow = fn(REACH, 'team_chat_message_notices_follow')
    expect(follow).toContain('if new.deleted_at is not null then')
    expect(follow).toContain('delete from public.notification n')
    expect(follow).toContain('set body = public.team_chat_notice_snippet(new.body,')
    expect(flat(REACH)).toContain('create trigger team_chat_message_notices_follow after update of body, attachments, deleted_at on public.team_chat_message for each row when (old.deleted_at is null) execute function public.team_chat_message_notices_follow();')
    // The words as the app's copy cuts them (src/lib/team-chat/notify.ts): 140 characters, files alone said so.
    const snippet = fn(REACH, 'team_chat_notice_snippet')
    expect(snippet).toContain("when char_length(w) > 140 then rtrim(left(w, 139)) || '…'")
    expect(snippet).toContain("'Sent a file'")
    // What the away email may read: the member's own access now, never a deleted message or an archived channel.
    const readable = fn(REACH, 'team_chat_readable_messages')
    expect(readable).toContain('and x.deleted_at is null')
    expect(readable).toContain('c.archived_at is null')
    expect(readable).toContain('public.team_chat_member_can_read(x.channel_id, mem)')
  })

  it('has DEV probes for each of these', () => {
    for (const probe of ['pasted a secret, then edited it out', "a deleted message''s notifications go", 'mentioned, then removed from the private channel', 'no longer a member of the workspace', 'team_chat_readable_messages', 'team_chat_set_notify', 'team_chat_notify_candidates', 'team_chat_mark_read', 'team_chat_mark_thread_read', 'team_chat_search', 'NON-MEMBER of a private team channel finds nothing', 'a DM OUTSIDER finds nothing', 'a deleted message is never found']) {
      expect(PROBES, probe).toContain(probe)
    }
    expect(PROBES.trimEnd().endsWith('rollback;')).toBe(true)
  })
})

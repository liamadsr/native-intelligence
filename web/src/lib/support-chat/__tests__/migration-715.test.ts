/**
 * Migration 715 (support chat), read as text: what the database must hold for
 * a customer's support conversation to reach our staff and nothing else.
 *
 * Rehearsed on a local Postgres 16 with stand-ins for Supabase's roles, auth
 * and storage and the tables it touches: applied twice, then 60 checks
 * passed (sign-up with and without staff; the welcome and its mention; one
 * per account; a name never from an address; the customer reads, posts,
 * mutes and deletes theirs, and can't rename, archive, leave, thread, call,
 * poll or grant; nothing restarts a deleted one but an admin; the first-load
 * start for accounts made since; a teammate can't read it; staff read
 * support conversations and their files only, post, retry, delete their own,
 * mute, mark read, and can't delete a conversation; nobody else reads the
 * inbox; the merge's re-stamp, a workspace's and an account's deletion). See
 * docs/plans/support-chat.md.
 */
import { describe, expect, it } from 'vitest'
import { migrationsInOrder, type MigrationFile } from '@/test/migration-sql'

const ALL = migrationsInOrder()
const FILE = ALL.find((m) => m.file === '715_support_chat.sql')
const SQL = FILE?.sql ?? ''

/** Every `create or replace function public.<fn>(` block in a file (any case), to its closing dollar quote and semicolon. */
function blocksIn(sql: string, fn: string): string[] {
  const re = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\s*\\(`, 'gi')
  const out: string[] = []
  for (const m of sql.matchAll(re)) {
    const start = m.index ?? 0
    const tag = /\$(\w*)\$/.exec(sql.slice(start))
    if (!tag) continue
    const open = start + (tag.index ?? 0)
    const close = sql.indexOf(tag[0], open + tag[0].length)
    const semi = sql.indexOf(';', close + tag[0].length)
    out.push(sql.slice(start, semi + 1))
  }
  return out
}

/** The newest file before 715 that defines `fn`, and its block. */
function before715(fn: string): { file: string; block: string } {
  const earlier = ALL.filter((m) => m.num < 715)
  for (let i = earlier.length - 1; i >= 0; i--) {
    const blocks = blocksIn(earlier[i].sql, fn)
    if (blocks.length) return { file: earlier[i].file, block: blocks[blocks.length - 1] }
  }
  return { file: '(none)', block: '' }
}

/** The newest file of all that defines `fn`. */
function newest(fn: string, files: MigrationFile[] = ALL): string {
  for (let i = files.length - 1; i >= 0; i--) if (blocksIn(files[i].sql, fn).length) return files[i].file
  return '(none)'
}

/** The body between the dollar quotes, whitespace collapsed. */
function body(block: string): string {
  const tag = /\$(\w*)\$/.exec(block)
  if (!tag) return ''
  const open = (tag.index ?? 0) + tag[0].length
  return block.slice(open, block.indexOf(tag[0], open)).replace(/\s+/g, ' ').trim()
}

const DEFINED = [...SQL.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(/gi)].map((m) => m[1])

describe('migration 715: the file', () => {
  it('is there, one transaction, under lock_timeout, and reloads the API schema last', () => {
    expect(FILE).toBeDefined()
    expect(SQL).toMatch(/^begin;$/m)
    expect(SQL).toMatch(/SET LOCAL lock_timeout = '5s';/)
    expect(SQL.trimEnd()).toMatch(/notify pgrst, 'reload schema';\s*commit;$/)
    expect(SQL).toContain('How to apply')
    expect(SQL).not.toContain('\\')
  })

  it('pins search_path on every function and revokes each from public and anon', () => {
    expect(DEFINED.length).toBeGreaterThan(15)
    for (const fn of new Set(DEFINED)) {
      for (const block of blocksIn(SQL, fn)) {
        expect(block, fn).toMatch(/set search_path (=|to) '?public'?, '?pg_temp'?/i)
      }
    }
    const NEW = ['is_support_staff', 'support_chat_staff_can_read', 'support_chat_channel_guard', 'support_chat_member_guard', 'support_chat_no_thread',
      'support_chat_no_call', 'support_chat_no_grant', 'support_chat_inbox', 'support_chat_post', 'support_chat_delete', 'support_chat_mark_read',
      'support_chat_welcome_words', 'support_chat_start', 'support_chat_on_signup', 'support_chat_mute', 'support_chat_remove', 'support_chat_start_if_due']
    for (const fn of NEW) {
      expect(DEFINED, fn).toContain(fn)
      expect(SQL, fn).toMatch(new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon`))
    }
  })

  it('gives staff their functions as themselves, and the start to the service role only', () => {
    for (const fn of ['support_chat_inbox()', 'support_chat_post(uuid, text, uuid)', 'support_chat_delete(uuid)', 'support_chat_mark_read(uuid)', 'support_chat_mute(uuid, boolean)', 'support_chat_remove(uuid)']) {
      expect(SQL).toContain(`grant execute on function public.${fn} to authenticated, service_role;`)
    }
    for (const fn of ['support_chat_start(uuid, boolean)', 'support_chat_start_if_due(uuid)']) {
      expect(SQL).toContain(`revoke all on function public.${fn} from public, anon, authenticated;`)
      expect(SQL).toContain(`grant execute on function public.${fn} to service_role;`)
    }
    // The four tables are nobody's but the service role's.
    for (const t of ['support_staff', 'support_chat_settings', 'support_chat_read', 'support_chat_deleted']) {
      expect(SQL).toContain(`revoke all on table public.${t} from public, anon, authenticated;`)
      expect(SQL).toContain(`alter table public.${t} enable row level security;`)
    }
  })
})

describe('migration 715: who reads a support conversation', () => {
  it('the two team chat readers take it as a DM’s members, from 572’s text and nothing else', () => {
    for (const fn of ['team_chat_can_read', 'team_chat_member_can_read']) {
      const prior = before715(fn)
      expect(prior.file, fn).toBe('572_meeting_conversations.sql')
      const mine = blocksIn(SQL, fn)
      expect(mine).toHaveLength(1)
      expect(body(mine[0])).toBe(body(prior.block).replace(/kind in \('dm', 'meeting'\)/g, "kind in ('dm', 'meeting', 'support')"))
      expect(newest(fn)).toBe('715_support_chat.sql')
    }
  })

  it('leaves the seven record-grant readers alone (a grant to it reaches nobody), and refuses one', () => {
    for (const fn of ['my_entity_grant_ids', 'entity_grant_reaches', 'entity_grant_ids_for', 'my_entity_edit_grant_ids', 'entity_edit_grant_reaches', 'entity_visible_to']) {
      expect(blocksIn(SQL, fn), fn).toHaveLength(0)
      const last = ALL.filter((m) => m.num < 715).reverse().find((m) => blocksIn(m.sql, fn).length)
      // Their channel arms name 'channel' and ('dm', 'meeting'): never 'support'.
      for (const block of blocksIn(last?.sql ?? '', fn)) expect(block, fn).not.toContain("'support'")
    }
    expect(SQL).toMatch(/create trigger support_chat_no_grant\s+before insert or update of grantee_kind, grantee_channel_id on public\.entity_access/)
  })

  it('lets staff read support conversations only: the row, its messages, its files', () => {
    expect(SQL).toMatch(/create policy team_chat_channel_support_staff_select on public\.team_chat_channel\s+for select to authenticated using \(kind = 'support' and public\.is_support_staff\(\)\);/)
    expect(SQL).toMatch(/create policy team_chat_message_support_staff_select on public\.team_chat_message\s+for select to authenticated using \(public\.support_chat_staff_can_read\(channel_id\)\);/)
    expect(SQL).toMatch(/bucket_id = 'team-chat-files'\s+and public\.support_chat_staff_can_read\(public\.team_chat_file_channel\(name\)\)/)
    expect(body(blocksIn(SQL, 'support_chat_staff_can_read')[0])).toBe(
      "select public.is_support_staff() and exists (select 1 from public.team_chat_channel c where c.id = ch and c.kind = 'support');",
    )
    expect(body(blocksIn(SQL, 'is_support_staff')[0])).toContain('s.user_id = auth.uid()')
    // No policy lets staff insert or update anything: they write through the functions.
    expect(SQL).not.toMatch(/create policy \w+ on public\.team_chat_message\s+for (insert|update)/)
  })

  it('checks the staff row in every staff function', () => {
    expect(body(blocksIn(SQL, 'support_chat_post')[0])).toContain('select * into s from public.support_staff where user_id = auth.uid()')
    expect(body(blocksIn(SQL, 'support_chat_post')[0])).toContain("where id = ch and kind = 'support'")
    expect(body(blocksIn(SQL, 'support_chat_delete')[0])).toContain('x.support_user_id = auth.uid()')
    expect(body(blocksIn(SQL, 'support_chat_mark_read')[0])).toContain('public.support_chat_staff_can_read(ch)')
    expect(body(blocksIn(SQL, 'support_chat_inbox')[0])).toContain("c.kind = 'support' and public.is_support_staff()")
  })
})

describe('migration 715: restated functions are their newest text plus exactly these changes', () => {
  // Each: the newest definition before 715, and every change 715 makes to its body (old -> new).
  const RESTATED: Array<[string, string, Array<[string, string]>]> = [
    [
      'team_chat_message_guard',
      '670_meeting_guest_chat.sql',
      [
        [
          'or new.guest_name is distinct from old.guest_name then',
          'or new.guest_name is distinct from old.guest_name or (new.support_user_id is not null and new.support_user_id is distinct from old.support_user_id) or new.support_name is distinct from old.support_name or new.support_avatar_url is distinct from old.support_avatar_url then',
        ],
      ],
    ],
    [
      'team_chat_notify_candidates',
      '702_channel_snooze_inbox_hold.sql',
      [
        ["(m.channel_kind = 'dm' or tm.notify_level = 'all')", "(m.channel_kind in ('dm', 'support') or tm.notify_level = 'all')"],
        ["case when m.channel_kind = 'dm' then 'all'", "case when m.channel_kind in ('dm', 'support') then 'all'"],
      ],
    ],
    ['team_chat_set_notify', '560_team_chat_reach.sql', [["case when ch_kind = 'dm' then 'all'", "case when ch_kind in ('dm', 'support') then 'all'"]]],
    [
      'team_chat_search',
      '670_meeting_guest_chat.sql',
      [
        ['x.agent_name, x.body,', 'x.agent_name, x.support_name, x.body,'],
        ["when rc.dm_key = me::text", "when rc.kind = 'support' then coalesce(rc.name, 'Support') when rc.dm_key = me::text"],
        ["coalesce(h.agent_name, 'Agent') else", "coalesce(h.agent_name, 'Agent') when h.author_kind = 'support' then coalesce(h.support_name, 'Support') else"],
      ],
    ],
  ]
  for (const [fn, from, changes] of RESTATED) {
    it(`${fn}: ${from}'s text, with ${changes.length} change${changes.length === 1 ? '' : 's'}`, () => {
      const prior = before715(fn)
      expect(prior.file).toBe(from)
      const mine = blocksIn(SQL, fn)
      expect(mine).toHaveLength(1)
      let want = body(prior.block)
      for (const [from, to] of changes) {
        expect(want, `${fn}: ${from}`).toContain(from)
        want = want.split(from).join(to)
      }
      expect(body(mine[0])).toBe(want)
      expect(newest(fn)).toBe('715_support_chat.sql')
    })
  }

  it('the guard holds the support columns; search names our staff', () => {
    const guard = body(blocksIn(SQL, 'team_chat_message_guard')[0])
    expect(guard).toContain('or (new.support_user_id is not null and new.support_user_id is distinct from old.support_user_id)')
    expect(guard).toContain('or new.support_name is distinct from old.support_name')
    expect(guard).toContain('or new.support_avatar_url is distinct from old.support_avatar_url')
    const search = body(blocksIn(SQL, 'team_chat_search')[0])
    expect(search).toContain("when h.author_kind = 'support' then coalesce(h.support_name, 'Support')")
    expect(search).toContain("when rc.kind = 'support' then coalesce(rc.name, 'Support')")
  })
})

describe('migration 715: the conversation itself', () => {
  it('is one per account, and only a support conversation carries an account', () => {
    expect(SQL).toMatch(/create unique index if not exists team_chat_channel_support_key\s+on public\.team_chat_channel \(support_user_id\)\s+where kind = 'support';/)
    expect(SQL).toContain("(kind = 'support' and name is not null and char_length(name) between 1 and 80 and dm_key is null and team_id is null and support_user_id is not null)")
    expect((SQL.match(/and support_user_id is null\)/g) ?? []).length).toBe(3)
    expect(body(blocksIn(SQL, 'support_chat_start')[0])).toContain("on conflict (support_user_id) where kind = 'support' do nothing")
  })

  it('a staff message carries nobody else, and nobody else’s carries ours', () => {
    expect(SQL).toContain("check (author_kind in ('member', 'agent', 'guest', 'support'))")
    expect((SQL.match(/and support_user_id is null and support_name is null and support_avatar_url is null\)/g) ?? []).length).toBe(3)
    expect(SQL).toContain("or (author_kind = 'support' and author_member_id is null and agent_name is null and agent_for_member_id is null")
  })

  it('is refused a thread, a call and a poll; a signed-in client never renames, archives, deletes or leaves it, a cascade still can', () => {
    expect(SQL).toMatch(/create trigger support_chat_no_thread\s+before insert on public\.team_chat_message/)
    expect(SQL).toMatch(/create trigger support_chat_no_call\s+before insert on public\.team_call/)
    expect(SQL).toMatch(/create trigger support_chat_no_poll\s+before insert on public\.team_chat_poll/)
    const guard = body(blocksIn(SQL, 'support_chat_channel_guard')[0])
    expect(guard).toContain("if coalesce(auth.role(), '') <> 'authenticated' then")
    expect(guard).toContain("if old.kind = 'support' and pg_trigger_depth() <= 1 and coalesce(current_setting('support_chat.removing', true), '') <> old.id::text then")
    for (const col of ['name', 'topic', 'team_id', 'dm_key', 'workspace_id', 'archived_at', 'support_user_id', 'kind', 'created_by']) {
      expect(guard, col).toContain(`new.${col} is distinct from old.${col}`)
    }
    // last_message_at moves with every message (474's touch, under the customer's session).
    expect(guard).not.toContain('last_message_at')
    expect(body(blocksIn(SQL, 'support_chat_member_guard')[0])).toContain('pg_trigger_depth() <= 1')
  })

  it('starts at sign-up, after the first workspace is made, and never fails a sign-up', () => {
    // Triggers on one event fire in name order: 013's on_auth_user_created makes the workspace first.
    expect('on_auth_user_created' < 'on_auth_user_created_support_chat').toBe(true)
    expect(SQL).toMatch(/create trigger on_auth_user_created_support_chat\s+after insert on auth\.users/)
    const onSignup = body(blocksIn(SQL, 'support_chat_on_signup')[0])
    expect(onSignup).toContain('perform public.support_chat_start(new.id); exception when others then')
    expect(onSignup).toContain('return new;')
  })

  it('welcomes them by name with an @-mention of their member row', () => {
    const start = body(blocksIn(SQL, 'support_chat_start')[0])
    expect(start).toContain("else left('Native Intelligence Support x ' || left(btrim(me.display_name), 50), 80)")
    // Never from their address: a name that is only its first part leaves the name plain.
    expect(start).toContain("or lower(btrim(me.display_name)) = address then 'Native Intelligence Support'")
    expect(start).toContain("case when position(('@' || person) in body) > 0 then array[me.id] else '{}'::uuid[] end")
    expect(start).toContain("now() - interval '1 second'")
    expect(SQL).toMatch(/values \(true, 'Hi \{name\}, welcome to Native Intelligence!/)
  })
})

describe('migration 715: the customer deletes theirs', () => {
  it('only their own, completely, and nothing starts another by itself', () => {
    const remove = body(blocksIn(SQL, 'support_chat_remove')[0])
    expect(remove).toContain('c.support_user_id is distinct from auth.uid() or not public.team_chat_can_read(ch) then return null;')
    expect(remove).toContain("delete from public.notification n where n.group_key = 'team_chat:' || ch::text;")
    expect(remove).toContain('insert into public.support_chat_deleted')
    expect(remove).toContain("perform set_config('support_chat.removing', ch::text, true); delete from public.team_chat_channel where id = ch;")
    const start = body(blocksIn(SQL, 'support_chat_start')[0])
    expect(start).toContain("if not coalesce(p_fresh, false) then return jsonb_build_object('started', false, 'channel_id', null, 'reason', 'deleted');")
    const due = body(blocksIn(SQL, 'support_chat_start_if_due')[0])
    expect(due).toContain('u.created_at >= st.starts_from')
    expect(due).toContain('return public.support_chat_start(p_user, false);')
  })
})

describe('migration 715: the workspace merge needs nothing new', () => {
  it('its team chat step touches dm and channel only; a support conversation moves with the re-stamp', () => {
    const merge = ALL.filter((m) => blocksIn(m.sql, '_wsmerge_team_chat').length).at(-1)
    expect(merge?.file).toBe('707_fix_workspace_merge.sql')
    const block = blocksIn(merge!.sql, '_wsmerge_team_chat').at(-1)!
    expect(block).not.toContain('support')
    for (const k of block.matchAll(/kind = '(\w+)'/g)) expect(['dm', 'channel']).toContain(k[1])
  })

  it('the new tables carry no workspace_id and no member id', () => {
    for (const t of ['support_staff', 'support_chat_settings', 'support_chat_read', 'support_chat_deleted']) {
      const def = SQL.slice(SQL.indexOf(`create table if not exists public.${t} (`))
      const cols = def.slice(0, def.indexOf(');'))
      expect(cols, t).not.toContain('workspace_id')
      expect(cols, t).not.toContain('references public.member')
    }
  })
})

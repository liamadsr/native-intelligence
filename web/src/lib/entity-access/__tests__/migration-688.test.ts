/**
 * 688: a private spreadsheet or canvas can be shared with people
 * (docs/plans/record-sharing.md, Phase 1). It puts both kinds on the grant
 * store (entity_access, 492) by restating the shared grant functions from
 * their newest bodies with two arms each, gives the kinds' own read and
 * write rules a grant arm, keeps what a grant never opens closed, and widens
 * the two notification checks. The rules themselves were rehearsed on a local
 * Postgres with several people (the plan's Phase 1); this pins the file.
 */
import { describe, expect, it, vi } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { GRANTABLE_TYPES, GRANTING_HELD_TYPES } from '../model'
import { addEntityGrant } from '../store'
import type { SupabaseClient } from '@supabase/supabase-js'

const all = migrationsInOrder()
const FILE = '688_record_sharing.sql'
const sql = all.find((m) => m.file === FILE)!.sql
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

/** One function's text, from its `create or replace` to its closing `$$;`. */
function fnBlock(text: string, name: string): string {
  const start = text.search(new RegExp(`create or replace function public\\.${name}\\(`, 'i'))
  if (start < 0) return ''
  return text.slice(start, text.indexOf('\n$$;', start) + '\n$$;'.length)
}

/** The newest file, by name, that defines a function. */
function newestDefining(name: string): string {
  return [...all].reverse().find((m) => fnBlock(m.sql, name) !== '')!.file
}

const sourceOf = (file: string) => all.find((m) => m.file === file)!.sql

/** 688's two arms, as one run of lines just before the case's `else false`. */
function withoutArms(body: string): { rest: string; arms: string } {
  const lines = body.split('\n')
  const from = lines.findIndex((l) => /^\s+when 'spreadsheet' then/.test(l))
  const to = lines.findLastIndex((l) => l.trim() === 'else false')
  return { rest: [...lines.slice(0, from), ...lines.slice(to)].join('\n'), arms: lines.slice(from, to).join('\n') }
}

/** The quoted words of a list in a CHECK. */
const words = (text: string) => [...text.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
function checkList(text: string, constraint: string): string[] {
  const at = text.search(new RegExp(`add constraint ${constraint} check`, 'i'))
  return at < 0 ? [] : words(text.slice(at, text.indexOf(';', at)))
}

const RESTATED: Array<[name: string, source: string]> = [
  ['entity_access_guard', '520_data_tables.sql'],
  ['entity_grant_only', '520_data_tables.sql'],
  ['entity_edit_grant_on', '520_data_tables.sql'],
  ['entity_edit_grant_only', '520_data_tables.sql'],
  ['entity_access_can_share', '520_data_tables.sql'],
  ['entity_grant_ids_for', '601_data_tables_grant_ids.sql'],
]

describe('migration 688: the shared grant functions, newest bodies plus two arms', () => {
  for (const [name, source] of RESTATED) {
    it(`${name}: 688 is its newest definition, and is ${source.slice(0, 3)}'s body with only the two arms added`, () => {
      expect(newestDefining(name)).toBe(FILE)
      // The source was the newest before 688.
      expect(all.filter((m) => m.file !== FILE && m.file > source && fnBlock(m.sql, name) !== '').map((m) => m.file)).toEqual([])
      const { rest, arms } = withoutArms(fnBlock(sql, name))
      expect(rest).toBe(fnBlock(sourceOf(source), name))
      expect(arms.match(/when 'spreadsheet' then/g)).toHaveLength(1)
      expect(arms.match(/when 'canvas' then/g)).toHaveLength(1)
    })
  }

  it('every grantable kind has its arm in each of them, and in the entity_access CHECK', () => {
    for (const [name] of RESTATED) {
      const body = fnBlock(sql, name)
      for (const kind of GRANTABLE_TYPES) expect(body, `${name}: ${kind}`).toMatch(new RegExp(`when '${kind}' then`))
    }
    expect(checkList(sql, 'entity_access_entity_type')).toEqual([...GRANTABLE_TYPES])
  })

  it('the owner shares: a spreadsheet by its maker, a canvas by its owner, no admin arm', () => {
    const { arms } = withoutArms(fnBlock(sql, 'entity_access_can_share'))
    expect(arms).toContain('s.created_by = public.current_member_id(p_workspace)')
    expect(arms).toContain('cv.owner_member_id = public.current_member_id(p_workspace)')
    expect(arms).not.toContain('get_member_role')
  })
})

describe('migration 688: the kinds’ own rules take the grant', () => {
  it('a spreadsheet: 675’s select and update policies, as they stood, or a grant (edit to write)', () => {
    const own = "(public.is_workspace_member(workspace_id)\n     and (visibility = 'workspace' or created_by = public.current_member_id(workspace_id)))"
    const select = /create policy spreadsheet_select on public\.spreadsheet[\s\S]*?;/.exec(sql)![0]
    expect(select).toContain(own)
    expect(select).toContain("or (id = any ((select public.my_entity_grant_ids('spreadsheet'))::uuid[])\n        and public.has_entity_grant('spreadsheet', id, workspace_id))")
    const update = /create policy spreadsheet_update on public\.spreadsheet[\s\S]*?;/.exec(sql)![0]
    expect(update.split(own)).toHaveLength(3)
    expect(update.match(/public\.has_entity_edit_grant\('spreadsheet', id, workspace_id\)/g)).toHaveLength(2)
    expect(update).not.toContain('has_entity_grant(')
  })

  it('spreadsheet_entity_visible_to keeps its signature (689’s presence asks it) and gains the grant', () => {
    const body = fnBlock(sql, 'spreadsheet_entity_visible_to')
    expect(body).toMatch(/^create or replace function public\.spreadsheet_entity_visible_to\(p_id uuid, p_workspace uuid, p_user uuid\)\nreturns boolean\n/)
    expect(body).toContain("public.entity_grant_reaches('spreadsheet', p_id, v_ws, p_user)")
    expect(newestDefining('spreadsheet_entity_visible_to')).toBe(FILE)
  })

  it('a canvas: its three helpers take the grant, edit only by an edit grant and never for a guest', () => {
    for (const name of ['canvas_visible_to', 'canvas_editable_by', 'my_canvas_ids']) expect(newestDefining(name), name).toBe(FILE)
    expect(fnBlock(sql, 'canvas_visible_to')).toContain("public.entity_grant_reaches('canvas', c.id, c.workspace_id, p_user_id)")
    const edit = fnBlock(sql, 'canvas_editable_by')
    expect(edit).toContain("public.entity_edit_grant_reaches('canvas', c.id, c.workspace_id, p_user_id)")
    expect(edit).toContain("and m.role <> 'guest'")
    expect(edit).not.toContain('entity_grant_reaches(')
    const mine = fnBlock(sql, 'my_canvas_ids')
    expect(mine).toContain("select unnest(public.my_entity_grant_ids('canvas')) as id")
    expect(mine).toContain("public.has_entity_grant('canvas', c.id, c.workspace_id)")
  })

  it('the agent’s batched reads take p_grants with no default (519’s rule)', () => {
    for (const name of ['visible_spreadsheet_ids', 'visible_canvas_ids']) {
      expect(fnBlock(sql, name), name).toMatch(new RegExp(`public\\.${name}\\(p_ids uuid\\[\\], p_user_id uuid, p_grants boolean\\)`))
    }
    expect(fnBlock(sql, 'spreadsheet_visible_ungranted')).not.toContain('grant_reaches')
    expect(fnBlock(sql, 'canvas_visible_ungranted')).not.toContain('grant_reaches')
  })

  it('each new function runs as its owner with a pinned search path, and is no anon’s', () => {
    for (const name of ['spreadsheet_visible_to', 'spreadsheet_editable_by', 'spreadsheet_visible_ungranted', 'visible_spreadsheet_ids', 'canvas_visible_ungranted', 'visible_canvas_ids']) {
      expect(fnBlock(sql, name), name).toMatch(/security definer\nset search_path = public, pg_temp/)
      expect(sql, name).toMatch(new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon;`))
    }
  })
})

describe('migration 688: what a grant never opens', () => {
  it('a view grant writes no comment, and no grant deletes the record (restrictive policies)', () => {
    for (const [table, kind, column] of [['spreadsheet_comment', 'spreadsheet', 'spreadsheet_id'], ['canvas_comment', 'canvas', 'canvas_id']]) {
      for (const op of ['insert', 'update', 'delete']) {
        const name = `${table}_${op}_not_by_grant`
        const policy = new RegExp(`create policy ${name} on public\\.${table}\\s+as restrictive for ${op} to public\\s+(using|with check) \\(not public\\.entity_view_grant_only\\('${kind}', ${column}\\)\\);`)
        expect(sql, name).toMatch(policy)
      }
    }
    for (const kind of ['spreadsheet', 'canvas']) {
      expect(sql).toMatch(new RegExp(`create policy ${kind}_delete_not_by_grant on public\\.${kind}\\s+as restrictive for delete to public\\s+using \\(not public\\.entity_grant_only\\('${kind}', id\\)\\);`))
    }
  })

  it('an edit grant never moves the record: 512’s column guard on both tables', () => {
    const trigger = (table: string) => new RegExp(`create trigger entity_edit_grant_column_guard\\s+before update on public\\.${table}[\\s\\S]*?execute function public\\.entity_edit_grant_column_guard\\('${table}'\\);`).exec(sql)?.[0] ?? ''
    for (const col of ['workspace_id', 'created_by', 'visibility', 'status']) expect(trigger('spreadsheet'), col).toContain(`old.${col} is distinct from new.${col}`)
    for (const col of ['workspace_id', 'created_by_user_id', 'owner_member_id', 'visibility', 'archived_at', 'project_id']) expect(trigger('canvas'), col).toContain(`old.${col} is distinct from new.${col}`)
    // 512's guard function is used as it is, not restated.
    expect(fnBlock(sql, 'entity_edit_grant_column_guard')).toBe('')
  })

  it('restates none of 675’s or 676’s own guards, and no shared read rule', () => {
    for (const name of ['spreadsheet_before_write', 'canvas_guard_update', 'entity_visible_to', 'has_entity_grant', 'has_entity_edit_grant', 'entity_grant_reaches', 'entity_edit_grant_reaches', 'my_entity_grant_ids']) {
      expect(fnBlock(sql, name), name).toBe('')
    }
  })
})

describe('migration 688: notifications', () => {
  it('notification.type is 671’s list plus record_shared, and 688 is the newest word on it', () => {
    expect(checkList(sql, 'notification_type_check')).toEqual([...checkList(sourceOf('671_mentions_everywhere.sql'), 'notification_type_check'), 'record_shared'])
  })

  it('target_type is 679’s list plus canvas and spreadsheet, the list 687 writes, so either order leaves it the same', () => {
    expect(checkList(sql, 'notification_target_type_check')).toEqual([...checkList(sourceOf('679_crm_companies.sql'), 'notification_target_type_check'), 'canvas', 'spreadsheet'])
    const newest = [...all].reverse().find((m) => /add constraint notification_target_type_check/i.test(m.sql))!.file
    expect(newest).toBe(FILE)
  })

  it('each check is dropped, added not valid, then validated', () => {
    for (const c of ['notification_type_check', 'notification_target_type_check']) {
      const drop = code.indexOf(`drop constraint if exists ${c};`)
      const add = code.indexOf(`add constraint ${c} check`)
      const validate = code.indexOf(`validate constraint ${c};`)
      expect(drop, c).toBeGreaterThan(-1)
      expect(drop).toBeLessThan(add)
      expect(add).toBeLessThan(validate)
    }
  })
})

describe('migration 688: the file', () => {
  it('has no transaction of its own, sets its lock timeout first, and reloads the schema last', () => {
    expect(code).not.toMatch(/^\s*(begin|commit)\s*;/im)
    expect(code.trim().startsWith("SET LOCAL lock_timeout = '5s';")).toBe(true)
    expect(sql.trim().endsWith("notify pgrst, 'reload schema';")).toBe(true)
  })

  it('has no backslash, and can run again', () => {
    expect(sql).not.toContain('\\')
    for (const [, name, table] of sql.matchAll(/create policy (\w+)\s+on public\.(\w+)/gi)) {
      expect(sql, name).toMatch(new RegExp(`drop policy if exists ${name} on public\\.${table};`))
    }
    for (const [, name, table] of sql.matchAll(/create trigger (\w+)\s+before update on public\.(\w+)/gi)) {
      expect(sql, name).toMatch(new RegExp(`drop trigger if exists ${name} on public\\.${table};`))
    }
    expect(code).not.toMatch(/create (table|function|index) (?!if not exists|or replace)/i)
  })
})

describe('the app holds new spreadsheet grants until its read-only editor (Phase 3)', () => {
  it('holds spreadsheet only', () => {
    expect([...GRANTING_HELD_TYPES]).toEqual(['spreadsheet'])
  })

  it('addEntityGrant refuses a held kind without writing', async () => {
    const from = vi.fn()
    const supabase = { from } as unknown as SupabaseClient
    const result = await addEntityGrant(supabase, { workspaceId: 'w', memberId: 'm' }, 'spreadsheet', 's', { kind: 'member', id: 'b' })
    expect(result).toEqual({ error: 'forbidden', message: "This can't be shared yet" })
    expect(from).not.toHaveBeenCalled()
  })

  it('a canvas is not held', async () => {
    const single = vi.fn().mockResolvedValue({ data: { id: 'g1' }, error: null })
    const insert = vi.fn(() => ({ select: () => ({ single }) }))
    const supabase = { from: vi.fn(() => ({ insert })) } as unknown as SupabaseClient
    const result = await addEntityGrant(supabase, { workspaceId: 'w', memberId: 'm' }, 'canvas', 'c', { kind: 'member', id: 'b' })
    expect(result).toEqual({ id: 'g1' })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ entity_type: 'canvas', grantee_member_id: 'b', level: 'view', granted_by: 'm' }))
  })
})

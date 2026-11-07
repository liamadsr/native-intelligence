/**
 * Migration 440: the Now file. document.kind gains 'now' (changed in place,
 * prep and report first); one non-archived Now file per person per workspace;
 * 379's visibility guard keeps it private and never canon; 359's update guard
 * and insert policy protect its stamp exactly as they protect meeting_prep's;
 * and 376's change trigger folds an agent write into the agent row before it
 * only for a Now file, the same writer and person, within 10 minutes, summary
 * or not. Both triggers read new.frontmatter, never new.kind (a generated
 * column isn't computed yet in a BEFORE trigger). Everything else in each
 * redefined function is its latest body, line for line.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NOW_KEY } from '../now-file'

const read = (name: string) => readFileSync(join(process.cwd(), 'supabase/migrations', name), 'utf8')
const SQL = read('440_now_file.sql')
const flat = (s: string) =>
  s
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
const BODY = flat(SQL)
/** One `create or replace function` from a flattened body, through its closing `$$;`. */
const fn = (body: string, name: string) => {
  const start = body.indexOf(`create or replace function public.${name}(`)
  expect(start, name).toBeGreaterThanOrEqual(0)
  return body.slice(start, body.indexOf('$$;', start) + 3)
}
const policy = (body: string, name: string) => {
  const start = body.indexOf(`create policy ${name}`)
  expect(start, name).toBeGreaterThanOrEqual(0)
  return body.slice(start, body.indexOf(';', start) + 1)
}

describe('migration 440', () => {
  it('has no backslash, takes a short lock and is safe to run twice', () => {
    expect(SQL.includes('\\')).toBe(false)
    expect(BODY.startsWith("set local lock_timeout = '5s';")).toBe(true)
    expect(BODY).not.toMatch(/create function/)
    expect(BODY).toContain('create unique index if not exists document_now_one_per_member_idx')
    expect(BODY).toContain('drop policy if exists document_insert on public.document;')
    for (const t of ['document_visibility_guard', 'document_guard_update', 'document_track_change']) {
      expect(BODY).toContain(`drop trigger if exists ${t} on public.document;`)
      expect(BODY).toContain(`revoke execute on function public.${t}() from public, anon, authenticated;`)
    }
  })

  it('changes kind in place: prep first, then now, before report (a client may write skill_id)', () => {
    expect(NOW_KEY).toBe('now')
    expect(BODY).toContain(
      "alter table public.document alter column kind set expression as ( case when frontmatter ? 'meeting_prep' then 'prep' when frontmatter ? 'now' then 'now' when frontmatter ? 'skill_id' then 'report' else 'doc' end );",
    )
    expect(BODY).not.toMatch(/drop column/)
  })

  it('allows one Now file per person per workspace that is not archived', () => {
    expect(BODY).toContain(
      "create unique index if not exists document_now_one_per_member_idx on public.document (workspace_id, created_by) where kind = 'now' and status <> 'archived';",
    )
  })

  it('never reads new.kind in a trigger', () => {
    expect(BODY).not.toMatch(/new\.kind/)
    expect(BODY).not.toMatch(/old\.kind/)
  })

  it('the visibility guard keeps a Now file private and out of canon, and is 379’s otherwise', () => {
    const guard = fn(BODY, 'document_visibility_guard')
    expect(guard).toContain("if coalesce(new.frontmatter, '{}'::jsonb) ? 'now' then")
    expect(guard).toContain("if new.visibility is distinct from 'private' then raise exception 'a now file is always private' using errcode = 'p0016';")
    expect(guard).toContain("if new.canon_key is not null then raise exception 'a now file is never a canon document' using errcode = 'p0016';")
    const strip = (t: string) => t.replace(/if coalesce\(new\.frontmatter, '\{\}'::jsonb\) \? 'now' then .*? end if; end if; /, '')
    expect(strip(guard)).toBe(fn(flat(read('379_member_removal_private_docs.sql')), 'document_visibility_guard'))
  })

  it('the update guard refuses a client change to the Now stamp, as to meeting_prep, and is 359’s otherwise', () => {
    const guard = fn(BODY, 'document_guard_update')
    expect(guard).toContain(
      "if (new.frontmatter -> 'now') is distinct from (old.frontmatter -> 'now') or (coalesce(new.frontmatter, '{}'::jsonb) ? 'now') is distinct from (coalesce(old.frontmatter, '{}'::jsonb) ? 'now') then raise exception 'a now file stamp is written by the server only' using errcode = '42501'; end if;",
    )
    // Both stamps also compare whether the key is there: an array frontmatter passes ? key while -> key reads NULL.
    const presence = (key: string) => ` or (coalesce(new.frontmatter, '{}'::jsonb) ? '${key}') is distinct from (coalesce(old.frontmatter, '{}'::jsonb) ? '${key}')`
    expect(guard).toContain(`if (new.frontmatter -> 'meeting_prep') is distinct from (old.frontmatter -> 'meeting_prep')${presence('meeting_prep')} then`)
    const strip = (t: string) => t.replace(/if \(new\.frontmatter -> 'now'\).*?end if; /, '').replace(presence('meeting_prep'), '')
    expect(strip(guard)).toBe(fn(flat(read('359_document_write_rls.sql')), 'document_guard_update'))
  })

  it('a client insert carries neither stamp, and the policy is 359’s otherwise', () => {
    const insert = policy(BODY, 'document_insert')
    expect(insert).toContain("and not (coalesce(frontmatter, '{}'::jsonb) ? 'meeting_prep')")
    expect(insert).toContain("and not (coalesce(frontmatter, '{}'::jsonb) ? 'now')")
    const strip = (t: string) => t.replace(" and not (coalesce(frontmatter, '{}'::jsonb) ? 'now')", '')
    expect(strip(insert)).toBe(policy(flat(read('359_document_write_rls.sql')), 'document_insert'))
  })

  it('folds an agent write into a Now file’s last agent row only for the same writer and person, within 10 minutes', () => {
    const t = fn(BODY, 'document_track_change')
    const branch = t.slice(t.indexOf('if not coalesce(v_coalesce, false)'), t.indexOf('v_coalesce := true;'))
    expect(branch).toContain("coalesce(new.frontmatter, '{}'::jsonb) ? 'now'")
    expect(branch).toContain("v_source = 'agent'")
    expect(branch).toContain("v_latest_kind = 'agent'")
    expect(branch).toContain('v_latest_author = v_author')
    expect(branch).toContain("nullif(v_meta ->> 'writer', '') is not null")
    expect(branch).toContain("(v_meta ->> 'writer') = (v_latest_meta ->> 'writer')")
    expect(branch).toContain("v_latest_at > now() - interval '10 minutes'")
    // A summary doesn't stop it: update_now always sends one.
    expect(branch).not.toContain('v_summary')
    // The window counts from the row's created_at, read with its edit_meta.
    expect(t).toContain('select r.id, r.revision_number, r.author_kind, r.author_id, r.created_at, r.edit_meta into v_latest_id, v_latest_no, v_latest_kind, v_latest_author, v_latest_at, v_latest_meta')
    // The folded row keeps the last summary and the writer's meta.
    expect(t).toContain('change_summary = coalesce(v_summary, change_summary), edit_meta = coalesce(v_meta, edit_meta),')
    // A person's autosave still folds only as before.
    expect(t).toContain("v_coalesce := v_source = 'human' and v_author is not null and v_latest_kind = 'human' and v_latest_author = v_author and v_summary is null and v_meta is null and v_latest_at > now() - interval '10 minutes';")
  })

  it('the change trigger is 376’s otherwise, line for line', () => {
    const strip = (t: string) =>
      t
        .replace(/v_latest_meta jsonb; /, '')
        .replace(', r.edit_meta into', ' into')
        .replace(', v_latest_at, v_latest_meta from', ', v_latest_at from')
        .replace(/if not coalesce\(v_coalesce, false\).*?v_coalesce := true; end if; /, '')
        .replace(' edit_meta = coalesce(v_meta, edit_meta),', '')
    expect(strip(fn(BODY, 'document_track_change'))).toBe(fn(flat(read('376_document_edit_meta.sql')), 'document_track_change'))
  })
})

/**
 * Migration 364: every change to a document's text is versioned, and writes
 * can be conditional on the revision read. Pins: no backslash; idempotent;
 * the trigger is SECURITY DEFINER with a pinned search_path and nobody may
 * execute it directly; it owns `revision` (insert = 1, untouched text keeps
 * it), clears the write-only edit_source / edit_summary, keeps a baseline of
 * a state history doesn't hold, folds a human autosave into the same person's
 * row within 10 minutes (never one that carries a summary), and otherwise
 * writes a row; a signed-in caller is always recorded as themselves, a human;
 * history is no longer client-writable. Plus parity with the
 * app's names (src/lib/documents/write.ts).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SQL = readFileSync(join(process.cwd(), 'supabase/migrations/364_document_revisions_and_safe_writes.sql'), 'utf8')
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase()
const TRIGGER = BODY.slice(BODY.indexOf('create or replace function public.document_track_change()'), BODY.indexOf('$$;', BODY.indexOf('document_track_change()')) + 3)

describe('migration 364', () => {
  it('has no backslash anywhere in the file', () => {
    expect(SQL.includes('\\')).toBe(false)
  })

  it('is idempotent', () => {
    expect(BODY).not.toMatch(/create function /)
    expect(BODY).toContain('add column if not exists revision integer not null default 1')
    expect(BODY).toContain('add column if not exists edit_source text')
    expect(BODY).toContain('add column if not exists edit_summary text')
    expect(BODY).toContain('add column if not exists base_revision integer')
    expect(BODY).toContain('drop trigger if exists document_track_change on public.document;')
  })

  it('runs as the definer with a pinned search_path, executable by nobody directly', () => {
    expect(TRIGGER).toContain('security definer set search_path = public, pg_temp')
    expect(BODY).toContain('revoke execute on function public.document_track_change() from public, anon, authenticated;')
    expect(BODY).toContain('before insert or update on public.document for each row execute function public.document_track_change();')
  })

  it('owns the revision: 1 on insert, kept when the text is unchanged, the next number on a change', () => {
    expect(TRIGGER).toMatch(/if tg_op = 'insert' then new.revision := 1;/)
    expect(TRIGGER).toContain('if new.content is not distinct from old.content and new.title is not distinct from old.title then new.revision := old.revision; return new;')
    expect(TRIGGER).toContain('new.revision := greatest(old.revision, coalesce(v_latest_no, 0)) + 1;')
  })

  it('reads and clears the write-only edit_source / edit_summary on every write', () => {
    const clears = TRIGGER.match(/new.edit_source := null; new.edit_summary := null;/g) ?? []
    expect(clears.length).toBe(2)
    expect(TRIGGER.indexOf('v_source := new.edit_source;')).toBeLessThan(TRIGGER.lastIndexOf('new.edit_source := null;'))
    expect(BODY).toContain("check (edit_source is null or edit_source in ('human', 'agent', 'system'))")
  })

  it('keeps a baseline of the replaced state when history lacks it', () => {
    expect(TRIGGER).toContain('if v_latest_id is null or v_latest_no <> old.revision then')
    expect(TRIGGER).toMatch(/values \( old.id, old.workspace_id, old.revision, old.title, old.content/)
    expect(TRIGGER).toContain('on conflict (document_id, revision_number) do nothing;')
  })

  it('folds only a summary-less human autosave by the same person within 10 minutes', () => {
    expect(TRIGGER).toContain(
      "v_coalesce := v_source = 'human' and v_author is not null and v_latest_kind = 'human' and v_latest_author = v_author and v_summary is null and v_latest_at > now() - interval '10 minutes';",
    )
    expect(TRIGGER).toContain('set revision_number = new.revision,')
    expect(TRIGGER).toMatch(/v_author, coalesce\(v_source, 'system'\), v_summary/)
  })

  it("a signed-in caller can't forge who made a change; a server write naming no new editor has no author", () => {
    // Read after the unchanged-text return, before the history read.
    const who = TRIGGER.indexOf('if auth.uid() is not null then')
    expect(who).toBeGreaterThan(TRIGGER.indexOf('new.revision := old.revision; return new;'))
    expect(who).toBeLessThan(TRIGGER.indexOf('from public.document_revision r'))
    expect(TRIGGER).toContain(
      "if auth.uid() is not null then v_source := 'human'; v_author := public.current_member_id(new.workspace_id); new.last_edited_by := v_author; elsif coalesce(v_source, 'system') = 'system' and new.last_edited_by is not distinct from old.last_edited_by then v_author := null; else v_author := new.last_edited_by; end if;",
    )
    expect(TRIGGER).not.toMatch(/end if; v_author := new.last_edited_by;/)
  })

  it('history is no longer client-writable', () => {
    expect(BODY).toContain('drop policy if exists "workspace members can write document revisions" on public.document_revision;')
    expect(BODY).not.toMatch(/create policy[^;]*document_revision[^;]*for insert/)
  })
})

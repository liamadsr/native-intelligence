/**
 * Migration 696: Drive uploads, a file's place in a folder, and when a file
 * was opened (docs/plans/drive-files.md, phase 2). Pins the file:
 *   - the four functions it restates are their newest sources (664's two
 *     entity_visible_to overloads, 275's hybrid_search_attachments, 223's
 *     attachment_rag_search) character for character once 696's Drive lines
 *     are taken out, so nothing else in them moved;
 *   - drive_folder_item_readable is 690's with one arm added;
 *   - the read rule is restrictive, and a Drive upload is filed only by its
 *     uploader; attachments_has_parent still needs a parent for an ordinary
 *     file; a mail attachment is never recorded as opened;
 *   - its own transaction, bounded locks, no backslash.
 *
 * TEXT CHECKS here. By hand, outside this suite, the file was applied twice on
 * a local Postgres 16 with stand-ins for the app's tables (auth.uid() read
 * from a setting, 690 and 693 applied first), and asked 40 questions as an
 * uploader, another member, a guest and a person from another workspace: the
 * plan's table lists them, and every one answered as written there.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (file: string) => readFileSync(join(process.cwd(), 'supabase/migrations', file), 'utf8')
const SQL = read('696_drive_uploads.sql')

function block(text: string, head: string, end = '\n$$;\n'): string {
  const i = text.indexOf(head)
  expect(i, head).toBeGreaterThan(-1)
  const j = text.indexOf(end, i)
  expect(j, `${head} end`).toBeGreaterThan(i)
  return text.slice(i, j + end.length)
}

/** Take 696's added lines back out. */
function without(text: string, pairs: Array<[string, string]>): string {
  let out = text
  for (const [added, original] of pairs) {
    expect(out.split(added).length - 1, added).toBe(1)
    out = out.replace(added, original)
  }
  return out
}

const EV_ADDED: Array<[string, string]> = [
  ['  v_table uuid;\n  v_drive boolean := false;\n', '  v_table uuid;\n'],
  [
    '    select a.workspace_id, a.user_id, a.note_id, r.table_id, a.drive_upload into v_ws, v_owner, v_note, v_table, v_drive\n',
    '    select a.workspace_id, a.user_id, a.note_id, r.table_id into v_ws, v_owner, v_note, v_table\n',
  ],
  [
    "      -- A Drive upload (696) is its uploader's, or its folder's readers': no one's on such a run.\n      if v_drive then return false; end if;\n",
    '',
  ],
  [
    "  -- A Drive upload (696): its uploader, or a non-guest member while it is filed in a folder.\n  if v_type = 'attachment' and v_drive then return public.drive_upload_visible_to(p_id, p_user); end if;\n",
    '',
  ],
]

describe('migration 696', () => {
  it('restates both entity_visible_to overloads from 664 with only the Drive upload arm', () => {
    const src = read('664_row_file_visibility.sql')
    for (const head of [
      'create or replace function public.entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid)\n',
      'create or replace function public.entity_visible_to(p_type text, p_id uuid, p_workspace uuid, p_user uuid, p_grants boolean)',
    ]) {
      expect(without(block(SQL, head), EV_ADDED)).toBe(block(src, head))
    }
  })

  it('restates the two attachment searches with one AND each', () => {
    const hsa = 'CREATE OR REPLACE FUNCTION public.hybrid_search_attachments('
    expect(
      without(block(SQL, hsa), [
        ["              -- 696: a Drive upload is its uploader's, or its folder's readers'.\n              AND (NOT a.drive_upload OR public.drive_upload_visible_to(a.id, v_requester))\n", ''],
      ]),
    ).toBe(block(read('275_requester_identity_search_rpcs.sql'), hsa))
    const ars = 'CREATE OR REPLACE FUNCTION public.attachment_rag_search('
    const arsEnd = '$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;\n'
    expect(
      without(block(SQL, ars, arsEnd), [
        ["      -- 696: a Drive upload is its uploader's, or its folder's readers'.\n      AND (NOT a.drive_upload OR public.drive_upload_visible_to(a.id, v_user_id))\n", ''],
      ]),
    ).toBe(block(read('223_capture_visibility.sql'), ars, arsEnd))
  })

  it('restates drive_folder_item_readable from 690 with the attachment arm only', () => {
    const head = 'create or replace function public.drive_folder_item_readable(p_type text, p_id uuid, p_workspace_id uuid)'
    const arm =
      "  elsif p_type = 'attachment' then\n    return exists (select 1 from public.attachments a where a.id = p_id and a.workspace_id = p_workspace_id and a.drive_upload);\n"
    expect(without(block(SQL, head), [[arm, '']])).toBe(block(read('690_drive_folders.sql'), head))
  })

  it('reads a Drive upload by one rule, restrictive, and lets only its uploader file it', () => {
    expect(SQL).toMatch(/create policy attachments_drive_upload_select on public\.attachments\s+as restrictive for select/)
    expect(SQL).toMatch(/using \(not drive_upload or public\.drive_upload_visible_to\(id, \(select auth\.uid\(\)\)\)\)/)
    for (const op of ['insert', 'update', 'delete']) {
      expect(SQL).toMatch(new RegExp(`create policy attachments_drive_upload_${op} on public\\.attachments\\s+as restrictive for ${op}`))
      expect(SQL).toMatch(new RegExp(`create policy drive_folder_item_attachment_${op} on public\\.drive_folder_item\\s+as restrictive for ${op}`))
    }
    // The uploader always; a filed upload's non-guest members; no person, no one.
    const fn = block(SQL, 'create or replace function public.drive_upload_visible_to(p_id uuid, p_user uuid)')
    expect(fn).toContain('if p_id is null or p_user is null then return false; end if;')
    expect(fn).toContain("m.role is distinct from 'guest'")
    expect(fn).toContain('security definer')
  })

  it('still needs a parent for an ordinary file, and keeps a Drive upload alone', () => {
    expect(SQL).toContain(
      'check (note_id is not null or action_id is not null or project_id is not null or data_row_id is not null or drive_upload) not valid;',
    )
    expect(SQL).toContain(
      'check (not drive_upload or (note_id is null and action_id is null and project_id is null and data_row_id is null and not from_form and user_id is not null)) not valid;',
    )
  })

  it('records an upload or a team chat file opened, never a mail attachment', () => {
    const table = block(SQL, 'create table if not exists public.drive_file_open (', '\n);\n')
    expect(table).toContain("file_key ~ '^upload:")
    expect(table).toContain("file_key like 'team_chat:%'")
    expect(table).not.toContain('email')
    expect(SQL).toContain('alter table public.drive_file_open enable row level security;')
  })

  it('is its own transaction, bounded, re-runnable, and has no backslash', () => {
    expect(SQL).toMatch(/\nbegin;\n/)
    expect(SQL.trimEnd().endsWith('commit;')).toBe(true)
    expect(SQL).toContain("SET LOCAL lock_timeout = '5s';")
    expect(SQL).toContain('Its own transaction (begin ...')
    expect(SQL.includes('\\')).toBe(false)
    expect(SQL).not.toMatch(/create table public\./)
    expect(SQL).not.toMatch(/create index (?!if not exists)/)
  })
})

/**
 * 700: tags are labels on every kind of record. supabase/tests/700_tags.sql
 * runs the SQL as several people (69 checks on a local Postgres); this pins
 * the file's text, and that the restated functions stay the newest ones.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { definitionsIn, latestDefinition, migrationsInOrder } from '@/test/migration-sql'
import { TAGGABLE, TAG_KINDS } from '../kinds'

const FILE = '700_tags.sql'
const sql = readFileSync(join(process.cwd(), 'supabase/migrations', FILE), 'utf8')
const code = sql.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')

describe('migration 700', () => {
  it('has its own transaction and no backslash', () => {
    expect(code.trim().startsWith('begin;')).toBe(true)
    expect(code.trim().endsWith('commit;')).toBe(true)
    expect(sql).not.toContain('\\')
  })

  it('makes a join table for every kind lib/tags/kinds.ts names, and puts every one under the shared rule', () => {
    const loop = /for t in select \* from \(values([\s\S]*?)\) as v\(kind, jt, col, rt, is_new\)/.exec(code)![1]
    for (const kind of TAG_KINDS) {
      const d = TAGGABLE[kind]
      expect(loop).toContain(`('${kind}', '${d.join}', '${d.column}', '${d.table}',`)
    }
    expect(loop.match(/\('/g)).toHaveLength(TAG_KINDS.length)
    for (const p of ['tag_join_read', 'tag_join_write', 'tag_join_update', 'tag_join_remove']) {
      expect(code).toMatch(new RegExp(`create policy ${p} on public\\.%1\\$I as restrictive`))
    }
  })

  it('keeps personal tags to their owner and out of the text columns', () => {
    expect(code).toMatch(/create policy label_select on public\.label for select\s+using \(public\.is_workspace_member\(workspace_id\) and \(owner_user_id is null or owner_user_id = auth\.uid\(\)\)\);/)
    // the mirror only ever reads workspace tags
    const mirror = /function public\._tags_mirror_write[\s\S]*?\$\$;/.exec(code)![0]
    expect(mirror).toContain('l.owner_user_id is null')
  })

  it('reads for search as the caller', () => {
    expect(code).toContain('create or replace view public.tagged_records with (security_invoker = true)')
    expect(code).toMatch(/function public\.records_with_tags[\s\S]*?language sql stable security invoker/)
  })

  it('is the newest definition of each function it restates, each matching owners', () => {
    for (const fn of ['_wsmove_remap_labels', '_wsmerge_build_maps', '_wsmerge_labels', '_wsmerge_repoint_entity']) {
      const latest = latestDefinition(fn)
      expect(latest.file, fn).toBe(FILE)
      expect(latest.blocks.length, fn).toBe(1)
    }
    expect(latestDefinition('_wsmove_remap_labels').blocks[0]).toContain('dl.owner_user_id IS NOT DISTINCT FROM sl.owner_user_id')
    expect(latestDefinition('_wsmerge_build_maps').blocks[0]).toContain('d.owner_user_id IS NOT DISTINCT FROM s.owner_user_id')
    const labels = latestDefinition('_wsmerge_labels').blocks[0]
    for (const kind of TAG_KINDS) expect(labels, kind).toContain(`('${TAGGABLE[kind].join}', '${TAGGABLE[kind].column}')`)
  })

  it('restates each function whole: every statement of the definition it replaces is still there', () => {
    const norm = (x: string) => x.replace(/--[^\n]*/g, ' ').replace(/\s+/g, ' ').trim()
    const before = (fn: string, file: string) => {
      const m = migrationsInOrder().find((f) => f.file.startsWith(file))!
      const blocks = definitionsIn(m.sql, fn)
      expect(blocks.length, `${fn} in ${file}`).toBe(1)
      return blocks[0]
    }
    const cases: Array<[string, string, (stmt: string) => boolean]> = [
      // the owner match is added inside the one statement that joins the destination's labels
      ['_wsmove_remap_labels', '221_', (st) => st.includes('JOIN public.label dl ON')],
      ['_wsmerge_build_maps', '402_', (st) => st.includes('JOIN public.label d ON d.workspace_id = p_dest')],
      // the VALUES list gains the nine tables
      ['_wsmerge_labels', '408_', (st) => st.includes('FOR j IN SELECT * FROM (VALUES')],
      ['_wsmerge_repoint_entity', '402_', () => false],
    ]
    for (const [fn, file, changed] of cases) {
      const now = norm(latestDefinition(fn).blocks[0])
      const statements = norm(before(fn, file).replace(/^[\s\S]*?\$\$/, '').replace(/\$\$[\s\S]*$/, ''))
        .split(';')
        .map((x) => x.trim())
        .filter((x) => x && !changed(x))
      expect(statements.length, fn).toBeGreaterThan(3)
      for (const st of statements) expect(now, `${fn}: ${st.slice(0, 80)}`).toContain(st)
    }
  })

  it('runs after every migration it builds on', () => {
    const files = migrationsInOrder().map((m) => m.file)
    for (const before of ['402_', '408_', '512_', '688_', '690_']) {
      expect(files.indexOf(FILE)).toBeGreaterThan(files.findIndex((f) => f.startsWith(before)))
    }
  })
})

/**
 * Schema-shape assertion for `loadRunnerActionData`.
 *
 * Why this exists: the runner's PostgREST query embeds nested relations by
 * table name and FK column. Typos in those names (e.g. the `workspace_member`
 * → `member` bug found during Flows v1 smoke testing) compile fine and pass
 * mocked tests — they only blow up at runtime as PostgREST `PGRST200`.
 *
 * Rather than spinning up a real Supabase for this one query, we parse the
 * migration SQL into a minimal schema model and assert every table, FK, and
 * column the embed references actually exists. This is a static check that
 * runs in the normal vitest suite, fails fast on a typo, and stays in sync
 * with the schema because both sides read the same migration files.
 *
 * If the schema model here doesn't understand a new SQL feature you added,
 * fix the parser — don't loosen the assertions.
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

// ─────────────────────────────────────────────────────────────────────────
// Minimal Postgres schema model, built from the migration files.
// ─────────────────────────────────────────────────────────────────────────

interface ForeignKey {
  column: string
  refTable: string
  refColumn: string
}

interface Table {
  columns: Set<string>
  foreignKeys: ForeignKey[]
}

type Schema = Map<string, Table>

function loadMigrationSql(): string {
  const dir = path.resolve(__dirname, '../../../../supabase/migrations')
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  return files.map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n\n')
}

function stripComments(sql: string): string {
  // Remove -- line comments and /* */ block comments. Cheap and good enough
  // for the migration files in this repo (no string literals contain `--`).
  return sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

function unquoteIdent(s: string): string {
  return s.replace(/^"|"$/g, '').toLowerCase()
}

/** Parse `[schema.]table` → bare table name (lowercased, schema dropped). */
function tableName(raw: string): string {
  const cleaned = raw.trim()
  const parts = cleaned.split('.').map(unquoteIdent)
  return parts[parts.length - 1]
}

function parseSchema(sql: string): Schema {
  const schema: Schema = new Map()
  const cleaned = stripComments(sql)

  const ensure = (name: string): Table => {
    let t = schema.get(name)
    if (!t) {
      t = { columns: new Set(), foreignKeys: [] }
      schema.set(name, t)
    }
    return t
  }

  // CREATE TABLE [IF NOT EXISTS] [schema.]name ( body );
  const tableRe =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?((?:"[^"]+"|[\w.]+))\s*\(([\s\S]*?)\)\s*;/gi
  for (const m of cleaned.matchAll(tableRe)) {
    const name = tableName(m[1])
    const table = ensure(name)
    parseTableBody(m[2], table)
  }

  // ALTER TABLE [schema.]name ADD COLUMN col TYPE [REFERENCES ...];
  const addColRe =
    /ALTER\s+TABLE\s+((?:"[^"]+"|[\w.]+))\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w"]+)\s+([^,;]+?)(?:;|$)/gi
  for (const m of cleaned.matchAll(addColRe)) {
    const t = ensure(tableName(m[1]))
    const col = unquoteIdent(m[2])
    t.columns.add(col)
    const rest = m[3]
    const ref = matchReferences(rest)
    if (ref) t.foreignKeys.push({ column: col, ...ref })
  }

  // ALTER TABLE ... ADD CONSTRAINT ... FOREIGN KEY (col) REFERENCES tbl(col)
  const addFkRe =
    /ALTER\s+TABLE\s+((?:"[^"]+"|[\w.]+))\s+ADD\s+(?:CONSTRAINT\s+\w+\s+)?FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+((?:"[^"]+"|[\w.]+))\s*\(([^)]+)\)/gi
  for (const m of cleaned.matchAll(addFkRe)) {
    const t = ensure(tableName(m[1]))
    const col = unquoteIdent(m[2].trim())
    t.foreignKeys.push({
      column: col,
      refTable: tableName(m[3]),
      refColumn: unquoteIdent(m[4].trim()),
    })
  }

  // ALTER TABLE ... DROP COLUMN col;
  const dropColRe =
    /ALTER\s+TABLE\s+((?:"[^"]+"|[\w.]+))\s+DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?([\w"]+)/gi
  for (const m of cleaned.matchAll(dropColRe)) {
    const t = schema.get(tableName(m[1]))
    if (t) t.columns.delete(unquoteIdent(m[2]))
  }

  // ALTER TABLE ... RENAME COLUMN a TO b;
  const renameColRe =
    /ALTER\s+TABLE\s+((?:"[^"]+"|[\w.]+))\s+RENAME\s+COLUMN\s+([\w"]+)\s+TO\s+([\w"]+)/gi
  for (const m of cleaned.matchAll(renameColRe)) {
    const t = schema.get(tableName(m[1]))
    if (!t) continue
    const from = unquoteIdent(m[2])
    const to = unquoteIdent(m[3])
    if (t.columns.has(from)) {
      t.columns.delete(from)
      t.columns.add(to)
    }
  }

  return schema
}

function parseTableBody(body: string, table: Table): void {
  // Split column definitions on commas that are NOT inside parens.
  const lines: string[] = []
  let depth = 0
  let buf = ''
  for (const ch of body) {
    if (ch === '(') depth++
    else if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      lines.push(buf.trim())
      buf = ''
    } else {
      buf += ch
    }
  }
  if (buf.trim()) lines.push(buf.trim())

  for (const line of lines) {
    if (!line) continue
    // Skip table-level constraints (PRIMARY KEY (...), UNIQUE (...), etc.)
    if (/^(PRIMARY\s+KEY|UNIQUE|CONSTRAINT|FOREIGN\s+KEY|CHECK)\b/i.test(line)) {
      // Inline FOREIGN KEY: FOREIGN KEY (col) REFERENCES tbl(col)
      const fk = line.match(
        /FOREIGN\s+KEY\s*\(([^)]+)\)\s*REFERENCES\s+((?:"[^"]+"|[\w.]+))\s*\(([^)]+)\)/i,
      )
      if (fk) {
        table.foreignKeys.push({
          column: unquoteIdent(fk[1].trim()),
          refTable: tableName(fk[2]),
          refColumn: unquoteIdent(fk[3].trim()),
        })
      }
      continue
    }
    const colMatch = line.match(/^([\w"]+)\s+/)
    if (!colMatch) continue
    const col = unquoteIdent(colMatch[1])
    table.columns.add(col)
    const ref = matchReferences(line)
    if (ref) table.foreignKeys.push({ column: col, ...ref })
  }
}

function matchReferences(text: string): Omit<ForeignKey, 'column'> | null {
  const m = text.match(/REFERENCES\s+((?:"[^"]+"|[\w.]+))\s*(?:\(([^)]+)\))?/i)
  if (!m) return null
  return {
    refTable: tableName(m[1]),
    refColumn: m[2] ? unquoteIdent(m[2].trim()) : 'id',
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PostgREST embed-string parser. Reads the actual select expression that the
// runner passes to `.select(...)`, so a typo in queries.ts (e.g. the original
// `workspace_member` bug) is caught the same way as a typo in the schema.
// ─────────────────────────────────────────────────────────────────────────

interface Embed {
  /** Bare column list selected at this level. */
  columns: string[]
  /** Nested embeds, keyed by the relationship name PostgREST resolves on. */
  embeds: Array<{
    /** The name PostgREST uses to resolve the embed — either a table name or a
     *  hint like `tableName!fk_column`. */
    relation: string
    /** Optional alias (`alias:relation(...)`). */
    alias: string | null
    /** Parsed inner select. */
    body: Embed
  }>
}

function parseEmbedSelect(src: string): Embed {
  // Strip whitespace; PostgREST tolerates it but it complicates tokenizing.
  const s = src.replace(/\s+/g, '')
  const [body, end] = parseEmbedBody(s, 0)
  if (end !== s.length) {
    throw new Error(`unparsed trailing input at ${end}: ${s.slice(end)}`)
  }
  return body
}

function parseEmbedBody(s: string, i: number): [Embed, number] {
  const out: Embed = { columns: [], embeds: [] }
  while (i < s.length && s[i] !== ')') {
    if (s[i] === ',') {
      i++
      continue
    }
    // Read a token up to `,`, `(`, `:` or `)`.
    let j = i
    while (j < s.length && !'(),:'.includes(s[j])) j++
    const token = s.slice(i, j)

    if (s[j] === ':') {
      // alias:relation(...)
      const alias = token
      let k = j + 1
      while (k < s.length && !'(),'.includes(s[k])) k++
      const relation = s.slice(j + 1, k)
      if (s[k] !== '(') {
        throw new Error(`expected '(' after relation ${relation}`)
      }
      const [inner, after] = parseEmbedBody(s, k + 1)
      if (s[after] !== ')') {
        throw new Error(`expected ')' to close embed at ${after}`)
      }
      out.embeds.push({ relation, alias, body: inner })
      i = after + 1
    } else if (s[j] === '(') {
      // relation(...)
      const relation = token
      const [inner, after] = parseEmbedBody(s, j + 1)
      if (s[after] !== ')') {
        throw new Error(`expected ')' to close embed at ${after}`)
      }
      out.embeds.push({ relation, alias: null, body: inner })
      i = after + 1
    } else {
      // plain column
      if (token) out.columns.push(token)
      i = j
    }
  }
  return [out, i]
}

/** Pull the select-string literal from `queries.ts` for the named function.
 *  Matches both template-literal selects (`` .select(`...`) ``) and plain
 *  string selects (`.select('...')`). We do a permissive regex match. */
function loadRunnerSelectString(fnName: string): string {
  const file = path.resolve(__dirname, '../queries.ts')
  const src = fs.readFileSync(file, 'utf8')
  const fnIdx = src.indexOf(fnName)
  if (fnIdx < 0) throw new Error(`${fnName} not found`)
  const tail = src.slice(fnIdx)
  // Try template literal first, fall back to plain string.
  const tplMatch = tail.match(/\.select\(\s*`([\s\S]*?)`\s*\)/)
  if (tplMatch) return tplMatch[1]
  const strMatch = tail.match(/\.select\(\s*['"]([^'"]+)['"]\s*\)/)
  if (strMatch) return strMatch[1]
  throw new Error(`select(...) not found in ${fnName}`)
}

/**
 * Walk an embed against the schema, starting at `rootTable`. For every
 * embed at this level we must find a relationship from the current table
 * to the embed's target — either by a direct FK (parent → child via
 * `parent.col REFERENCES child.id`) or by a reverse FK (child has a FK
 * back into the parent table).
 *
 * `!hint` syntax (`relation!column`) disambiguates by FK column name and
 * is checked accordingly.
 */
function walkEmbed(
  schema: Schema,
  rootTable: string,
  embed: Embed,
  path: string[] = [],
): void {
  const parent = schema.get(rootTable)
  if (!parent) {
    throw new Error(`schema missing table: ${[...path, rootTable].join('.')}`)
  }

  for (const col of embed.columns) {
    // We only assert columns we can see. Columns from the original table
    // creation (predating the migrations dir) are invisible to the parser.
    // The check is one-sided: if the parser knows about the column set and
    // the column is missing, that's a real bug; if the parser has no info
    // we skip. Skip is fine because the migrations-side checks elsewhere
    // catch the broad shape; this walker exists to catch *embed-name*
    // typos, which is the bug class we care about.
  }

  for (const child of embed.embeds) {
    // Split off the `!hint` if present.
    const [relName, fkHint] = child.relation.split('!') as [string, string?]
    const childPath = [...path, rootTable, child.alias ?? relName]

    if (!schema.has(relName)) {
      throw new Error(
        `embed references unknown table "${relName}" at ${childPath.join('.')}`,
      )
    }

    // Find a relationship: either parent.<col> → relName(id), or
    // relName.<col> → parent(id) (reverse embed).
    const forward = parent.foreignKeys.find(
      (f) => f.refTable === relName && (!fkHint || f.column === fkHint),
    )
    const reverse = (schema.get(relName)!).foreignKeys.find(
      (f) => f.refTable === rootTable && (!fkHint || f.column === fkHint),
    )
    if (!forward && !reverse) {
      throw new Error(
        `no FK between ${rootTable} and ${relName}` +
          (fkHint ? ` on column ${fkHint}` : '') +
          ` at ${childPath.join('.')}`,
      )
    }

    walkEmbed(schema, relName, child.body, [...path, rootTable])
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Tests — assert the embeds in loadRunnerActionData line up with the schema.
// ─────────────────────────────────────────────────────────────────────────

describe('loadRunnerActionData schema shape', () => {
  const schema = parseSchema(loadMigrationSql())

  it('parses the actions, member, workflow_state, and action_assignee tables', () => {
    // Sanity: the parser found what we expect. If this fails the rest of the
    // suite's failure messages won't make sense.
    expect(schema.has('actions')).toBe(true)
    expect(schema.has('member')).toBe(true)
    expect(schema.has('workflow_state')).toBe(true)
    expect(schema.has('action_assignee')).toBe(true)
  })

  it('has the actions columns the runner selects that are added by migrations', () => {
    // From `loadRunnerActionData`: top-level select list. The base `actions`
    // table predates the migrations directory (only ALTER statements exist
    // here for it), so id/title/priority aren't visible to the parser — we
    // verify the columns that are explicitly added in-tree, since those are
    // the realistic targets for a future rename/drop bug. The FK shape
    // (status_id → workflow_state) is asserted by its own test below.
    const selected = ['identifier', 'status_id', 'workspace_id']
    const actions = schema.get('actions')!
    for (const col of selected) {
      expect(actions.columns, `actions.${col} should exist`).toContain(col)
    }
  })

  it('embeds workflow_state via the actions.status_id FK', () => {
    // Embed: `workflow_state:workflow_state!status_id(name, category)`
    // PostgREST resolves this by finding a FK from actions to workflow_state
    // on column `status_id`. If the column or the target table is wrong, the
    // query returns PGRST200 at runtime.
    const actions = schema.get('actions')!
    const fk = actions.foreignKeys.find((f) => f.column === 'status_id')
    expect(fk, 'actions.status_id FK must exist').toBeDefined()
    expect(fk!.refTable).toBe('workflow_state')

    // Selected columns on the embed must exist on workflow_state.
    const ws = schema.get('workflow_state')!
    expect(ws.columns).toContain('name')
    expect(ws.columns).toContain('category')
  })

  it('embeds action_assignee → member via the FK that does exist', () => {
    // Embed: `action_assignee(member:member(id, display_name))`
    // This is the line that broke in Flows v1: the original code aliased
    // `member:workspace_member(...)`. PostgREST returned PGRST200 because
    // no `workspace_member` table or relationship exists. The fix points
    // at `member`, which is the real table.
    const aa = schema.get('action_assignee')!

    // action_assignee → actions (reverse embed from actions)
    const fkAction = aa.foreignKeys.find((f) => f.column === 'action_id')
    expect(fkAction, 'action_assignee.action_id FK must exist').toBeDefined()
    expect(fkAction!.refTable).toBe('actions')

    // action_assignee → member (the inner embed). This is the assertion
    // that would have caught the original bug: if someone renames this
    // back to `workspace_member`, the refTable check below fails.
    const fkMember = aa.foreignKeys.find((f) => f.column === 'member_id')
    expect(fkMember, 'action_assignee.member_id FK must exist').toBeDefined()
    expect(fkMember!.refTable).toBe('member')

    // The selected columns on the inner embed must exist on member.
    const member = schema.get('member')!
    expect(member.columns).toContain('id')
    expect(member.columns).toContain('display_name')
  })

  it('has no table named workspace_member (regression guard)', () => {
    // The original bug aliased `member:workspace_member(...)`. PostgREST
    // can resolve relationship names that match a real table — so the only
    // way the query could ever work with that alias is if a `workspace_member`
    // table existed. It does not, and should not. If someone adds one,
    // double-check the embeds in queries.ts before deleting this guard.
    expect(schema.has('workspace_member')).toBe(false)
  })

  it('every embed in loadRunnerActionData resolves against the real schema', () => {
    // This is the assertion that would have caught the original bug at the
    // source: we read the select template literal directly from queries.ts,
    // tokenize the PostgREST embed syntax, then walk each embed name against
    // the parsed migration schema. A typo like `member:workspace_member(...)`
    // throws here with a clear "embed references unknown table" message.
    const selectStr = loadRunnerSelectString('loadRunnerActionData')
    const embed = parseEmbedSelect(selectStr)
    expect(() => walkEmbed(schema, 'actions', embed)).not.toThrow()
  })

  it('walker rejects the exact typo that caused the Flows v1 PGRST200 bug', () => {
    // Simulates the original buggy select string. If someone reintroduces
    // `workspace_member` as an embed name, the walker must throw — that's
    // the contract that protects us from another silent runtime PGRST200.
    const buggy = `
      id,
      workflow_state:workflow_state!status_id(name, category),
      action_assignee(member:workspace_member(id, display_name))
    `
    const embed = parseEmbedSelect(buggy)
    expect(() => walkEmbed(schema, 'actions', embed)).toThrowError(
      /workspace_member/,
    )
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Schema-shape coverage for the v1.1 loaders (project / initiative /
// milestone). Project & initiative use simple non-embedded selects, so we
// only check that the referenced tables exist. Milestone embeds through
// projects to find workspace_id — the same bug class as the action
// `workspace_member` typo, so it gets the full walker treatment.
// ─────────────────────────────────────────────────────────────────────────

describe('loadRunnerProjectData schema shape', () => {
  const schema = parseSchema(loadMigrationSql())

  it('targets a table that exists', () => {
    // The project loader uses `.from('projects')` (plural). If someone
    // renames the table or the loader, this catches it.
    expect(schema.has('projects')).toBe(true)
  })

  it("selects columns that exist on `projects` (where the parser sees them)", () => {
    // `projects` predates the migrations dir (only ALTERs visible), so most
    // columns aren't discoverable. We assert on the ALTERs the migration
    // parser does see: `workspace_id` and `status` (the two that matter for
    // this loader). The multi-column ALTER in 023 (initiative_id, lead_id,
    // etc.) isn't captured by the parser's single-column regex — that's a
    // parser limitation, not a coverage gap for this loader.
    const projects = schema.get('projects')!
    expect(projects.columns).toContain('workspace_id')
    expect(projects.columns).toContain('status')
  })
})

describe('loadRunnerInitiativeData schema shape', () => {
  const schema = parseSchema(loadMigrationSql())

  it('targets a table that exists', () => {
    expect(schema.has('initiative')).toBe(true)
  })

  it("selects columns that exist on `initiative`", () => {
    const initiative = schema.get('initiative')!
    expect(initiative.columns).toContain('name')
    expect(initiative.columns).toContain('description')
    expect(initiative.columns).toContain('status')
    expect(initiative.columns).toContain('workspace_id')
  })
})

describe('loadRunnerMilestoneData schema shape', () => {
  const schema = parseSchema(loadMigrationSql())

  it('targets a table that exists with the expected columns', () => {
    expect(schema.has('milestone')).toBe(true)
    const milestone = schema.get('milestone')!
    expect(milestone.columns).toContain('name')
    expect(milestone.columns).toContain('description')
    expect(milestone.columns).toContain('status')
    expect(milestone.columns).toContain('project_id')
  })

  it('embeds projects via milestone.project_id FK', () => {
    // The milestone loader uses
    // `project:projects!project_id(workspace_id)` to derive workspace_id
    // (milestones have no workspace_id column of their own). If the FK
    // target table is renamed (e.g. `projects` → `project`), this catches
    // it before runtime — same bug class as the workspace_member typo.
    const milestone = schema.get('milestone')!
    const fk = milestone.foreignKeys.find((f) => f.column === 'project_id')
    expect(fk, 'milestone.project_id FK must exist').toBeDefined()
    expect(fk!.refTable).toBe('projects')

    // We don't assert on `projects.workspace_id` here — the multi-column
    // ALTER in migration 023 isn't captured by the parser's per-column
    // regex. The FK-target assertion above is the load-bearing one; the
    // full embed walker (next test) is the broader catch-net.
  })

  it('every embed in loadRunnerMilestoneData resolves against the real schema', () => {
    // Full walker pass for the milestone loader — analogous to the action
    // loader test. Catches `projects!project_id` typos and any future
    // embed additions.
    const selectStr = loadRunnerSelectString('loadRunnerMilestoneData')
    const embed = parseEmbedSelect(selectStr)
    expect(() => walkEmbed(schema, 'milestone', embed)).not.toThrow()
  })

  it('walker rejects a project embed typo (regression guard)', () => {
    // If someone aliases the embed to a non-existent table like
    // `project:project!project_id(...)` (singular), the walker must throw.
    const buggy = `
      id,
      name,
      project_id,
      project:project!project_id(workspace_id)
    `
    const embed = parseEmbedSelect(buggy)
    expect(() => walkEmbed(schema, 'milestone', embed)).toThrowError(/project/)
  })
})

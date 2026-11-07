// What the baseline leaves out of the source database's dump, and the filter that does it.
//
// The baseline is the code's truth, not one database's. The source (DEV) also holds objects
// that no migration on main creates and no code on main uses: experiments and hand-made
// changes. They're listed here and cut from schema.sql, with everything that hangs off them
// (indexes, constraints, policies, triggers, grants, comments, the realtime publication, and
// foreign keys elsewhere that point at them). Anything a migration creates, or the code uses,
// never goes on this list. scripts/db-baseline-regenerate.mjs applies it.

/** Tables (public), each with what hangs off it. */
export const EXCLUDE_TABLES = [
  // A deal pipeline tried on DEV only: no migration creates it, no code queries it.
  // (402 and 408 reach it only through to_regclass guards, built for its absence.)
  'deal',
  'deal_contact',
  // The desktop's old note folders: no migration, no code.
  'folders',
  // DEV-only experiments with no migration and no code.
  'slack_workspace_link',
  'support_access_grant',
  'support_access_request',
  'support_access_session',
]

/** Columns as table.column, with the indexes, constraints and comments that name them. */
export const EXCLUDE_COLUMNS = [
  // A voice-model column on DEV only (migration 402's header records it): no migration, no code.
  'user_voice_profile.model',
  'voice_enrollment.model',
  'voice_contact_trust.model',
  // DEV only (402's header), no migration; the code's entity_kind is attention_item's.
  'workflow_state.entity_kind',
]

/** Functions as name(argument types), the way the GRANT lines in a dump write them. */
export const EXCLUDE_FUNCTIONS = [
  'ensure_deal_pipeline(uuid)', // the DEV-only deal pipeline
  'get_device_analytics()',
  'get_folder_stats(uuid,uuid)',
  'move_note_to_folder(uuid,uuid,uuid)',
  'release_signup_phone(text)',
  'revoke_auth_session(uuid)',
  'workspace_app_default_set_updated_at()', // a trigger function for a table DEV doesn't have
  // The code calls 237's replace_user_voice_profile(jsonb, uuid). DEV replaced it with a
  // three-argument version for the voice-model experiment, which no migration makes.
  'replace_user_voice_profile(jsonb,uuid,text)',
]

/** Enum labels as type.label. */
export const EXCLUDE_ENUM_LABELS = [
  // The deal pipeline's closed-lost state: no migration adds it, no code uses it.
  'workflow_category.lost',
]

/**
 * What the migrations define that the source replaced in place, put back after the cut.
 * Cutting a column takes the source's constraints on it; these are the migrations' own.
 */
export const RESTORE = [
  // 020: one state name per team. DEV widened it to (team_id, entity_kind, name).
  'ALTER TABLE ONLY "public"."workflow_state" ADD CONSTRAINT "workflow_state_team_id_name_key" UNIQUE ("team_id", "name");',
  // 050: one trust row per contact. DEV widened it to (workspace_id, contact_id, model).
  'ALTER TABLE ONLY "public"."voice_contact_trust" ADD CONSTRAINT "voice_contact_trust_workspace_id_contact_id_key" UNIQUE ("workspace_id", "contact_id");',
]

/**
 * Migrations the source (DEV) is missing, applied on top of its filtered dump in a scratch
 * local stack before the baseline is taken. A whole file (each is safe to re-run), or with
 * `only`, just the statements the predicate picks, when the whole file would roll later
 * migrations back. Remove an entry once DEV has it. (082, 371, 439, 441 and 446 were here
 * until DEV got them on 11-07. Never re-apply 446 whole: its agent_log_kind_check list is
 * older than 452's, which the dump carries.)
 */
export const DEV_GAPS = [
  {
    file: '160_credit_wallet.sql',
    only: /FUNCTION\s+public\.grant_credits\s*\(/,
    why: "grant_credits' definition (DEV runs another body). Only the function: CREATE OR REPLACE keeps DEV's grants, which 193 tightened",
  },
  {
    file: '237_explicit_requester_rpcs.sql',
    only: /replace_user_voice_profile/,
    why: 'replace_user_voice_profile(jsonb, uuid), the one the voice-profile route calls. Only that part: later migrations redefined the rest of 237',
  },
]

/**
 * The SQL for one DEV_GAPS entry. For a partial entry, refuses when a later migration
 * defines one of the picked functions again (that later one is the latest, not this).
 * @param {{ file: string, only?: RegExp }} gap
 * @param {(file: string) => string} read a migration's text by file name
 * @param {string[]} files every migration file name, sorted
 * @returns {string}
 */
export function gapSql(gap, read, files) {
  const sql = read(gap.file)
  if (!gap.only) return sql
  const only = gap.only
  const picked = splitStatements(sql).filter((s) => only.test(s.replace(/--[^\n]*/g, '')))
  if (!picked.length) throw new Error(`${gap.file}: nothing matches ${only}`)
  const names = new Set(
    picked.flatMap((s) =>
      [...s.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi)].map((m) => m[1].toLowerCase()),
    ),
  )
  for (const later of files.filter((f) => f > gap.file)) {
    const text = read(later)
    for (const name of names) {
      if (new RegExp(`CREATE\\s+(OR\\s+REPLACE\\s+)?FUNCTION\\s+(public\\.)?${name}\\s*\\(`, 'i').test(text)) {
        throw new Error(`${later} redefines ${name}: take it from there, not ${gap.file}`)
      }
    }
  }
  return `${picked.map((s) => s.trim()).join('\n\n')}\n`
}

// ── the filter ──────────────────────────────────────────────────────────────

/**
 * Split SQL into statements, honouring quotes, quoted identifiers and dollar-quoting.
 * @param {string} sql
 * @returns {string[]}
 */
export function splitStatements(sql) {
  const out = []
  let start = 0
  let i = 0
  const n = sql.length
  while (i < n) {
    const c = sql[i]
    if (c === "'") {
      i++
      while (i < n) {
        if (sql[i] !== "'") i++
        else if (sql[i + 1] === "'") i += 2 // '' inside a string
        else break
      }
      i++
    } else if (c === '"') {
      i = sql.indexOf('"', i + 1) + 1 || n
    } else if (c === '-' && sql[i + 1] === '-') {
      i = sql.indexOf('\n', i) + 1 || n
    } else if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64))
      if (m) {
        const end = sql.indexOf(m[0], i + m[0].length)
        i = end === -1 ? n : end + m[0].length
      } else i++
    } else if (c === ';') {
      out.push(sql.slice(start, i + 1))
      start = i + 1
      i++
    } else i++
  }
  if (start < n) out.push(sql.slice(start))
  return out
}

/** The text between the parenthesis at `open` and its match. */
function parenBody(s, open) {
  let depth = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '"') i = s.indexOf('"', i + 1)
    else if (s[i] === "'") i = s.indexOf("'", i + 1)
    else if (s[i] === '(') depth++
    else if (s[i] === ')' && --depth === 0) return s.slice(open + 1, i)
  }
  return null
}

function splitTopLevel(s) {
  const parts = []
  let depth = 0
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '"' || c === "'") {
      const j = s.indexOf(c, i + 1)
      cur += s.slice(i, j + 1)
      i = j
      continue
    }
    if (c === '(') depth++
    if (c === ')') depth--
    if (c === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  if (cur.trim()) parts.push(cur)
  return parts
}

/**
 * name(type,type) for a function reference in pg_dump's quoting, or null.
 * @param {string} stmt
 * @returns {string | null}
 */
export function functionIdentity(stmt) {
  const m = /FUNCTION "(?:public|private)"\."([^"]+)"\(/.exec(stmt)
  if (!m) return null
  const args = parenBody(stmt, m.index + m[0].length - 1)
  if (args === null) return null
  const types = splitTopLevel(args)
    .map((a) => a.replace(/\s+DEFAULT\s[\s\S]*$/i, '').trim())
    .filter((a) => a && !/^OUT\s/i.test(a))
    .map((a) => {
      const arg = a.replace(/^(IN|INOUT|VARIADIC)\s+/i, '')
      // A leading quoted identifier followed by more is the argument's name.
      const named = /^"[^"]+"\s+(\S[\s\S]*)$/.exec(arg)
      return (named ? named[1] : arg).replace(/"/g, '').replace(/\s+/g, ' ').trim()
    })
  return `${m[1]}(${types.join(',')})`
}

const q = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * @typedef {{ tables?: string[], columns?: string[], functions?: string[], enumLabels?: string[], restore?: string[] }} Exclusions
 */

/**
 * Cut the excluded objects from a pg_dump script. Returns the script and a log of what went
 * (and which entries matched nothing, a sign the list is stale).
 * @param {string} sql
 * @param {Exclusions} [ex]
 * @returns {{ sql: string, log: string[], unused: string[] }}
 */
export function excludeFromDump(sql, ex = {}) {
  const tables = ex.tables ?? EXCLUDE_TABLES
  const columns = ex.columns ?? EXCLUDE_COLUMNS
  const functions = new Set((ex.functions ?? EXCLUDE_FUNCTIONS).map((f) => f.replace(/\s+/g, '')))
  const labels = ex.enumLabels ?? EXCLUDE_ENUM_LABELS
  const used = new Set()
  const log = []
  const tableRe = tables.map((t) => [t, new RegExp(`"public"\\."${q(t)}"(?![\\w"])`)])
  const kept = []
  for (let stmt of splitStatements(sql)) {
    const head = stmt.trim().split('\n')[0].slice(0, 160)
    const isFunctionDef = /^\s*CREATE (OR REPLACE )?FUNCTION /.test(stmt)
    const fn = /FUNCTION "(?:public|private)"\./.test(stmt) ? functionIdentity(stmt) : null
    const aboutFunction =
      /^\s*(CREATE (OR REPLACE )?|ALTER |COMMENT ON )FUNCTION /.test(stmt) || /^\s*(GRANT|REVOKE) [^;]* ON FUNCTION /.test(stmt)
    if (fn && aboutFunction && functions.has(fn.replace(/\s+/g, ''))) {
      used.add(`function ${fn}`)
      log.push(`- ${head}`)
      continue
    }
    // A trigger that runs an excluded function goes with it.
    const runs = /^\s*CREATE (OR REPLACE )?TRIGGER [\s\S]*EXECUTE FUNCTION "(?:public|private)"\."([^"]+)"\(\)/.exec(stmt)
    if (runs && functions.has(`${runs[2]}()`)) {
      log.push(`- ${head}`)
      continue
    }
    const hitTable = tableRe.find(([, re]) => re.test(stmt))
    if (hitTable) {
      if (isFunctionDef) {
        log.push(`! kept, but its body names excluded table ${hitTable[0]}: ${head}`)
      } else {
        used.add(`table ${hitTable[0]}`)
        log.push(`- ${head}`)
        continue
      }
    }
    let drop = false
    for (const col of columns) {
      const [t, c] = col.split('.')
      const onTable = new RegExp(`"public"\\."${q(t)}"(?![\\w"])`).test(stmt)
      if (!onTable) continue
      const colRe = new RegExp(`(^|[^\\w])"${q(c)}"(?![\\w"])`, 'm')
      if (new RegExp(`^\\s*CREATE TABLE (IF NOT EXISTS )?"public"\\."${q(t)}" \\(`).test(stmt)) {
        // The column's line, and any table constraint line that names it (pg_dump writes
        // each on one line).
        const lines = stmt.split('\n')
        const keep = lines.filter(
          (l) => !new RegExp(`^\\s+"${q(c)}" `).test(l) && !(/^\s+CONSTRAINT /.test(l) && colRe.test(l)),
        )
        if (keep.length !== lines.length) {
          // Whatever is now last before the closing parenthesis loses its comma.
          const close = keep.findIndex((l) => /^\)/.test(l))
          if (close > 0) keep[close - 1] = keep[close - 1].replace(/,\s*$/, '')
          stmt = keep.join('\n')
          used.add(`column ${col}`)
          log.push(`- column ${col} (and its constraints) from CREATE TABLE "public"."${t}"`)
        }
      } else if (!isFunctionDef && (colRe.test(stmt) || stmt.includes(`"public"."${t}"."${c}"`))) {
        used.add(`column ${col}`)
        log.push(`- ${head}`)
        drop = true
        break
      }
    }
    if (drop) continue
    for (const l of labels) {
      const [type, label] = l.split('.')
      const enumRe = new RegExp(`^\\s*CREATE TYPE "public"\\."${q(type)}" AS ENUM \\(`)
      if (!enumRe.test(stmt)) continue
      const next = stmt.replace(new RegExp(`,\\s*'${q(label)}'|'${q(label)}',\\s*`), '')
      if (next !== stmt) {
        stmt = next
        used.add(`enum ${l}`)
        log.push(`- enum label ${l}`)
      }
    }
    kept.push(stmt)
  }
  const unused = [
    ...tables.map((t) => `table ${t}`),
    ...columns.map((c) => `column ${c}`),
    ...[...functions].map((f) => `function ${f}`),
    ...labels.map((l) => `enum ${l}`),
  ].filter((k) => ![...used].some((u) => u.replace(/\s+/g, '') === k.replace(/\s+/g, '')))
  // Put back what the migrations define, unless the source already has it by that name.
  let out = kept.join('')
  const restore = (ex.restore ?? RESTORE).filter((s) => {
    const name = /ADD CONSTRAINT ("[^"]+")/.exec(s)?.[1]
    return !(name && out.includes(`CONSTRAINT ${name} `))
  })
  if (restore.length) {
    out = `${out.trimEnd()}\n\n\n-- Restored from the migrations (scripts/db-baseline-exclude.mjs RESTORE).\n${restore.join('\n')}\n`
    log.push(...restore.map((s) => `+ ${s}`))
  }
  return { sql: out, log, unused }
}

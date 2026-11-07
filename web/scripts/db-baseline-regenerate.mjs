#!/usr/bin/env node
// Regenerate supabase/baseline/schema.sql and seed.sql: the database as the migrations up to
// the cut define it, and the configuration rows the app needs. Read-only on the source
// project (pg_dump, run by the Supabase CLI in Docker, and SELECTs).
//
//   node scripts/db-baseline-regenerate.mjs <project-ref> <cut>
//
// The source (DEV) has drifted from the migrations, so its dump isn't taken as it is:
//   1. dump the source's public and private schemas, and read its config rows;
//   2. cut what no migration makes and no code uses, and put back what the source replaced
//      in place (scripts/db-baseline-exclude.mjs: the EXCLUDE_* lists and RESTORE);
//   3. load that into a scratch local Supabase stack, with the config rows;
//   4. apply the migrations the source is missing there (DEV_GAPS, same file);
//   5. dump the local stack and read its rows: that is the baseline.
// Then prove it with scripts/db-bootstrap.sh on another empty local stack.
//
// Needs the Supabase CLI logged in (SUPABASE_CLI, default `supabase`), Docker and Node. It
// starts and removes its own stack (project id db-baseline-gen, ports 54321-54329): stop any
// other local stack first.
//
// What it writes:
//   schema.sql  pg_dump of public and private with the CLI's usual filters, minus extensions
//               the app doesn't use, then what the app needs in schemas a Supabase project
//               manages: triggers on auth.users, storage buckets, and the storage.objects and
//               realtime.messages policies.
//   seed.sql    the configuration rows (SEED below), never user, workspace or usage data.
//   CUT         the cut number, under the rules already in the file.

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEV_GAPS, EXCLUDE_TABLES, excludeFromDump, gapSql } from './db-baseline-exclude.mjs'

const [ref, cutArg] = process.argv.slice(2)
if (!ref || !/^\d+$/.test(cutArg ?? '')) {
  console.error('usage: node scripts/db-baseline-regenerate.mjs <project-ref> <cut>')
  process.exit(1)
}
const cut = Number(cutArg)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'supabase/baseline')
const MIGRATIONS = path.join(ROOT, 'supabase/migrations')
const CLI = process.env.SUPABASE_CLI || 'supabase'
const STACK_ID = 'db-baseline-gen'
const DB_CONTAINER = `supabase_db_${STACK_ID}`
// The CLI treats ./supabase as its project folder: run it from an empty one.
const work = mkdtempSync(path.join(tmpdir(), 'db-baseline-'))
const stack = path.join(work, 'stack')

function run(cmd, args, input) {
  const r = spawnSync(cmd, args, { cwd: work, encoding: 'utf8', maxBuffer: 1 << 30, input })
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed:\n${r.stderr || r.stdout}`)
  return r.stdout
}
const cli = (args) => run(CLI, args)

/** Rows from the source project. `sql` is one SELECT; it runs with an empty search_path. */
function sourceQuery(sql) {
  const out = cli(['db', 'query', '--linked', '--project-ref', ref, `set search_path = '';\n${sql}`])
  return JSON.parse(out.slice(out.indexOf('{'))).rows
}

/** Run a script on the scratch stack as postgres. */
function localExec(sql, { single = false } = {}) {
  const args = ['exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1']
  return run('docker', single ? [...args, '-1'] : args, sql)
}

/** Rows from the scratch stack. `sql` is one SELECT; it runs with an empty search_path. */
function localQuery(sql) {
  const out = run('docker', [
    'exec', '-i', DB_CONTAINER, 'psql', '-U', 'postgres', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1',
    '-c', "set search_path = ''",
    '-c', `select coalesce(json_agg(t), '[]') from (${sql}) t`,
  ])
  return JSON.parse(out.trim())
}

const migrations = readdirSync(MIGRATIONS).filter((f) => /^\d+_.*\.sql$/.test(f)).sort()
const atOrBelow = migrations.filter((f) => Number.parseInt(f, 10) <= cut)
if (!atOrBelow.some((f) => Number.parseInt(f, 10) === cut)) throw new Error(`no migration numbered ${cut}`)
const readMigration = (f) => readFileSync(path.join(MIGRATIONS, f), 'utf8')
for (const g of DEV_GAPS) {
  if (Number.parseInt(g.file, 10) > cut) throw new Error(`DEV_GAPS names ${g.file}, after the cut`)
}

// ── the schema filter ───────────────────────────────────────────────────────
// Extensions enabled on the source that nothing in the app uses (dblink, wrappers), and ones
// every Supabase project manages itself (pg_stat_statements, supabase_vault).
const UNUSED_EXTENSIONS = ['dblink', 'wrappers', 'pg_stat_statements', 'supabase_vault']

// pg_dump writes each object's grants as the change from Postgres's built-in default. A
// Supabase project's default privileges grant more than that on every new object in public
// (EXECUTE on functions to anon and authenticated, for one), so clear them before anything
// is made, or objects would come out with grants the source doesn't have. The dump's own
// ALTER DEFAULT PRIVILEGES at the end puts the source's back.
const RESET_DEFAULTS = ['TABLES', 'SEQUENCES', 'FUNCTIONS']
  .map(
    (k) =>
      `ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" REVOKE ALL ON ${k} FROM "postgres", "anon", "authenticated", "service_role";`,
  )
  .join('\n')

function filterDump(raw) {
  // Grants on functions the dump doesn't create belong to extensions (vector, pg_trgm,
  // unaccent). supabase_admin owns those, so as postgres they only print "no privileges
  // were granted": a fresh project already gives them the same grants. Drop them.
  const created = new Set([...raw.matchAll(/^CREATE OR REPLACE FUNCTION ("[^"]+"\."[^"]+")\(/gm)].map((m) => m[1]))
  const out = raw
    .split('\n')
    .filter((line) => !UNUSED_EXTENSIONS.some((e) => line.startsWith(`CREATE EXTENSION IF NOT EXISTS "${e}"`)))
    .filter((line) => {
      const m = line.match(/^(?:GRANT|REVOKE) .* ON FUNCTION ("[^"]+"\."[^"]+")\(/)
      return !m || created.has(m[1])
    })
    .join('\n')
  const marker = 'SET row_security = off;\n'
  if (!out.includes(marker)) throw new Error('pg_dump header changed: no "SET row_security = off;"')
  return out.replace(marker, `${marker}\n${RESET_DEFAULTS}\n`)
}

// What the app needs in the schemas a Supabase project manages.
function outsidePublic(query) {
  const triggers = query(`
    select pg_get_triggerdef(t.oid) || ';' as ddl
    from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
    join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
    where n.nspname = 'auth' and not t.tgisinternal and pn.nspname in ('public', 'private')
    order by t.tgname`)
  const buckets = query(`
    select format('INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES (%L, %L, %L, %L, %L) ON CONFLICT (id) DO NOTHING;',
      id, name, public, file_size_limit, allowed_mime_types) as ddl
    from storage.buckets order by id`)
  const policies = query(`
    select format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s;', p.polname, n.nspname, c.relname,
      case when p.polpermissive then 'PERMISSIVE' else 'RESTRICTIVE' end,
      case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT' when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end,
      (select string_agg(case when r = 0 then 'public' else quote_ident(pg_get_userbyid(r)) end, ', ') from unnest(p.polroles) r),
      case when p.polqual is not null then E'\\n  USING (' || pg_get_expr(p.polqual, p.polrelid) || ')' else '' end,
      case when p.polwithcheck is not null then E'\\n  WITH CHECK (' || pg_get_expr(p.polwithcheck, p.polrelid) || ')' else '' end) as ddl
    from pg_policy p join pg_class c on c.oid = p.polrelid join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('storage', 'realtime')
    order by n.nspname, c.relname, p.polname`)
  const sql = `

-- ════════════════════════════════════════════════════════════════════════════
-- Outside public: what the app needs in the schemas a Supabase project manages.
-- ════════════════════════════════════════════════════════════════════════════

-- auth.users triggers that call the app's functions (new user setup).
${triggers.map((r) => r.ddl).join('\n')}

-- Storage buckets.
${buckets.map((r) => r.ddl).join('\n')}

-- storage.objects and realtime.messages (private channel) policies.
${policies.map((r) => r.ddl).join('\n\n')}
`
  const strays = EXCLUDE_TABLES.filter((t) => new RegExp(`\\bpublic\\.${t}\\b`).test(sql))
  if (strays.length) throw new Error(`a policy or trigger outside public names an excluded table: ${strays.join(', ')}`)
  return sql
}

// ── the seed ────────────────────────────────────────────────────────────────
// Configuration only: [table, which rows, order, columns written as NULL, why].
const SEED = [
  ['ai_plan_definitions', 'true', 'sort_order, name', ['stripe_price_id'],
    'Plans (free, BYOK, subscriber): limits, allowed providers and the pricing page. Stripe price ids belong to one Stripe account: set your own.'],
  ['ai_model_costs', 'true', 'provider, model, effective_from', [],
    'Per-model token prices that usage logging and plan limits charge against.'],
  ['features', 'true', 'sort_order, id', [],
    'Purchasable desktop features (speech to text, text to speech).'],
  ['purchase_options', 'true', 'sort_order, id', ['stripe_price_id'],
    'One-time purchases and bundles of those features. Stripe price ids: set your own.'],
  ['recipe', 'workspace_id is null', 'category, is_system desc, slug nulls last, id', ['created_by'],
    'The built-in library every workspace sees (workspace_id NULL): system skills and agents, and the loop and work-bot anchor agents.'],
]

// Real names left in built-in rows become the stand-ins the migrations use.
const STAND_INS = readFileSync(path.join(ROOT, 'scripts/open-source/stand-ins.txt'), 'utf8')
  .split('\n')
  .filter((l) => l.trim() && !l.startsWith('#'))
  .map((l) => {
    const [pattern, standIn] = l.split('\t')
    return [new RegExp(pattern, 'gu'), standIn]
  })
const scrub = (text) => STAND_INS.reduce((t, [re, standIn]) => t.replace(re, standIn), text)

function seedSql(query) {
  let seed = `-- Database baseline: configuration rows. GENERATED by scripts/db-baseline-regenerate.mjs.
-- Cut: migration ${cut}. Only the rows the app needs to run, never user, workspace, message,
-- token or usage data. scripts/db-bootstrap.sh applies it after schema.sql.

SET search_path = '';
`
  for (const [table, where, order, nulls, why] of SEED) {
    const override = nulls.length ? ` || jsonb_build_object(${nulls.map((c) => `'${c}', null`).join(', ')})` : ''
    const [{ rows: found }] = query(
      `select jsonb_pretty(coalesce(jsonb_agg(to_jsonb(t)${override} order by ${order}), '[]'::jsonb)) as rows from public.${table} t where ${where}`,
    )
    const rows = scrub(found)
    if (rows.includes('$seed$')) throw new Error(`${table}: a row contains the $seed$ quote tag`)
    seed += `
-- ${table} (${JSON.parse(rows).length} rows): ${why}
INSERT INTO public.${table}
SELECT * FROM jsonb_populate_recordset(NULL::public.${table}, $seed$
${rows}
$seed$)
ON CONFLICT DO NOTHING;
`
  }
  return seed
}

// ── 1-2. the source, filtered ───────────────────────────────────────────────
const sourceRaw = path.join(work, 'source.sql')
cli(['db', 'dump', '--linked', '--project-ref', ref, '-f', sourceRaw])
const excluded = excludeFromDump(readFileSync(sourceRaw, 'utf8'))
console.log(`excluded from the source (scripts/db-baseline-exclude.mjs):\n${excluded.log.join('\n')}`)
if (excluded.unused.length) {
  console.warn(`exclusions that matched nothing (gone from the source? drop them):\n  ${excluded.unused.join('\n  ')}`)
}
const sourceSchema = `${filterDump(excluded.sql)}\n${outsidePublic(sourceQuery)}`
const sourceSeed = seedSql(sourceQuery)

let schemaBody
let outside
let seed
try {
  // ── 3. a scratch stack with the source on it ──────────────────────────────
  mkdirSync(stack)
  cli(['init', '--workdir', stack, '--yes'])
  const config = path.join(stack, 'supabase/config.toml')
  writeFileSync(config, readFileSync(config, 'utf8').replace(/^project_id = .*$/m, `project_id = "${STACK_ID}"`))
  cli(['start', '--workdir', stack, '-x', 'studio,imgproxy,edge-runtime,logflare,vector,mailpit,postgres-meta,supavisor'])
  localExec(sourceSchema, { single: true })
  localExec(sourceSeed, { single: true })

  // ── 4. the migrations the source is missing ───────────────────────────────
  for (const gap of [...DEV_GAPS].sort((a, b) => a.file.localeCompare(b.file))) {
    console.log(`DEV gap: ${gap.file}${gap.only ? ' (part)' : ''}: ${gap.why}`)
    localExec(gapSql(gap, readMigration, migrations))
  }

  // ── 5. the baseline, from the stack ───────────────────────────────────────
  const localRaw = path.join(work, 'local.sql')
  cli(['db', 'dump', '--local', '--workdir', stack, '-f', localRaw])
  const raw = readFileSync(localRaw, 'utf8')
  const leftover = excludeFromDump(raw, { restore: [] })
  if (leftover.log.length) throw new Error(`excluded objects came back after the gaps:\n${leftover.log.join('\n')}`)
  schemaBody = filterDump(raw).replace(/\n{4,}/g, '\n\n\n')
  outside = outsidePublic(localQuery)
  seed = seedSql(localQuery)
} finally {
  spawnSync(CLI, ['stop', '--workdir', stack, '--no-backup'], { cwd: work, stdio: 'ignore' })
}

const header = `-- Database baseline: schema. GENERATED by scripts/db-baseline-regenerate.mjs; don't edit by hand.
-- Cut: migration ${cut} (${atOrBelow.length} migration files, the last ${atOrBelow[atOrBelow.length - 1]}).
-- scripts/db-bootstrap.sh applies this file, then seed.sql, then every migration numbered
-- after the cut. The rules are in supabase/baseline/CUT.
`
writeFileSync(path.join(OUT, 'schema.sql'), `${header}\n${schemaBody.trimEnd()}\n${outside}`)
writeFileSync(path.join(OUT, 'seed.sql'), seed)

// ── denylist ────────────────────────────────────────────────────────────────
// The same check as scripts/open-source/export.sh: no real person, customer or partner.
const denylist = readFileSync(path.join(ROOT, 'scripts/open-source/denylist.txt'), 'utf8')
  .split('\n')
  .filter((l) => !/^\s*(#|$)/.test(l))
  .map((p) => new RegExp(p, 'iu'))
const hits = []
for (const file of ['schema.sql', 'seed.sql']) {
  readFileSync(path.join(OUT, file), 'utf8')
    .split('\n')
    .forEach((line, i) => {
      for (const re of denylist) if (re.test(line)) hits.push(`${file}:${i + 1} matches ${re.source}`)
    })
}
if (hits.length) {
  console.error(`denylist matches (add a stand-in to scripts/open-source/stand-ins.txt):\n${hits.join('\n')}`)
  process.exit(1)
}

// ── CUT ─────────────────────────────────────────────────────────────────────
const cutFile = path.join(OUT, 'CUT')
const rules = readFileSync(cutFile, 'utf8').split('\n').filter((l) => l.startsWith('#')).join('\n')
writeFileSync(cutFile, `${rules}\n${cut}\n`)

rmSync(work, { recursive: true, force: true })
console.log(`baseline regenerated at migration ${cut} in ${OUT}`)

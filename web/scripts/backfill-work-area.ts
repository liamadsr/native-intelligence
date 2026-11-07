/**
 * One-off back-fill after migration 318 (docs/plans/one-agent-and-chat-pages.md,
 * Phase S3): work records its area, and the Assistant's catch-all work moves
 * to its area's face. Migration 318 itself already folded Triage, Extraction,
 * the Reconciler and Email drafts into Captures and Mail (their rows, threads,
 * notices and cards); this script does what is safer in batches.
 *
 * Steps, each only where the writer or the source makes the area certain:
 *   1. kinds   ledger rows with no area whose kind has one fixed area
 *              (src/lib/work/work-area.ts KIND_AREAS: extraction, the
 *              reconciler and age-out, the email pass, imports, prospecting,
 *              evals, enrichment, sequence sends).
 *   2. loops   loop runs (`flow_run`) with no area, by their loop
 *              (`source.flow_id`): a seeded Triage or Commitment reconciler
 *              loop is Captures'; any other loop, its skills' area when they
 *              agree on one (recipe.area, migration 316). A loop whose skills
 *              disagree, or have none, is left alone.
 *   2b. named  rows with no area that name an area face take its area: the
 *              face is the area (a loop or a run Captures fronts).
 *   3. faces   the rows of the kinds an area face now takes (the extraction
 *              pass, the reconciler, the age-out and the email pass, which
 *              older rows may name no teammate for, and prospecting, evals,
 *              enrichment and the imports, the Assistant's) that name the
 *              workspace's Assistant, or no teammate at all (older rows the
 *              Assistant showed where they were read: bot-owner.ts), move to
 *              that face, as their writers now name it (system-teammates.ts
 *              workTeammateId, areaTeammateId). A skill holder's or a role
 *              teammate's stay theirs. Their bot notices move with them
 *              (metadata.teammate_id, teammate_name, and a title that was the
 *              Assistant's name).
 *   4. notices bot notices with no area take their ledger row's
 *              (metadata.work_item_id → tracked_job.area).
 *
 * Every write is fenced on what it read (area still null; the row still the
 * Assistant's), so a re-run changes nothing it already did.
 *
 * PREFLIGHT first (src/lib/work/area-backfill-preflight.ts): the columns and
 * rows migrations 316, 317 and 318 add. Anything missing stops the run before
 * a single read of the work, dry run or --execute, naming the migration to
 * apply, so an --execute can never stop halfway on a missing column.
 *
 * DRY-RUN by default: prints counts, writes nothing. Pass --execute to write.
 * It prints ids and counts only, never a title or any content.
 *
 * Usage:
 *   npx tsx scripts/backfill-work-area.ts [--execute] [--workspace <id>] [--env-file <path>]
 *
 * Required env vars:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   — the anon key silently reads/writes 0 rows under RLS.
 * Read from --env-file when given, and then the file WINS over anything already
 * exported in the shell. With no --env-file, .env.local fills only what isn't
 * exported. The script prints its target host first: check it before
 * --execute. It never prints a key.
 *
 * PROD (with Liam's word, after migrations 316, 317 and 318), from a checkout of this branch:
 *   npx tsx scripts/backfill-work-area.ts --env-file <main checkout>/.env.production.local
 *   npx tsx scripts/backfill-work-area.ts --env-file <main checkout>/.env.production.local --execute
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { KIND_AREAS, areaFaceKey, singleArea } from '../src/lib/work/work-area'
import { flowSkillIds, systemKeyForFlow } from '../src/lib/work/system-teammates'
import { areaBackfillPreflight } from '../src/lib/work/area-backfill-preflight'

const arg = (flag: string) => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? (process.argv[at + 1] ?? null) : null
}

const ENV_FILE = arg('--env-file')
config({ path: ENV_FILE ?? '.env.local', override: ENV_FILE !== null, quiet: true })

const EXECUTE = process.argv.includes('--execute')
const WORKSPACE_FILTER = arg('--workspace')

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL')
if (!SUPABASE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

const PAGE = 1000
const CHUNK = 100

/**
 * The kinds whose rows move from the Assistant, or from no teammate, to their
 * area's face (step 3): every fixed-area kind whose area has a face (sequence
 * sends' area has none: they keep no bot).
 */
const FACE_KINDS = Object.keys(KIND_AREAS).filter((kind) => areaFaceKey(KIND_AREAS[kind]) !== null)

type Row = Record<string, unknown>

/** Every row a query pages through. */
async function all<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    out.push(...(data ?? []))
    if (!data || data.length < PAGE) return out
  }
}

const chunks = <T>(list: readonly T[]) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK))

const counts = { kinds: 0, loops: 0, named: 0, faces: 0, faceNotices: 0, notices: 0, failed: 0 }

function fail(step: string, message: string) {
  counts.failed++
  console.log(`    FAILED ${step}: ${message}`)
}

// ── 1. Fixed kinds ──────────────────────────────────────────────────────────
async function stepKinds() {
  console.log('1. Ledger rows whose kind has one area')
  for (const [kind, area] of Object.entries(KIND_AREAS)) {
    let count = supabase.from('tracked_job').select('id', { count: 'exact', head: true }).eq('kind', kind).is('area', null)
    if (WORKSPACE_FILTER) count = count.eq('workspace_id', WORKSPACE_FILTER)
    const { count: n, error } = await count
    if (error) {
      fail(`count ${kind}`, error.message)
      continue
    }
    if (!n) continue
    console.log(`   ${kind} → ${area}: ${n}`)
    counts.kinds += n
    if (!EXECUTE) continue
    let write = supabase.from('tracked_job').update({ area }).eq('kind', kind).is('area', null)
    if (WORKSPACE_FILTER) write = write.eq('workspace_id', WORKSPACE_FILTER)
    const { error: writeError } = await write
    if (writeError) fail(`write ${kind}`, writeError.message)
  }
}

// ── 2. Loop runs, by their loop ─────────────────────────────────────────────
async function stepLoops() {
  console.log('2. Loop runs, by their loop')
  const rows = await all<Row>((from, to) => {
    let q = supabase.from('tracked_job').select('id, workspace_id, source').eq('kind', 'flow_run').is('area', null)
    if (WORKSPACE_FILTER) q = q.eq('workspace_id', WORKSPACE_FILTER)
    return q.order('id', { ascending: true }).range(from, to)
  })
  const flowIds = [...new Set(rows.map((r) => (r.source as { flow_id?: unknown } | null)?.flow_id).filter((id): id is string => typeof id === 'string' && !!id))]
  const flows = new Map<string, { workspace_id: string; seed_key: string | null; actions: unknown }>()
  for (const ids of chunks(flowIds)) {
    const { data, error } = await supabase.from('flow').select('id, workspace_id, seed_key, actions').in('id', ids)
    if (error) throw new Error(error.message)
    for (const f of (data ?? []) as Array<{ id: string; workspace_id: string; seed_key: string | null; actions: unknown }>) flows.set(f.id, f)
  }
  // Each loop's skills, read once.
  const skillIds = [...new Set([...flows.values()].flatMap((f) => flowSkillIds(Array.isArray(f.actions) ? (f.actions as Array<{ type: string }>) : [])))]
  const skills = new Map<string, { area: string | null; workspace_id: string | null; is_system: boolean }>()
  for (const ids of chunks(skillIds)) {
    const { data, error } = await supabase.from('recipe').select('id, area, workspace_id, is_system').in('id', ids).eq('category', 'skill')
    if (error) throw new Error(error.message)
    for (const s of (data ?? []) as Array<{ id: string; area: string | null; workspace_id: string | null; is_system: boolean }>) skills.set(s.id, s)
  }
  const areaOfFlow = new Map<string, string | null>()
  for (const [id, f] of flows) {
    const seeded = systemKeyForFlow({ seed_key: f.seed_key })
    if (seeded) {
      areaOfFlow.set(id, areaFaceKey(seeded))
      continue
    }
    // The run_skill executor's visibility rule: the loop's workspace's own skills, or a system one.
    const areas = flowSkillIds(Array.isArray(f.actions) ? (f.actions as Array<{ type: string }>) : [])
      .map((sid) => skills.get(sid))
      .filter((s) => s && (s.is_system || s.workspace_id === f.workspace_id))
      .map((s) => s!.area)
    areaOfFlow.set(id, singleArea(areas))
  }
  const byArea = new Map<string, string[]>()
  for (const r of rows) {
    const flowId = (r.source as { flow_id?: unknown } | null)?.flow_id
    const area = typeof flowId === 'string' ? areaOfFlow.get(flowId) : null
    if (!area) continue
    byArea.set(area, [...(byArea.get(area) ?? []), r.id as string])
  }
  for (const [area, ids] of byArea) {
    console.log(`   flow_run → ${area}: ${ids.length}`)
    counts.loops += ids.length
    if (!EXECUTE) continue
    for (const chunk of chunks(ids)) {
      const { error } = await supabase.from('tracked_job').update({ area }).in('id', chunk).is('area', null)
      if (error) fail(`loops ${area}`, error.message)
    }
  }
  console.log(`   (${rows.length - counts.loops} loop runs left with no area: no loop, or skills with no single area)`)
}

// ── 2b. Rows named for an area face take its area ──────────────────────────
async function stepNamed() {
  console.log('2b. Rows with no area that name an area face')
  const mates = await all<Row>((from, to) => {
    let q = supabase.from('ai_team_member').select('id, system_key').eq('is_system', true)
    if (WORKSPACE_FILTER) q = q.eq('workspace_id', WORKSPACE_FILTER)
    return q.order('id', { ascending: true }).range(from, to)
  })
  const byArea = new Map<string, string[]>()
  for (const m of mates) {
    const area = areaFaceKey(m.system_key as string | null)
    if (area) byArea.set(area, [...(byArea.get(area) ?? []), m.id as string])
  }
  for (const [area, faceIds] of byArea) {
    let n = 0
    for (const ids of chunks(faceIds)) {
      const { count, error } = await supabase.from('tracked_job').select('id', { count: 'exact', head: true }).in('ai_team_member_id', ids).is('area', null)
      if (error) {
        fail(`count named ${area}`, error.message)
        continue
      }
      n += count ?? 0
      if (EXECUTE && count) {
        const { error: writeError } = await supabase.from('tracked_job').update({ area }).in('ai_team_member_id', ids).is('area', null)
        if (writeError) fail(`named ${area}`, writeError.message)
      }
    }
    if (n) console.log(`   named for ${area}: ${n}`)
    counts.named += n
  }
}

// ── 3. The Assistant's former work, to its area's face ──────────────────────
async function stepFaces() {
  console.log("3. The Assistant's (or nobody's) rows of the kinds an area face now takes")
  const mates = await all<Row>((from, to) => {
    let q = supabase.from('ai_team_member').select('id, workspace_id, system_key, name').eq('is_system', true)
    if (WORKSPACE_FILTER) q = q.eq('workspace_id', WORKSPACE_FILTER)
    return q.order('id', { ascending: true }).range(from, to)
  })
  const assistants = new Map<string, { id: string; name: string }>()
  const faces = new Map<string, { id: string; name: string }>()
  for (const m of mates) {
    const ws = m.workspace_id as string
    if (m.system_key === 'assistant') assistants.set(ws, { id: m.id as string, name: (m.name as string) || 'Assistant' })
    else if (typeof m.system_key === 'string') faces.set(`${ws}:${m.system_key}`, { id: m.id as string, name: (m.name as string) || m.system_key })
  }
  const assistantIds = [...assistants.values()].map((a) => a.id)
  const rows: Row[] = []
  for (const ids of chunks(assistantIds)) {
    rows.push(
      ...(await all<Row>((from, to) =>
        supabase.from('tracked_job').select('id, workspace_id, kind, ai_team_member_id').in('ai_team_member_id', ids).in('kind', FACE_KINDS).order('id', { ascending: true }).range(from, to),
      )),
    )
  }
  // Older rows with no teammate at all (the Assistant showed them where read).
  rows.push(
    ...(await all<Row>((from, to) => {
      let q = supabase.from('tracked_job').select('id, workspace_id, kind, ai_team_member_id').is('ai_team_member_id', null).in('kind', FACE_KINDS)
      if (WORKSPACE_FILTER) q = q.eq('workspace_id', WORKSPACE_FILTER)
      return q.order('id', { ascending: true }).range(from, to)
    })),
  )
  const NOBODY = { id: '', name: '' }
  const moves = new Map<string, { from: { id: string; name: string }; to: { id: string; name: string }; area: string; ids: string[] }>()
  let noFace = 0
  for (const r of rows) {
    const ws = r.workspace_id as string
    const area = KIND_AREAS[r.kind as string]
    const face = area ? faces.get(`${ws}:${area}`) : undefined
    const assistant = assistants.get(ws)
    const from = r.ai_team_member_id === null ? NOBODY : assistant && assistant.id === r.ai_team_member_id ? assistant : null
    if (!face || !from) {
      noFace++
      continue
    }
    const key = `${from.id || 'none'}:${ws}>${face.id}`
    const move = moves.get(key) ?? { from, to: face, area: area!, ids: [] }
    move.ids.push(r.id as string)
    moves.set(key, move)
  }
  for (const m of moves.values()) {
    console.log(`   ${m.from.id || '(no teammate)'} → ${m.to.id} (${m.area}): ${m.ids.length} rows`)
    counts.faces += m.ids.length
    if (!m.from.id) {
      // No teammate: no bot notice to move; the write is fenced on it still having none.
      if (!EXECUTE) continue
      for (const chunk of chunks(m.ids)) {
        const { error } = await supabase.from('tracked_job').update({ ai_team_member_id: m.to.id }).in('id', chunk).is('ai_team_member_id', null)
        if (error) fail(`faces ${m.area}`, error.message)
      }
      continue
    }
    if (!EXECUTE) {
      // Count the notices that would follow.
      for (const chunk of chunks(m.ids)) {
        const { count } = await supabase
          .from('notification')
          .select('id', { count: 'exact', head: true })
          .in('metadata->>work_item_id', chunk)
          .eq('metadata->>teammate_id', m.from.id)
        counts.faceNotices += count ?? 0
      }
      continue
    }
    for (const chunk of chunks(m.ids)) {
      const { error } = await supabase.from('tracked_job').update({ ai_team_member_id: m.to.id }).in('id', chunk).eq('ai_team_member_id', m.from.id)
      if (error) {
        fail(`faces ${m.area}`, error.message)
        continue
      }
      const { data: notices, error: readError } = await supabase
        .from('notification')
        .select('id, title, metadata')
        .in('metadata->>work_item_id', chunk)
        .eq('metadata->>teammate_id', m.from.id)
      if (readError) {
        fail(`face notices ${m.area}`, readError.message)
        continue
      }
      for (const n of (notices ?? []) as Array<{ id: string; title: string | null; metadata: Record<string, unknown> }>) {
        const metadata = {
          ...n.metadata,
          teammate_id: m.to.id,
          ...('teammate_name' in n.metadata ? { teammate_name: m.to.name } : {}),
          area: m.area,
        }
        const { error: writeError } = await supabase
          .from('notification')
          .update({ metadata, ...(n.title === m.from.name ? { title: m.to.name } : {}) })
          .eq('id', n.id)
          .eq('metadata->>teammate_id', m.from.id)
        if (writeError) fail(`notice ${n.id}`, writeError.message)
        else counts.faceNotices++
      }
    }
  }
  if (noFace > 0) console.log(`   (${noFace} rows left with the Assistant: their workspace has no face for the area yet)`)
}

// ── 4. Bot notices take their row's area ────────────────────────────────────
async function stepNotices() {
  console.log("4. Bot notices with no area, from their row's")
  const notices = await all<Row>((from, to) => {
    let q = supabase.from('notification').select('id, metadata').not('metadata->>work_item_id', 'is', null).is('metadata->>area', null)
    if (WORKSPACE_FILTER) q = q.eq('workspace_id', WORKSPACE_FILTER)
    return q.order('id', { ascending: true }).range(from, to)
  })
  const rowIds = [...new Set(notices.map((n) => (n.metadata as Record<string, unknown>).work_item_id).filter((id): id is string => typeof id === 'string'))]
  const areaOf = new Map<string, string>()
  for (const ids of chunks(rowIds)) {
    const { data, error } = await supabase.from('tracked_job').select('id, area').in('id', ids).not('area', 'is', null)
    if (error) throw new Error(error.message)
    for (const r of (data ?? []) as Array<{ id: string; area: string }>) areaOf.set(r.id, r.area)
  }
  for (const n of notices) {
    const metadata = n.metadata as Record<string, unknown>
    const area = areaOf.get(metadata.work_item_id as string)
    if (!area) continue
    counts.notices++
    if (!EXECUTE) continue
    const { error } = await supabase.from('notification').update({ metadata: { ...metadata, area } }).eq('id', n.id as string).is('metadata->>area', null)
    if (error) fail(`notice ${n.id}`, error.message)
  }
  console.log(`   ${counts.notices} notices${EXECUTE ? '' : ' would'} take their row's area${EXECUTE ? '' : ' (a dry run counts only rows that already have one; steps 1 and 2 add more)'}`)
}

async function main() {
  console.log(`Target: ${new URL(SUPABASE_URL!).host}${ENV_FILE ? ` (from ${ENV_FILE})` : ''}`)
  console.log(`Mode: ${EXECUTE ? 'EXECUTE' : 'dry-run (pass --execute to write)'}${WORKSPACE_FILTER ? `, workspace ${WORKSPACE_FILTER}` : ''}`)
  console.log('')
  // Nothing is read or written past this until every migration it needs is there.
  const missing = await areaBackfillPreflight(supabase)
  if (missing.length > 0) {
    console.error('Stopped before writing anything. This database lacks:')
    for (const m of missing) console.error(`  - ${m.missing}`)
    console.error('Apply 316, then 317, then 318 (each as one transaction), then run this again.')
    process.exitCode = 1
    return
  }
  console.log('Preflight: 316, 317 and 318 are in.')
  await stepKinds()
  await stepLoops()
  await stepNamed()
  await stepFaces()
  // After 1 and 2, so the notices see the rows' new areas.
  await stepNotices()
  console.log('')
  console.log(
    `${EXECUTE ? 'Done' : 'Dry run'}: ${counts.kinds} rows by kind, ${counts.loops} loop runs, ${counts.named} rows by their face, ${counts.faces} rows to their area's face ` +
      `(${counts.faceNotices} notices with them), ${counts.notices} notices given their row's area; ${counts.failed} failed`,
  )
  if (counts.failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

/**
 * One-off back-fill: the work bots on `chat` move to their workspace's next
 * free character, renamed to match (docs/plans/bots-v4.md decision 7, Phase 5).
 *
 * Runs AFTER migration 310, which reserves `chat` (the catalogue's Assistant)
 * for the new Assistant system teammate. DEV first; PROD only on Liam's word.
 *
 * The plan is src/lib/bots/assistant-face-backfill.ts: each work bot on `chat`,
 * oldest first per workspace, takes the first free face that is nobody's
 * starting face (not a role's or a system teammate's; any free face only when
 * those are all worn), and a work bot still named "Assistant" (v3's back-fill
 * named it after its face) takes the new face's catalogue name, unless another
 * teammate there already goes by it. A renamed one keeps its name. Work bots
 * in a workspace with every character worn are reported and left alone, and
 * so are other teammates on `chat` (ones people made, which got `chat` first
 * since migration 297) unless --include-others moves them too, by the same
 * rules.
 *
 * Each write is fenced on the row still being on `chat` (and still a work bot,
 * for one), so a re-run (or a face someone changed meanwhile) never moves a
 * teammate twice.
 *
 * DRY-RUN by default: prints the plan, writes nothing. Pass --execute to write.
 *
 * Usage:
 *   npx tsx scripts/backfill-assistant-face.ts [--execute] [--include-others] [--workspace <id>] [--env-file <path>]
 *
 * Required env vars:
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   — the anon key silently reads/writes 0 rows under RLS.
 * Read from --env-file when given, and then the file WINS over anything already
 * exported in the shell (so a DEV variable left in the shell can't send a PROD
 * run to DEV, or the other way round). With no --env-file, .env.local fills
 * only what isn't exported. The script prints its target host first: check it
 * before --execute. It never prints a key.
 *
 * PROD (with Liam's word), from a checkout of this branch:
 *   npx tsx scripts/backfill-assistant-face.ts --env-file <main checkout>/.env.production.local --include-others
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { ASSISTANT_FACE, planAssistantFaceBackfill, type FaceBackfillTeammate } from '../src/lib/bots/assistant-face-backfill'

const arg = (flag: string) => {
  const at = process.argv.indexOf(flag)
  return at >= 0 ? (process.argv[at + 1] ?? null) : null
}

const ENV_FILE = arg('--env-file')
config({ path: ENV_FILE ?? '.env.local', override: ENV_FILE !== null, quiet: true })

const EXECUTE = process.argv.includes('--execute')
const INCLUDE_OTHERS = process.argv.includes('--include-others')
const WORKSPACE_FILTER = arg('--workspace')

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL')
if (!SUPABASE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

const PAGE = 1000
const WORKSPACE_CHUNK = 100
const COLUMNS = 'id, workspace_id, name, bot_character, fronts_only, is_system, created_at'

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

async function main() {
  console.log(`Target: ${new URL(SUPABASE_URL!).host}${ENV_FILE ? ` (from ${ENV_FILE})` : ''}`)
  console.log(`Mode: ${EXECUTE ? 'EXECUTE' : 'dry-run (pass --execute to write)'}`)
  if (WORKSPACE_FILTER) console.log(`Workspace filter: ${WORKSPACE_FILTER}`)
  console.log(`Teammates that aren't work bots: ${INCLUDE_OTHERS ? 'moved too (--include-others)' : 'reported, left alone'}`)

  // The Assistant must exist first: moving the work bots off its face is only
  // half of migration 310's change.
  const { data: anchor, error: anchorError } = await supabase
    .from('recipe')
    .select('id')
    .eq('slug', 'loop-assistant')
    .is('workspace_id', null)
    .maybeSingle()
  if (anchorError) throw new Error(anchorError.message)
  if (!anchor) {
    console.log('Migration 310 is not applied here (no loop-assistant recipe).')
    if (EXECUTE) throw new Error('Apply migration 310 before running this with --execute')
  }

  // Which workspaces have anyone but the Assistant on the face.
  const onFace = await all<{ workspace_id: string }>((from, to) => {
    let q = supabase.from('ai_team_member').select('workspace_id').eq('bot_character', ASSISTANT_FACE).eq('is_system', false)
    if (WORKSPACE_FILTER) q = q.eq('workspace_id', WORKSPACE_FILTER)
    return q.order('id', { ascending: true }).range(from, to)
  })
  const workspaces = [...new Set(onFace.map((r) => r.workspace_id))].sort()
  console.log(`Workspaces with a teammate other than the Assistant on "${ASSISTANT_FACE}": ${workspaces.length}`)

  // Each of those workspaces' whole roster: a face is free only when nobody there wears it.
  const roster: FaceBackfillTeammate[] = []
  for (let i = 0; i < workspaces.length; i += WORKSPACE_CHUNK) {
    const chunk = workspaces.slice(i, i + WORKSPACE_CHUNK)
    roster.push(
      ...(await all<FaceBackfillTeammate>((from, to) =>
        supabase.from('ai_team_member').select(COLUMNS).in('workspace_id', chunk).order('id', { ascending: true }).range(from, to),
      )),
    )
  }

  const plan = planAssistantFaceBackfill(roster, { includeOthers: INCLUDE_OTHERS })
  for (const m of plan.moves) {
    console.log(`  ${m.workspaceId} ${m.id}${m.workBot ? '' : ' (not a work bot)'} "${m.fromName}" → ${m.toFace}${m.toName ? ` "${m.toName}"` : ' (keeps its name)'}`)
  }
  for (const s of plan.stuck) console.log(`  STUCK ${s.workspaceId} ${s.id} "${s.name}": every character in the workspace is worn`)
  for (const o of plan.others) console.log(`  LEFT ${o.workspaceId} ${o.id} "${o.name}": not a work bot (--include-others moves it)`)

  let moved = 0
  let failed = 0
  let skipped = 0
  if (EXECUTE) {
    for (const m of plan.moves) {
      const { data, error } = await supabase
        .from('ai_team_member')
        .update(m.toName ? { bot_character: m.toFace, name: m.toName } : { bot_character: m.toFace })
        .eq('id', m.id)
        .eq('fronts_only', m.workBot)
        .eq('is_system', false)
        .eq('bot_character', ASSISTANT_FACE)
        .select('id')
      if (error) {
        failed++
        console.log(`    FAILED ${m.id}: ${error.message}`)
      } else if ((data ?? []).length === 0) {
        skipped++
        console.log(`    SKIPPED ${m.id}: no longer ${m.workBot ? 'a work bot' : 'a teammate'} on "${ASSISTANT_FACE}"`)
      } else moved++
    }
  }

  const renamed = plan.moves.filter((m) => m.toName).length
  console.log('')
  console.log(
    EXECUTE
      ? `Done: ${moved} moved (${renamed} planned renames), ${skipped} skipped, ${failed} failed; ${plan.stuck.length} stuck, ${plan.others.length} other teammates left on "${ASSISTANT_FACE}"`
      : `Dry run: ${plan.moves.length} would move (${renamed} renamed, ${plan.moves.length - renamed} keep their name); ${plan.stuck.length} stuck, ${plan.others.length} other teammates left on "${ASSISTANT_FACE}"`,
  )
  if (failed > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

/**
 * One-off back-fill: every existing loop gets its bot (docs/plans/bots-v3.md,
 * Phase 3; migration 302's `flow.ai_team_member_id`).
 *
 * Runs AFTER migration 302. DEV first; PROD only on Liam's word.
 *
 * For each loop whose column is empty, in the order a new loop's default uses
 * (src/lib/flows/flow-bot.ts backfillFlowBot):
 *   1. a seeded loop's own system teammate (Triage, Reconciler);
 *   2. the teammate that already holds one of the loop's skills
 *      (ai_team_member_skill) and that its run-as member can reach;
 *   3. Triage, for a loop running a verdict-class skill;
 *   4. a new work bot on the first free face, named after that face (the
 *      catalogue's name: Ember is called Ember), fronts_only.
 * It writes the column explicitly, so the loop editor shows who was chosen and
 * the user can change it. Only empty columns are written: a re-run never
 * overrides a choice.
 *
 * DRY-RUN by default: prints each loop's plan, makes nothing. Pass --execute to
 * write.
 *
 * --rename-loop-named: instead, renames the work bots an earlier build of this
 * script named after their loop (a work bot whose name is exactly the name of a
 * loop it fronts) to their character's catalogue name. Same dry-run rule.
 *
 * Usage:
 *   npx tsx scripts/backfill-loop-bots.ts [--execute] [--workspace <id>] [--rename-loop-named]
 *
 * Required env vars (loaded from .env.local if present):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   — the anon key silently reads/writes 0 rows under RLS.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { backfillFlowBot, type BackfillFlow, type BackfillOutcome } from '../src/lib/flows/flow-bot'
import { characterName } from '../src/lib/bots/bot-faces'
import { asBotCharacter } from '../src/lib/bots/teammate-faces'

config({ path: '.env.local' })

const EXECUTE = process.argv.includes('--execute')
const wsFlag = process.argv.indexOf('--workspace')
const WORKSPACE_FILTER = wsFlag >= 0 ? process.argv[wsFlag + 1] : null
const RENAME = process.argv.includes('--rename-loop-named')

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL')
if (!SUPABASE_KEY) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY')

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })

const PAGE = 200

/** Work bots named after a loop they front → their character's catalogue name. */
async function renameLoopNamed() {
  let q = supabase
    .from('ai_team_member')
    .select('id, workspace_id, name, bot_character')
    .eq('fronts_only', true)
  if (WORKSPACE_FILTER) q = q.eq('workspace_id', WORKSPACE_FILTER)
  const { data: bots, error } = await q
  if (error) throw new Error(error.message)
  let renamed = 0
  let failed = 0
  for (const bot of (bots ?? []) as Array<{ id: string; workspace_id: string; name: string; bot_character: string | null }>) {
    const face = asBotCharacter(bot.bot_character)
    if (!face) continue
    const { data: loops } = await supabase.from('flow').select('name').eq('ai_team_member_id', bot.id)
    const loopNames = new Set(((loops ?? []) as Array<{ name: string | null }>).map((l) => (l.name ?? '').trim()))
    if (!loopNames.has(bot.name.trim())) continue
    const next = characterName(face)
    if (next === bot.name) continue
    console.log(`  ${bot.workspace_id} ${bot.id} "${bot.name}" → "${next}"`)
    if (!EXECUTE) continue
    const { error: upError } = await supabase.from('ai_team_member').update({ name: next }).eq('id', bot.id).eq('fronts_only', true)
    if (upError) {
      failed++
      console.log(`    FAILED: ${upError.message}`)
    } else renamed++
  }
  console.log('')
  console.log(EXECUTE ? `Done: ${renamed} renamed, ${failed} failed` : 'Dry run: nothing renamed (pass --execute to write)')
  if (failed > 0) process.exitCode = 1
}

async function main() {
  console.log(`Target: ${new URL(SUPABASE_URL!).host}`)
  console.log(`Mode: ${EXECUTE ? 'EXECUTE' : 'dry-run (pass --execute to write)'}`)
  if (WORKSPACE_FILTER) console.log(`Workspace filter: ${WORKSPACE_FILTER}`)
  if (RENAME) return renameLoopNamed()

  const outcomes: BackfillOutcome[] = []
  // Always the first page of still-empty loops when executing (each write
  // drops a row out of the filter); paged by offset on a dry run.
  for (let offset = 0; ; offset += EXECUTE ? 0 : PAGE) {
    let q = supabase
      .from('flow')
      .select('id, workspace_id, team_id, name, created_by, seed_key, actions')
      .is('ai_team_member_id', null)
      .order('created_at', { ascending: true })
      .range(offset, offset + PAGE - 1)
    if (WORKSPACE_FILTER) q = q.eq('workspace_id', WORKSPACE_FILTER)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    const flows = (data ?? []) as BackfillFlow[]
    if (flows.length === 0) break
    let progressed = false
    for (const flow of flows) {
      if (outcomes.some((o) => o.flowId === flow.id)) continue
      const outcome = await backfillFlowBot(supabase, flow, { execute: EXECUTE })
      outcomes.push(outcome)
      progressed = true
      const detail =
        outcome.kind === 'set'
          ? `→ ${outcome.teammateId}${outcome.created ? ' (new work bot)' : ''}`
          : outcome.kind === 'would-set'
            ? `→ would name ${outcome.plan}${outcome.teammateId ? ` (${outcome.teammateId})` : ''}`
            : outcome.kind === 'skipped'
              ? `skipped: ${outcome.reason}`
              : `FAILED: ${outcome.error}`
      console.log(`  ${flow.workspace_id} ${flow.id} "${flow.name}" ${detail}`)
    }
    if (!progressed || flows.length < PAGE) break
  }

  const count = (k: BackfillOutcome['kind']) => outcomes.filter((o) => o.kind === k).length
  console.log('')
  console.log(
    `Done: ${count('set')} set (${outcomes.filter((o) => o.kind === 'set' && o.created).length} new work bots), ` +
      `${count('would-set')} planned, ${count('skipped')} skipped, ${count('failed')} failed`,
  )
  if (count('failed') > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

/**
 * One-time backfill: seed the default loop, Triage, into workspaces that never
 * got it (GEN-148 / seed-default-loops.ts).
 *
 * Why: seedDefaultLoops runs on workspace creation, at signup
 * (seed-signup-loops.ts) and at the onboarding Prime step, but workspaces made
 * before those hooks have zero seeded flow rows. This walks them and runs the
 * SAME seeder, so an old workspace ends up like a fresh one. The seed set is
 * Triage alone, for every edition, so there is no per-edition choice to make
 * here. Cost safety is inherent to Triage: it is capture-triggered, so it fires
 * zero times on an inactive workspace.
 *
 * The seeder is the single source of truth for WHAT gets seeded and its safety
 * knobs — this script only enumerates targets, resolves the run-as identity the
 * seeder needs, and calls it. Safe to re-run: the default (no --workspace) mode
 * targets only NEVER-seeded workspaces (zero seed_key rows), so it cannot
 * resurrect a Triage loop a user later deleted (a workspace with any seeded
 * loop but no Triage had it and removed it). Such a workspace is reported and
 * repairable only via an explicit --workspace run.
 *
 * RUN-AS IDENTITY: the seeder attributes the seeded loop to created_by = the
 * workspace creator's auth.users id (the run-as identity the flow dispatchers
 * honor). On the create route that's user.id directly; here we recover it from
 * the workspace's OWNER member (member.role = 'owner' → member.user_id). A
 * workspace with no owner member is skipped and reported — there's no valid
 * identity to bill the loops to.
 *
 * DRY-RUN by default — prints, per workspace, whether Triage is missing and
 * would be seeded, then a summary. Pass --execute to actually call the seeder.
 *
 * Usage:
 *   npx tsx scripts/backfill-seed-loops.ts [--execute] [--workspace <id>]
 *   npx tsx --env-file=/tmp/dev.env scripts/backfill-seed-loops.ts --execute
 *
 * Required env vars (loaded from .env.local if present):
 *   NEXT_PUBLIC_SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY   — the anon key silently reads/writes 0 rows under RLS.
 */
import { createClient } from '@supabase/supabase-js'
import { config } from 'dotenv'
import { SEED_KEYS, seedDefaultLoops } from '../src/lib/flows/seed-default-loops'

config({ path: '.env.local' })

const EXECUTE = process.argv.includes('--execute')
const wsFlag = process.argv.indexOf('--workspace')
const WORKSPACE_FILTER = wsFlag >= 0 ? process.argv[wsFlag + 1] : null

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL')
if (!SUPABASE_KEY) {
  throw new Error(
    'Missing SUPABASE_SERVICE_ROLE_KEY — the anon client silently reads/writes 0 rows under RLS. Set it before running.',
  )
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
})

/** The seed keys the seeder installs (Triage) — a workspace missing one is a candidate. */
const ALL_SEED_KEYS = Object.values(SEED_KEYS)

/** Per-workspace outcome for the final summary. */
type WsOutcome =
  | { kind: 'seeded'; workspaceId: string; name: string; seeded: string[]; skippedMissingSkill: string[] }
  | { kind: 'would-seed'; workspaceId: string; name: string; missing: string[] }
  | { kind: 'skipped-complete'; workspaceId: string; name: string }
  | { kind: 'skipped-no-owner'; workspaceId: string; name: string }
  | { kind: 'failed'; workspaceId: string; name: string; error: string }

async function main() {
  console.log(`Target: ${SUPABASE_URL}`)
  console.log(`Mode: ${EXECUTE ? 'EXECUTE' : 'dry-run (pass --execute to seed)'}`)
  if (WORKSPACE_FILTER) console.log(`Workspace filter: ${WORKSPACE_FILTER}`)
  console.log('')

  // 1. Enumerate candidate workspaces. Either the single --workspace target, or
  //    every workspace (we compute per-workspace which seed keys are missing
  //    below, rather than trying to express "missing ANY seed_key" as one query).
  let wsQuery = supabase.from('workspace').select('id, name').order('created_at', { ascending: true })
  if (WORKSPACE_FILTER) wsQuery = wsQuery.eq('id', WORKSPACE_FILTER)
  const { data: workspaces, error: wsErr } = await wsQuery
  if (wsErr) throw new Error(`enumerate workspaces failed: ${wsErr.message}`)
  if (!workspaces || workspaces.length === 0) {
    console.log(WORKSPACE_FILTER ? 'No workspace matched the filter.' : 'No workspaces found.')
    return
  }

  const outcomes: WsOutcome[] = []

  for (const ws of workspaces) {
    const workspaceId = ws.id as string
    const name = (ws.name as string) ?? '(unnamed)'
    try {
      // Which of this workspace's seed keys are already present? (Same predicate
      // the seeder uses internally — we compute it here only to decide whether
      // the workspace is a target and to print the dry-run diff.)
      const { data: existing, error: existingErr } = await supabase
        .from('flow')
        .select('seed_key')
        .eq('workspace_id', workspaceId)
        .not('seed_key', 'is', null)
      if (existingErr) throw new Error(`read existing seed_keys failed: ${existingErr.message}`)
      const present = new Set((existing ?? []).map((r) => r.seed_key as string))
      const missing = ALL_SEED_KEYS.filter((k) => !present.has(k))

      if (missing.length === 0) {
        outcomes.push({ kind: 'skipped-complete', workspaceId, name })
        continue
      }

      // Default (no --workspace) targets only NEVER-seeded workspaces — the
      // actual backfill population. A workspace with some seeded loop but no
      // Triage was seeded and then a user DELETED Triage (flow delete is a hard
      // delete); re-seeding would resurrect a deliberately-removed loop that
      // seeds ENABLED. Repairing that is an explicit --workspace act.
      if (!WORKSPACE_FILTER && present.size > 0) {
        outcomes.push({ kind: 'skipped-complete', workspaceId, name })
        console.log(
          `  SKIP  ${workspaceId}  ${name} — seeded before, missing ${missing.join(', ')} (likely deleted); use --workspace to repair explicitly`,
        )
        continue
      }

      // No seeded row at all can still mean Triage was deleted: migration 351
      // removed the idle groom/brief/reconcile rows that used to be the only
      // evidence. Triage leaves traces that outlive it (its action cards, the
      // hourly triage_reconcile jobs, which only run where a capture_processed
      // loop was on), so a workspace with either is treated as one that chose
      // to delete it.
      if (!WORKSPACE_FILTER) {
        const [{ count: cards, error: cardsErr }, { count: sweeps, error: sweepsErr }] = await Promise.all([
          supabase.from('attention_item').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('kind', 'action_card'),
          supabase.from('tracked_job').select('id', { count: 'exact', head: true }).eq('workspace_id', workspaceId).eq('kind', 'triage_reconcile'),
        ])
        if (cardsErr || sweepsErr) throw new Error(`read Triage history failed: ${(cardsErr ?? sweepsErr)!.message}`)
        if ((cards ?? 0) > 0 || (sweeps ?? 0) > 0) {
          outcomes.push({ kind: 'skipped-complete', workspaceId, name })
          console.log(`  SKIP  ${workspaceId}  ${name} — has Triage history but no Triage loop (likely deleted); use --workspace to repair explicitly`)
          continue
        }
      }

      // Resolve the run-as identity: the workspace owner's auth.users id.
      // member.role = 'owner' → member.user_id. No owner ⇒ no identity to
      // attribute the loop to ⇒ skip and report (never seed anonymously).
      const { data: owner, error: ownerErr } = await supabase
        .from('member')
        .select('user_id')
        .eq('workspace_id', workspaceId)
        .eq('role', 'owner')
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
      if (ownerErr) throw new Error(`resolve owner failed: ${ownerErr.message}`)
      const createdByUserId = owner?.user_id as string | undefined
      if (!createdByUserId) {
        outcomes.push({ kind: 'skipped-no-owner', workspaceId, name })
        console.log(`  SKIP  ${workspaceId}  ${name} — no owner member; cannot attribute the loop`)
        continue
      }

      if (!EXECUTE) {
        outcomes.push({ kind: 'would-seed', workspaceId, name, missing })
        console.log(`  WOULD ${workspaceId}  ${name} — missing: ${missing.join(', ')}`)
        continue
      }

      // EXECUTE: run the real seeder. It re-reads existing seed_keys and inserts
      // only the missing set, so passing the whole workspace is correct even if
      // `missing` raced with a concurrent seed.
      const res = await seedDefaultLoops(supabase, { workspaceId, createdByUserId })
      outcomes.push({
        kind: 'seeded',
        workspaceId,
        name,
        seeded: res.seeded,
        skippedMissingSkill: res.skippedMissingSkill,
      })
      const parts = [`seeded: ${res.seeded.length ? res.seeded.join(', ') : 'none'}`]
      if (res.skippedMissingSkill.length) parts.push(`skipped(no-skill): ${res.skippedMissingSkill.join(', ')}`)
      console.log(`  SEED  ${workspaceId}  ${name} — ${parts.join(' | ')}`)
    } catch (err) {
      // Never let one workspace abort the run — collect and continue.
      const error = err instanceof Error ? err.message : String(err)
      outcomes.push({ kind: 'failed', workspaceId, name, error })
      console.error(`  FAIL  ${workspaceId}  ${name} — ${error}`)
    }
  }

  // 2. Final summary.
  const wouldSeed = outcomes.filter((o) => o.kind === 'would-seed')
  const seeded = outcomes.filter((o) => o.kind === 'seeded')
  const skippedComplete = outcomes.filter((o) => o.kind === 'skipped-complete')
  const skippedNoOwner = outcomes.filter((o) => o.kind === 'skipped-no-owner')
  const failed = outcomes.filter((o) => o.kind === 'failed')

  console.log('')
  console.log('=== Summary ===')
  console.log(`Workspaces scanned:          ${outcomes.length}`)
  console.log(`Already complete (skipped):  ${skippedComplete.length}`)
  console.log(`No owner (skipped):          ${skippedNoOwner.length}`)
  if (EXECUTE) {
    const totalLoops = seeded.reduce((n, o) => n + (o.kind === 'seeded' ? o.seeded.length : 0), 0)
    console.log(`Workspaces seeded:           ${seeded.length}  (${totalLoops} loop rows)`)
  } else {
    console.log(`Workspaces to seed:          ${wouldSeed.length}`)
  }
  console.log(`Failed:                      ${failed.length}`)

  if (failed.length > 0) {
    console.log('\nFailures:')
    for (const o of failed) {
      if (o.kind === 'failed') console.log(`  ${o.workspaceId}  ${o.name} — ${o.error}`)
    }
  }

  if (!EXECUTE && wouldSeed.length > 0) {
    console.log('\nRe-run with --execute to seed these workspaces.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

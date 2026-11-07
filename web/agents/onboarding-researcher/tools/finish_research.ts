/**
 * finish_research — the mandatory terminal tool for EVERY research run
 * (including personal-domain "skip" runs). It durably records the outcome under
 * `member.onboarding_progress.research` so the onboarding wizard can show the
 * result even if no one was streaming the session, then returns an ack.
 *
 * Owner-derivation: workspace_id + user_id come ONLY from the verified session
 * principal. The model supplies the brief text and the outcome flags.
 *
 * Persistence: a member-scoped, deep-within-`research` merge (see
 * lib/research-progress.ts) so this preserves the `sessionId`/`startedAt` the
 * kickoff route wrote while adding status/brief/companyFound/finishedAt. (The
 * merge_onboarding_progress RPC is not usable here — it's auth.uid()-scoped and
 * only deep-merges `tutorial`; see that file's header.)
 *
 * The `brief` is shown to a brand-new user during onboarding: warm, concise,
 * first-person, honest about uncertainty. The agent authors it; this tool just
 * persists it.
 *
 * `seededSummary` is NOT trusted from the model — it is derived from the DB.
 * Verified live 2026-07-13: on personal-email light runs the model seeds starter
 * content but omits seededSummary from this call, so the wizard's READY card and
 * the dashboard tour silently fell back to generic copy. Because the starter
 * project's id is a pure function of the workspace (lib/seed-id.ts), "did this
 * run seed, and what?" is an exact lookup: probe that id, count the (equally
 * deterministic) starter-action ids, and use those canonical values. The model's
 * input is only a fallback when the probe fails, plus the sole source of
 * `workspaceRenamed` (a rename leaves no seeded-marker to derive from).
 */
import { defineTool } from 'eve/tools'
import { z } from 'zod'
import { requireOwner, serviceClient, NoOwnerError } from '../lib/tool-context.js'
import { mergeResearchProgress } from '../lib/research-progress.js'
import { writeBriefToHome } from '../lib/home-brief-writer.js'
import { postInternalResearchSettle } from '../lib/app-client.js'
import {
  deriveStarterProjectId,
  deriveStarterActionId,
  MAX_STARTER_ACTIONS,
} from '../lib/seed-id.js'

export default defineTool({
  description:
    'Finish the research run. Call this EXACTLY ONCE at the very end of every ' +
    "run — including runs where you skipped research. Provide a short, warm, " +
    'first-person brief for the new user ("Here\'s what I learned…") that is ' +
    'honest about what you did and didn\'t find. Use status "done" when you ' +
    'researched (business domain, or a confidently-identified person), or ' +
    '"skipped" when you intentionally did no research (personal email domain ' +
    'with no confident person match). Status describes RESEARCH only — seeding ' +
    'starter content does not make a run "done", and a seeded run must still ' +
    'pass seededSummary regardless of status.',
  inputSchema: z.object({
    status: z
      .enum(['done', 'skipped'])
      .describe('"done" if you researched; "skipped" for a personal-domain light run.'),
    brief: z
      .string()
      .min(1)
      .describe(
        'A short, warm, first-person summary shown to the new user during ' +
        'onboarding. Say what you learned and what you set up; keep it honest ' +
        'about uncertainty. No corporate cringe.'
      ),
    companyFound: z
      .boolean()
      .default(false)
      .describe('True if you saved a company profile this run.'),
    seededSummary: z
      .object({
        projectName: z.string().describe('Name of the starter project you seeded.'),
        actionCount: z
          .number()
          .int()
          .describe('How many starter actions you seeded.'),
        workspaceRenamed: z
          .string()
          .optional()
          .describe('New workspace name, if you renamed it.'),
      })
      .optional()
      .describe(
        'REQUIRED whenever save_starter_content succeeded this run (even with ' +
        'status "skipped"): copy projectName and actionCount from that tool\'s ' +
        'RESULT, and workspaceRenamed if it reported a rename. Omit ONLY when ' +
        'you skipped seeding. (The server re-derives projectName/actionCount ' +
        'from the DB, but workspaceRenamed only flows from here.)'
      ),
  }),
  async execute(input, ctx) {
    let owner
    try {
      owner = requireOwner(ctx)
    } catch (err) {
      if (err instanceof NoOwnerError) {
        // Still surface the brief to the model/stream, but we could not persist
        // it (no workspace to write to — e.g. the localDev smoke path).
        return {
          success: false,
          persisted: false,
          error: err.message,
          brief: input.brief,
        }
      }
      throw err
    }
    const { userId, workspaceId } = owner
    const supabase = serviceClient()

    // Canonical seeded summary, straight from the seeded rows (see header). The
    // model's seededSummary is a fallback for a failed probe; its
    // workspaceRenamed is kept either way since no seeded row records a rename.
    const derived = await deriveSeededSummary(supabase, workspaceId)
    const seededSummary = derived
      ? {
          ...derived,
          ...(input.seededSummary?.workspaceRenamed
            ? { workspaceRenamed: input.seededSummary.workspaceRenamed }
            : {}),
        }
      : input.seededSummary

    try {
      const merged = await mergeResearchProgress(supabase, {
        userId,
        workspaceId,
        patch: {
          status: input.status,
          brief: input.brief,
          companyFound: input.companyFound,
          finishedAt: new Date().toISOString(),
          // Only write seededSummary when present — absent means no seeding
          // happened (probe found nothing AND the model reported none), and we
          // must not overwrite a prior run's summary with undefined.
          ...(seededSummary ? { seededSummary } : {}),
        },
      })
      if (!merged) {
        return {
          success: false,
          persisted: false,
          error: 'No member row for this user + workspace; nothing persisted.',
          brief: input.brief,
        }
      }

      // The run's Activity row (Sequence row 6): the app settles it from the
      // state persisted just above. Best-effort — the ledger never fails a run.
      const sessionId = (ctx as { session?: { id?: string } } | undefined)?.session?.id
      if (sessionId) {
        try {
          await postInternalResearchSettle(sessionId)
        } catch (settleErr) {
          console.warn('finish_research: ledger settle failed (non-fatal):', settleErr)
        }
      }

      // Conversational onboarding ("the dashboard is the reveal"): land the
      // brief as the OPENING assistant message in the member's home chat so it
      // reads as "the room was set up before you walked in." Best-effort and
      // idempotent — the brief is ALREADY durably in onboarding_progress above,
      // so a chat-write failure never loses it (F2's client adoption renders it
      // from onboarding_progress as a fallback). The stable message id makes a
      // finish_research re-run converge on one bubble. Gate the seeded line on
      // the DB-derived seededSummary so a light run never fakes a project.
      try {
        await writeBriefToHome(supabase, {
          userId,
          workspaceId,
          brief: input.brief,
          seededSummary: merged.seededSummary,
          // The activity hook appended the run's tool-call trail onto
          // research.activityLog during the run; mergeResearchProgress preserves
          // it (the patch never touches it), so it round-trips here. The writer
          // lands it as a "here's what I looked into" message ABOVE the brief,
          // gated on it actually having content.
          activityLog: merged.activityLog,
        })
      } catch (chatErr) {
        // Never fail the research run on a chat-surface write.
        console.warn('finish_research: home brief write threw (non-fatal):', chatErr)
      }

      return {
        success: true,
        persisted: true,
        status: input.status,
        companyFound: input.companyFound,
        message: 'Research finished and recorded.',
      }
    } catch (err) {
      return {
        success: false,
        persisted: false,
        error: err instanceof Error ? err.message : 'unknown persistence error',
        brief: input.brief,
      }
    }
  },
})

/**
 * Rebuild the canonical seeded summary from the DB, or null when this workspace
 * was never seeded. Exact by construction: the starter project's id — and each
 * starter action's id — is a pure function of the workspace (lib/seed-id.ts),
 * so this probes those precise rows rather than pattern-matching on names or
 * tags. `projectName` is whatever actually stands in the row (first run wins
 * under save_starter_content's ignoreDuplicates), which is what the wizard card
 * and tour must show. Best-effort: any read error returns null so the finish
 * itself never fails on this — the caller then falls back to the model's input.
 */
async function deriveSeededSummary(
  supabase: ReturnType<typeof serviceClient>,
  workspaceId: string
): Promise<{ projectName: string; actionCount: number } | null> {
  try {
    const projectId = deriveStarterProjectId(workspaceId)
    const { data: project, error: projErr } = await supabase
      .from('projects')
      .select('name')
      .eq('id', projectId)
      .eq('workspace_id', workspaceId)
      .maybeSingle<{ name: string }>()
    if (projErr || !project?.name) return null

    const candidateIds = Array.from({ length: MAX_STARTER_ACTIONS }, (_, i) =>
      deriveStarterActionId(projectId, i)
    )
    const { data: actionRows, error: actErr } = await supabase
      .from('actions')
      .select('id')
      .eq('workspace_id', workspaceId)
      .in('id', candidateIds)
    if (actErr) return null

    return { projectName: project.name, actionCount: actionRows?.length ?? 0 }
  } catch {
    return null
  }
}

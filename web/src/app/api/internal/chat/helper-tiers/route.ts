/**
 * POST /api/internal/chat/helper-tiers
 *
 * INTERNAL-ONLY. The chat-agent's `helpers` tool asks here, in its first step
 * (agents/chat-agent/lib/helpers-prepare.ts, beside the spec read), which tier
 * each quick helper task runs on (auto model selection,
 * src/lib/ai/model-route.ts): `strong` starts the declared `helper_strong`
 * subagent on STRONG_MODEL, anything else the plain `helper`, which runs on
 * the thread's own tier. The rules decide (routeHelperTask), then the plan,
 * the daily cap and the kill switch, read once for all the tasks so they can't
 * overshoot the cap together (decideHelperTiers); Jev's model.tier answers in
 * shadow for the undecided tasks, after the response.
 *
 * The main agent may name each task's model (`models`, one HELPER_MODELS
 * key or null per task, in order): that model decides, and a premium one
 * still passes the plan, the cap and the kill switch. Each route answered
 * carries its roster key (`model`), which picks the helper subagent.
 *
 * Auth: the shared internal secret and a verified, unexpired chat-run token,
 * as the spec route. Who the tasks are for comes only from the token. The
 * body carries the tasks, their models and the turn's ctx (its `route`
 * excerpt: "use the best model" in the person's own message counts). All are
 * agent-supplied: a forged one can only raise the token owner's own tier,
 * which the cap bounds.
 *
 * Status: 200 `{ tiers: ModelRoute[] }` in task order; 400 a malformed body;
 * 401 the secret or token; 403 helpers are not allowed in this conversation.
 */
import { createHash } from 'node:crypto'
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { extractChatRunToken, extractInternalSecret, verifyChatRunToken, verifyInternalSecret } from '@/lib/chat/chat-run-token'
import { helpersGate } from '@/lib/chat/helpers-gate'
import { chatRunBindingRefusal } from '@/lib/chat/surface-run-guard'
import { decideHelperTiers } from '@/lib/ai/helper-tier'
import { JEV_TIER_MODE, modelRouteMetadata, parseTurnRouteSignals } from '@/lib/ai/model-route'
import { isHelperModelKey, type HelperModelKey } from '@/lib/ai/models'
import { deferLogWrite } from '@/lib/log/agent-log'

export const dynamic = 'force-dynamic'

/** At most this many tasks (the `helpers` tool takes 1–4). */
const MAX_TASKS = 4
/** A task's text and context, as long as the tool allows (4,000 + 8,000). */
const MAX_TASK_CHARS = 12_000

/** The turn's routing excerpt from the forwarded ctx (base64url JSON), or undefined. */
function turnExcerpt(ctx: unknown): string | undefined {
  if (typeof ctx !== 'string' || !ctx || ctx.length > 64_000) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(ctx, 'base64url').toString('utf8'))
    return parseTurnRouteSignals(parsed?.route)?.excerpt
  } catch {
    return undefined
  }
}

export async function POST(request: Request) {
  if (!verifyInternalSecret(extractInternalSecret(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const claims = verifyChatRunToken(extractChatRunToken(request))
  if (!claims) return NextResponse.json({ error: 'invalid or expired run token' }, { status: 401 })
  const gate = helpersGate(claims)
  if (!gate.allowed) return NextResponse.json({ error: gate.reason, code: 'HELPERS_NOT_ALLOWED' }, { status: 403 })
  // The claims must bind to a live conversation of this user (surface-run-guard.ts):
  // a forged token must not spend someone else's helper tiers.
  const refused = await chatRunBindingRefusal(claims)
  if (refused) return refused

  let body: { tasks?: unknown; models?: unknown; ctx?: unknown }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return NextResponse.json({ error: 'invalid body', code: 'INPUT_INVALID' }, { status: 400 })
  }
  const tasks = Array.isArray(body.tasks) ? body.tasks : null
  if (!tasks || tasks.length === 0 || tasks.length > MAX_TASKS || !tasks.every((t) => typeof t === 'string' && t.length <= MAX_TASK_CHARS)) {
    return NextResponse.json({ error: 'tasks must be 1-4 strings', code: 'INPUT_INVALID' }, { status: 400 })
  }

  // Each task's chosen model, in order: a key, or null (the rules pick). Absent
  // from an older agent; a list of the wrong length or with an unknown key is
  // malformed (never guessed).
  let models: Array<HelperModelKey | null> = (tasks as string[]).map(() => null)
  if (body.models !== undefined) {
    if (!Array.isArray(body.models) || body.models.length !== tasks.length || !body.models.every((m) => m === null || isHelperModelKey(m))) {
      return NextResponse.json({ error: 'models must be one helper model key or null per task', code: 'INPUT_INVALID' }, { status: 400 })
    }
    models = body.models as Array<HelperModelKey | null>
  }

  const supabase = getServiceClient()
  const excerpt = turnExcerpt(body.ctx)
  // One escalation per task per run token (the browser mints one per send),
  // so a replayed step never counts a task twice.
  const tokenHash = createHash('sha256').update(extractChatRunToken(request) ?? '').digest('hex').slice(0, 24)
  const decisions = await decideHelperTiers(supabase, {
    userId: claims.userId,
    workspaceId: claims.workspaceId,
    surface: 'quick_helper',
    turnExcerpt: excerpt,
    defaultTier: 'fast',
    tasks: (tasks as string[]).map((task, i) => ({
      key: `quick:${tokenHash}:${i}:${createHash('sha256').update(task).digest('hex').slice(0, 16)}`,
      task,
      ...(models[i] ? { requested: models[i] } : {}),
    })),
  })

  // Jev's model.tier for the tasks the rules left undecided: shadow, after the answer.
  if (JEV_TIER_MODE === 'shadow') {
    ;(tasks as string[]).forEach((task, i) => {
      if (!decisions[i].undecided) return
      deferLogWrite(
        (async () => {
          const { runDecision } = await import('@/lib/ai/decisions/run-decision')
          await runDecision(
            'model.tier',
            { surface: 'helper', text: task.slice(0, 2000), attachments: [] },
            { userId: claims.userId, workspaceId: claims.workspaceId, runId: claims.conversationId, mode: 'shadow' },
          )
        })().catch((err: unknown) => {
          console.warn('[helper-tiers] model.tier shadow skipped:', err instanceof Error ? err.message : String(err))
        }),
      )
    })
  }

  return NextResponse.json({ tiers: decisions.map((d) => modelRouteMetadata(d.route)) })
}

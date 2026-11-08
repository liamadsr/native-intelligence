import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireUser } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { AGENT_MODEL_FIELD, AUTO_AGENT_MODEL, parseAgentModel, parseAgentModelChoice } from '@/lib/ai/agent-model'
import { readAgentModelPlan, saveAgentModel } from '@/lib/ai/agent-model-store'
import { PLAN_MAIN_MODEL, planModelLabel } from '@/lib/chatgpt/plan-models'

/**
 * /api/account/agent-model — the model the person's main agent runs on
 * (src/lib/ai/agent-model.ts), the one setting behind Settings → Preferences →
 * Assistant → Model. Kept on the account, so it follows them to every device;
 * the chat reads it from there on each turn, whatever the surface.
 *
 *  • GET: `{ model, plan, planModel }`. `model` is what they saved, or `auto`.
 *    `plan` says what the setting may offer: `chatgpt` (the free tier: their
 *    ChatGPT plan's model runs, named in `planModel`; the setting is hidden),
 *    `paid`, `unpaid` (no premium model), or null when the plan check failed.
 *  • PUT `{ model }`: `auto` or one of AGENT_MODEL_IDS, saved through the
 *    admin API keyed on the verified user (as the profile PATCH saves the
 *    agent's name). The plan isn't checked here: each turn applies it.
 */
export async function GET() {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { user } = auth

  const plan = await readAgentModelPlan(getServiceClient(), user.id)
  return NextResponse.json({
    model: parseAgentModel(user.user_metadata?.[AGENT_MODEL_FIELD]) ?? AUTO_AGENT_MODEL,
    plan,
    planModel: plan === 'chatgpt' ? planModelLabel(PLAN_MAIN_MODEL) : null,
  })
}

export async function PUT(request: Request) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { user } = auth

  const body = (await request.json().catch(() => null)) as { model?: unknown } | null
  const choice = parseAgentModelChoice(body?.model)
  if (!choice) return badRequest('model must be auto or one of the listed models')

  try {
    await saveAgentModel(getServiceClient(), user.id, choice === AUTO_AGENT_MODEL ? null : choice)
  } catch (err) {
    return serverError('Could not save the model', err instanceof Error ? err.message : String(err))
  }
  return NextResponse.json({ model: choice })
}

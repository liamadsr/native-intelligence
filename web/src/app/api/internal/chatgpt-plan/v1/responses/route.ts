/**
 * POST /api/internal/chatgpt-plan/v1/responses
 *
 * INTERNAL-ONLY. A free user's model calls, on their own ChatGPT plan
 * (docs/plans/chatgpt-free-tier.md §4–6). Each cloud eve agent's plan model
 * (agents/<agent>/lib/chatgpt-plan-model.ts, an AI SDK OpenAI Responses
 * model) has this route's directory as its base URL, so each step's
 * Responses request lands here, and src/lib/chatgpt/plan-proxy.ts does the
 * rest: the person's plan token, the plan route's rules, OpenAI's answer
 * streamed back, the connection's status kept. Nothing here ever reaches the
 * AI Gateway or a Dial8 key.
 *
 * Auth: any eve agent's run, as that agent authenticates to its own internal
 * routes: its family's secret and a verified, unexpired run token
 * (src/lib/chatgpt/plan-caller.ts). The token alone says whose plan pays;
 * the model can't name another person.
 *
 * Usage is not logged here: each agent's usage path logs a `chatgpt-plan`
 * step at no cost (logUsage skips billing for the plan provider).
 *
 * Status: plan-proxy.ts's, plus 401 for a call no agent run vouches for.
 */
import { NextResponse } from 'next/server'
import { planCallerFrom } from '@/lib/chatgpt/plan-caller'
import { proxyPlanResponses } from '@/lib/chatgpt/plan-proxy'

export const dynamic = 'force-dynamic'
/** One model step, streamed: as long as the tool route allows a step's tools. */
export const maxDuration = 300

export async function POST(request: Request) {
  const caller = await planCallerFrom(request)
  if (!caller) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  // The cloud agents' web_search on the plan is OpenAI's own (the local
  // agent's relay never sets this: its network is off).
  return proxyPlanResponses(request, caller.userId, { webSearch: true })
}

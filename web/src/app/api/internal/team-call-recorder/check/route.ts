/**
 * POST /api/internal/team-call-recorder/check { producer }
 * → { recorder, liveAgent, liveAgentHealth, turnKey, livekit } the app's side
 * of the call notes' preflight (src/lib/team-calls/recorder-check.ts): the
 * recorder's `node src/main.ts --check` asks it before a call, so the owner
 * learns what a call's notes need is in place without holding one.
 *
 * Server only: the feed's secret (404 while the feed is off here, 401
 * without it, as every feed route). Reads settings and one health answer;
 * writes nothing.
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ProducerSchema } from '@/lib/capture-feed/contract'
import { feedRequest } from '@/lib/capture-feed/route'
import { recorderCheck } from '@/lib/team-calls/recorder-check'

export const dynamic = 'force-dynamic'

const CheckSchema = z.object({ producer: ProducerSchema })

export async function POST(request: Request) {
  const body = await feedRequest(request, CheckSchema)
  if (body instanceof Response) return body
  const out = await recorderCheck()
  console.info(
    `[team-call-recorder] producer=${body.producer.id} check recorder=${out.recorder} live_agent=${out.liveAgent} live_agent_health=${out.liveAgentHealth} turn_key=${out.turnKey} livekit=${out.livekit}`,
  )
  return NextResponse.json(out)
}

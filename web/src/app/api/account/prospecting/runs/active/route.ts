/**
 * /api/account/prospecting/runs/active — every run still in flight in this
 * workspace, with the name of the list it is filling.
 *
 * WHY A WORKSPACE-WIDE READ EXISTS AT ALL. Every other run endpoint is scoped
 * to one list (`lists/[id]/runs`) or one run (`runs/[id]`), which is exactly
 * right for a page that already knows which run it started. It is useless for
 * the case Scout introduced: the agent starts a run from the chat, and nothing
 * on the Prospecting index, the list card, or the nav has any idea. This is the
 * one read that answers "is anything happening right now?" — the nav dot, the
 * index's live badges, and a list page adopting a run it did not start all hang
 * off it.
 *
 * It is a POLL endpoint, hit every 5s while something is live and every 20s
 * when nothing is, so it is deliberately one query with an embedded list name
 * and a hard cap of 50 rows.
 *
 * The response shape mirrors `runs/[id]`'s `run` — the same `RunPayload` fields
 * plus `list_name` — so a client can feed a row from here straight into the
 * same renderer that draws a polled run.
 */
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { listActiveRuns } from '@/lib/prospecting/runs'

export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const result = await listActiveRuns(supabase, { workspaceId })
  if (!result.ok) return serverError()

  return NextResponse.json({ runs: result.runs })
}

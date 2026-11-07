/**
 * GET /api/account/flows/paused — the Flows view's "paused — plan AI limit
 * reached" banner (WS-4b): the distinct flows whose most recent run in the
 * last 48h was the usage-limit failure. One cheap query over recent runs,
 * fenced to the caller's workspace through the flow; the builder is pure
 * (src/lib/flows/paused-flows.ts).
 */
import { NextResponse } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { PAUSED_WINDOW_MS, buildPausedFlows, type PausedFlowRunRow } from '@/lib/flows/paused-flows'

const RUN_SELECT = 'id, flow_id, status, fired_at, error_message, action_results, flow!inner(id, name, workspace_id)'
const SCAN_LIMIT = 150

export async function GET() {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const sinceIso = new Date(Date.now() - PAUSED_WINDOW_MS).toISOString()
  const { data, error } = await supabase
    .from('flow_run')
    .select(RUN_SELECT)
    .eq('flow.workspace_id', workspaceId)
    .gte('fired_at', sinceIso)
    .order('fired_at', { ascending: false })
    .limit(SCAN_LIMIT)
  if (error) return serverError(error.message)
  return NextResponse.json({ paused_flows: buildPausedFlows((data ?? []) as unknown as PausedFlowRunRow[]) })
}

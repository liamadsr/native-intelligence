/**
 * /api/account/evals/suites — the Evals index, and creating a suite.
 *
 * Everything here runs on the RLS-scoped client from `requireWorkspace`.
 * Migration 252's policies are the boundary (`is_workspace_member` on every
 * eval_* table), and the query layer carries an explicit `workspace_id` on top
 * — the same two-layer posture the prospecting routes take, where neither
 * layer is load-bearing alone.
 *
 * There is no role gate. Any member can author and run a suite; the monthly
 * eval budget is the control, not a permission (spec §10).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace, requireWorkspaceFeature } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { listSuites, SUITE_FIELDS } from '@/lib/evals/queries'
import type { EvalSuiteRow } from '@/lib/evals/types'
import { CreateSuiteSchema } from '../schemas'
import { parseBody } from '../parse-body'
import { recipeIsVisible } from './target-recipe'

export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const gated = await requireWorkspaceFeature(auth, 'evals')
  if (gated) return gated
  const { supabase, workspaceId } = auth

  const suites = await listSuites(supabase, workspaceId)
  return NextResponse.json({ suites })
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const gated = await requireWorkspaceFeature(auth, 'evals')
  if (gated) return gated
  const { supabase, user, workspaceId } = auth

  const parsed = await parseBody(request, CreateSuiteSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  // See `./target-recipe.ts`: a uuid the caller cannot read must not reach the
  // row, because `startEvalRun` snapshots that recipe's system prompt on the
  // SERVICE client and serves it back on the run detail.
  if (body.target_recipe_id) {
    const visible = await recipeIsVisible(supabase, body.target_recipe_id, workspaceId, user.id)
    if (visible === 'error') return serverError()
    if (!visible) return badRequest('That agent does not exist in this workspace')
  }

  const { data, error } = await supabase
    .from('eval_suite')
    .insert({
      workspace_id: workspaceId,
      name: body.name,
      description: body.description ?? null,
      target_kind: body.target_kind,
      target_recipe_id: body.target_recipe_id ?? null,
      suite_kind: body.suite_kind ?? 'capability',
      judge_model: body.judge_model ?? null,
      created_by: user.id,
    })
    .select(SUITE_FIELDS)
    .single()

  if (error || !data) {
    console.error('[evals] create suite failed:', error?.message)
    return serverError()
  }

  return NextResponse.json({ suite: data as unknown as EvalSuiteRow }, { status: 201 })
}

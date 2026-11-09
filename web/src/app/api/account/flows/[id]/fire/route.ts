/**
 * POST /api/account/flows/[id]/fire — manual test-fire.
 *
 * Runs the flow so the user can verify it before flipping `enabled=true`,
 * writing a flow_run row exactly like the production dispatch path so the
 * test shows up in run history.
 *
 * - entity_status_change flows fire against a real entity (caller supplies
 *   entity_id/action_id) or a synthetic placeholder.
 * - schedule / capture_processed flows are workspace-scoped: no entity, a
 *   synthetic trigger context (capture_processed additionally gets a
 *   synthetic capture so `{{capture.*}}` tokens render).
 *
 * The run_skill executor is injected, so "Test" genuinely executes the skill
 * (LLM run, document + notification delivery) — this is the loop engine's
 * verification path per docs/loop-engine/DESIGN.md. The skill runs AS the
 * CALLER (not flow.created_by): a test-fire is the caller's own act, and
 * running it as the creator would let any member borrow the creator's data
 * access and bill the creator's plan.
 *
 * Auth: any supplied entity must belong to the same workspace as the flow;
 * the caller must be a workspace member (enforced by requireWorkspaceMember).
 *
 * The kill switch (A5, src/lib/work/agent-paused.ts): with the workspace's
 * autonomy off, the test-fire is refused up front (409 AGENT_PAUSED, a message
 * the editor's toast shows), rather than running a skill whose every tool call
 * the skill-run door would refuse.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, badRequest, notFound, serverError } from '@/lib/api-errors'
import { AGENT_PAUSED_CODE, checkAgentPaused } from '@/lib/work/agent-paused'
import { getServiceClient } from '@/lib/admin'
import { loadRunnerEntityData } from '@/lib/flows/queries'
import { runFlow } from '@/lib/flows/runner'
import { createRunSkillExecutor, flowRunDeadlineMs } from '@/lib/flows/run-skill'
import { createRunAgentExecutor } from '@/lib/flows/run-agent'
import { createRunLocalAgentExecutor } from '@/lib/flows/run-local-agent'
import { createArchiveCaptureExecutor } from '@/lib/flows/archive-capture'
import { legacySnapshotFromResults } from '@/lib/flows/run-record'
import { createCallToolExecutor } from '@/lib/flows/call-tool'
import { keepRunState } from '@/lib/flows/flow-step-resume'
// Shared with chat's test_flow (a dry run of the same fire): src/lib/flows/test-fire.ts.
import { SYNTH_ID, makeSyntheticEntity, prSampleState, prTestTrigger } from '@/lib/flows/test-fire'
import type { FireExtras, RunnerEntityData } from '@/lib/flows/runner'
import type { FlowAction, FlowEntityType, TriggerContext } from '@/lib/flows/types'

// A test-fire can run a real skill (up to 240s per prose run_skill action, and
// a flow can chain two) — needs far more headroom than the default. The
// deadline below clips a second skill's wall to what is left, or refuses it.
export const maxDuration = 300

const APP_BASE_URL =
  process.env.NEXT_PUBLIC_APP_URL ??
  process.env.VERCEL_URL ??
  'https://dial8.ai'

const FLOW_FIELDS = `
  id, workspace_id, team_id, name, description, enabled,
  trigger_type, trigger_config, actions,
  created_by, created_at, updated_at
`


export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // This request's budget (maxDuration): run_skill walls must fire before it.
  const deadlineMs = flowRunDeadlineMs(Date.now(), maxDuration * 1000)
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params

  const body = await request.json().catch(() => ({}))
  const entityId =
    typeof body?.entity_id === 'string'
      ? body.entity_id
      : typeof body?.action_id === 'string'
        ? body.action_id
        : null

  // Load the flow with its encrypted token. We're going through Supabase
  // with the user's session — RLS already restricts to workspace flows.
  const { data: flowRow } = await supabase
    .from('flow')
    .select(FLOW_FIELDS)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (!flowRow) return notFound('Flow not found')

  if (await checkAgentPaused(getServiceClient(), workspaceId, 'manual_fire')) {
    return apiError('Agent work is switched off for this workspace, so loops can’t run, tests included. An admin can turn it back on in Settings → Autonomy.', {
      status: 409,
      code: AGENT_PAUSED_CODE,
    })
  }

  const triggerType = flowRow.trigger_type as string
  const isWorkspaceScoped = triggerType === 'schedule' || triggerType === 'capture_processed'

  // Resolve what to fire against. Workspace-scoped triggers have no entity;
  // entity_status_change fires against a caller-supplied entity or a
  // synthetic placeholder so the user can smoke-test without picking one.
  let entityData: RunnerEntityData | null = null
  let entityType: FlowEntityType | null = null
  let trigger: TriggerContext
  const extras: FireExtras = { workspaceId }

  if (isWorkspaceScoped) {
    trigger = {
      type: triggerType as 'schedule' | 'capture_processed',
      entity_type: null,
      from_status_id: null,
      to_status_id: null,
      fired_at: new Date().toISOString(),
    }
    if (triggerType === 'capture_processed') {
      // Synthetic capture so {{capture.*}} tokens render in the test.
      extras.capture = { id: SYNTH_ID, title: 'Test fire from Native Intelligence' }
    }
  } else {
    // A PR loop fires against its linked action, with the PR state it waits
    // for (test-fire.ts prTestTrigger, the same build as test_flow's).
    const pr = triggerType === 'pr_status_changed'
    entityType = (pr ? 'action' : (flowRow.trigger_config?.entity_type ?? 'action')) as FlowEntityType
    if (entityId) {
      entityData = await loadRunnerEntityData(supabase, entityType, entityId)
      if (!entityData || entityData.workspace_id !== workspaceId) {
        return badRequest('entity_id not found in workspace')
      }
    } else {
      entityData = makeSyntheticEntity(
        entityType,
        workspaceId,
        pr ? { to_status_id: prSampleState(flowRow.trigger_config) } : flowRow.trigger_config,
      )
    }
    trigger = pr
      ? prTestTrigger(flowRow.trigger_config, new Date().toISOString())
      : {
          type: 'entity_status_change',
          entity_type: entityType,
          from_status_id: flowRow.trigger_config?.from_status_id ?? null,
          to_status_id: flowRow.trigger_config?.to_status_id ?? '',
          fired_at: new Date().toISOString(),
        }
  }

  const actions = (Array.isArray(flowRow.actions) ? flowRow.actions : []) as FlowAction[]
  // Pre-generate the flow_run id and the per-fire key. Verdict cards carry the
  // flow_run id (null at insert — the flow_run row is a real FK written last),
  // back-filled after the terminal insert, keyed on this fireId (run_key).
  const flowRunId = crypto.randomUUID()
  const fireId = crypto.randomUUID()
  const ran = await runFlow(
    { actions },
    entityData,
    trigger,
    APP_BASE_URL,
    {
      executors: {
        run_skill: createRunSkillExecutor({
          workspaceId,
          deadlineMs,
          // Test-fires run as the CALLER — never inherit flow.created_by.
          runAsUserId: user.id,
          // Provenance + a per-invocation fire id (no Inngest event here).
          flowId: id,
          fireId,
          flowRunId,
          manual: true,
        }),
        // Test-fire injects the real run_agent executor so "Test" genuinely goes
        // through the flag gate — with RUN_AGENT_DISPATCH_ENABLED off (v1), Test
        // shows the inert result (dispatched:false), which is exactly the
        // pre-arm verification we want.
        run_agent: createRunAgentExecutor({
          workspaceId,
          flowId: id,
          // Test-fires run as the CALLER — never inherit flow.created_by.
          runAsUserId: user.id,
          fireId,
        }),
        // L5: a job on the CALLER's own Mac. The person clicked, but the job
        // still runs as an unattended one (the blocking reviewer, the step's
        // saved words); a folder that isn't the caller's own resolves to none.
        run_local_agent: createRunLocalAgentExecutor({
          workspaceId,
          flowId: id,
          runAsUserId: user.id,
          fireKey: flowRunId,
        }),
        // Test-fires of capture_processed flows pass a SYNTHETIC capture id, so
        // this resolves to a clean "not found — skipped" no-op — a Test never
        // archives a real capture, which is exactly what we want.
        archive_capture: createArchiveCaptureExecutor({ workspaceId }),
        // F4: a connected app's tool. A Test is a real run (the person is
        // here): an outward step parks on their card like any fire.
        call_tool: createCallToolExecutor({
          workspaceId,
          runAsUserId: user.id,
          flowId: id,
          flowName: (flowRow.name as string | null) ?? null,
          flowRunId,
          // A Test, often of a loop still off: its card is answered anyway (R1).
          manual: { firedBy: user.id },
        }),
      },
      extras,
    },
  )
  const { status, action_results } = ran
  const snapshot = legacySnapshotFromResults(action_results)

  // flow_run is server-managed (no INSERT policy for end users) so we use
  // the service-role client to record the run. Authorization for this
  // test-fire was already enforced above via requireWorkspaceMember + the
  // workspace-scoped flow lookup.
  const serviceClient = getServiceClient()
  const { error: insertError } = await serviceClient.from('flow_run').insert({
    id: flowRunId,
    flow_id: id,
    // Only populate triggered_by_action_id when we actually fired against
    // an action entity — the column is action-specific.
    triggered_by_action_id: entityType === 'action' ? entityId : null,
    status,
    action_results,
    ...snapshot,
  })

  if (insertError) {
    return serverError(`Flow ran but run record failed: ${insertError.message}`)
  }

  // Back-fill the run back-link on any cards this test-fire surfaced (keyed on
  // the stable per-fire run_key). Best-effort — the card works without it.
  await serviceClient
    .from('attention_item')
    .update({ source_flow_run_id: flowRunId })
    .eq('run_key', fireId)
    .is('source_flow_run_id', null)

  // F4: the run's step outputs, and a parked run's way back (flow-step-resume.ts).
  try {
    await keepRunState(serviceClient, {
      flowRunId,
      flowId: id,
      workspaceId,
      actions,
      createdBy: (flowRow.created_by as string | null) ?? null,
      outcome: ran,
      context: { trigger, entity: entityData, extras, fire_id: fireId, origin_depth: 1, run_as_user_id: user.id, manual: true },
    })
  } catch (err) {
    return serverError(`Flow ran but its parked step could not be kept: ${err instanceof Error ? err.message : String(err)}`)
  }

  return NextResponse.json({ result: { status, action_results } })
}

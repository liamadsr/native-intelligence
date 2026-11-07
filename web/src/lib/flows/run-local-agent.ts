/**
 * run_local_agent executor (L5, docs/plans/teammate-agent.md): a loop's step
 * that starts a job on the loop OWNER's Mac, in a folder they shared there.
 *
 * FIRE-AND-FORGET, like run_agent: render the request, hand it to
 * src/lib/local-agent/unattended.ts (which holds every rule: a shared folder,
 * the blocking reviewer, the agent switch, one live job per step), return.
 * The job reports in the owner's home thread on its own; a status:'success'
 * here means "handed to the Mac" (or a clean skip), not "done".
 *
 * Who: always the flow's owner (flow.created_by, re-stamped by whoever last
 * changed its steps or trigger) or, on a manual fire, the person who clicked.
 * Never a fallback to the workspace's owner: a Mac is one person's, and a
 * folder id resolves only among its own owner's grants.
 *
 * What it sends: words only. The request is the owner's saved template with
 * the trigger's values substituted, each fenced as untrusted (a meeting title
 * or an email subject can carry an instruction), plus the folder's id and the
 * mode. Never another step's output (refused at save, step-data.ts).
 *
 * The runner (runner.ts) stays pure: callers build this executor and inject
 * it via runFlow's `executors.run_local_agent`.
 */
import { getServiceClient } from '@/lib/admin'
import { fenceUntrustedValue } from '@/lib/ai/agent-run-context'
import { startUnattendedLocalAgent, type UnattendedDeps } from '@/lib/local-agent/unattended'
import { buildTemplateContext, renderTemplate } from './template'
import type { RunLocalAgentExecutionResult, RunLocalAgentExecutor } from './runner'
import type { RunLocalAgentActionConfig } from './types'

export function createRunLocalAgentExecutor(deps: {
  workspaceId: string
  /** The flow whose step this is (the job's origin, for the reviewer's words). */
  flowId: string
  /** Whose Mac: the flow's owner on a dispatch, the clicker on a manual fire. */
  runAsUserId: string | null
  /**
   * One id per fire (the flow run, else the trigger event): a retried fire
   * returns the job it already started instead of starting a second.
   */
  fireKey: string | null
  /** Test seams. */
  unattended?: UnattendedDeps
  supabase?: () => ReturnType<typeof getServiceClient>
}): RunLocalAgentExecutor {
  return async (action, ctx) => {
    const startedAt = Date.now()
    const config = (action.config ?? {}) as Partial<RunLocalAgentActionConfig>
    const summary = (bytes: number) => ({ method: 'LOCAL_AGENT', url: `local-agent://${config.folder_id || 'no-folder'}`, header_names: [], body_byte_length: bytes })
    const result = (fields: { ok: boolean; code: number; preview?: string | null; error?: string | null; bytes?: number; sessionId?: string | null }): RunLocalAgentExecutionResult => ({
      status: fields.ok ? 'success' : 'failed',
      request_summary: summary(fields.bytes ?? 0),
      response_status_code: fields.code,
      response_body_preview: fields.preview ?? null,
      error_message: fields.error ?? null,
      duration_ms: Date.now() - startedAt,
      dispatched: !!fields.sessionId,
      local_agent_session_id: fields.sessionId ?? null,
    })

    if (!deps.runAsUserId) return result({ ok: false, code: 400, error: 'The loop has no owner whose Mac could take the job' })
    if (!deps.fireKey) return result({ ok: false, code: 400, error: 'No fire id for the job (it could start twice on a retry)' })
    if (typeof config.folder_id !== 'string' || !config.folder_id || typeof config.request !== 'string' || !config.request.trim()) {
      return result({ ok: false, code: 400, error: 'run_local_agent needs a shared folder and a request' })
    }

    const templateCtx = buildTemplateContext(ctx.entity, ctx.trigger, ctx.appBaseUrl, {
      workspaceId: deps.workspaceId,
      capture: ctx.capture ?? null,
    })
    // The owner's words are theirs; the values put into them may come from a
    // meeting or an email, so each is fenced as untrusted.
    const request = renderTemplate(config.request, templateCtx, { transformValue: fenceUntrustedValue }).trim()
    const bytes = new TextEncoder().encode(request).length
    if (!request) return result({ ok: false, code: 400, error: 'The request rendered empty', bytes })

    try {
      const started = await startUnattendedLocalAgent(
        (deps.supabase ?? getServiceClient)(),
        {
          userId: deps.runAsUserId,
          workspaceId: deps.workspaceId,
          folderId: config.folder_id,
          request,
          mode: config.mode === 'edit' ? 'edit' : 'read',
          origin: { flowId: deps.flowId, actionId: action.id, fireKey: deps.fireKey },
        },
        deps.unattended,
      )
      if (started.status === 'skipped') return result({ ok: true, code: 208, preview: started.reason, bytes })
      if (started.status === 'refused') return result({ ok: false, code: 403, error: `${started.code}: ${started.reason}`, bytes })
      const device = started.session.deviceName || 'the Mac'
      const where = started.session.folderLabel || 'the folder'
      return result({
        ok: true,
        code: started.created ? 202 : 200,
        bytes,
        sessionId: started.session.id,
        preview: started.deviceOnline
          ? started.joined
            ? `This step's job was already working in ${where} on ${device}: the request is its next turn; it reports in the home thread.`
            : `Handed to ${device} in ${where}; it reports in the home thread.`
          : `${device} went offline: the job waits up to 15 minutes for it, in ${where}, then expires.`,
      })
    } catch (err) {
      return result({ ok: false, code: 500, error: err instanceof Error ? err.message : String(err), bytes })
    }
  }
}

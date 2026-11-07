import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { pushActionToLinear } from '@/lib/tasks/linear-push'
import { parseLinearOverrides } from '@/lib/tasks/push-overrides'
import { resolveEntityWorkspace } from './_shared'

/**
 * Linear push tool.
 *
 * Thin agent-facing wrapper over pushActionToLinear — the SAME function the
 * action panel's POST /api/account/actions/[id]/linear route calls, so chat, MCP
 * and the UI can never drift on gating, payload shape or idempotency.
 *
 * The optional destination params mirror the route's override body EXACTLY,
 * validated through the SAME parser. Note what is NOT here: a workflow state.
 * Overriding the team re-derives the right start state server-side, so there is
 * nothing for the model to choose and no way for it to name a state belonging to
 * another team.
 *
 * Registered through createTools(), which means the MCP registrar also exposes
 * it automatically as `dial8_push_action_to_linear` (src/lib/mcp/tools/index.ts
 * prefixes every AI-SDK tool with `dial8_`).
 *
 * WORKSPACE ROUTING: the action is resolved to ITS OWN workspace via
 * `resolveEntityWorkspace` before the push, and that resolved workspace — never
 * the session's — is what `pushActionToLinear` loads the Linear connection
 * config from. A foreign-but-member action_id must push through its own
 * workspace's Linear team, not whichever team the session happens to be
 * pointed at.
 */
export function createLinearTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
) {
  return {
    push_action_to_linear: tool({
      description:
        'Push a Dial8 action to the workspace\'s connected Linear team as an issue, ' +
        'and link the two so later Dial8 status changes move the Linear issue. ' +
        'Accepts the action UUID or its identifier (e.g. ENG-42). ' +
        'Requires a Linear connection with a team chosen in ' +
        'Settings → Connectors → Linear.',
      inputSchema: z.object({
        action_id: z.string().optional().describe('UUID of the action'),
        identifier: z.string().optional().describe('Action identifier like ENG-42'),
        // Every field below is an OPTIONAL per-push override of the workspace
        // destination. Omitting them all is the original behaviour.
        title: z
          .string()
          .optional()
          .describe('Issue title. Defaults to the action’s own title.'),
        team_id: z
          .string()
          .optional()
          .describe(
            'Linear team id to file into instead of the configured one. ' +
              'The issue’s starting workflow state is re-derived from that team.',
          ),
        project_id: z
          .string()
          .optional()
          .describe('Linear project id — must be associated with the destination team'),
        assignee_id: z.string().optional().describe('Linear user id'),
        priority: z
          .number()
          .int()
          .min(0)
          .max(4)
          .optional()
          .describe('0 No priority, 1 Urgent, 2 High, 3 Medium, 4 Low'),
        label_ids: z
          .array(z.string())
          .optional()
          .describe('Linear label ids. Group labels cannot be applied to an issue.'),
        due_date: z.string().optional().describe('Due date as YYYY-MM-DD'),
      }),
      execute: async ({ action_id, identifier, ...overrideFields }) => {
        let id = action_id

        if (!id && identifier) {
          const { data } = await supabase
            .from('actions')
            .select('id')
            .eq('identifier', identifier)
            .eq('workspace_id', workspaceId)
            .maybeSingle()
          id = data?.id
        }

        if (!id) {
          return { success: false, error: 'Provide action_id or identifier' }
        }

        // Route to the ACTION's own workspace — never the session's. See the
        // WORKSPACE ROUTING note above.
        const resolved = await resolveEntityWorkspace(
          supabase,
          userId,
          'actions',
          id,
          workspaceId,
          strictWorkspace,
        )
        if (!resolved) {
          return { success: false, error: 'Action not found', code: 'action_not_found' }
        }
        const targetWorkspaceId = resolved.workspaceId

        // Undefined-valued keys are dropped BEFORE parsing: the AI SDK hands
        // every optional param through as an explicit `undefined`, and the
        // parser's empty-object fold is what turns "the model named no
        // destination" back into today's exact config-driven push.
        const supplied = Object.fromEntries(
          Object.entries(overrideFields).filter(([, value]) => value !== undefined),
        )
        const parsed = parseLinearOverrides(
          Object.keys(supplied).length > 0 ? supplied : undefined,
        )
        // The SAME validation the route runs, reported as a tool error the model
        // can correct on its next turn.
        if (!parsed.ok) return { success: false, error: parsed.error }

        const result = await pushActionToLinear({
          actionId: id,
          workspaceId: targetWorkspaceId,
          userId,
          supabase,
          ...(parsed.value ? { overrides: parsed.value } : {}),
        })

        if (!result.ok) {
          return { success: false, error: result.error, code: result.code }
        }

        // `created: false` means the action was already linked — report it as a
        // success with the existing issue so the agent doesn't retry in a loop.
        return {
          success: true,
          already_linked: !result.created,
          action_id: id,
          task_url: result.link.external_url,
          task_title: result.link.external_title,
          message: result.created
            ? `Pushed to Linear: ${result.link.external_title ?? id}`
            : `Already linked to a Linear issue: ${result.link.external_title ?? id}`,
        }
      },
    }),
  }
}

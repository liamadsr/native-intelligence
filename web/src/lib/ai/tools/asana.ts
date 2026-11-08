import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { pushActionToAsana } from '@/lib/tasks/asana-push'
import { parseAsanaOverrides } from '@/lib/tasks/push-overrides'
import { resolveEntityWorkspace } from './_shared'

/**
 * Asana push tool.
 *
 * Thin agent-facing wrapper over pushActionToAsana — the SAME function the
 * action panel's POST /api/account/actions/[id]/asana route calls, so chat, MCP
 * and the UI can never drift on gating, payload shape or idempotency.
 *
 * The optional destination params mirror the route's override body EXACTLY,
 * validated through the SAME parser. Note what is NOT here: a priority. Asana
 * has no native priority field, so exposing one would invite the model to send a
 * value nothing can store.
 *
 * Registered through createTools(), which means the MCP registrar also exposes
 * it automatically as `dial8_push_action_to_asana` (src/lib/mcp/tools/index.ts
 * prefixes every AI-SDK tool with `dial8_`).
 *
 * WORKSPACE ROUTING: the action is resolved to ITS OWN workspace via
 * `resolveEntityWorkspace` before the push, and that resolved workspace — never
 * the session's — is what `pushActionToAsana` loads the Asana connection
 * config from. A foreign-but-member action_id must push through its own
 * workspace's Asana project, not whichever project the session happens to be
 * pointed at; pinning the push to the session workspace would either miss the
 * action entirely or, worse, push it into the wrong tenant's project.
 */
export function createAsanaTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
) {
  return {
    push_action_to_asana: tool({
      description:
        'Push a Native Intelligence action to the workspace\'s connected Asana project as a task, ' +
        'and link the two so later Native Intelligence status changes update the Asana task. ' +
        'Accepts the action UUID or its identifier (e.g. ENG-42). ' +
        'Requires an Asana connection with a project chosen in Settings → Connectors → Asana.',
      inputSchema: z.object({
        action_id: z.string().optional().describe('UUID of the action'),
        identifier: z.string().optional().describe('Action identifier like ENG-42'),
        // Every field below is an OPTIONAL per-push override of the workspace
        // destination. Omitting them all is the original behaviour.
        title: z
          .string()
          .optional()
          .describe('Task name. Defaults to the action’s own title.'),
        project_gid: z
          .string()
          .optional()
          .describe(
            'Asana project gid to file into instead of the configured one. ' +
              'Overriding it also suppresses the workspace’s section mapping, ' +
              'since a section belongs to exactly one project.',
          ),
        section_gid: z
          .string()
          .optional()
          .describe('Section of the destination project to place the task in'),
        assignee_gid: z.string().optional().describe('Asana user gid'),
        due_on: z
          .string()
          .optional()
          .describe('Due date as YYYY-MM-DD (Asana’s date-only field)'),
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
        const parsed = parseAsanaOverrides(
          Object.keys(supplied).length > 0 ? supplied : undefined,
        )
        // The SAME validation the route runs, reported as a tool error the model
        // can correct on its next turn.
        if (!parsed.ok) return { success: false, error: parsed.error }

        const result = await pushActionToAsana({
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
        // success with the existing task so the agent doesn't retry in a loop.
        return {
          success: true,
          already_linked: !result.created,
          action_id: id,
          task_url: result.link.external_url,
          task_title: result.link.external_title,
          message: result.created
            ? `Pushed to Asana: ${result.link.external_title ?? id}`
            : `Already linked to an Asana task: ${result.link.external_title ?? id}`,
        }
      },
    }),
  }
}

import { tool } from 'ai'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { pushActionToJira } from '@/lib/tasks/jira-push'
import { parseJiraOverrides } from '@/lib/tasks/push-overrides'
import { resolveEntityWorkspace } from './_shared'

/**
 * Jira push tool.
 *
 * Thin agent-facing wrapper over pushActionToJira — the SAME function the action
 * panel's POST /api/account/actions/[id]/jira route calls, so chat, MCP and the
 * UI can never drift on gating, payload shape or idempotency.
 *
 * The optional destination params mirror the route's override body EXACTLY,
 * validated through the SAME parser, so an agent asked to "file this in the
 * Platform project as a Bug" reaches the identical code path the compose panel
 * does — including the dependent-field rules, which the model then gets a
 * readable error about rather than a Jira 400.
 *
 * Registered through createTools(), which means the MCP registrar also exposes
 * it automatically as `dial8_push_action_to_jira` (src/lib/mcp/tools/index.ts
 * prefixes every AI-SDK tool with `dial8_`).
 *
 * WORKSPACE ROUTING: the action is resolved to ITS OWN workspace via
 * `resolveEntityWorkspace` before the push, and that resolved workspace — never
 * the session's — is what `pushActionToJira` loads the Jira connection config
 * from. A foreign-but-member action_id must push through its own workspace's
 * Jira project, not whichever project the session happens to be pointed at.
 */
export function createJiraTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  strictWorkspace = false,
) {
  return {
    push_action_to_jira: tool({
      description:
        'Push a Dial8 action to the workspace\'s connected Jira project as an issue, ' +
        'and link the two so later Dial8 status changes transition the Jira issue. ' +
        'Accepts the action UUID or its identifier (e.g. ENG-42). ' +
        'Requires a Jira connection with a site, project and issue type chosen in ' +
        'Settings → Connectors → Jira.',
      inputSchema: z.object({
        action_id: z.string().optional().describe('UUID of the action'),
        identifier: z.string().optional().describe('Action identifier like ENG-42'),
        // Every field below is an OPTIONAL per-push override of the workspace
        // destination. Omitting them all is the original behaviour.
        title: z
          .string()
          .optional()
          .describe('Issue summary. Defaults to the action’s own title.'),
        project_id: z
          .string()
          .optional()
          .describe(
            'Jira project id to file into instead of the configured one. ' +
              'REQUIRES issue_type_id — Jira issue types are per-project copies.',
          ),
        issue_type_id: z
          .string()
          .optional()
          .describe('Jira issue type id (from the project’s create metadata)'),
        assignee_account_id: z
          .string()
          .optional()
          .describe('Atlassian accountId. Never an email — Jira does not accept one.'),
        priority_id: z
          .string()
          .optional()
          .describe('Priority id from the project+type’s create metadata'),
        due_date: z.string().optional().describe('Due date as YYYY-MM-DD'),
        labels: z.array(z.string()).optional().describe('Jira labels (freeform strings)'),
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
        const parsed = parseJiraOverrides(
          Object.keys(supplied).length > 0 ? supplied : undefined,
        )
        // The SAME validation the route runs, reported as a tool error the model
        // can correct on its next turn rather than as a Jira 400 it cannot read.
        if (!parsed.ok) return { success: false, error: parsed.error }

        const result = await pushActionToJira({
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
          // The model gets told what it lost, in the message it reads. This path
          // has no compose-meta gate at all, so a due date or label on a project
          // whose create screen lacks the field is dropped on EVERY push —
          // reporting it is the only way the model can tell the user or retry
          // differently.
          ...(result.dropped_fields ? { dropped_fields: result.dropped_fields } : {}),
          ...(result.assignee_set === false ? { assignee_set: false } : {}),
          message: result.created
            ? `Pushed to Jira: ${result.link.external_title ?? id}` +
              (result.dropped_fields
                ? `. Jira's create screen rejected [${result.dropped_fields.join(', ')}], so the issue was created without those fields.`
                : '') +
              (result.assignee_set === false
                ? '. The assignee could not be applied, so the issue is unassigned.'
                : '')
            : `Already linked to a Jira issue: ${result.link.external_title ?? id}`,
        }
      },
    }),
  }
}

import { tool } from 'ai'
import { z } from 'zod'
import { REPO_FULL_NAME_RE } from '@/lib/environments/types'

/**
 * The chat's cloud counterpart of start_local_agent (docs/plans/
 * environments.md §3, E2): a coding run in a fresh cloud sandbox, filed as an
 * action in the repo's project and started as an action's Start would start
 * it. It runs in the chat's environment when that is a cloud one (§7 Q7),
 * else in the project's. A schema twin like start_local_agent's: no generic
 * execute, so MCP cannot export it and every other surface treats it as
 * absent (CHAT_NATIVE_TOOL_NAMES). Only the authenticated main-chat tool
 * route runs it (/api/internal/chat/tool, with eve's call, turn and session
 * ids), through src/lib/chat/cloud-coding-tools.ts.
 */

export const CLOUD_CODING_TOOL_NAMES = ['start_cloud_coding_run'] as const

/** What a coding run's request may hold (the action's description; the issue block cuts at 20 KB). */
export const CLOUD_CODING_REQUEST_MAX = 16_000

const uuid = (what: string) => z.string().uuid(`must be a ${what}`)

export const startCloudCodingRunSchema = z
  .object({
    project_id: uuid('project_id from the environment section or list_projects')
      .optional()
      .describe("The project whose GitHub repository the run works on (the `environment` section lists the workspace's project repos)."),
    repo: z
      .string()
      .trim()
      .regex(REPO_FULL_NAME_RE, 'must look like owner/repo')
      .optional()
      .describe('Or the repository itself (owner/repo), when it is one project’s repo in this workspace.'),
    request: z
      .string()
      .trim()
      .min(1)
      .max(CLOUD_CODING_REQUEST_MAX)
      .describe('The change to make, in words, self-contained: the goal, what done looks like. It becomes the action’s description; the run cannot read this conversation.'),
    title: z.string().trim().min(1).max(200).optional().describe('A short title for the action. Default: the request’s first line.'),
    environment_id: uuid('environment id')
      .optional()
      .describe(
        "Leave it out when this chat's environment is a cloud one: the run goes there. Otherwise pass the cloud environment the person chose (or an offline Mac's cloud_fallback named, once they agreed); without one the call is refused with the choices, so ask the person.",
      ),
  })
  .refine((v) => !!v.project_id !== !!v.repo, { message: 'Pass exactly one of project_id or repo' })
export type StartCloudCodingRunInput = z.infer<typeof startCloudCodingRunSchema>

export function createCloudCodingTools() {
  return {
    start_cloud_coding_run: tool({
      description:
        "In main chat, when the person asks for code changes and this chat's environment is a cloud one (or they say \"in the cloud\"), start a coding run: it files an action in the repo's project, works on the repository on GitHub in a fresh cloud sandbox (never on changes they haven't pushed), and opens a pull request. " +
        "Pass the project (or its repo) and the request in words, self-contained. It runs in this chat's cloud environment; from a chat on a Mac, ask the person which cloud environment to use and pass its environment_id. Say where it runs (the answer names it and its network). " +
        'Returns at once with the action and the run; never claim the work is done from it. Call it once per task. Only in a turn the person typed. Unsupported outside main chat.',
      inputSchema: startCloudCodingRunSchema,
    }),
  }
}

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { withActiveWorkspace } from './envelope'
import { storedGithubToken } from '@/lib/oauth/github-token'

/**
 * GitHub-specific MCP tools for PR linking and status checks.
 * These operate on the `action_github_pr` table and are not
 * part of the AI SDK tool registry.
 *
 * @param workspaceName - display name of the active workspace, threaded from
 *   registerTools so these results carry the same `active_workspace` stamp the
 *   bridged tools get from the adapter in ./index.ts.
 */
export function registerGitHubTools(
  server: McpServer,
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  workspaceName?: string | null,
) {
  // Hand-registered tools build their own `content`, so the adapter's stamp
  // never reaches them. Same helper, same shape. Errors are left alone.
  const active = { id: workspaceId, name: workspaceName ?? null }
  const ok = (payload: unknown) => ({
    content: [{
      type: 'text' as const,
      text: JSON.stringify(withActiveWorkspace(payload, active), null, 2),
    }],
  })

  server.tool(
    'dial8_link_pr',
    'Link a GitHub pull request to an action item. The PR URL must be a valid GitHub PR URL (e.g. https://github.com/owner/repo/pull/123). If the user has connected their GitHub account, PR metadata (title, state) will be fetched automatically.',
    {
      action_id: z.string().describe('The action item ID to link the PR to.'),
      pr_url: z.string().url().describe('The full GitHub PR URL (e.g. https://github.com/owner/repo/pull/123).'),
    },
    async ({ action_id, pr_url }) => {
      // Parse the GitHub PR URL
      const parsed = parseGitHubPrUrl(pr_url)
      if (!parsed) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Invalid GitHub PR URL. Expected format: https://github.com/owner/repo/pull/123' }) }],
          isError: true,
        }
      }

      // Verify the action belongs to this workspace
      const { data: action, error: actionError } = await supabase
        .from('actions')
        .select('id')
        .eq('id', action_id)
        .eq('workspace_id', workspaceId)
        .single()

      if (actionError || !action) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Action not found in current workspace.' }) }],
          isError: true,
        }
      }

      // Try to fetch PR metadata from GitHub API
      const prMeta = await fetchPrMetadata(parsed.repoFullName, parsed.prNumber, userId, supabase)

      const { data: pr, error } = await supabase
        .from('action_github_pr')
        .upsert(
          {
            workspace_id: workspaceId,
            action_id: action_id,
            pr_url,
            repo_full_name: parsed.repoFullName,
            pr_number: parsed.prNumber,
            created_by: userId,
            // Without fresh metadata (no token, rate limit, 404) the columns are
            // left out: a new row takes the column defaults, and a re-link
            // keeps the synced state/title instead of resetting them to "open".
            ...(prMeta
              ? {
                  pr_title: prMeta.title || null,
                  pr_state: prMeta.state || 'open',
                  pr_draft: prMeta.draft || false,
                  head_branch: prMeta.headBranch || null,
                  last_synced_at: new Date().toISOString(),
                }
              : {}),
          },
          { onConflict: 'action_id,repo_full_name,pr_number' },
        )
        .select()
        .single()

      if (error) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message }) }],
          isError: true,
        }
      }

      return ok({ success: true, pr })
    },
  )

  server.tool(
    'dial8_get_pr_status',
    'Get all pull requests linked to an action item with their current status (open, merged, closed, draft).',
    {
      action_id: z.string().describe('The action item ID to get linked PRs for.'),
    },
    async ({ action_id }) => {
      const { data: prs, error } = await supabase
        .from('action_github_pr')
        .select('*')
        .eq('action_id', action_id)
        .eq('workspace_id', workspaceId)
        .order('linked_at', { ascending: false })

      if (error) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message }) }],
          isError: true,
        }
      }

      return ok({
        action_id,
        prs: (prs || []).map((pr) => ({
          id: pr.id,
          pr_url: pr.pr_url,
          repo_full_name: pr.repo_full_name,
          pr_number: pr.pr_number,
          pr_title: pr.pr_title,
          pr_state: pr.pr_state,
          pr_draft: pr.pr_draft,
          head_branch: pr.head_branch,
          linked_at: pr.linked_at,
        })),
      })
    },
  )

  server.tool(
    'dial8_list_linked_prs',
    'List recent pull requests linked to actions in the current workspace. Optionally filter by action ID.',
    {
      action_id: z.string().optional().describe('Optional action ID to filter by. If omitted, returns recent PRs across the workspace.'),
      limit: z.number().optional().describe('Maximum number of PRs to return. Defaults to 20.'),
    },
    async ({ action_id, limit }) => {
      let query = supabase
        .from('action_github_pr')
        .select('*, actions!action_id(id, identifier, title)')
        .eq('workspace_id', workspaceId)
        .order('linked_at', { ascending: false })
        .limit(limit || 20)

      if (action_id) {
        query = query.eq('action_id', action_id)
      }

      const { data: prs, error } = await query

      if (error) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ error: error.message }) }],
          isError: true,
        }
      }

      return ok({
        prs: (prs || []).map((pr) => {
          const actionRaw = pr.actions as unknown
          const actionData = (Array.isArray(actionRaw) ? actionRaw[0] : actionRaw) as { id: string; identifier: string; title: string } | null
          return {
            id: pr.id,
            pr_url: pr.pr_url,
            repo_full_name: pr.repo_full_name,
            pr_number: pr.pr_number,
            pr_title: pr.pr_title,
            pr_state: pr.pr_state,
            pr_draft: pr.pr_draft,
            head_branch: pr.head_branch,
            linked_at: pr.linked_at,
            action: actionData ? {
              id: actionData.id,
              identifier: actionData.identifier,
              title: actionData.title,
            } : null,
          }
        }),
      })
    },
  )
}

function parseGitHubPrUrl(url: string): { repoFullName: string; prNumber: number } | null {
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== 'github.com') return null
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (parts.length < 4 || parts[2] !== 'pull') return null
    const prNumber = parseInt(parts[3], 10)
    if (isNaN(prNumber)) return null
    return { repoFullName: `${parts[0]}/${parts[1]}`, prNumber }
  } catch {
    return null
  }
}

async function fetchPrMetadata(
  repoFullName: string,
  prNumber: number,
  userId: string,
  supabase: SupabaseClient,
): Promise<{ title: string; state: string; draft: boolean; headBranch: string } | null> {
  try {
    const accessToken = await storedGithubToken(supabase, userId)

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
    }
    if (accessToken) {
      headers.Authorization = `Bearer ${accessToken}`
    }

    const res = await fetch(
      `https://api.github.com/repos/${repoFullName}/pulls/${prNumber}`,
      { headers },
    )

    if (!res.ok) return null

    const data = await res.json()
    return {
      title: data.title,
      state: data.merged ? 'merged' : data.state,
      draft: data.draft || false,
      headBranch: data.head?.ref || null,
    }
  } catch {
    return null
  }
}

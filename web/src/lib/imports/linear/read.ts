/**
 * Reading a Linear team's issues for an import (docs/plans/imports.md,
 * phase 2), through the workspace's existing Linear connection and its
 * `read` scope. Shallow pages of 100, the complexity budget's friend
 * (src/lib/integrations/linear-api.ts explains why nesting, not paging, costs).
 */
import { linearGraphQL, listTeamStates, type LinearWorkflowState } from '@/lib/integrations/linear-api'

/** The most issues one import reads. */
export const LINEAR_IMPORT_MAX_ISSUES = 5000
const PAGE = 100
/** A pause between pages, so a big import stays well under Linear's rate limit (linearGraphQL also backs off when Linear says so). */
const PAUSE_MS = 250

export interface LinearImportIssue {
  id: string
  identifier: string
  title: string
  description: string | null
  priority: number | null
  estimate: number | null
  dueDate: string | null
  url: string | null
  state: { id: string; name: string; type: string } | null
  assignee: { id: string; name: string | null; email: string | null } | null
  labels: { nodes: { id: string; name: string }[] } | null
  project: { id: string; name: string } | null
  parent: { id: string } | null
  cycle: { number: number | null; name: string | null } | null
}

interface Page {
  team?: {
    issues?: {
      nodes?: LinearImportIssue[]
      pageInfo?: { hasNextPage: boolean; endCursor: string | null }
    }
  }
}

const ISSUE_FIELDS = `id identifier title description priority estimate dueDate url
  state { id name type }
  assignee { id name email }
  labels(first: 20) { nodes { id name } }
  project { id name }
  parent { id }
  cycle { number name }`

/**
 * A team's issues, oldest first. With `includeClosed` false, completed and
 * canceled ones are left out. Stops at `max` and says so.
 */
export async function readTeamIssues(
  accessToken: string,
  teamId: string,
  opts: { includeClosed: boolean; max?: number; pauseMs?: number },
): Promise<{ issues: LinearImportIssue[]; truncated: boolean }> {
  const max = Math.min(opts.max ?? LINEAR_IMPORT_MAX_ISSUES, LINEAR_IMPORT_MAX_ISSUES)
  const filter = opts.includeClosed ? {} : { state: { type: { nin: ['completed', 'canceled'] } } }
  const issues: LinearImportIssue[] = []
  let after: string | null = null
  while (issues.length < max) {
    const data: Page = await linearGraphQL<Page>(
      accessToken,
      `query ImportIssues($teamId: String!, $first: Int!, $after: String, $filter: IssueFilter) {
         team(id: $teamId) {
           issues(first: $first, after: $after, filter: $filter, orderBy: createdAt) {
             nodes { ${ISSUE_FIELDS} }
             pageInfo { hasNextPage endCursor }
           }
         }
       }`,
      { teamId, first: PAGE, after, filter },
    )
    const conn = data?.team?.issues
    issues.push(...(conn?.nodes ?? []).filter((n) => n?.id))
    if (!conn?.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) return { issues: issues.slice(0, max), truncated: false }
    after = conn.pageInfo.endCursor
    const pause = opts.pauseMs ?? PAUSE_MS
    if (pause > 0) await new Promise((r) => setTimeout(r, pause))
  }
  return { issues: issues.slice(0, max), truncated: true }
}

export async function readTeamStates(accessToken: string, teamId: string): Promise<LinearWorkflowState[]> {
  return listTeamStates(accessToken, teamId)
}

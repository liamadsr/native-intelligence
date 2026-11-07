import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest } from '@/lib/api-errors'
import { listCreateMetaFields } from '@/lib/integrations/jira-api'
import {
  classifyCreateMeta,
  createMetaCacheKey,
  nativeCreateIssueUrl,
  readCachedCreateMeta,
  writeCachedCreateMeta,
} from '@/lib/tasks/jira-compose-meta'
import { loadJiraSyncState } from '@/lib/tasks/jira-config'
import { jiraErrorResponse, requireJiraToken } from '@/lib/tasks/jira-picker'
import { NextResponse } from 'next/server'

/**
 * GET /api/account/jira/compose-meta?cloudId=&projectId=&issueTypeId=
 *
 * The ONE call that gates the entire Jira compose form: which fields the panel
 * may render, which it must, what the valid priorities are, and whether a create
 * is possible at all. See src/lib/tasks/jira-compose-meta.ts for the
 * classification and why the three-way split is what it is.
 *
 * Unlike the four destination pickers next door, this route does more than
 * proxy: it CLASSIFIES, because the raw field list is large, mostly irrelevant,
 * and needs the same fold in every caller. Sending it whole would push that fold
 * into the browser and make the required-field wall a client-side opinion rather
 * than a server contract.
 *
 * Cached in-process for an hour keyed workspace+site+project+type — a create
 * screen changes when an admin edits it, and the panel re-reads it on every
 * open. The cache holds the RAW field list rather than the classification, so a
 * change to the fold takes effect on the next deploy instead of the next hour.
 *
 * A 401 from Jira surfaces as 400 `reconnect_required`.
 */
export async function GET(request: Request): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { workspaceId } = auth

  const params = new URL(request.url).searchParams
  const cloudId = params.get('cloudId')?.trim()
  if (!cloudId) {
    return badRequest('`cloudId` query param required (an Atlassian site id)')
  }
  const projectId = params.get('projectId')?.trim()
  if (!projectId) {
    return badRequest('`projectId` query param required (a Jira project id)')
  }
  const issueTypeId = params.get('issueTypeId')?.trim()
  if (!issueTypeId) {
    return badRequest('`issueTypeId` query param required (a Jira issue type id)')
  }

  const resolved = await requireJiraToken(workspaceId)
  if (resolved instanceof Response) return resolved

  const cacheKey = createMetaCacheKey(workspaceId, cloudId, projectId, issueTypeId)

  try {
    let fields = readCachedCreateMeta(cacheKey)
    const cached = fields !== null
    if (!fields) {
      fields = await listCreateMetaFields(resolved.token, cloudId, projectId, issueTypeId)
      writeCachedCreateMeta(cacheKey, fields)
    }

    // The site url for the wall's link-out. Read from the config rather than
    // taken as a param: a link into a site the workspace did not configure is
    // not a link this route should be able to mint.
    const syncState = await loadJiraSyncState(workspaceId)
    const nativeUrl = nativeCreateIssueUrl(syncState?.config.site_url, projectId, issueTypeId)

    return NextResponse.json({
      meta: classifyCreateMeta(fields),
      // Present ONLY when the panel needs it (blocking fields) — but returned
      // unconditionally so the panel never has to make a second call to learn
      // where it would send someone.
      native_create_url: nativeUrl,
      cached,
    })
  } catch (err) {
    return jiraErrorResponse(err, 'read Jira create metadata')
  }
}

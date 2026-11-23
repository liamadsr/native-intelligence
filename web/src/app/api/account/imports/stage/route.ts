/**
 * POST /api/account/imports/stage
 * Plan an import and keep it as a staged import: its preview. Nothing in the
 * workspace changes until POST /[id]/apply.
 *
 *   task CSV  multipart: source=task_csv, file, mapping (JSON list, one
 *             field a column), team_id, project_id?
 *   Notion    multipart: source=notion, file (.zip), visibility
 *             (workspace|private), folder_id?, folder_name?
 *   Linear    JSON: { source: 'linear', teams: [{ linear_team_id, team_id }],
 *             include_closed, create_states }
 */
import { NextResponse, type NextRequest } from 'next/server'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { NOTION_LIMITS } from '@/lib/imports/notion/export'
import { importView } from '@/lib/imports/preview'
import { requireImporter, UUID_RE } from '@/lib/imports/route-auth'
import { stageLinear, stageNotion, stageTaskCsv, TASK_FILE_MAX_BYTES, type Staged } from '@/lib/imports/stage'

export const maxDuration = 300

const tooBig = (what: string) => apiError(`That file is over ${what}.`, { status: 413, code: 'TOO_LARGE' })

export async function POST(request: NextRequest) {
  const who = await requireImporter()
  if (who instanceof Response) return who
  const length = Number(request.headers.get('content-length') ?? 0)
  try {
    let staged: Staged
    if ((request.headers.get('content-type') ?? '').includes('application/json')) {
      if (length > 64 * 1024) return badRequest('That request is too big.')
      const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
      if (body?.source !== 'linear' || !Array.isArray(body.teams)) return badRequest('Send source linear and the teams to import.')
      const teams = (body.teams as Array<Record<string, unknown>>).map((t) => ({ linearTeamId: String(t?.linear_team_id ?? ''), teamId: String(t?.team_id ?? '') }))
      if (teams.some((t) => !t.linearTeamId || !UUID_RE.test(t.teamId))) return badRequest('Each Linear team needs one of ours to go into.')
      staged = await stageLinear(who, { teams, includeClosed: body.include_closed === true, createStates: body.create_states !== false })
    } else {
      if (length > NOTION_LIMITS.zipBytes + 256 * 1024) return tooBig('50 MB')
      const form = await request.formData().catch(() => null)
      const file = form?.get('file')
      const source = form?.get('source')
      if (!(file instanceof File)) return badRequest('Send the file.')
      if (source === 'task_csv') {
        if (file.size > TASK_FILE_MAX_BYTES) return tooBig('5 MB')
        let mapping: unknown
        try {
          mapping = JSON.parse(String(form!.get('mapping') ?? 'null'))
        } catch {
          return badRequest('Send the mapping as a list of fields.')
        }
        if (!Array.isArray(mapping)) return badRequest('Send the mapping as a list of fields.')
        const teamId = String(form!.get('team_id') ?? '')
        const projectId = String(form!.get('project_id') ?? '') || null
        if (!UUID_RE.test(teamId) || (projectId && !UUID_RE.test(projectId))) return badRequest('Choose a team (and, if you like, a project).')
        staged = await stageTaskCsv(who, { bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name, mapping, teamId, projectId })
      } else if (source === 'notion') {
        if (file.size > NOTION_LIMITS.zipBytes) return tooBig('50 MB')
        const visibility = form!.get('visibility') === 'private' ? 'private' : 'workspace'
        const folderId = String(form!.get('folder_id') ?? '') || null
        if (folderId && !UUID_RE.test(folderId)) return badRequest('Choose a folder.')
        staged = await stageNotion(who, { bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name, visibility, parentFolderId: folderId, folderName: String(form!.get('folder_name') ?? '') || null })
      } else return badRequest('Choose what to import: task_csv, notion or linear.')
    }
    if (!staged.ok) return staged.status === 413 ? tooBig('50 MB') : badRequest(staged.error)
    return NextResponse.json({ import: await importView(who.db, who.svc, staged.imp) }, { status: 201 })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not read that import')
  }
}

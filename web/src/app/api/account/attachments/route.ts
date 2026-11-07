import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'
import { inngest } from '@/lib/inngest/client'
import { INDEXABLE_ATTACHMENT_EXTENSIONS } from '@/lib/attachments/extract-text'
import {
  ALLOWED_ATTACHMENT_EXTENSIONS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_LABEL,
  getFileExtension,
  fileCategory,
} from '@/lib/attachments/constants'

const ATTACHMENT_FIELDS =
  'id, file_name, file_size_bytes, mime_type, file_extension, file_category, storage_path, thumbnail_path, note_id, action_id, project_id, created_at'

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { searchParams } = request.nextUrl
  const projectId = searchParams.get('project_id')
  const noteId = searchParams.get('note_id')
  const actionId = searchParams.get('action_id')

  // When filtering by project, also include attachments from captures in that project
  if (projectId && !noteId && !actionId) {
    // Workspace-shared: include captures from all teammates in this project
    const { data: captures } = await supabase
      .from('captures')
      .select('id')
      .eq('project_id', projectId)
      .eq('workspace_id', workspaceId)

    const captureIds = captures?.map((c) => c.id) || []

    let query = supabase
      .from('attachments')
      .select(ATTACHMENT_FIELDS)
      .eq('workspace_id', workspaceId)

    if (captureIds.length > 0) {
      query = query.or(`project_id.eq.${projectId},note_id.in.(${captureIds.join(',')})`)
    } else {
      query = query.eq('project_id', projectId)
    }

    query = query.order('created_at', { ascending: false })

    const { data, error } = await query

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ attachments: data || [] })
  }

  let query = supabase
    .from('attachments')
    .select(ATTACHMENT_FIELDS)
    .eq('workspace_id', workspaceId)

  if (noteId) query = query.eq('note_id', noteId)
  if (actionId) query = query.eq('action_id', actionId)

  query = query
    .order('display_order', { ascending: true })
    .order('created_at', { ascending: false })

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ attachments: data || [] })
}

interface RegisterBody {
  storage_path?: unknown
  file_name?: unknown
  file_size_bytes?: unknown
  mime_type?: unknown
  note_id?: unknown
  action_id?: unknown
  project_id?: unknown
}

const STORAGE_PATH_SEGMENT = /^[0-9a-zA-Z_-]+$/
const UUID_FILENAME = /^[0-9a-f-]+\.[0-9a-z]+$/i

/**
 * POST /api/account/attachments
 * Registers metadata for a file the browser has already uploaded directly to
 * the 'attachments' storage bucket. Body is JSON:
 *   { storage_path, file_name, file_size_bytes, mime_type,
 *     note_id?, action_id?, project_id? }
 * At least one parent (note_id, action_id, project_id) is required.
 */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  let body: RegisterBody
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body.')
  }

  const storagePath = typeof body.storage_path === 'string' ? body.storage_path : ''
  const fileName = typeof body.file_name === 'string' ? body.file_name : ''
  const mimeType = typeof body.mime_type === 'string' ? body.mime_type : 'application/octet-stream'
  const clientSize = Number(body.file_size_bytes)
  const noteId = typeof body.note_id === 'string' && body.note_id ? body.note_id : null
  const actionId = typeof body.action_id === 'string' && body.action_id ? body.action_id : null
  let projectId = typeof body.project_id === 'string' && body.project_id ? body.project_id : null

  if (!storagePath || !fileName) {
    return badRequest('storage_path and file_name are required.')
  }
  if (!noteId && !actionId && !projectId) {
    return badRequest('One of note_id, action_id, or project_id is required.')
  }

  const ext = getFileExtension(fileName)
  if (!ext || !ALLOWED_ATTACHMENT_EXTENSIONS.has(ext)) {
    return badRequest('File type not supported. Upload images, documents, or code files.')
  }

  if (!Number.isFinite(clientSize) || clientSize < 0 || clientSize > MAX_ATTACHMENT_BYTES) {
    return badRequest(`File too large. Maximum size is ${MAX_ATTACHMENT_LABEL}.`)
  }

  // Path security: client supplies the storage_path, so validate it strictly.
  // Shape must be `${user.id}/<segment>/<uuid>.<ext>`, own-folder only, no
  // traversal, and its extension must match the declared file's extension.
  if (storagePath.includes('..') || !storagePath.startsWith(`${user.id}/`)) {
    return badRequest('Invalid storage path.')
  }
  const segments = storagePath.split('/')
  if (segments.length !== 3) {
    return badRequest('Invalid storage path.')
  }
  const [, parentSegment, objectName] = segments
  if (!STORAGE_PATH_SEGMENT.test(parentSegment) || !UUID_FILENAME.test(objectName)) {
    return badRequest('Invalid storage path.')
  }
  if (getFileExtension(objectName) !== ext) {
    return badRequest('Storage path extension does not match the file name.')
  }

  // Reject a double-register of the same object.
  const { data: existing } = await supabase
    .from('attachments')
    .select('id')
    .eq('storage_path', storagePath)
    .maybeSingle()
  if (existing) {
    return badRequest('This file has already been registered.')
  }

  // Parent validation + server-side derivation of project_id.
  if (actionId) {
    const { data: action } = await supabase
      .from('actions')
      .select('id, project_id')
      .eq('id', actionId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!action) {
      return notFound('Action not found in this workspace')
    }
    projectId = action.project_id ?? null
  } else if (noteId) {
    const { data: capture } = await supabase
      .from('captures')
      .select('id, project_id')
      .eq('id', noteId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!capture) {
      return notFound('Capture not found in this workspace')
    }
    projectId = capture.project_id ?? null
  } else if (projectId) {
    const { data: project } = await supabase
      .from('projects')
      .select('id')
      .eq('id', projectId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (!project) {
      return notFound('Project not found in this workspace')
    }
  }

  // Verify the object exists in storage. The own-folder SELECT policy covers
  // paths under `${user.id}/`, so a missing/unreadable object means the direct
  // upload never happened — reject rather than record a phantom row with a
  // client-declared size.
  let recordedSize = clientSize
  const { data: info, error: infoError } = await supabase.storage
    .from('attachments')
    .info(storagePath)
  if (infoError || !info) {
    return badRequest('Uploaded file not found in storage. Please retry the upload.')
  }
  const storageSize = Number((info as { size?: number }).size)
  if (Number.isFinite(storageSize)) {
    if (storageSize > MAX_ATTACHMENT_BYTES) {
      await supabase.storage.from('attachments').remove([storagePath])
      return badRequest(`File too large. Maximum size is ${MAX_ATTACHMENT_LABEL}.`)
    }
    recordedSize = storageSize
  }

  const category = fileCategory(mimeType)

  let countQuery = supabase
    .from('attachments')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
  if (noteId) countQuery = countQuery.eq('note_id', noteId)
  if (actionId) countQuery = countQuery.eq('action_id', actionId)
  if (!noteId && !actionId && projectId) countQuery = countQuery.eq('project_id', projectId)
  const { count } = await countQuery

  const isEmbeddable = INDEXABLE_ATTACHMENT_EXTENSIONS.has(ext)

  const { data, error } = await supabase
    .from('attachments')
    .insert({
      user_id: user.id,
      workspace_id: workspaceId,
      note_id: noteId,
      action_id: actionId,
      project_id: projectId,
      file_name: fileName,
      file_size_bytes: recordedSize,
      mime_type: mimeType,
      file_extension: ext,
      file_category: category,
      storage_bucket: 'attachments',
      storage_path: storagePath,
      display_order: count || 0,
    })
    .select(ATTACHMENT_FIELDS)
    .single()

  if (error) {
    await supabase.storage.from('attachments').remove([storagePath])
    return serverError(error.message)
  }

  if (isEmbeddable) {
    inngest.send({
      name: 'attachment/index',
      data: {
        attachmentId: data.id,
        userId: user.id,
        workspaceId,
        projectId,
      },
    }).catch((err) => {
      console.error('[attachments] Failed to send attachment/index event:', err)
    })
  }

  return NextResponse.json({ attachment: data })
}

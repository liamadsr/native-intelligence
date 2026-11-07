import {
  MAX_CHAT_UPLOAD_BYTES,
  getChatUploadExtension,
  isAllowedUploadExtension,
  isOwnChatUploadPath,
} from '@/lib/chat/upload-allowlist'
import { CHAT_UPLOAD_URL_TTL_SECONDS } from '@/lib/chat/fresh-upload-url'
import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/ai/chat/upload
 * Registers a file the browser already uploaded DIRECT to Supabase storage
 * under `${user.id}/chat-uploads/...` (bypassing the 4.5MB serverless body
 * ceiling). Validates the path prefix, extension allowlist, and 10MB cap
 * against the object's own metadata, then returns a signed URL + metadata.
 * The file is NOT yet attached to any entity — the AI can later attach it
 * to an action/capture using the attach_chat_file tool.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const body = await request.json().catch(() => null)
  const storagePath = typeof body?.storage_path === 'string' ? body.storage_path : ''
  const fileName = typeof body?.file_name === 'string' ? body.file_name : ''
  const mimeType = typeof body?.mime_type === 'string' ? body.mime_type : 'application/octet-stream'

  if (!storagePath || !fileName) {
    return NextResponse.json({ error: 'storage_path and file_name are required' }, { status: 400 })
  }

  if (!isOwnChatUploadPath(user.id, storagePath)) {
    return NextResponse.json({ error: 'Invalid storage path' }, { status: 400 })
  }

  const ext = getChatUploadExtension(fileName)
  if (!ext || !isAllowedUploadExtension(ext)) {
    return NextResponse.json(
      { error: 'File type not supported. Upload a text file (markdown, txt, csv, json, code) or an image. PDFs and Office documents are not supported.' },
      { status: 400 },
    )
  }
  if (getChatUploadExtension(storagePath) !== ext) {
    return NextResponse.json({ error: 'Storage path does not match the file name.' }, { status: 400 })
  }

  const folder = storagePath.slice(0, storagePath.lastIndexOf('/'))
  const objectName = storagePath.slice(storagePath.lastIndexOf('/') + 1)
  const { data: listing, error: listError } = await supabase.storage
    .from('attachments')
    .list(folder, { search: objectName, limit: 1 })

  const object = listing?.find((o) => o.name === objectName)
  if (listError || !object) {
    return NextResponse.json({ error: 'Uploaded file not found in storage.' }, { status: 404 })
  }

  const size = (object.metadata?.size as number | undefined) ?? 0
  if (size > MAX_CHAT_UPLOAD_BYTES) {
    await supabase.storage.from('attachments').remove([storagePath]).catch(() => {})
    return NextResponse.json({ error: 'File exceeds the 10MB chat limit' }, { status: 400 })
  }

  const { data: urlData, error: urlError } = await supabase.storage
    .from('attachments')
    .createSignedUrl(storagePath, CHAT_UPLOAD_URL_TTL_SECONDS)

  if (urlError || !urlData?.signedUrl) {
    return NextResponse.json({ error: 'Failed to generate URL' }, { status: 500 })
  }

  const fileId = objectName.slice(0, objectName.lastIndexOf('.')) || objectName

  return NextResponse.json({
    fileId,
    fileName,
    fileSize: size,
    mimeType,
    fileExtension: ext,
    storagePath,
    url: urlData.signedUrl,
  })
}

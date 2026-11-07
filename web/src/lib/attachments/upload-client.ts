'use client'

import { createClient } from '@/lib/supabase/client'
import { getFileExtension, isAllowedAttachmentFile } from './constants'

export class AttachmentUploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AttachmentUploadError'
  }
}

interface UploadAttachmentOptions {
  file: File
  noteId?: string
  actionId?: string
  projectId?: string
}

export async function uploadAttachment(
  opts: UploadAttachmentOptions,
): Promise<{ attachment: Record<string, unknown> }> {
  const { file, noteId, actionId, projectId } = opts

  const check = isAllowedAttachmentFile(file)
  if (!check.ok) {
    throw new AttachmentUploadError(check.reason)
  }

  const parentId = noteId || actionId || projectId
  if (!parentId) {
    throw new AttachmentUploadError('An attachment must be attached to a note, action, or project.')
  }

  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  const userId = session?.user?.id
  if (!userId) {
    throw new AttachmentUploadError('You need to be signed in to upload attachments.')
  }

  const ext = getFileExtension(file.name)
  const storagePath = `${userId}/${parentId}/${crypto.randomUUID()}.${ext}`

  const { error: uploadError } = await supabase.storage
    .from('attachments')
    .upload(storagePath, file, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    })

  if (uploadError) {
    throw new AttachmentUploadError(uploadError.message || 'Upload failed. Please try again.')
  }

  let res: Response
  try {
    res = await fetch('/api/account/attachments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storage_path: storagePath,
        file_name: file.name,
        file_size_bytes: file.size,
        mime_type: file.type || 'application/octet-stream',
        note_id: noteId || undefined,
        action_id: actionId || undefined,
        project_id: projectId || undefined,
      }),
    })
  } catch {
    await supabase.storage.from('attachments').remove([storagePath]).catch(() => {})
    throw new AttachmentUploadError('Network error while saving the attachment. Please try again.')
  }

  if (!res.ok) {
    await supabase.storage.from('attachments').remove([storagePath]).catch(() => {})
    const body = await res.json().catch(() => null)
    throw new AttachmentUploadError(body?.error || 'Upload failed. Please try again.')
  }

  return res.json()
}

/** Upload files one after another: how many landed, and the first failure's reason. */
export async function uploadAttachments(
  files: File[],
  parent: Omit<UploadAttachmentOptions, 'file'>,
): Promise<{ uploaded: number; firstError: string | null }> {
  let uploaded = 0
  let firstError: string | null = null
  for (const file of files) {
    try {
      await uploadAttachment({ ...parent, file })
      uploaded++
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'Upload failed. Please try again.'
      firstError ??= message
      console.error('[attachments] upload failed:', err)
    }
  }
  return { uploaded, firstError }
}

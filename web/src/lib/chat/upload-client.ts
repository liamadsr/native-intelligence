'use client'

import { createClient } from '@/lib/supabase/client'
import {
  getChatUploadExtension,
  validateChatUpload,
} from './upload-allowlist'

export class ChatUploadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ChatUploadError'
  }
}

export interface ChatUploadResult {
  fileId: string
  fileName: string
  fileSize: number
  mimeType: string
  fileExtension: string
  storagePath: string
  url: string
}

export async function uploadChatFile(file: File): Promise<ChatUploadResult> {
  const check = validateChatUpload(file)
  if (!check.ok) {
    throw new ChatUploadError(check.reason)
  }

  const supabase = createClient()
  const { data: { session } } = await supabase.auth.getSession()
  const userId = session?.user?.id
  if (!userId) {
    throw new ChatUploadError('You need to be signed in to upload files.')
  }

  const ext = getChatUploadExtension(file.name)
  const fileId = crypto.randomUUID()
  const storagePath = `${userId}/chat-uploads/${fileId}.${ext}`

  const { error: uploadError } = await supabase.storage
    .from('attachments')
    .upload(storagePath, file, {
      contentType: file.type || 'application/octet-stream',
      upsert: false,
    })

  if (uploadError) {
    throw new ChatUploadError(uploadError.message || 'Upload failed. Please try again.')
  }

  let res: Response
  try {
    res = await fetch('/api/ai/chat/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        storage_path: storagePath,
        file_name: file.name,
        mime_type: file.type || 'application/octet-stream',
      }),
    })
  } catch {
    await supabase.storage.from('attachments').remove([storagePath]).catch(() => {})
    throw new ChatUploadError('Network error while saving the file. Please try again.')
  }

  if (!res.ok) {
    await supabase.storage.from('attachments').remove([storagePath]).catch(() => {})
    const body = await res.json().catch(() => null)
    throw new ChatUploadError(body?.error || 'Upload failed. Please try again.')
  }

  return res.json()
}

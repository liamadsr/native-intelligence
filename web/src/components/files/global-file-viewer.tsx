'use client'

/**
 * One file viewer for the whole app, for places that have none of their own
 * (a search result picked in the palette, which closes as it opens the
 * file): `openFileViewer(file)` from anywhere, `<GlobalFileViewer />`
 * mounted once in the dashboard shell. `openAttachmentById` opens an
 * uploaded file by its id, read under the person's own row security, so a
 * file they can't read is never opened (the attachments policies, 493, and
 * the bucket's read policy, 663, fence it).
 */
import * as React from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { uploadViewerFile } from '@/lib/files/sources'
import type { ViewerFile } from '@/lib/files/viewer-file'
import { FileViewer } from './file-viewer'

const EVENT = 'ni:open-file-viewer'

/** Open a file in the app-wide viewer. */
export function openFileViewer(file: ViewerFile): void {
  window.dispatchEvent(new CustomEvent<ViewerFile>(EVENT, { detail: file }))
}

/** Signed for ten minutes: enough for a video to stream. */
const VIEW_TTL_SECONDS = 600

/** Open an uploaded file (an `attachments` row) by its id, as the person reads it. Says so when it can't. */
export async function openAttachmentById(id: string): Promise<boolean> {
  const supabase = createClient()
  const { data: row } = await supabase
    .from('attachments')
    .select('id, file_name, file_size_bytes, mime_type, storage_path, from_form, file_category')
    .eq('id', id)
    .maybeSingle()
  const file = row as {
    id: string
    file_name: string
    file_size_bytes: number | null
    mime_type: string | null
    storage_path: string | null
    from_form?: boolean | null
    file_category: string | null
  } | null
  if (!file?.storage_path) {
    toast.error('That file can’t be opened')
    return false
  }
  const path = file.storage_path
  const { data: signed } = await supabase.storage.from('attachments').createSignedUrl(path, VIEW_TTL_SECONDS)
  if (!signed?.signedUrl) {
    toast.error('That file can’t be opened')
    return false
  }
  openFileViewer(uploadViewerFile({ ...file, storage_path: path }, signed.signedUrl))
  return true
}

export function GlobalFileViewer() {
  const [file, setFile] = React.useState<ViewerFile | null>(null)
  React.useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent<ViewerFile>).detail
      if (detail) setFile(detail)
    }
    window.addEventListener(EVENT, onOpen)
    return () => window.removeEventListener(EVENT, onOpen)
  }, [])
  return <FileViewer file={file} onClose={() => setFile(null)} />
}

'use client'

/**
 * A table row's files (migration 663: what a form's submission sent), in the
 * row panel. The record carousel (components/capture/attachments-carousel.tsx)
 * reads a capture's or an action's files by their id, so it can't take a
 * row's: this lists them with the app's own pieces instead. An image opens in
 * the same viewer (its Lightbox), any other file downloads through a short
 * signed URL that asks storage for an attachment download, so a stranger's
 * file is never opened in place. Nothing at all when the row has no files.
 *
 * GET /api/account/attachments?data_row_id= reads them on the person's own
 * client: a file on a table they can't read never comes back.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, FileImage, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { Lightbox } from '@/components/capture/attachments-carousel'
import { PropertyGroup } from '@/components/views/property-group'
import type { AttachmentItem } from '@/app/account/(dashboard)/views/capture-utils'
import { formatFileSize } from '@/lib/attachments/workspace-files-model'
import { downloadFile } from '@/lib/download'
import { createClient } from '@/lib/supabase/client'

type RowFile = AttachmentItem & { from_form?: boolean | null }

/** A short signed URL; `download` names the file storage sends as an attachment. */
async function signedUrl(path: string, download?: string): Promise<string | null> {
  const { data } = await createClient().storage.from('attachments').createSignedUrl(path, 60, download ? { download } : undefined)
  return data?.signedUrl ?? null
}

export function RowFiles({ rowId }: { rowId: string }) {
  const [files, setFiles] = useState<RowFile[]>([])
  const [viewing, setViewing] = useState<{ item: RowFile; url: string } | null>(null)

  useEffect(() => {
    let live = true
    setFiles([])
    fetch(`/api/account/attachments?data_row_id=${encodeURIComponent(rowId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { attachments?: RowFile[] } | null) => live && setFiles(j?.attachments ?? []))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [rowId])

  useEffect(() => {
    if (!viewing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setViewing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [viewing])

  if (!files.length) return null

  const open = async (file: RowFile) => {
    if (!file.storage_path) return
    const image = file.file_category === 'image'
    const url = await signedUrl(file.storage_path, image ? undefined : file.file_name)
    if (!url) return toast.error('Could not open the file')
    if (image) return setViewing({ item: file, url })
    try {
      await downloadFile(url, file.file_name)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed')
    }
  }

  return (
    <PropertyGroup title="Files">
      <ul className="space-y-0.5 px-3" data-row-files="">
        {files.map((file) => {
          const Icon = file.file_category === 'image' ? FileImage : FileText
          const size = formatFileSize(file.file_size_bytes)
          return (
            <li key={file.id} className="flex items-center gap-2 py-1" data-row-file={file.id}>
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-sm text-foreground hover:underline"
                title={file.file_category === 'image' ? `View ${file.file_name}` : `Download ${file.file_name}`}
                onClick={() => void open(file)}
              >
                {file.file_name}
              </button>
              {size && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{size}</span>}
              {file.file_category !== 'image' && <Download className="h-3 w-3 shrink-0 text-muted-foreground/60" aria-hidden />}
            </li>
          )
        })}
      </ul>
      {viewing &&
        createPortal(
          <Lightbox images={[viewing.item]} signedUrls={{ [viewing.item.id]: viewing.url }} currentIndex={0} onIndexChange={() => {}} onClose={() => setViewing(null)} />,
          document.body,
        )}
    </PropertyGroup>
  )
}

'use client'

/**
 * A message's attachments as chips: an icon for the kind of file, its name and
 * size, and a download button when there is somewhere to download it from
 * (the person's own mailbox, or a share). A calendar file says so; when the
 * message's invitation is drawn as a card above, its chip is still here, to
 * download the .ics itself.
 */
import { CalendarDays, Download, File, FileArchive, FileImage, FileSpreadsheet, FileText, FileVideo, Music, Presentation } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { isCalendarAttachment } from '@/lib/email/calendar-invite'

export interface AttachmentChipData {
  name: string
  size: number
  mimeType: string
}

export function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return ''
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(sizes.length - 1, Math.floor(Math.log(bytes) / Math.log(k)))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

/** The icon and its tint for a file, by type first and by extension when the type says nothing. */
export function attachmentKind(attachment: Pick<AttachmentChipData, 'name' | 'mimeType'>): { icon: LucideIcon; tone: string; label: string } {
  const type = (attachment.mimeType || '').toLowerCase()
  const ext = (attachment.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()
  if (isCalendarAttachment(attachment)) return { icon: CalendarDays, tone: 'text-blue-500', label: 'Calendar file' }
  if (type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg'].includes(ext)) return { icon: FileImage, tone: 'text-emerald-500', label: 'Image' }
  if (type === 'application/pdf' || ext === 'pdf') return { icon: FileText, tone: 'text-red-500', label: 'PDF' }
  if (type.includes('spreadsheet') || type.includes('excel') || ['xlsx', 'xls', 'csv', 'numbers'].includes(ext)) return { icon: FileSpreadsheet, tone: 'text-green-600', label: 'Spreadsheet' }
  if (type.includes('presentation') || type.includes('powerpoint') || ['pptx', 'ppt', 'key'].includes(ext)) return { icon: Presentation, tone: 'text-orange-500', label: 'Presentation' }
  if (type.startsWith('video/') || ['mp4', 'mov', 'webm'].includes(ext)) return { icon: FileVideo, tone: 'text-purple-500', label: 'Video' }
  if (type.startsWith('audio/') || ['mp3', 'wav', 'm4a'].includes(ext)) return { icon: Music, tone: 'text-purple-500', label: 'Audio' }
  if (type.includes('zip') || type.includes('compressed') || ['zip', 'gz', 'tar', '7z', 'rar'].includes(ext)) return { icon: FileArchive, tone: 'text-amber-600', label: 'Archive' }
  if (type.includes('word') || type.startsWith('text/') || ['doc', 'docx', 'txt', 'md', 'rtf', 'pages'].includes(ext)) return { icon: FileText, tone: 'text-sky-500', label: 'Document' }
  return { icon: File, tone: 'text-muted-foreground', label: 'File' }
}

export function EmailAttachments<T extends AttachmentChipData>({
  attachments,
  hrefFor,
}: {
  attachments: readonly T[]
  /** Where one downloads from; null or absent: listed only. */
  hrefFor?: (attachment: T) => string | null
}) {
  if (!attachments.length) return null
  return (
    <div className="mt-3 flex flex-wrap gap-2" data-email-attachments="">
      {attachments.map((attachment, i) => {
        const href = hrefFor?.(attachment) ?? null
        const { icon: Icon, tone, label } = attachmentKind(attachment)
        const size = formatFileSize(attachment.size)
        return (
          <div
            key={`${attachment.name}-${i}`}
            data-email-attachment=""
            title={`${attachment.name}${size ? ` · ${size}` : ''}`}
            className="flex max-w-[260px] items-stretch overflow-hidden rounded-lg border border-border/70 bg-muted/30 text-xs"
          >
            <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5">
              <Icon className={`h-4 w-4 shrink-0 ${tone}`} aria-label={label} />
              <div className="min-w-0">
                <p className="truncate font-medium leading-tight">{attachment.name}</p>
                {size && <p className="leading-tight text-muted-foreground">{size}</p>}
              </div>
            </div>
            {href && (
              <a
                href={href}
                download={attachment.name}
                target="_blank"
                rel="noopener noreferrer"
                data-email-attachment-link=""
                aria-label={`Download ${attachment.name}`}
                title={`Download ${attachment.name}`}
                className="flex shrink-0 items-center border-l border-border/70 px-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Download className="h-3.5 w-3.5" />
              </a>
            )}
          </div>
        )
      })}
    </div>
  )
}

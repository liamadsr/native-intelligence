'use client'

/**
 * The Studio video card: the video create_studio_video made, get_studio_video
 * read, edit_studio_video changed, or export_studio_video exported (with its
 * file once the export is done). Its title, format, length and status, a
 * thumbnail when the video has one, and "Open in Studio", which opens the
 * Studio on that video as any card opens a page on a place (openTarget). The
 * booking link cards' frame (./booking-link-card.tsx). Never animated.
 */
import { memo, useState } from 'react'
import { Clapperboard, Download } from 'lucide-react'
import { openTarget } from '@/lib/chat-cards/open-card'
import { videoCardLine, type StudioVideoCardData, type StudioVideoCardVerb } from '@/lib/studio/agent/video-card'

const FRAME = 'w-fit max-w-full self-start rounded-xl border border-border/60 bg-background px-3 py-2'
const HEADING = 'mb-1.5 text-[11px] font-medium text-muted-foreground'
const BUTTON = 'inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-0.5 text-[11px] font-medium text-foreground hover:bg-muted'

const HEADINGS: Record<StudioVideoCardVerb, string> = {
  made: 'Video made',
  read: 'Video',
  edited: 'Video edited',
  exporting: 'Exporting video',
  exported: 'Video exported',
  'export-failed': 'Export failed',
}

/** The video's thumbnail, or nothing when it has none (or it fails to load). */
function Thumbnail({ url }: { url: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return null
  return (
    // A small signed-in image from the app's own API: next/image would add nothing here.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" loading="lazy" onError={() => setFailed(true)} className="h-12 w-20 shrink-0 rounded-md bg-muted object-cover" data-studio-video-thumb="" />
  )
}

function StudioVideoCardImpl({ data }: { data: StudioVideoCardData }) {
  const { video } = data
  const line = videoCardLine(video)
  return (
    <div data-studio-video-card={data.verb} className={FRAME}>
      <p className={HEADING}>
        {HEADINGS[data.verb]}
        {data.verb === 'edited' && data.edits ? ` · ${data.edits} ${data.edits === 1 ? 'change' : 'changes'}` : ''}
      </p>
      <div className="flex min-w-0 items-center gap-2.5">
        {video.thumbnailUrl ? <Thumbnail url={video.thumbnailUrl} /> : null}
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-foreground">{video.title}</p>
          {line && <p className="text-xs text-muted-foreground">{line}</p>}
          {video.studioProject && <p className="truncate text-[11px] text-muted-foreground">{video.studioProject}</p>}
        </div>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <button
          type="button"
          className={BUTTON}
          data-studio-video-open=""
          onClick={() => openTarget({ type: 'studio_video', id: video.id, title: video.title }, { from: 'chip' })}
        >
          <Clapperboard className="h-3 w-3" strokeWidth={1.75} />
          Open in Studio
        </button>
        {data.downloadUrl && (
          <a href={data.downloadUrl} target="_blank" rel="noreferrer" className={BUTTON} data-studio-video-download="">
            <Download className="h-3 w-3" strokeWidth={1.75} />
            Download
          </a>
        )}
      </div>
    </div>
  )
}

export const StudioVideoCard = memo(StudioVideoCardImpl)

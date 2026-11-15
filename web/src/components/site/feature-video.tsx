'use client'

/**
 * A feature's recorded walkthrough: the still with a play button, and the
 * player once it is pressed. Nothing is fetched before that (`preload` is
 * off until play), so a page with a video costs no more to open than one
 * without.
 */
import { useState } from 'react'
import { Play } from 'lucide-react'
import type { FeatureVideo as FeatureVideoData } from '@/lib/marketing/features'

export function FeatureVideo({ video, name }: { video: FeatureVideoData; name: string }) {
  const [playing, setPlaying] = useState(false)
  const label = `Watch the ${name} walkthrough`

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-3xl border border-border bg-black shadow-2xl shadow-black/30">
      {playing ? (
        <video src={video.src} poster={video.poster} controls autoPlay playsInline className="h-full w-full" />
      ) : (
        <button type="button" onClick={() => setPlaying(true)} aria-label={label} className="group absolute inset-0 block h-full w-full">
          {video.poster && <img src={video.poster} alt="" className="h-full w-full object-cover" />}
          <span className="absolute inset-0 bg-black/20 transition-colors group-hover:bg-black/10" />
          <span className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-3 rounded-full border border-white/20 bg-black/60 py-2 pl-2 pr-5 text-white backdrop-blur-md">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white text-black">
              <Play aria-hidden className="h-4 w-4 translate-x-px fill-current" />
            </span>
            <span className="text-left text-sm font-medium">
              {label}
              {video.length && <span className="font-normal text-white/70"> · {video.length}</span>}
            </span>
          </span>
        </button>
      )}
    </div>
  )
}

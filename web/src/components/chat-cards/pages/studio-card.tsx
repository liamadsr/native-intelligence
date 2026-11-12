'use client'

/**
 * The Studio as a card: making videos and ads. Studio projects and their videos, each video's overview, storyboard
 * and cast, and the editor (the preview, the timeline, the inspector), all inside the card, which draws its own
 * navigation (a rail down its left side), as an editor does.
 *
 * The editor is a large bundle with a video player in it, and it measures the window as it mounts: it loads the
 * first time a Studio card is opened, in the browser only, never on the server.
 *
 * Where the card is, is a video and one of its pages (overview, storyboard, cast, edit). The place moves two ways,
 * and the two must not answer each other:
 *
 *   The Studio moves   the person opens another video or page inside it. The card keeps the place (so it opens
 *                      there again, and the agent's note says what the person is looking at). The Studio is not
 *                      told: it is already there.
 *   The card moves     a link to one video, the agent showing the video it just made, the header's Back. The
 *                      Studio is asked to go there.
 *
 * So a place the Studio itself reported is never handed back to it as a request. Without that, the two would
 * trade places for ever (the card asking for the page the Studio just left).
 */
import * as React from 'react'
import dynamic from 'next/dynamic'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import type { StudioPage, StudioRootProps } from '@/components/studio/studio-root'
import { PageGate, usePagePlace, type PageCardProps } from './page-card'

const StudioRoot = dynamic(() => import('@/components/studio/studio-root'), {
  ssr: false,
  loading: () => <div className="flex h-full items-center justify-center text-sm text-muted-foreground">Opening the Studio…</div>,
})

const VIDEO_PAGES: readonly StudioPage[] = ['overview', 'storyboard', 'cast', 'edit']

/** A place in the Studio: one video and which of its pages (none: the Studio project it is in), or nowhere in particular. */
export interface StudioPlace {
  videoId: string | null
  page: StudioPage | null
}

/** The place a card's `at` and `tab` name. */
export function studioPlaceOf(at: { type: string; id: string } | null | undefined, tab: string | undefined): StudioPlace {
  if (at?.type !== 'studio_video') return { videoId: null, page: null }
  return { videoId: at.id, page: VIDEO_PAGES.find((p) => p === tab) ?? null }
}

const samePlace = (a: StudioPlace, b: StudioPlace) => a.videoId === b.videoId && a.page === b.page

export default function StudioCard(props: PageCardProps) {
  const workspaceId = useWorkspaceId()
  const { at, tab, go } = usePagePlace(props)
  const place = React.useMemo(() => studioPlaceOf(at, tab), [at, tab])
  const placeRef = React.useRef(place)
  placeRef.current = place

  // Where the Studio last said it is, and what it was last asked to open.
  const reported = React.useRef<StudioPlace | null>(null)
  const [asked, setAsked] = React.useState<StudioPlace>(place)
  React.useEffect(() => {
    // The card's place changed. The Studio's own report coming back is not a request.
    if (reported.current && samePlace(reported.current, place)) return
    setAsked((current) => (samePlace(current, place) ? current : place))
  }, [place])

  const onPlace = React.useCallback<NonNullable<StudioRootProps['onPlace']>>(
    ({ videoId, title, page }) => {
      if (!videoId) return
      const now: StudioPlace = { videoId, page: page === 'project' ? null : page }
      reported.current = now
      if (samePlace(placeRef.current, now)) return
      go({ type: 'studio_video', id: videoId, ...(title ? { label: title } : {}) } as Parameters<typeof go>[0], now.page ?? undefined)
    },
    [go],
  )

  if (!workspaceId) return null
  return (
    <PageGate spec={props.spec}>
      <div className="h-full min-h-0" data-studio-card="">
        <StudioRoot workspaceId={workspaceId} videoId={asked.videoId} page={asked.page ?? undefined} onPlace={onPlace} />
      </div>
    </PageGate>
  )
}

'use client'

/**
 * The Studio as a card: making videos and ads. Studio projects and their videos, each video's overview, storyboard
 * and cast, and the editor (the preview, the timeline, the inspector), all inside the card.
 *
 * Its navigation is the Studio page's sub-nav beside the rail (app/account/(dashboard)/page-panel/studio-panel.tsx;
 * Liam, 11-12: the Studio "needs to match the rest of our app"), as every page's is. The card draws its own rail
 * down its left side only while that sub-nav is not on screen: inline in the chat, below `md` (no rail, no
 * sub-nav), opened as something other than the Studio page's own card (the agent's card on one video), or with
 * the panel closed or the capture's notepad on the left (page-panel/subnav-on-screen.ts). While it is still
 * being decided (a refresh), it keeps the sub-nav's look, so nothing shows then goes. What the Studio says of
 * where it is goes to the sub-nav (../studio-card-controls.ts), which moves it by asking the card.
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
 *   The card moves     a link to one video, the agent showing the video it just made, the header's Back, a row of
 *                      the sub-nav. The Studio is asked to go there.
 *
 * So a place the Studio itself reported is never handed back to it as a request. Without that, the two would
 * trade places for ever (the card asking for the page the Studio just left). Each request is a new one (`ask`
 * counts them), so asking for a place the Studio has since moved away from moves it back, and asking for where
 * it is already does nothing.
 */
import * as React from 'react'
import dynamic from 'next/dynamic'
import { useWorkspaceId } from '@/app/account/workspace-switcher'
import { pageOfCard } from '@/app/account/(dashboard)/rail/rail-pages'
import { useRailShown } from '@/app/account/(dashboard)/rail/rail-media'
import { useOwnSubnavShown } from '@/app/account/(dashboard)/page-panel/subnav-on-screen'
import type { CardSpec } from '@/lib/chat-cards/kinds'
import type { StudioPage, StudioRootProps } from '@/components/studio/studio-root'
import { publishStudioCard, unpublishStudioCard } from '../studio-card-controls'
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

/**
 * Whether the card leaves its navigation to the sub-nav beside the rail: full screen where the rail is, as the
 * Studio page's own card, while that page's sub-nav is on screen (or still being decided).
 */
export function studioNavInPanel(opts: { fullScreen: boolean; railShown: boolean; ownCard: boolean; subnavShown: boolean }): boolean {
  return opts.fullScreen && opts.railShown && opts.ownCard && opts.subnavShown
}

/** What the Studio is asked to open: a place (`page` may be its Studio project's overview), and which request it is. */
interface StudioAsk {
  videoId: string | null
  page: StudioPage | null
  n: number
}

export default function StudioCard(props: PageCardProps) {
  const { toolCallId, store, fullScreen, spec } = props
  const workspaceId = useWorkspaceId()
  const { at, tab, go } = usePagePlace(props)
  const place = React.useMemo(() => studioPlaceOf(at, tab), [at, tab])
  const placeRef = React.useRef(place)
  placeRef.current = place

  // Where the Studio last said it is (in the card's terms), and what it was last asked to open.
  const reported = React.useRef<StudioPlace | null>(null)
  const [asked, setAsked] = React.useState<StudioAsk>(() => ({ ...place, n: 0 }))
  React.useEffect(() => {
    // The card's place changed. The Studio's own report coming back is not a request.
    const where = reported.current
    if (where && samePlace(where, place)) return
    setAsked((current) => (!where && samePlace(current, place) ? current : { ...place, n: current.n + 1 }))
  }, [place])

  // Where the Studio is, as it says: for the sub-nav.
  const [here, setHere] = React.useState<{ videoId: string | null; title: string | null; page: StudioPage } | null>(null)
  const onPlace = React.useCallback<NonNullable<StudioRootProps['onPlace']>>(
    ({ videoId, title, page }) => {
      setHere((was) => (was && was.videoId === videoId && was.title === title && was.page === page ? was : { videoId, title, page }))
      if (!videoId) return
      const now: StudioPlace = { videoId, page: page === 'project' ? null : page }
      reported.current = now
      if (samePlace(placeRef.current, now)) return
      go({ type: 'studio_video', id: videoId, ...(title ? { label: title } : {}) } as Parameters<typeof go>[0], now.page ?? undefined)
    },
    [go],
  )

  // The sub-nav's asks: a video, on a page (its Studio project's overview too; null: where it was last).
  const ask = React.useCallback((videoId: string, page: StudioPage | null) => setAsked((current) => ({ videoId, page, n: current.n + 1 })), [])
  const show = React.useCallback(() => {
    if (store.fullScreen() !== toolCallId) store.enterFullScreen(toolCallId)
  }, [store, toolCallId])
  const label = at?.type === 'studio_video' ? ((at as { label?: string }).label ?? null) : null
  React.useEffect(() => {
    publishStudioCard({
      cardId: toolCallId,
      workspaceId,
      // Before the Studio has said: the card's own place.
      videoId: here ? here.videoId : place.videoId,
      title: here ? here.title : label,
      page: here ? here.page : place.page,
      go: ask,
      show,
    })
  }, [toolCallId, workspaceId, here, place, label, ask, show])
  React.useEffect(() => () => unpublishStudioCard(toolCallId), [toolCallId])

  // Its own rail only where the sub-nav is not its navigation.
  const ownCard = React.useMemo(() => pageOfCard(spec as CardSpec) === 'studio', [spec])
  const railShown = useRailShown()
  const subnavShown = useOwnSubnavShown(ownCard ? 'studio' : null)
  const navInPanel = studioNavInPanel({ fullScreen, railShown, ownCard, subnavShown })

  if (!workspaceId) return null
  return (
    <PageGate spec={props.spec}>
      <div className="h-full min-h-0" data-studio-card="">
        <StudioRoot
          workspaceId={workspaceId}
          videoId={asked.videoId}
          page={asked.page ?? undefined}
          ask={asked.n}
          navInPanel={navInPanel}
          onPlace={onPlace}
        />
      </div>
    </PageGate>
  )
}

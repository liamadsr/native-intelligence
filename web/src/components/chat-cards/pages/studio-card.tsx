'use client'

/**
 * The Studio as a card: making videos and ads. Studio projects and their videos, each video's overview, storyboard
 * and cast, and the editor (the preview, the timeline, the inspector), all inside the card.
 *
 * The Studio is one of Outreach's pages (Liam, 11-13: "it should be part of the outreach page"): the sub-nav
 * beside the app's rail switches between Outreach's pages, so the Studio's own navigation (its Projects and videos,
 * the Studio project's overview, the video's Overview, Storyboard, Cast and Edit) is its own pages rail, a column of
 * icons down its left edge, always there (components/studio/ui/AppRail.tsx).
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
 * trade places for ever (the card asking for the page the Studio just left). Each request is a new one (`ask`
 * counts them), so asking for a place the Studio has since moved away from moves it back, and asking for where
 * it is already does nothing.
 *
 * The agent in the app's chat is the Studio's agent (the editor has none of its own). When the person sends it a
 * message with this card in front, the chat's card store asks the card what the editor shows at that moment
 * (ChatCardStore.provideLive): the video, its Studio project, the page, the playhead, the format and what is
 * selected (lib/chat-cards/studio-note.ts), after the editor has saved the person's edits (settle), so the agent
 * edits what they see. Read then and only then: nothing is reported as the playhead moves or the selection
 * changes. Never for a guest of the workspace (the Studio refuses one).
 */
import * as React from 'react'
import dynamic from 'next/dynamic'
import { useIsWorkspaceGuest, useWorkspaceId } from '@/app/account/workspace-switcher'
import { projectOfVideo, readStudioList, studioList } from '@/components/studio/studio-list'
import { useStudioRevision } from '@/components/studio/studio-changes'
import type { StudioPage, StudioRootProps } from '@/components/studio/studio-root'
import type { EditorChatLink } from '@/components/studio/ui/chat-note'
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

/** What the Studio is asked to open: a place (`page` may be its Studio project's overview), and which request it is. */
interface StudioAsk {
  videoId: string | null
  page: StudioPage | null
  n: number
}

export default function StudioCard(props: PageCardProps) {
  const { toolCallId, store } = props
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

  // Where the Studio is, as it says: the card keeps it.
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

  // What the agent is told about the editor when a turn is sent with this card in front (see the header).
  const guest = useIsWorkspaceGuest()
  const link = React.useRef<EditorChatLink | null>(null)
  const onLive = React.useCallback((next: EditorChatLink | null) => {
    link.current = next
  }, [])
  React.useEffect(() => {
    if (guest || !workspaceId) return
    return store.provideLive(toolCallId, {
      read: () => {
        const note = link.current?.note()
        if (!note) return null
        const list = studioList(workspaceId)
        const project = list ? projectOfVideo(list, note.v.id) : null
        return { studio: project ? { ...note, sp: { id: project.id, title: project.title } } : note }
      },
      settle: () => link.current?.flush() ?? Promise.resolve(true),
    })
  }, [store, toolCallId, guest, workspaceId])
  // Which Studio project a video is in comes from the Studio's list (components/studio/studio-list.ts), kept fresh
  // while the card is open: read when there is none yet, when the Studio says its list changed, and when the open
  // video is not in it (made since). Never at send time, never on a timer.
  const videoNow = place.videoId
  const revision = useStudioRevision()
  const readAt = React.useRef(revision)
  React.useEffect(() => {
    if (guest || !workspaceId || !videoNow) return
    const list = studioList(workspaceId)
    if (list && readAt.current === revision && list.some((c) => c.ads.some((a) => a.id === videoNow))) return
    readAt.current = revision
    void readStudioList(workspaceId)
  }, [guest, workspaceId, videoNow, revision])

  if (!workspaceId) return null
  return (
    <PageGate spec={props.spec}>
      <div className="h-full min-h-0" data-studio-card="">
        <StudioRoot
          workspaceId={workspaceId}
          videoId={asked.videoId}
          page={asked.page ?? undefined}
          ask={asked.n}
          onPlace={onPlace}
          onLive={onLive}
        />
      </div>
    </PageGate>
  )
}

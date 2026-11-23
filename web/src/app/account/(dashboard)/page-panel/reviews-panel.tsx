'use client'

/**
 * Reviews' sub-nav beside the rail (docs/plans/github-reviews.md, "Reviews on
 * the app's own list"), as My Actions' (tasks-panel.tsx): the sections
 * (Review requests, Authored by me, Assigned to me, Involves me) and the
 * state (Open, Closed, All). It lights its rows from what the card says
 * (reviews-card-controls.ts) and moves the card; the card has no section
 * tabs of its own from `md` up.
 */
import { useLayoutEffect, useRef } from 'react'
import { AtSign, CircleCheckBig, CircleDot, Eye, GitPullRequest, Layers, SquarePen, UserRound, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useReviewsCard, type ReviewsCardControls } from '@/components/chat-cards/reviews-card-controls'
import { REVIEW_SECTIONS, SECTION_LABEL, type ReviewSection, type ReviewStateFilter } from '@/lib/github/reviews'
import { KEEP_PLACE_ATTR } from '../rail/selected-place'
import { PagePanelFrame } from './page-panel-frame'
import { PAGE_PANEL_LABELS, type PagePanelProps } from './page-panel-types'
import { usePendingMove } from './pending-move'

const SECTION_ICONS: Record<ReviewSection, LucideIcon> = {
  review_requests: Eye,
  authored: SquarePen,
  assigned: UserRound,
  involves: AtSign,
}

const STATES: ReadonlyArray<{ key: ReviewStateFilter; label: string; icon: LucideIcon }> = [
  { key: 'open', label: 'Open', icon: CircleDot },
  { key: 'closed', label: 'Closed', icon: CircleCheckBig },
  { key: 'all', label: 'All', icon: Layers },
]

const ROW_LIT = 'bg-foreground/[0.08] hover:bg-foreground/[0.08]'

export function ReviewsPanel({ active, mode, front, onContent }: PagePanelProps) {
  const card = useReviewsCard(front?.id ?? null)
  // Its rows are always there: something to show from its first commit, card or not.
  useLayoutEffect(() => {
    onContent('reviews', true)
  }, [onContent])
  const frontRef = useRef(front)
  frontRef.current = front
  const run = usePendingMove<ReviewsCardControls>(card, active)
  const section = card?.section ?? 'review_requests'
  const state = card?.state ?? 'open'

  const press = (move: (c: ReviewsCardControls) => void) =>
    run((c) => {
      if (c.cardId !== frontRef.current?.id) c.show()
      move(c)
    })

  return (
    <PagePanelFrame mode={mode} active={active} label={PAGE_PANEL_LABELS.reviews} page="reviews">
      <nav
        aria-label={PAGE_PANEL_LABELS.reviews}
        data-reviews-panel-nav=""
        {...{ [KEEP_PLACE_ATTR]: '' }}
        className="min-h-0 overflow-y-auto overscroll-contain px-1.5 py-2.5 scrollbar-hide-deep"
      >
        <div className="ph-no-capture flex flex-col gap-3">
          <section aria-label="Pull requests">
            <ul className="flex flex-col">
              {REVIEW_SECTIONS.map((s) => (
                <li key={s}>
                  <PanelRow
                    icon={SECTION_ICONS[s] ?? GitPullRequest}
                    label={SECTION_LABEL[s]}
                    lit={s === section}
                    data={{ 'data-reviews-panel-section': s }}
                    onPress={() => press((c) => c.setSection(s))}
                  />
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="reviews-panel-state">
            <h3 id="reviews-panel-state" className="px-2 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">
              State
            </h3>
            <ul className="flex flex-col">
              {STATES.map((st) => (
                <li key={st.key}>
                  <PanelRow
                    icon={st.icon}
                    label={st.label}
                    lit={st.key === state}
                    data={{ 'data-reviews-panel-state': st.key }}
                    onPress={() => press((c) => c.setState(st.key))}
                  />
                </li>
              ))}
            </ul>
          </section>
        </div>
      </nav>
    </PagePanelFrame>
  )
}

function PanelRow({ icon: Icon, label, lit, data, onPress }: { icon: LucideIcon; label: string; lit: boolean; data: Record<string, string>; onPress: () => void }) {
  return (
    <button
      type="button"
      {...data}
      aria-current={lit ? 'true' : undefined}
      onClick={onPress}
      title={label}
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded-xl px-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none',
        lit ? ROW_LIT : 'hover:bg-muted/60',
      )}
    >
      <span aria-hidden className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
        <Icon className="size-4" strokeWidth={1.75} />
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">{label}</span>
    </button>
  )
}

'use client'

/**
 * Evals as a card: the real EvalsView, the suites, one suite (on its tab),
 * one case or one run. Each step moves the card the way it moves a tab; a
 * case or a run remembers its suite, kept with the card, so Back returns to
 * it; each step is one of the card's history (the header's Back and Forward).
 * The suites list and a suite's cases and runs are card lists.
 *
 * Gated like the nav: Evals is an opt-in feature, and the card is off where
 * it is (PageGate, and show refuses it on the server).
 */
import { EvalsView } from '@/app/account/(dashboard)/evals/evals-view'
import type { EvalSuiteTab } from '@/app/account/(dashboard)/evals/suite-tabs'
import type { PagePlace } from '@/lib/chat-cards/pages'
import { PageCardSurface, usePageCardSurface, usePagePlace, type PageCardProps } from './page-card'
import { useCardNav, useCardNavStoreSync } from '../card-history'

export default function EvalsCard(props: PageCardProps) {
  const { toolCallId, store } = props
  const surface = usePageCardSurface(props)
  const place = usePagePlace(props)
  const at = place.at
  // The suite above a case or a run moves with the place, in the same step.
  const storedSuite = () => {
    const kept = store.state(toolCallId)
    const keptAt = kept.at === undefined ? at : kept.at
    return keptAt?.type === 'eval_suite' ? keptAt : keptAt ? (kept.trail?.[0] ?? null) : null
  }
  const suiteNav = useCardNav<PagePlace | null>('eval_suite', storedSuite, (next) => store.update(toolCallId, { trail: next ? [next] : [] }))
  // A case seeded from outside the card (a reused card) brings its suite, in
  // the place's step.
  useCardNavStoreSync(store, suiteNav, storedSuite)
  const suite = suiteNav.value
  const tab = place.tab as EvalSuiteTab | undefined

  const openSuite = (next: PagePlace | null) => {
    suiteNav.set(next, { persist: false })
    store.update(toolCallId, { trail: [] })
    place.go(next)
  }
  const openChild = (child: PagePlace) => {
    store.update(toolCallId, { trail: suite ? [suite] : [] })
    place.go(child, tab)
  }

  return (
    <PageCardSurface surface={surface}>
      <div className="h-full min-h-0">
        <EvalsView
          suiteId={suite?.id ?? null}
          suiteName={suite?.label}
          suiteTab={tab}
          caseId={at?.type === 'eval_case' ? at.id : null}
          runId={at?.type === 'eval_run' ? at.id : null}
          onOpenSuite={(id, name) => openSuite({ type: 'eval_suite', id, label: name })}
          onSuiteTabChange={(next) => place.setTab(next)}
          onOpenCase={(caseId, caseName) => openChild({ type: 'eval_case', id: caseId, label: caseName })}
          onOpenRun={(runId, runLabel) => openChild({ type: 'eval_run', id: runId, label: runLabel })}
          onBackToSuite={() => (suite ? place.go(suite, tab) : openSuite(null))}
          onCloseDetail={() => openSuite(null)}
        />
      </div>
    </PageCardSurface>
  )
}

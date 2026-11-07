'use client'

/**
 * Evals — the view mounted by tab-content for `view: 'evals'`.
 *
 * Renders the suites index, one suite, one case or one run depending on the tab
 * LOCATION, exactly like SequencesView and ProspectingView: every detail is a
 * real history step, so Back/Forward and Recently viewed reach all four
 * screens. Nothing here opens a slide-over.
 *
 * The INDEX is the shared views system (UnifiedViewLayout with
 * entityType="eval_suite"), so suites get the same saved views, filters,
 * grouping, sort, display properties and list/board layouts as Actions and
 * Sequences — this wrapper contributes only what views can't: the page header
 * and the "+" that fires /create-eval. Migration 255 is what makes that
 * possible: the three summary facts a suite row shows (case count, last
 * outcome, when) are REAL columns kept current by triggers, so a view can
 * group and sort on them.
 *
 * NO CHILD-TABLE BRIDGE. Sequences re-dispatch `sequence_enrollment` events as
 * `sequence` ones because the row's numbers live on a child table the list
 * never subscribes to. Evals needs no such bridge: 255's triggers land every
 * eval_case and eval_run change on the eval_suite ROW, which is in the realtime
 * publication, so the list already refreshes on the one subscription
 * use-realtime-entities holds.
 *
 * PROP CONTRACT (what tab-content passes; do not change):
 *
 *   suiteId / caseId / runId — from the tab location; the deepest non-null wins
 *   suiteTab / onSuiteTabChange — the suite page's inner tab, on the LOCATION
 *                    so Back/Forward restore it; switching one is a history
 *                    step, the same contract a side panel's `section` has
 *   onOpenSuite / onOpenCase / onOpenRun — push a detail history entry
 *   on*NameLoaded  — deep links arrive with a placeholder label; called once
 *                    the real name is known so the tab label + Recently viewed
 *                    adopt it
 *   onBackToSuite  — a case or run returns to its suite as a history step
 *   onCloseDetail  — return to the index as a history step
 *
 * Because the page renders its OWN header (ViewHeader / EntityDetailHeader,
 * which draw the nav toggle), 'evals' is in tab-content's
 * VIEWS_WITH_OWN_HEADER — EVERY branch must therefore keep rendering a header,
 * or the nav toggle vanishes (a documented historical bug; omitting the header
 * while staying out of that set produces the inverse, a doubled header).
 *
 * WHY "+" DOES NOT OPEN A FORM. A suite is worth nothing without cases, and a
 * case is a synthetic meeting — a timed, speaker-labeled transcript with
 * expected outcomes. No form can collect that. The primary action therefore
 * fires the `/create-eval` system skill (migration 253), which interviews the
 * user and writes both the suite and its cases through the eval tools. Same
 * gesture the Library uses for `/create-skill`, same window event
 * (`dial8:trigger-skill`) the shell already routes to the active tab's chat.
 */

import { Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { UnifiedViewLayout } from '@/components/views/unified-view-layout'
import type { EvalSuiteTab } from '@/app/account/(dashboard)/evals/suite-tabs'
import { ViewHeader } from '../views/view-header'
import { EvalCasePage } from './case-page'
import { EvalRunPage } from './run-page'
import { EvalSuiteDetail } from './suite-detail'

/** The slug of the system skill that authors a suite (migration 253). */
export const CREATE_EVAL_SKILL_SLUG = 'create-eval'

/**
 * Fire the `/create-eval` skill in the active tab's chat.
 *
 * The chat lives once at the shell (workspace-scoped, shared across tabs), so
 * a view reaches it through a window event rather than a ref — the same bridge
 * the email reply affordance and the proposal card use.
 */
export function openCreateEvalSkill() {
  window.dispatchEvent(
    new CustomEvent('dial8:trigger-skill', { detail: { slug: CREATE_EVAL_SKILL_SLUG } }),
  )
}

// ============================================================
// The view
// ============================================================

export function EvalsView({
  suiteId,
  suiteName,
  suiteTab,
  caseId,
  runId,
  onOpenSuite,
  onSuiteTabChange,
  onSuiteNameLoaded,
  onOpenCase,
  onCaseNameLoaded,
  onOpenRun,
  onRunLabelLoaded,
  onBackToSuite,
  onCloseDetail,
}: {
  /** From the tab location — non-null renders the suite (or, with caseId /
   *  runId, one of its children). */
  suiteId: string | null
  /** The suite's name as the location knows it, for the case/run breadcrumb. */
  suiteName?: string
  /** Which of the suite page's inner tabs is open, from the location. */
  suiteTab?: EvalSuiteTab
  caseId?: string | null
  runId?: string | null
  /** Push a detail history entry (recently-viewed label rides along). */
  onOpenSuite: (id: string, name: string) => void
  /** Switching a suite's inner tab is a history step, like a side panel's
   *  section — the caller re-navigates to the same suite with a new tab. */
  onSuiteTabChange?: (tab: EvalSuiteTab) => void
  /** Deep links arrive with a placeholder name; called once the detail page
   *  knows the real one so the caller can refresh the history entry/label. */
  onSuiteNameLoaded?: (id: string, name: string) => void
  onOpenCase?: (caseId: string, caseName: string, suiteName: string) => void
  onCaseNameLoaded?: (caseId: string, caseName: string) => void
  onOpenRun?: (runId: string, runLabel: string, suiteName: string) => void
  onRunLabelLoaded?: (runId: string, runLabel: string) => void
  /** A case or a run returns to its suite as a history step. */
  onBackToSuite?: () => void
  /** Return to the index as a history step. */
  onCloseDetail: () => void
}) {
  // The deepest location wins: a case or a run is opened FROM a suite and the
  // location keeps the suite id so Back has somewhere to go.
  if (caseId) {
    return (
      <EvalCasePage
        caseId={caseId}
        suiteName={suiteName}
        onBack={onBackToSuite ?? onCloseDetail}
        onCaseNameLoaded={onCaseNameLoaded}
      />
    )
  }

  if (runId) {
    return (
      <EvalRunPage
        runId={runId}
        suiteName={suiteName}
        onBack={onBackToSuite ?? onCloseDetail}
        onRunLabelLoaded={onRunLabelLoaded}
      />
    )
  }

  if (suiteId) {
    return (
      <EvalSuiteDetail
        suiteId={suiteId}
        tab={suiteTab}
        onBack={onCloseDetail}
        onTabChange={onSuiteTabChange}
        onSuiteNameLoaded={onSuiteNameLoaded}
        onOpenCase={onOpenCase}
        onOpenRun={onOpenRun}
      />
    )
  }

  return (
    <div className="flex h-full flex-col">
      {/* Page header — title + create. The views toolbar (search, filter,
          group, sort, display, layout) renders just below, inside
          UnifiedViewLayout, so there is deliberately NO search input here:
          that would be a second search box competing with the toolbar's. */}
      <ViewHeader
        title="Evals"
        actions={
          /* Ghost icon-only create — the house convention. It fires the
             /create-eval skill rather than opening a form; see the module
             header. */
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-muted-foreground hover:text-foreground"
            onClick={openCreateEvalSkill}
            title="New eval suite"
            aria-label="New eval suite"
          >
            <Plus className="h-4 w-4" />
          </Button>
        }
      />

      <div className="min-h-0 flex-1">
        <UnifiedViewLayout
          entityType="eval_suite"
          onItemSelect={(id, title) => onOpenSuite(id, title)}
        />
      </div>
    </div>
  )
}

/** Exported for the suite detail's loading header, so both screens spin the
 *  same glyph in the same place. */
export function EvalsLoading() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
    </div>
  )
}

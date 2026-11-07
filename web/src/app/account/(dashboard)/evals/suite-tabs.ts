/**
 * The eval suite page's inner tabs. Declared as a value (not a bare union) so
 * the page can hand the same list to `usePanelSection` as its allow-list —
 * which is what clamps a stale persisted tab from an older build back to
 * Overview instead of rendering a blank body with no tab selected.
 */
export const EVAL_SUITE_TABS = ['overview', 'cases', 'runs'] as const
export type EvalSuiteTab = (typeof EVAL_SUITE_TABS)[number]

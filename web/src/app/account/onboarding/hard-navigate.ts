/**
 * Full-document navigation out of the onboarding wizard.
 *
 * Deliberately NOT router.replace(): every wizard → dashboard hop must reach
 * the server fresh. The client router cache can hold an RSC payload for
 * /account captured while onboarding was still incomplete — i.e. the
 * (dashboard)/layout.tsx redirect BACK to /account/onboarding — and replaying
 * that stale redirect after the completion stamp produced an unbreakable
 * client-side ping-pong between the two routes (only a new window escaped it).
 * A document navigation bypasses the router cache entirely, so the layout
 * re-reads member.onboarding_completed_at and the loop is structurally
 * impossible. location.replace (not assign) keeps the wizard out of history.
 *
 * Lives in its own module so jsdom tests can mock it — window.location
 * navigation is unimplemented in jsdom.
 */
export function hardNavigate(path: string): void {
  window.location.replace(path)
}

/**
 * Headers pinning an onboarding API call to the SAME workspace resolution the
 * document navigations use (workspace cookie → first membership) — NOT the
 * desktop multi-window localStorage pin. The workspace-fetch interceptor
 * injects `x-workspace-id` from localStorage on /api/ requests, but the
 * (dashboard) layout and the onboarding page guard never see that header; if
 * the two resolutions land on different member rows (e.g. an invited user
 * whose workspace cookie lapsed while localStorage persisted), the wizard's
 * "already completed" decision would disagree with the layout's redirect
 * forever — a full-page-load variant of the redirect loop. An explicitly
 * present EMPTY header stops the interceptor from injecting (it skips when the
 * header already exists) and reads as absent on the server
 * (`fromHeader || fromCookie`), so every wizard-side decision is made about
 * the exact workspace the documents gated on.
 */
export const DOCUMENT_SCOPE_HEADERS = { 'x-workspace-id': '' } as const

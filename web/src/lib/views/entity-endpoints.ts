import type { ViewEntityType } from './types'

/**
 * Maps each entity type to its PATCH-by-id endpoint. Used by:
 *   - `UnifiedViewLayout.patchItem` for inline row edits
 *   - `UnifiedViewLayout.handleMoveItem` for board DnD
 * so both paths share one source of truth.
 *
 * Returns null for entities that don't expose a single-record PATCH endpoint
 * (email threads are patched via a different API shape).
 */
export const ENTITY_ENDPOINTS: Record<ViewEntityType, (id: string) => string | null> = {
  agent: id => `/api/account/agents/${id}`,
  skill: id => `/api/account/skills/${id}`,
  action: id => `/api/account/actions/${id}`,
  project: id => `/api/account/projects/${id}`,
  initiative: id => `/api/account/initiatives/${id}`,
  capture: id => `/api/account/captures/${id}`,
  contact: id => `/api/account/contacts/${id}`,
  company: id => `/api/account/companies/${id}`,
  document: id => `/api/account/documents/${id}`,
  email_thread: id => `/api/account/email/threads/${id}`,
  flow: id => `/api/account/flows/${id}`,
  sequence: id => `/api/account/sequences/${id}`,
  // PATCH here takes name / purpose / policy / status (updateList), which is
  // what an inline rename or a board drag onto another purpose column needs.
  prospect_list: id => `/api/account/prospecting/lists/${id}`,
  prospect_list_entry: id => `/api/account/prospecting/entries/${id}`,
  eval_suite: id => `/api/account/evals/suites/${id}`,
  eval_case: id => `/api/account/evals/cases/${id}`,
  // A RUN HAS NO PATCH. It is the immutable record of one execution against
  // one prompt hash — nothing about it is a field a person sets — so its REST
  // surface is GET and nothing else. Returning null here is what makes every
  // inline-edit and board-drag path on a run row a no-op by construction
  // rather than a 405 the user sees after an optimistic update rolls back.
  eval_run: () => null,
  // Takes `confirmation` and refuses every other field — a claim's text, type
  // and confidence are extraction output, not row-editable properties. This is
  // also the write path behind the claim board's drag (Suggested ⇄ Confirmed).
  claim: id => `/api/account/claims/${id}`,
}

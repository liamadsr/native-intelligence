/**
 * Proposals only the person can apply (always-on safety fixes).
 *
 * An `mcp_call` proposal (change_type mcp_call, entity_type external; the live
 * agent stages them with propose_mcp_call) runs a tool on a connected app as
 * the person when applied (apply-engine.ts mcpCall → callToolByServerId). Its
 * tool name is the remote one, not `mcp__*`, so the outward gate never sees
 * it, and accept_proposal / settle_card reach unattended loops, flow runs and
 * chats alike. So the model never applies one: accept_proposal and settle_card
 * refuse it as they refuse an approval card, and only the person's own click
 * (the card's Accept, PATCH /api/account/attention-items with actor 'person',
 * or Apply in the capture) applies it.
 *
 * The apply engine has no calendar-event proposal (handlers in
 * apply-engine.ts), so there is nothing calendar-shaped to add here.
 *
 * Auto-apply (the live agent's and Triage's) is untouched: auto-apply-gate.ts
 * stages mcp_call for a human unless the person turned on allow_external in
 * their trust policy, an explicit standing choice of theirs.
 */
export function proposalNeedsPerson(change: { change_type?: string | null } | null | undefined): boolean {
  return change?.change_type === 'mcp_call'
}

/** What the model reads when it tries to apply one. */
export const PROPOSAL_PERSON_ONLY_NOTE =
  "That proposal runs a tool in a connected app outside Native Intelligence, so only the person can accept it: on its card, or with Apply in the capture. Don't accept it; tell them it is waiting for them."

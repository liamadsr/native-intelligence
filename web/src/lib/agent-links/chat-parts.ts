/**
 * Agents talking to agents in each owner's chat (agent links phase D): the
 * parts the server writes into an owner's home thread about a link, read here
 * for the chat to draw. The same parts go to both owners, each from their own
 * side, so nothing here says who asked whom.
 *
 *   data-ask-card + `agent_link`   a held call the other person's agent asked
 *                                  for: the ordinary ask card, with the link
 *                                  it came over riding along (the approval's
 *                                  context.agentLink, approvals.ts askAtHome)
 *                                  so the chat names the other agent above
 *                                  the card and opens the conversation.
 *   data-agent-link-activity       one exchange between the two agents, in one
 *                                  line: what happened, with whom, how many
 *                                  messages. The server rewrites the same part
 *                                  as the exchange grows.
 *
 * Both open the link's conversation as a card (the `agent_link` page kind,
 * src/lib/chat-cards/pages.ts), on the exchange they are about when they
 * name one.
 *
 * Client-safe and pure: a part is data, so every field is checked.
 */
import type { AgentLinkActivityPartData, AgentLinkCardContext } from './views'

export { AGENT_LINK_ACTIVITY_PART_TYPE, type AgentLinkActivityPartData } from './views'

/** Which link a part is about: enough to say it and to open the conversation. */
export interface AgentLinkRef {
  /** agent_link.id */
  link_id: string
  /** The other person, as the owner knows them. */
  peer_name: string
  /** The workspace their agent answers from, when it is known. */
  workspace_name: string | null
  /** The exchange the part is about, to open the card on. */
  exchange_id?: string
}

/** A `data-ask-card` part's `agent_link` field: the link a held call came over. */
export type AgentLinkAskData = AgentLinkRef

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuid = (v: unknown): string | null => (typeof v === 'string' && UUID_RE.test(v) ? v : null)
const text = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null
  const t = v.replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, max) : null
}
const iso = (v: unknown): string | null => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : null)

/** The link a part names, or null when it names none (or a malformed one). */
export function agentLinkRef(value: unknown): AgentLinkRef | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const linkId = uuid(v.link_id)
  const name = text(v.peer_name, 80)
  if (!linkId || !name) return null
  const exchangeId = uuid(v.exchange_id)
  return { link_id: linkId, peer_name: name, workspace_name: text(v.workspace_name, 80), ...(exchangeId ? { exchange_id: exchangeId } : {}) }
}

/** A held call's context.agentLink as its part carries it, or null when the approval names no link. */
export function agentLinkAskData(context: AgentLinkCardContext | null | undefined): AgentLinkAskData | null {
  if (!context) return null
  return agentLinkRef({ link_id: context.linkId, peer_name: context.peerName, workspace_name: context.workspaceName })
}

/** An exchange's activity part's data, or null when it isn't one. */
export function agentLinkActivityPartData(value: unknown): AgentLinkActivityPartData | null {
  if (!value || typeof value !== 'object') return null
  const d = value as Record<string, unknown>
  const linkId = uuid(d.link_id)
  const exchangeId = uuid(d.exchange_id)
  const peer = d.peer && typeof d.peer === 'object' ? (d.peer as Record<string, unknown>) : null
  const name = text(peer?.name, 80)
  const summary = text(d.summary, 240)
  const lastAt = iso(d.last_at)
  if (!linkId || !exchangeId || !name || !summary || !lastAt) return null
  const count = typeof d.count === 'number' && Number.isInteger(d.count) && d.count > 0 ? Math.min(d.count, 999) : 1
  return { link_id: linkId, peer: { name, workspace_name: text(peer?.workspace_name, 80) }, exchange_id: exchangeId, summary, count, last_at: lastAt }
}

/** The activity part's link, as the line and the card open it. */
export function activityLinkRef(data: AgentLinkActivityPartData): AgentLinkRef {
  return { link_id: data.link_id, peer_name: data.peer.name, workspace_name: data.peer.workspace_name, exchange_id: data.exchange_id }
}

/** "Dana Kim’s agent" */
export function peerAgentName(name: string): string {
  return `${name}’s agent`
}

/** Whose agent, and from where, in one line: "Dana Kim’s agent · Northwind". */
export function agentLinkLine(ref: Pick<AgentLinkRef, 'peer_name' | 'workspace_name'>): string {
  return [peerAgentName(ref.peer_name), ref.workspace_name].filter(Boolean).join(' · ')
}

/** The activity card's second line: "Dana Kim’s agent · Northwind · 4 messages · 1:15 PM". */
export function agentLinkActivityMeta(data: AgentLinkActivityPartData, time: string): string {
  return [agentLinkLine(activityLinkRef(data)), data.count > 1 ? `${data.count} messages` : null, time].filter(Boolean).join(' · ')
}

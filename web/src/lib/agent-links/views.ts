/**
 * Agent-to-agent links as the app's screens read them (migration 435; the
 * contracts are /mnt/project-files/agent-links/contracts.md): what
 * /api/account/agent-links and its exchanges route answer.
 *
 * Pure and client-safe.
 */

export const AGENT_LINK_STATES = ['requested', 'active', 'declined', 'expired', 'ended'] as const
export type AgentLinkState = (typeof AGENT_LINK_STATES)[number]

export const AGENT_LINK_EXCHANGE_STATES = ['open', 'done', 'capped'] as const
export type AgentLinkExchangeState = (typeof AGENT_LINK_EXCHANGE_STATES)[number]

export const AGENT_LINK_MESSAGE_KINDS = ['ask', 'answer', 'decline', 'note'] as const
export type AgentLinkMessageKind = (typeof AGENT_LINK_MESSAGE_KINDS)[number]

/** Most messages one exchange holds before both agents stop (decision: no loops). */
export const AGENT_LINK_EXCHANGE_MAX_MESSAGES = 8
/** Most exchanges a link starts in a day. */
export const AGENT_LINK_EXCHANGES_PER_DAY = 20
/** Most link requests one person may have waiting at once. */
export const AGENT_LINK_PENDING_MAX = 5
/** How long a request waits for the other person. */
export const AGENT_LINK_REQUEST_TTL_MS = 7 * 24 * 60 * 60_000

export interface LinkPeer {
  /** Null for an email request to someone not on Dial8 yet (never says whether they are). */
  userId: string | null
  /** Their name as their workspace shows it, else the name the requester typed. */
  name: string
  /** The agent's own name is kept on each person's device, so the server doesn't know it. */
  agentName: string | null
  /** The workspace their agent answers from; null until they accept. */
  workspaceName: string | null
  /** In the workspace this list was read in. */
  sameWorkspace: boolean
}

export interface LinkView {
  id: string
  state: AgentLinkState
  /** Who asked: me (outgoing) or them (incoming). */
  direction: 'outgoing' | 'incoming'
  peer: LinkPeer
  /** My agent_guest row for them: what their agent may ask mine (People's person page). Null on a request to me I haven't accepted. */
  myHalfGuestId: string | null
  /** What my agent may ask theirs, as one read-only line ("when they’re free, and holding a time"); null until active. */
  theirHalf: { summary: string } | null
  outside: boolean
  requestedAt: string
  acceptedAt: string | null
  expiresAt: string | null
  lastExchangeAt: string | null
}

/** A teammate in this workspace who could be linked: not me, not already linked or asked. */
export interface LinkCandidate {
  userId: string
  name: string
  agentName: string | null
}

export interface ExchangeMessageView {
  id: string
  from: 'me' | 'them'
  kind: AgentLinkMessageKind
  body: string
  at: string
}

export interface ExchangeView {
  id: string
  topic: string
  state: AgentLinkExchangeState
  startedBy: 'me' | 'them'
  messages: ExchangeMessageView[]
  createdAt: string
  closedAt: string | null
}

/** The chat part one exchange leaves in each owner's home thread (phase B writes it, phase D draws it). */
export const AGENT_LINK_ACTIVITY_PART_TYPE = 'data-agent-link-activity' as const

export interface AgentLinkActivityPartData {
  link_id: string
  peer: { name: string; workspace_name: string | null }
  exchange_id: string
  /** What happened, in plain words ("Told Ava you're free Thu 2:00 and Fri 10:00"). */
  summary: string
  count: number
  last_at: string
}

/** On a held call's card (tool_approval context): the link it came over, for the line over the card. */
export interface AgentLinkCardContext {
  linkId: string
  peerName: string
  workspaceName: string | null
}

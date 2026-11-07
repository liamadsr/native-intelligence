/**
 * The agent's inbox (migration 336; docs/plans/always-on-agent.md §5, A6):
 * one `agent_event` row per thing that happened for one person in one
 * workspace, routed by ./router.ts to ignore, quiet, turn or notify.
 *
 * This file is the vocabulary: the sources, kinds, states and outcomes the
 * table checks (migration 336 lists the same), the dedupe keys every producer
 * uses, and the facts a row may carry. Client-safe (no server imports).
 */

export const AGENT_EVENT_SOURCES = ['email', 'capture', 'meeting', 'work', 'mention', 'digest', 'reminder', 'crm'] as const
export type AgentEventSource = (typeof AGENT_EVENT_SOURCES)[number]

/**
 * Every kind the table accepts. `email.suspicious` is written by
 * markThreadTrust (A5's email.trust, once it enforces) and `work.approval` by
 * createToolApproval when a new approval card is held (A5 slice 3). The last
 * four (migration 401, docs/plans/retire-notifications-page.md) are notices
 * the notice tap (./notice.ts) records: a teammate's change to your things, a
 * reminder you set coming due, a contact's follow-up date, a sequence that
 * failed. `pr.changed` (migration 443, docs/plans/now-file.md "PR updates")
 * is a pull request the person's own work is linked to that was merged,
 * closed or reopened, or whose checks fail on their coding run's branch
 * (./pr-changed.ts). `connection.needs_reconnect` (migration 451, GEN-1171)
 * is a connected app whose sign-in expired for good
 * (src/lib/mcp-client/expired-notice.ts). `quote.received` (migration 458,
 * roadmap B1) is a customer's quote from the business's website form
 * (src/lib/customers/receive.ts). `job.paid` (migration 459, roadmap C2) is a
 * customer paying a payment link for a quote or job (src/lib/payments/paid.ts):
 * the owner was texted at once, so it waits quiet unless that text didn't go out.
 */
export const AGENT_EVENT_KINDS = [
  'email.drafted',
  'email.needs_reply',
  'email.suspicious',
  'capture.processed',
  'meeting.soon',
  'work.needs_input',
  'work.needs_review',
  'work.approval',
  'work.done',
  'work.failed',
  'mention',
  'activity',
  'reminder.due',
  'contact.followup_due',
  'sequence.failed',
  'meeting.changed',
  'email.arrived',
  'pr.changed',
  'connection.needs_reconnect',
  'quote.received',
  'job.paid',
] as const
export type AgentEventKind = (typeof AGENT_EVENT_KINDS)[number]

export const AGENT_EVENT_STATES = ['new', 'routed', 'delivered', 'expired'] as const
export type AgentEventState = (typeof AGENT_EVENT_STATES)[number]

export const AGENT_EVENT_OUTCOMES = ['ignore', 'quiet', 'turn', 'notify'] as const
export type AgentEventOutcome = (typeof AGENT_EVENT_OUTCOMES)[number]

/** The source each kind is filed under. */
export const KIND_SOURCE: Record<AgentEventKind, AgentEventSource> = {
  'email.drafted': 'email',
  'email.needs_reply': 'email',
  'email.suspicious': 'email',
  'capture.processed': 'capture',
  'meeting.soon': 'meeting',
  'meeting.changed': 'meeting',
  'email.arrived': 'email',
  'work.needs_input': 'work',
  'work.needs_review': 'work',
  'work.approval': 'work',
  'work.done': 'work',
  'work.failed': 'work',
  mention: 'mention',
  activity: 'mention',
  'reminder.due': 'reminder',
  'contact.followup_due': 'crm',
  'sequence.failed': 'work',
  // The source check (401) has no GitHub source: a PR is the person's work.
  'pr.changed': 'work',
  // Nor a connection one: a connected app the agent works through.
  'connection.needs_reconnect': 'work',
  // A customer's quote is the CRM's.
  'quote.received': 'crm',
  // A customer's payment is the CRM's.
  'job.paid': 'crm',
}

/**
 * The notification types the notice tap records, and the kind each becomes
 * (docs/plans/retire-notifications-page.md, "What each type becomes"). A
 * type not here records nothing: its producer writes its own event (the work
 * recorder, the meeting-soon and digest notices), or it is no news (a
 * loop's skip). Client-safe, so createNotification reads it without loading
 * the recorder.
 */
export const NOTICE_EVENT_KIND: Readonly<Record<string, AgentEventKind>> = {
  comment_reply: 'mention',
  comment_added: 'mention',
  action_assigned: 'mention',
  capture_shared: 'mention',
  action_unassigned: 'activity',
  action_status_changed: 'activity',
  decision_confirmed: 'activity',
  project_status_changed: 'activity',
  cycle_started: 'activity',
  reminder: 'reminder.due',
  contact_followup_due: 'contact.followup_due',
  workspace_merged: 'activity',
}

/** The kinds a notification stands behind: its notice already went out, and its row's ref is that notification. */
export const NOTICE_KINDS: ReadonlySet<AgentEventKind> = new Set(['mention', 'activity', 'reminder.due', 'contact.followup_due', 'sequence.failed'])

/** The kind a notification of this type records, or null. Pure. */
export function noticeEventKind(type: string): AgentEventKind | null {
  return Object.prototype.hasOwnProperty.call(NOTICE_EVENT_KIND, type) ? NOTICE_EVENT_KIND[type] : null
}

/** "Waiting on you": a question, a review, an approval. */
export const WAITING_KINDS: ReadonlySet<AgentEventKind> = new Set(['work.needs_input', 'work.needs_review', 'work.approval'])

/** What happened to a pull request (a `pr.changed` event's `prState`). */
export const PR_CHANGE_STATES = ['merged', 'closed', 'reopened', 'ci_failed'] as const
export type PrChangeState = (typeof PR_CHANGE_STATES)[number]

/** The table's caps (migration 336). */
export const AGENT_EVENT_FACTS_MAX_BYTES = 4000
export const AGENT_EVENT_DEDUPE_KEY_MAX = 300
/** A title or subject in the facts. */
export const AGENT_EVENT_TITLE_MAX = 80

/** How long before a meeting the meeting-soon producer and the router's notify rule look (decision Defaults: under 30 min). */
export const MEETING_SOON_WINDOW_MS = 30 * 60_000

/**
 * The templated facts a row may carry: a clipped title or subject (never a
 * body), counts and flags. Each producer fills the keys its kind needs.
 */
export interface AgentEventFacts {
  /** A clipped title: a work item's, a meeting's, a capture's. Never a mail subject (no stored mail). */
  title?: string
  /** A mail event: the sender's address (never a display name, subject or body). */
  from?: string
  /** A mail event: the thread's linked CRM contact (a pointer). */
  contactId?: string
  /** The recorder already sent this event's notice (a work event). */
  notified?: boolean
  /** A failure whose report landed in the home thread (a chat helper's, work/chat-report.ts): told there. */
  toldHome?: boolean
  /** The work item's kind (tracked_job.kind), for a work event. */
  workKind?: string
  /** The work item's area. */
  area?: string
  /** A meeting-soon event: whether a prep for it exists. */
  prepReady?: boolean
  /**
   * A meeting-soon event: Jev's meeting.needs_prep check skipped this
   * meeting's prep for this start (a lunch, a drive). Read back by the next
   * passes so the skip sticks (meeting-soon.ts recordedPrepSkips).
   */
  prepSkipped?: boolean
  /** A meeting-soon event: what it is about (a provider calendar event, the desktop's local one, or a pending capture). */
  meetingRef?: 'capture' | 'local_calendar_event' | 'calendar_event'
  /**
   * A meeting-soon event: the meeting's stable key (meetingKey: a hash of its
   * source and id), shared with its prep helper's idempotency key, so a prep
   * that finishes can find the meeting's row.
   */
  prepKey?: string
  /** A notice's event (./notice.ts): the notification type that stands in for it. */
  notificationType?: string
  /** A notice's event: what the notification points at (an action, a capture, a contact…), so the agent can open it. */
  targetType?: string
  targetId?: string
  /** A mail event: why no draft was written (cap hit, gate escalated, …). */
  reason?: string
  /**
   * A mail event: the sender is someone the person knows (a CRM contact, or an
   * address they have sent mail to; ./known-senders.ts). Liam's rule
   * (2026-10-15): such a thread needing a reply reaches the person in the home
   * thread within minutes; anything else waits for the review pile and the
   * digest.
   */
  known?: boolean
  /**
   * A mail event: email.trust marked the thread at its latest message (an
   * injection thread still drafts). Never a turn: neither the known-sender
   * rule nor Jev raises it.
   */
  flagged?: boolean
  /** An approval event: the door that held the call ('chat', 'loop', 'mcp'). */
  door?: string
  /** A processed meeting: the live agent's questions nobody answered in the call (unanswered ask_user). */
  openAsks?: number
  /** A processed meeting: the proposals the live agent staged that still wait for review. */
  pendingProposals?: number
  /**
   * A processed meeting that is its owner's first while getting started
   * (docs/plans/getting-started-skill.md): the router makes it a turn, so the
   * main agent shows them what their capture pulled out.
   */
  firstRun?: boolean
  /**
   * A meeting-changed event (./meeting-changes.ts): the provider marked it
   * cancelled, it is no longer on the calendar at its time (cancelled, or
   * moved past the watch window: can't tell which), or it moved.
   */
  change?: 'cancelled' | 'removed' | 'moved'
  /** A moved meeting's new start (ISO); occurs_at keeps the old one. */
  movedTo?: string
  /** A meeting-changed event: how many other people were invited. */
  attendeeCount?: number
  /** An arrived email (email.understand, docs/plans/email-through-the-agent.md E2): what it is, when Jev is sure. */
  emailKind?: 'conversation' | 'meeting' | 'receipt_or_bill' | 'delivery' | 'account_or_security' | 'newsletter_or_promo' | 'other_notice'
  /** An arrived email: Jev's clear answer to "should the person be told soon?" (absent: unsure). */
  shouldKnow?: boolean
  /** An arrived email: Jev's clear answer to "does it ask them for something only they can answer?" (absent: unsure). */
  needsInput?: boolean
  /** A pull request's change: its repo ("owner/name", GitHub's own characters only). Never its title or body. */
  repo?: string
  /** A pull request's change: its number. */
  prNumber?: number
  /** A pull request's change: what happened to it. */
  prState?: PrChangeState
  /** A pull request's change: the linked action's identifier (ENG-42), else its id. */
  action?: string
  /** A connection's expiry: the app's catalog id (connect takes it), when it is a catalog app. */
  catalogId?: string
}

/** The dedupe keys every producer shares (unique per workspace and user). */
export const agentEventKey = {
  /** A work item's move; a question can be asked more than once, so its key carries the move's instant. */
  work: (workItemId: string, status: string, atIso?: string | null) =>
    status === 'needs_input' && atIso ? `work:${workItemId}:needs_input:${Date.parse(atIso)}` : `work:${workItemId}:${status}`,
  /**
   * A finish collapses to one row per item per local day: a recurring routine
   * (each fire its own work item, so keyed on its flow) or an item done again
   * says "finished" once a day, never once a fire.
   */
  workDone: (itemKey: string, localDate: string) => `work:${itemKey}:done:${localDate}`,
  emailDraft: (draftId: string) => `email:draft:${draftId}`,
  emailNeedsReply: (accountId: string, threadId: string, messageId: string | null | undefined) =>
    `email:${accountId}:${threadId}:${messageId || 'latest'}`,
  captureProcessed: (captureId: string) => `capture:${captureId}:processed`,
  /**
   * A meeting starting soon, keyed on its stable key and start. Its prep being
   * ready is a key of its own (`…:prep`): the row first seen without prep stays
   * as it was (rows are written once), and the moment prep is ready a second
   * row lands and routes on its own (the "prep is ready" notice).
   */
  meetingSoon: (meetingKey: string, startIso: string, prepReady = false) => `meeting:${meetingKey}:${startIso}${prepReady ? ':prep' : ''}`,
  /** A meeting's change, told once: keyed on the start it had, what happened and (moved) where to. */
  /** An arrived email, understood once per message (E2). */
  emailArrived: (accountId: string, threadId: string, messageId: string | null | undefined) =>
    `email:arrived:${accountId}:${threadId}:${messageId || 'latest'}`,
  meetingChanged: (meetingKey: string, fromStartIso: string, change: 'cancelled' | 'removed' | 'moved', toStartIso?: string | null) =>
    `meeting:${meetingKey}:${fromStartIso}:changed:${change}${change === 'moved' && toStartIso ? `:${toStartIso}` : ''}`,
  approval: (approvalId: string) => `approval:${approvalId}`,
  emailSuspicious: (accountId: string, threadId: string, messageId: string | null | undefined) =>
    `email:suspicious:${accountId}:${threadId}:${messageId || 'latest'}`,
  mention: (notificationId: string) => `mention:${notificationId}`,
  /** Any other notice's event: one per notification (a notification maps to one kind). */
  notice: (notificationId: string) => `notice:${notificationId}`,
  /**
   * A pull request's change, told once: keyed on the PR, its new state and
   * what pins that change (the instant it happened, or a CI failure's commit,
   * so a burst of check events for one commit is one row).
   */
  prChanged: (repoFullName: string, prNumber: number, state: PrChangeState, pin: string) =>
    `pr:${repoFullName.toLowerCase()}#${prNumber}:${state}:${pin}`,
  /** A connected app's sign-in expired, told once per expiry: keyed on the instant it was marked. */
  connectionNeedsReconnect: (serverId: string, markedAtIso: string) => `connection:${serverId}:needs_reconnect:${Date.parse(markedAtIso)}`,
  /** A customer's quote, told once. */
  quoteReceived: (quoteId: string) => `quote:${quoteId}:received`,
  /** A payment request paid, told once. */
  jobPaid: (paymentRequestId: string) => `payment:${paymentRequestId}:paid`,
}

/** The Inngest event every producer sends after writing rows, once per person. */
export const AGENT_EVENT_CREATED = 'agent/event.created'

export interface AgentEventCreatedData {
  workspaceId: string
  userId: string
  /** `<workspaceId>:<userId>`: the router's debounce and concurrency key. */
  personKey: string
}

export function personKey(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`
}

export function isAgentEventKind(value: unknown): value is AgentEventKind {
  return typeof value === 'string' && (AGENT_EVENT_KINDS as readonly string[]).includes(value)
}

/** One row as the router and the away section read it. */
export interface AgentEventRow {
  id: string
  workspace_id: string
  user_id: string
  source: AgentEventSource
  kind: AgentEventKind
  priority: number
  occurs_at: string
  expires_at: string | null
  ref_type: string | null
  ref_id: string | null
  facts: AgentEventFacts
  dedupe_key: string
  state: AgentEventState
  outcome: AgentEventOutcome | null
  notification_id: string | null
  created_at: string
}

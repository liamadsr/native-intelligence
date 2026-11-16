/**
 * The owner-scoped event triggers (email_received, chat_message,
 * document_created, record_created, contact_created, page_changed): who a
 * fire is for, what never fires, and the cap.
 *
 * OWNER SCOPING. Unlike quote_received (workspace-wide), each of these fires
 * a loop only when its OWNER (flow.created_by, who it runs as) could see the
 * item: their own mailbox (the matcher filters on created_by), a channel they
 * can read, a document visible to them, a table they read, a contact they
 * see. Checked again at every fire with the canonical rules restated for a
 * service-role client (entity-fences.ts: the team chat channel fence, and
 * entity_refs_hidden, the SQL rule the graph's policies use, for documents;
 * visible_data_table_ids for tables; contact_visible_to for contacts), so a
 * loop whose owner lost access is skipped. A page watch is the owner's in a
 * different way: the page is public, but which page they watch and what they
 * asked about is theirs, so its runs are private to them like the others' and
 * a change fires only the one loop it belongs to (flowDispatchOnPageChanged).
 *
 * LOOP GUARD. Items made by agents, bots or automations never fire:
 *   - mail: the emitter takes only mail from someone else (never the
 *     person's own address, so never what the app sent from their mailbox);
 *   - chat: only a person's message (author_kind 'member', kind 'message')
 *     fires. The one writer of a person's message is the post route, which
 *     only a signed-in person reaches; an agent's reply (agent-turn.ts) is
 *     written as 'agent' and no loop step can post into team chat;
 *   - documents: only the documents route's plain create emits (an agent's
 *     create_document, reference ingest and canon templates never do);
 *   - records: only a form's submission and a person's own rows emit
 *     (emit-record-created.ts); a row an agent, an import, a sync or a
 *     loop's step wrote never does;
 *   - contacts: only a public intake's new contact (upsertCustomerContact,
 *     when it made one) and a person's own (the contacts route) emit
 *     (emit-contact-created.ts); a contact an agent, an import, a sync, a
 *     meeting's participants, prospecting or a new member made never does;
 *   - pages: only the watch pass emits (src/lib/flows/page-watch/), after
 *     reading the public page itself; nothing a loop's step does writes a
 *     change row.
 *
 * COST. An event loop on a busy channel could start hundreds of runs: each
 * flow runs at most EVENT_FIRE_CAP_PER_DAY times in any 24 hours; the fires
 * past it are ledgered as skipped (at most one row an hour, like the kill
 * switch's) with EVENT_CAP_SKIP_REASON, which the run history shows.
 *
 * Template variables carry ids only, never text someone else wrote: a step
 * reads the item with a tool (read_email, read_team_chat_message,
 * get_document, query_rows, get_contact, get_page_change) as the owner. A
 * form's row reaches it fenced as untrusted (data_row.from_form), a page's
 * new lines in the WEB fence; a page loop's `{{trigger.page_url}}` is the
 * owner's own setting.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isContactVisibleTo } from '@/lib/crm/contact-visibility'
import { hiddenGraphRefs, visiblePrivateKindIds } from '@/lib/knowledge/entity-fences'
import { AGENT_PAUSED_REASON } from '@/lib/work/agent-paused'
import type { ChatMessageTriggerConfig, ContactCreatedTriggerConfig, FlowWithSecrets, OwnerEventTriggerType, RecordCreatedTriggerConfig } from './types'

/** Most fires one event loop runs in any 24 hours. */
export const EVENT_FIRE_CAP_PER_DAY = 50
/** The skip's line in the run history once a loop hit the cap. */
export const EVENT_CAP_SKIP_REASON = `Skipped: this loop already ran ${EVENT_FIRE_CAP_PER_DAY} times in the last 24 hours, the most a loop that starts on new mail, chat messages or documents may run`
/** While capped, at most one skip row per flow per this window. */
export const EVENT_CAP_SKIP_LEDGER_WINDOW_MS = 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Whether this flow may run another event fire now: 'ok', 'capped' (ledger
 * the skip) or 'capped_quiet' (capped, and a skip row in the last hour
 * already says so). Skip rows (this cap's, the kill switch's) are not runs.
 * Fails OPEN on a read error, like the dormancy gate: a transient failure
 * never silently drops a fire.
 *
 * Accepted overshoot: the count here and the run's flow_run row (written when
 * the run ends) are not one atomic step, so fires running side by side can
 * each see room under the cap. The dispatchers run at most 2 at a time per
 * workspace (their Inngest concurrency), so a loop can go over the cap by up
 * to 2 runs a day. That is accepted: the cap guards cost, not correctness,
 * and a lock or a counter row would cost more than the runs it saves.
 */
export async function eventFireCapState(
  supabase: SupabaseClient,
  flowId: string,
  now: number = Date.now(),
  cap: number = EVENT_FIRE_CAP_PER_DAY,
): Promise<'ok' | 'capped' | 'capped_quiet'> {
  try {
    const { data, error } = await supabase
      .from('flow_run')
      .select('fired_at, response_body_preview')
      .eq('flow_id', flowId)
      .gte('fired_at', new Date(now - DAY_MS).toISOString())
      // Runs are capped and skip rows are hourly at most: this many always covers a day.
      .limit(cap * 4)
    if (error || !Array.isArray(data)) return 'ok'
    const rows = data as Array<{ fired_at?: string | null; response_body_preview?: string | null }>
    const runs = rows.filter((r) => r.response_body_preview !== EVENT_CAP_SKIP_REASON && r.response_body_preview !== AGENT_PAUSED_REASON).length
    if (runs < cap) return 'ok'
    const hourAgo = now - EVENT_CAP_SKIP_LEDGER_WINDOW_MS
    const recentSkip = rows.some((r) => r.response_body_preview === EVENT_CAP_SKIP_REASON && Date.parse(r.fired_at ?? '') >= hourAgo)
    return recentSkip ? 'capped_quiet' : 'capped'
  } catch {
    return 'ok'
  }
}

// ── Chat ────────────────────────────────────────────────────────────────────

/** A team chat message as the dispatcher reads it (ids and flags only, never its words). */
export interface ChatMessageFacts {
  id: string
  channel_id: string
  workspace_id: string
  author_kind: 'member' | 'agent'
  author_member_id: string | null
  thread_root_id: string | null
  mentions: string[]
  kind: 'message' | 'call'
  deleted: boolean
}

/** Read a message's facts (service role). Null when it is gone or the read fails. */
export async function loadChatMessageFacts(supabase: SupabaseClient, messageId: string): Promise<ChatMessageFacts | null> {
  const { data, error } = await supabase
    .from('team_chat_message')
    .select('id, channel_id, workspace_id, author_kind, author_member_id, thread_root_id, mentions, kind, deleted_at')
    .eq('id', messageId)
    .maybeSingle()
  if (error || !data) return null
  const r = data as Record<string, unknown>
  return {
    id: r.id as string,
    channel_id: r.channel_id as string,
    workspace_id: r.workspace_id as string,
    author_kind: r.author_kind === 'agent' ? 'agent' : 'member',
    author_member_id: (r.author_member_id as string | null) ?? null,
    thread_root_id: (r.thread_root_id as string | null) ?? null,
    mentions: Array.isArray(r.mentions) ? (r.mentions as unknown[]).filter((m): m is string => typeof m === 'string') : [],
    kind: r.kind === 'call' ? 'call' : 'message',
    deleted: r.deleted_at != null,
  }
}

/**
 * Why a team chat message fires no loop at all (the loop guard), or null.
 * Only a person's own written message fires: never an agent's reply, a call's
 * row in the conversation, or a message deleted since.
 */
export function chatMessageSkipReason(msg: Pick<ChatMessageFacts, 'author_kind' | 'author_member_id' | 'kind' | 'deleted'>): string | null {
  if (msg.author_kind !== 'member' || !msg.author_member_id) return 'written by an agent'
  if (msg.kind !== 'message') return 'a call, not a message'
  if (msg.deleted) return 'deleted'
  return null
}

/**
 * Does a chat_message loop take this message, given its owner's member id in
 * the workspace? Pure; read access is checked separately.
 *   - a channel loop takes its channel's messages (thread replies too);
 *   - "any channel" is valid only with mentions_only;
 *   - mentions_only takes a message that @mentions the owner, never the
 *     owner's own; without it the owner's own messages count.
 */
export function chatFlowMatches(
  cfg: Partial<ChatMessageTriggerConfig> | null | undefined,
  msg: Pick<ChatMessageFacts, 'channel_id' | 'author_member_id' | 'mentions'>,
  ownerMemberId: string | null,
): boolean {
  if (!cfg || !ownerMemberId) return false
  const channel = cfg.channel_id ?? null
  if (channel !== null && channel !== msg.channel_id) return false
  if (channel === null && cfg.mentions_only !== true) return false
  if (cfg.mentions_only === true) {
    return msg.author_member_id !== ownerMemberId && msg.mentions.includes(ownerMemberId)
  }
  return true
}

/** Each owner's member id in the workspace (a removed member has none). */
async function ownerMemberIds(supabase: SupabaseClient, workspaceId: string, ownerUserIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ownerUserIds.length === 0) return out
  const { data, error } = await supabase.from('member').select('id, user_id').eq('workspace_id', workspaceId).in('user_id', ownerUserIds)
  if (error || !Array.isArray(data)) return out
  for (const row of data as Array<{ id?: string; user_id?: string }>) if (row.id && row.user_id) out.set(row.user_id, row.id)
  return out
}

/** Can this person read the channel (the team chat read rule, entity-fences.ts)? Fails closed. */
export async function ownerCanReadChannel(supabase: SupabaseClient, ownerUserId: string, channelId: string, workspaceId: string): Promise<boolean> {
  const visible = await visiblePrivateKindIds(supabase, 'team_chat_channel', ownerUserId, [channelId], workspaceId)
  return visible.has(channelId)
}

/**
 * The matched chat_message loops this message fires: its owner is still a
 * member, the loop takes the message (chatFlowMatches), and the owner can
 * read its channel now.
 */
export async function chatFlowsToFire(supabase: SupabaseClient, flows: FlowWithSecrets[], msg: ChatMessageFacts): Promise<FlowWithSecrets[]> {
  if (flows.length === 0 || chatMessageSkipReason(msg)) return []
  const owners = [...new Set(flows.map((f) => f.created_by).filter((id): id is string => typeof id === 'string' && !!id))]
  const members = await ownerMemberIds(supabase, msg.workspace_id, owners)
  const readable = new Map<string, boolean>()
  const out: FlowWithSecrets[] = []
  for (const flow of flows) {
    const owner = flow.created_by
    if (!owner) continue
    if (!chatFlowMatches(flow.trigger_config as Partial<ChatMessageTriggerConfig>, msg, members.get(owner) ?? null)) continue
    if (!readable.has(owner)) readable.set(owner, await ownerCanReadChannel(supabase, owner, msg.channel_id, msg.workspace_id))
    if (readable.get(owner)) out.push(flow)
  }
  return out
}

/**
 * A chat_message trigger's save-time check: a named channel must be one the
 * loop's owner can read in this workspace. Null when fine (or not a chat
 * trigger, or any channel).
 */
export async function chatTriggerChannelProblem(
  supabase: SupabaseClient,
  args: { workspaceId: string; ownerUserId: string; triggerType: string; config: unknown },
): Promise<string | null> {
  if (args.triggerType !== 'chat_message') return null
  const channel = ((args.config ?? {}) as Partial<ChatMessageTriggerConfig>).channel_id ?? null
  if (channel === null) return null
  return (await ownerCanReadChannel(supabase, args.ownerUserId, channel, args.workspaceId))
    ? null
    : "trigger_config.channel_id is not a channel the loop's owner can read in this workspace"
}

// ── Documents ───────────────────────────────────────────────────────────────

export interface DocumentFacts {
  id: string
  workspace_id: string
  status: string | null
  visibility: string | null
}

/** Read a document's facts (service role). Null when it is gone or the read fails. */
export async function loadDocumentFacts(supabase: SupabaseClient, documentId: string): Promise<DocumentFacts | null> {
  const { data, error } = await supabase.from('document').select('id, workspace_id, status, visibility').eq('id', documentId).maybeSingle()
  if (error || !data) return null
  const r = data as Record<string, unknown>
  return {
    id: r.id as string,
    workspace_id: r.workspace_id as string,
    status: (r.status as string | null) ?? null,
    visibility: (r.visibility as string | null) ?? null,
  }
}

/** Why a created document fires no loop, or null: it was deleted, archived or moved by the time the fire ran. */
export function documentSkipReason(doc: DocumentFacts | null, workspaceId: string): string | null {
  if (!doc || doc.workspace_id !== workspaceId) return 'deleted'
  if (doc.status !== 'active') return 'archived'
  return null
}

/**
 * Can this person see the document? The SQL rule the graph's policies use
 * (entity_refs_hidden, without the grant arm: an unattended run reads no
 * grant). A PRIVATE document fires no loop, even its own author's: a loop's
 * run reads no private document (CreateToolsOptions.omitPrivateCaptures), so
 * it could not read what fired it. Fails closed.
 */
export async function ownerCanSeeDocument(supabase: SupabaseClient, ownerUserId: string, doc: DocumentFacts): Promise<boolean> {
  if ((doc.visibility ?? 'workspace') === 'private') return false
  const hidden = await hiddenGraphRefs(supabase, [{ type: 'document', id: doc.id }], ownerUserId, doc.workspace_id, { grants: false })
  return !hidden.has(`document:${doc.id}`)
}

/** The matched document_created loops whose owner can see the document now. */
export async function documentFlowsToFire(supabase: SupabaseClient, flows: FlowWithSecrets[], doc: DocumentFacts): Promise<FlowWithSecrets[]> {
  const visible = new Map<string, boolean>()
  const out: FlowWithSecrets[] = []
  for (const flow of flows) {
    const owner = flow.created_by
    if (!owner) continue
    if (!visible.has(owner)) visible.set(owner, await ownerCanSeeDocument(supabase, owner, doc))
    if (visible.get(owner)) out.push(flow)
  }
  return out
}

// ── Records (a table's new rows) ────────────────────────────────────────────

export interface RecordFacts {
  id: string
  workspace_id: string
  table_id: string
  archived: boolean
  /** Nothing in it yet: no name and no value. */
  blank: boolean
  /** Its table is archived or gone. */
  table_archived: boolean
}

/** Read a row's facts (service role): ids and flags only, never its words. Null when it is gone or the read fails. */
export async function loadRecordFacts(supabase: SupabaseClient, rowId: string): Promise<RecordFacts | null> {
  const { data, error } = await supabase.from('data_row').select('id, workspace_id, table_id, title, custom_fields, archived_at').eq('id', rowId).maybeSingle()
  if (error || !data) return null
  const r = data as Record<string, unknown>
  const values = r.custom_fields && typeof r.custom_fields === 'object' ? Object.values(r.custom_fields as Record<string, unknown>) : []
  const filled = values.some((v) => v !== null && v !== '' && !(Array.isArray(v) && v.length === 0))
  const { data: table, error: tableError } = await supabase.from('data_table').select('id, archived_at').eq('id', r.table_id as string).maybeSingle()
  return {
    id: r.id as string,
    workspace_id: r.workspace_id as string,
    table_id: r.table_id as string,
    archived: r.archived_at != null,
    blank: !(typeof r.title === 'string' && r.title.trim()) && !filled,
    table_archived: !!tableError || !table || (table as { archived_at?: string | null }).archived_at != null,
  }
}

/**
 * Why a new row fires no loop at all, or null: gone, moved, archived (its
 * table too), not in the table the event named, or still blank (a person
 * added a row and typed nothing in it).
 */
export function recordSkipReason(row: RecordFacts | null, workspaceId: string, tableId: string): string | null {
  if (!row || row.workspace_id !== workspaceId) return 'deleted'
  if (row.table_id !== tableId) return 'in another table'
  if (row.archived || row.table_archived) return 'archived'
  if (row.blank) return 'still empty'
  return null
}

/**
 * Can this person read the table, without a grant? The database's own rule
 * (visible_data_table_ids, 520). An unattended run reads no grant, so a table
 * only shared with the owner fires nothing: its run could not read the row
 * that fired it. Fails closed.
 */
export async function ownerCanReadTable(supabase: SupabaseClient, ownerUserId: string, tableId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase.rpc('visible_data_table_ids', { p_ids: [tableId], p_user_id: ownerUserId, p_grants: false })
    return !error && Array.isArray(data) && data.includes(tableId)
  } catch {
    return false
  }
}

/** The matched record_created loops whose owner can read the row's table now. */
export async function recordFlowsToFire(supabase: SupabaseClient, flows: FlowWithSecrets[], row: Pick<RecordFacts, 'table_id'>): Promise<FlowWithSecrets[]> {
  const readable = new Map<string, boolean>()
  const out: FlowWithSecrets[] = []
  for (const flow of flows) {
    const owner = flow.created_by
    if (!owner) continue
    if ((flow.trigger_config as Partial<RecordCreatedTriggerConfig>).table_id !== row.table_id) continue
    if (!readable.has(owner)) readable.set(owner, await ownerCanReadTable(supabase, owner, row.table_id))
    if (readable.get(owner)) out.push(flow)
  }
  return out
}

/**
 * A record_created trigger's save-time check: the table must be a live one
 * in this workspace that the loop's owner can read without a grant. Null
 * when fine (or not a record trigger).
 */
export async function recordTriggerTableProblem(
  supabase: SupabaseClient,
  args: { workspaceId: string; ownerUserId: string; triggerType: string; config: unknown },
): Promise<string | null> {
  if (args.triggerType !== 'record_created') return null
  const tableId = ((args.config ?? {}) as Partial<RecordCreatedTriggerConfig>).table_id
  const problem = "trigger_config.table_id is not a table the loop's owner can read in this workspace: their own or the workspace's (one only shared with them doesn't count, since a loop's run reads nothing shared)"
  if (typeof tableId !== 'string') return problem
  const { data, error } = await supabase.from('data_table').select('id').eq('id', tableId).eq('workspace_id', args.workspaceId).is('archived_at', null).maybeSingle()
  if (error || !data) return problem
  return (await ownerCanReadTable(supabase, args.ownerUserId, tableId)) ? null : problem
}

// ── Contacts (a CRM contact added) ──────────────────────────────────────────

/** Where a new contact came from, as a contact_created loop's `source` reads it. */
export type ContactOrigin = 'form' | 'manual'

export interface ContactFacts {
  id: string
  workspace_id: string
  /** Folded into another contact since. */
  merged: boolean
  /** 'form' for a public intake's (contact.source web_form or sms), 'manual' for a person's own, else null. */
  origin: ContactOrigin | null
}

/** A contact's own source column as a loop's `source` reads it: null for every source no emitter writes. */
export function contactOriginOf(source: unknown): ContactOrigin | null {
  if (source === 'web_form' || source === 'sms') return 'form'
  if (source === 'manual') return 'manual'
  return null
}

/** Read a contact's facts (service role): ids and flags only, never its name. Null when it is gone or the read fails. */
export async function loadContactFacts(supabase: SupabaseClient, contactId: string): Promise<ContactFacts | null> {
  const { data, error } = await supabase.from('contact').select('id, workspace_id, merged_into_contact_id, source').eq('id', contactId).maybeSingle()
  if (error || !data) return null
  const r = data as Record<string, unknown>
  return {
    id: r.id as string,
    workspace_id: r.workspace_id as string,
    merged: r.merged_into_contact_id != null,
    origin: contactOriginOf(r.source),
  }
}

/**
 * Why a new contact fires no loop at all, or null: gone, moved, merged into
 * another by the time the fire ran (a person who added a duplicate and folded
 * it away), or of a source no emitter writes (the loop guard, again: only a
 * public intake's and a person's own contacts ever fire).
 */
export function contactSkipReason(contact: ContactFacts | null, workspaceId: string): string | null {
  if (!contact || contact.workspace_id !== workspaceId) return 'deleted'
  if (contact.merged) return 'merged'
  if (!contact.origin) return 'not made by a form or a person'
  return null
}

/** Does a contact_created loop take a contact of this origin? Pure; a stored config without a source takes any. */
export function contactSourceMatches(cfg: Partial<ContactCreatedTriggerConfig> | null | undefined, origin: ContactOrigin | null): boolean {
  if (!origin) return false
  const source = cfg?.source ?? 'any'
  return source === 'any' || source === origin
}

/**
 * Can this person see the contact, without a grant? contact_visible_to
 * (contact-visibility.ts), the contact read rule restated for a service-role
 * client, with its grant arm off: a contact only shared with the owner fires
 * nothing, as a table only shared with them does. Fails closed.
 */
export async function ownerCanSeeContact(supabase: SupabaseClient, ownerUserId: string, contactId: string): Promise<boolean> {
  return isContactVisibleTo(supabase, contactId, ownerUserId, { grants: false })
}

/** The matched contact_created loops that take this contact (its source) and whose owner can see it now. */
export async function contactFlowsToFire(supabase: SupabaseClient, flows: FlowWithSecrets[], contact: Pick<ContactFacts, 'id' | 'origin'>): Promise<FlowWithSecrets[]> {
  const visible = new Map<string, boolean>()
  const out: FlowWithSecrets[] = []
  for (const flow of flows) {
    const owner = flow.created_by
    if (!owner) continue
    if (!contactSourceMatches(flow.trigger_config as Partial<ContactCreatedTriggerConfig>, contact.origin)) continue
    if (!visible.has(owner)) visible.set(owner, await ownerCanSeeContact(supabase, owner, contact.id))
    if (visible.get(owner)) out.push(flow)
  }
  return out
}

/**
 * A save-time check of an event trigger's target, whichever it has: a chat
 * loop's channel, a record loop's table. Null when fine.
 */
export async function eventTriggerTargetProblem(
  supabase: SupabaseClient,
  args: { workspaceId: string; ownerUserId: string; triggerType: string; config: unknown },
): Promise<string | null> {
  return (await chatTriggerChannelProblem(supabase, args)) ?? (await recordTriggerTableProblem(supabase, args))
}

/**
 * Does the workspace have an enabled loop on this event trigger (that person's
 * own, with `ownerUserId`)? The emitters ask first, so a workspace with none
 * sends no event per message. Fails OPEN (true) on a read error: the
 * dispatcher finds nothing to run, which costs one empty run, never a lost fire.
 */
export async function workspaceHasEventFlows(
  supabase: SupabaseClient,
  args: { workspaceId: string; triggerType: OwnerEventTriggerType; ownerUserId?: string; /** record_created: only loops on this table. */ tableId?: string },
): Promise<boolean> {
  try {
    let q = supabase
      .from('flow')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', args.workspaceId)
      .eq('enabled', true)
      .eq('trigger_type', args.triggerType)
    if (args.ownerUserId) q = q.eq('created_by', args.ownerUserId)
    if (args.tableId) q = q.eq('trigger_config->>table_id', args.tableId.toLowerCase())
    const { count, error } = await q.limit(1)
    if (error) return true
    return (count ?? 0) > 0
  } catch {
    return true
  }
}

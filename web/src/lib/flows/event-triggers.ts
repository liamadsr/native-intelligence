/**
 * The owner-scoped event triggers (email_received, chat_message,
 * document_created): who a fire is for, what never fires, and the cap.
 *
 * OWNER SCOPING. Unlike quote_received (workspace-wide), each of these fires
 * a loop only when its OWNER (flow.created_by, who it runs as) could see the
 * item: their own mailbox (the matcher filters on created_by), a channel they
 * can read, a document visible to them. Checked again at every fire with the
 * canonical rules restated for a service-role client (entity-fences.ts: the
 * team chat channel fence, and entity_refs_hidden, the SQL rule the graph's
 * policies use, for documents), so a loop whose owner lost access is skipped.
 *
 * LOOP GUARD. Items made by agents, bots or automations never fire:
 *   - mail: the emitter takes only mail from someone else (never the
 *     person's own address, so never what the app sent from their mailbox);
 *   - chat: only a person's message (author_kind 'member', kind 'message')
 *     fires. The one writer of a person's message is the post route, which
 *     only a signed-in person reaches; an agent's reply (agent-turn.ts) is
 *     written as 'agent' and no loop step can post into team chat;
 *   - documents: only the documents route's plain create emits (an agent's
 *     create_document, reference ingest and canon templates never do).
 *
 * COST. An event loop on a busy channel could start hundreds of runs: each
 * flow runs at most EVENT_FIRE_CAP_PER_DAY times in any 24 hours; the fires
 * past it are ledgered as skipped (at most one row an hour, like the kill
 * switch's) with EVENT_CAP_SKIP_REASON, which the run history shows.
 *
 * Template variables carry ids only, never text someone else wrote: a step
 * reads the item with a tool (read_email, read_team_chat_message,
 * get_document) as the owner.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { hiddenGraphRefs, visiblePrivateKindIds } from '@/lib/knowledge/entity-fences'
import { AGENT_PAUSED_REASON } from '@/lib/work/agent-paused'
import type { ChatMessageTriggerConfig, FlowWithSecrets, OwnerEventTriggerType } from './types'

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

/**
 * Does the workspace have an enabled loop on this event trigger (that person's
 * own, with `ownerUserId`)? The emitters ask first, so a workspace with none
 * sends no event per message. Fails OPEN (true) on a read error: the
 * dispatcher finds nothing to run, which costs one empty run, never a lost fire.
 */
export async function workspaceHasEventFlows(
  supabase: SupabaseClient,
  args: { workspaceId: string; triggerType: OwnerEventTriggerType; ownerUserId?: string },
): Promise<boolean> {
  try {
    let q = supabase
      .from('flow')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', args.workspaceId)
      .eq('enabled', true)
      .eq('trigger_type', args.triggerType)
    if (args.ownerUserId) q = q.eq('created_by', args.ownerUserId)
    const { count, error } = await q.limit(1)
    if (error) return true
    return (count ?? 0) > 0
  } catch {
    return true
  }
}

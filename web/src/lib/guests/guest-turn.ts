/**
 * One turn of a guest's own agent (guest access): the person the owner
 * added texts the Native Intelligence number, and a text turn answers them in their own
 * thread (chat_conversations.agent_guest_id) as the agent the owner made for
 * them. The run token says so (chat-run-token.ts `guestId`, on an SMS channel
 * turn only); the spec and tool routes read the guest here, live, and refuse
 * the turn when it no longer holds:
 *
 *   - the guest is the token user's own, in the token's workspace, and active;
 *   - the conversation is that guest's thread.
 *
 * A guest removed mid-turn, or a token replayed into another thread, gets
 * nothing. Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatRunTokenClaims } from '@/lib/chat/chat-run-token'
import { AGENT_GUEST_SELECT, toGuest, type AgentGuest } from './store'
import { GUEST_NATIVE_TOOLS } from './presets'
import { CUSTOMER_TOOLS } from '@/lib/customers/customer-tools-list'

/** Guest tools whose server side isn't built yet: never advertised or run. (None now: PR3 built the last.) */
export const GUEST_TOOLS_NOT_YET: ReadonlySet<string> = new Set<string>()

const NATIVE: ReadonlySet<string> = new Set(GUEST_NATIVE_TOOLS)

/**
 * The tools this guest's agent may call through the tool route: what the
 * owner gave them (already cleaned by toGuest), minus the chat agent's own
 * web tools (they run inside the agent, not here) and anything not built yet.
 */
export function guestCeiling(guest: Pick<AgentGuest, 'tools' | 'preset'>): Set<string> {
  // A business's customer (src/lib/customers/): the fixed list, whatever the row holds.
  if (guest.preset === 'customer') return new Set(CUSTOMER_TOOLS)
  return new Set(guest.tools.filter((name) => !NATIVE.has(name) && !GUEST_TOOLS_NOT_YET.has(name)))
}

/**
 * The ceiling of one of this owner's guests if they are still active, else
 * empty: an approval card a guest's call raised re-checks it at accept
 * (src/lib/safety/approvals.ts). Throws on a failed read.
 */
export async function activeGuestCeiling(supabase: SupabaseClient, ownerUserId: string, guestId: string): Promise<Set<string>> {
  const { data, error } = await supabase.from('agent_guest').select(AGENT_GUEST_SELECT).eq('id', guestId).eq('owner_user_id', ownerUserId).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return new Set()
  const guest = toGuest(data as Parameters<typeof toGuest>[0])
  return guest.state === 'active' ? guestCeiling(guest) : new Set()
}

export type GuestTurnClaims =Pick<ChatRunTokenClaims, 'userId' | 'workspaceId' | 'conversationId' | 'guestId'>

/**
 * The guest this turn answers, or null when the turn must not run: no guest
 * claim, someone else's guest, another workspace's, not active (removed,
 * still invited, waiting on a request), or a conversation that isn't their
 * thread. Throws on a failed read (the route answers 500, never runs blind).
 */
export async function loadGuestTurn(supabase: SupabaseClient, claims: GuestTurnClaims): Promise<AgentGuest | null> {
  if (!claims.guestId) return null
  const [guestRead, threadRead] = await Promise.all([
    supabase.from('agent_guest').select(AGENT_GUEST_SELECT).eq('id', claims.guestId).eq('owner_user_id', claims.userId).maybeSingle(),
    supabase
      .from('chat_conversations')
      .select('id')
      .eq('id', claims.conversationId)
      .eq('user_id', claims.userId)
      .eq('agent_guest_id', claims.guestId)
      .maybeSingle(),
  ])
  if (guestRead.error) throw new Error(guestRead.error.message)
  if (threadRead.error) throw new Error(threadRead.error.message)
  if (!guestRead.data || !threadRead.data) return null
  const guest = toGuest(guestRead.data as Parameters<typeof toGuest>[0])
  if (guest.state !== 'active' || guest.workspaceId !== claims.workspaceId) return null
  return guest
}

/** The owner's name as their guest's agent says it: their display name here, else "the owner". */
export async function ownerDisplayName(supabase: SupabaseClient, ownerUserId: string, workspaceId: string): Promise<string> {
  const { data } = await supabase
    .from('member')
    .select('display_name')
    .eq('user_id', ownerUserId)
    .eq('workspace_id', workspaceId)
    .limit(1)
    .maybeSingle()
  const name = typeof data?.display_name === 'string' ? data.display_name.replace(/\s+/g, ' ').trim().slice(0, 80) : ''
  return name || 'the owner'
}

export interface GuestMemoryItem {
  kind: 'fact' | 'preference'
  text: string
}

/** What this guest's agent learned about them, newest first (at most 40). Never the owner's memory. */
export async function readGuestMemory(supabase: SupabaseClient, guestId: string): Promise<GuestMemoryItem[]> {
  const { data, error } = await supabase
    .from('agent_guest_memory')
    .select('kind, text')
    .eq('guest_id', guestId)
    .order('created_at', { ascending: false })
    .limit(40)
  if (error) return []
  return ((data ?? []) as Array<{ kind: unknown; text: unknown }>)
    .filter((row): row is GuestMemoryItem => (row.kind === 'fact' || row.kind === 'preference') && typeof row.text === 'string')
}

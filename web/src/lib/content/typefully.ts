/**
 * Posting through the person's own Typefully (content C2a, P9;
 * content-skill-set.md §8 "The Dial8 route"). The model never sees
 * Typefully's tools for this: `publish_post` and `schedule_post` are our two
 * narrow tools in front of it (the template's allow-list lesson), and they run
 * ONLY from the person's approval: their click on a post card, or their Accept
 * on the approval card the chat raises (decision 2: the user always approves;
 * P7's rule that posts always card). The outward gate holds every call of
 * them (src/lib/safety/outward-gate.ts) and the tools refuse anything but an
 * approved call.
 *
 *   publish   Typefully's create-draft tool with `publish_at: "now"`: it
 *             posts at once (asynchronously, on Typefully's side).
 *   schedule  the same with `publish_at: "next-free-slot"`: the next open slot
 *             of the person's own Typefully posting schedule, which answers
 *             "when?" without a setting.
 *   threads   a thread's parts are the platform's posts, in order.
 *
 * ⚠️ UNVERIFIED AGAINST A REAL CONNECTION. No Typefully account has been
 * connected yet, so the server's real tool names and input shape are not
 * confirmed. What we know is from the Vercel template (§8: tool names
 * `typefully_create_draft`, `typefully_edit_draft`, social sets, `publish_at`
 * with "now" / "next-free-slot") and Typefully's public v2 API (a draft is
 * `{ platforms: { x: { enabled, posts: [{ text }] } }, publish_at }` on a
 * social set). This adapter is the ONE place that knows it:
 *   - it finds the tools by name first (KNOWN_*), then by shape (a draft
 *     create; a list of social sets), and says plainly when it finds none;
 *   - it checks the input it builds against the tool's own schema before
 *     calling, and refuses with the misfit instead of guessing;
 *   - it picks the person's first social set when the tool needs one.
 * To confirm with a real connect: the tool names, the draft input shape, how
 * a social set is listed (and which to pick when there are several), and what
 * a published draft returns.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { callToolByServerId, McpTokenExpiredError } from '@/lib/mcp-client'
import { isDraftCreateName, nameWords } from '@/lib/mcp-client/input-policy'
import { suggestedMcpServerFor } from '@/lib/mcp-client/suggested'
import { mcpContentText, toolOf } from '@/lib/mcp-client/owner-connection'
import { isMcpToolHidden } from '@/lib/mcp-client/tool-access'
import { checkToolInputAtRun } from '@/lib/flows/tool-input-schema'
import type { ConnectedMcpServerRow, McpToolDescriptor } from '@/lib/mcp-client/types'
import { POST_SURFACE_NAME, type PostSurface } from './post-draft'

/** The two ways a post goes out through Typefully. */
export type TypefullyWhen = 'now' | 'next_free_slot'

/** Typefully's own value for each (its API's publish_at). */
export const PUBLISH_AT: Readonly<Record<TypefullyWhen, string>> = { now: 'now', next_free_slot: 'next-free-slot' }

/** Tool names the template uses (unverified): tried before any shape match. */
export const KNOWN_CREATE_DRAFT = ['typefully_create_draft', 'create_draft'] as const
export const KNOWN_LIST_SOCIAL_SETS = ['typefully_list_social_sets', 'list_social_sets'] as const

/** Our post surfaces, as Typefully names its platforms. */
const PLATFORM_KEY: Readonly<Record<PostSurface, string>> = { x: 'x', linkedin: 'linkedin', threads: 'threads', bluesky: 'bluesky' }

/** The person's Typefully connection, when it is in the catalog's sense Typefully and switched on. */
export function isTypefullyServer(server: Pick<ConnectedMcpServerRow, 'server_url'> | null | undefined): boolean {
  return !!server?.server_url && suggestedMcpServerFor(server.server_url)?.id === 'typefully'
}

/** The person's own switched-on Typefully connection, or null. Never throws. */
export async function findTypefullyConnection(supabase: SupabaseClient, userId: string): Promise<ConnectedMcpServerRow | null> {
  try {
    const { data } = await supabase.from('connected_mcp_server').select('*').eq('user_id', userId).eq('is_enabled', true).limit(50)
    return ((data ?? []) as ConnectedMcpServerRow[]).find((s) => isTypefullyServer(s)) ?? null
  } catch {
    return null
  }
}

/** The create-draft tool: a known name, else a tool whose name is a draft create. Pure. */
export function createDraftTool(server: Pick<ConnectedMcpServerRow, 'tools_cache'>): McpToolDescriptor | null {
  for (const name of KNOWN_CREATE_DRAFT) {
    const t = toolOf(server, name)
    if (t) return t
  }
  return (server.tools_cache ?? []).find((t) => t && isDraftCreateName(t.name)) ?? null
}

/** The tool that lists the person's social sets (accounts): a known name, else list + social + set. Pure. */
export function listSocialSetsTool(server: Pick<ConnectedMcpServerRow, 'tools_cache'>): McpToolDescriptor | null {
  for (const name of KNOWN_LIST_SOCIAL_SETS) {
    const t = toolOf(server, name)
    if (t) return t
  }
  return (
    (server.tools_cache ?? []).find((t) => {
      if (!t) return false
      const w = nameWords(t.name)
      return (w.includes('list') || w.includes('get')) && w.includes('social') && (w.includes('set') || w.includes('sets'))
    }) ?? null
  )
}

/** Whether a tool's schema takes a property (anywhere at the top level). Pure. */
function takes(tool: McpToolDescriptor, key: string): boolean {
  const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties
  return !!props && Object.hasOwn(props, key)
}

/** One of the person's Typefully accounts (a social set): its id, and the handle or name to say. */
export interface TypefullyAccount {
  id: string | number
  label: string | null
}

/** The social sets in the list tool's text, each with an id and a name to say. Null when it can't be read. Pure. */
export function socialSets(text: string): TypefullyAccount[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const list: unknown = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object'
      ? ((parsed as Record<string, unknown>).results ?? (parsed as Record<string, unknown>).social_sets ?? (parsed as Record<string, unknown>).data)
      : null
  if (!Array.isArray(list)) return null
  const out: TypefullyAccount[] = []
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const id = typeof r.id === 'string' || typeof r.id === 'number' ? r.id : null
    if (id === null) continue
    const label = [r.username, r.name, r.handle].find((v): v is string => typeof v === 'string' && v.trim().length > 0) ?? null
    out.push({ id, label: label ? (label.startsWith('@') || label.includes(' ') ? label : `@${label}`) : null })
  }
  return out
}

/**
 * Which account a post goes out as (P9 review S2), never a guess: the one the
 * card was made for (`expectedId`, still listed), else the person's only
 * account. Two or more and none named: NEEDS_ACCOUNT. Pure.
 */
export function pickAccount(sets: readonly TypefullyAccount[], expectedId?: string | number | null): TypefullyAccount | 'NEEDS_ACCOUNT' | 'NO_SOCIAL_SET' {
  if (sets.length === 0) return 'NO_SOCIAL_SET'
  if (expectedId !== undefined && expectedId !== null) return sets.find((x) => String(x.id) === String(expectedId)) ?? 'NEEDS_ACCOUNT'
  return sets.length === 1 ? sets[0] : 'NEEDS_ACCOUNT'
}

/**
 * The create tool admits the publish time we send (P9 review S1): it takes a
 * `publish_at`, and its schema allows our value (an enum that lists it, or a
 * string). Otherwise a call could save a plain draft that publishes nothing
 * while we report it posted. Pure.
 */
export function admitsPublishAt(tool: Pick<McpToolDescriptor, 'inputSchema'>, value: string): boolean {
  const props = (tool.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties
  if (!props || !Object.hasOwn(props, 'publish_at')) return false
  const admits = (schema: unknown): boolean => {
    if (!schema || typeof schema !== 'object') return false
    const s = schema as { enum?: unknown; const?: unknown; type?: unknown; anyOf?: unknown; oneOf?: unknown }
    if (s.const !== undefined) return s.const === value
    if (Array.isArray(s.enum)) return s.enum.includes(value)
    for (const key of ['anyOf', 'oneOf'] as const) {
      const alts = s[key]
      if (Array.isArray(alts)) return alts.some(admits)
    }
    const types = Array.isArray(s.type) ? s.type : [s.type]
    return types.includes('string')
  }
  return admits(props.publish_at)
}

/**
 * The person's one Typefully account, for a post card to name before anyone
 * clicks (P9 review S2): null when Typefully isn't connected, its accounts
 * can't be read, or there are several (then the card offers no Typefully
 * button: posting from it would be a guess). Never throws.
 */
export async function resolveTypefullyAccount(
  supabase: SupabaseClient,
  userId: string,
  deps: { call?: typeof callToolByServerId } = {},
): Promise<TypefullyAccount | null> {
  try {
    const server = await findTypefullyConnection(supabase, userId)
    const create = server ? createDraftTool(server) : null
    if (!server || !create || isMcpToolHidden(server, create.name)) return null
    if (!takes(create, 'social_set_id')) return { id: '', label: null }
    const list = listSocialSetsTool(server)
    if (!list) return null
    const listed = await (deps.call ?? callToolByServerId)(supabase, server.id, list.name, {}, userId)
    const sets = listed.isError ? null : socialSets(mcpContentText(listed.content))
    const picked = sets ? pickAccount(sets) : 'NO_SOCIAL_SET'
    return typeof picked === 'string' ? null : picked
  } catch {
    return null
  }
}

/** The draft input we send: the platform's posts and the publish time, on a social set when the tool takes one. Pure. */
export function draftInput(args: { surface: PostSurface; parts: readonly string[]; when: TypefullyWhen; socialSetId?: string | number | null }): Record<string, unknown> {
  return {
    ...(args.socialSetId !== undefined && args.socialSetId !== null ? { social_set_id: args.socialSetId } : {}),
    platforms: { [PLATFORM_KEY[args.surface]]: { enabled: true, posts: args.parts.map((text) => ({ text })) } },
    publish_at: PUBLISH_AT[args.when],
  }
}

export type TypefullyResult =
  | { success: true; message: string; when: TypefullyWhen; account: string | null }
  | { success: false; code: string; error: string }

/**
 * Send one post (or a thread) through the person's Typefully, now or into
 * their queue. Call ONLY from an approved call (the tools check). Never throws.
 * Every refusal before the create call says nothing was posted (and its code
 * is one settle-card.ts NEVER_SENT_CODES lists); after it, it says to check.
 */
export async function sendToTypefully(
  supabase: SupabaseClient,
  args: { userId: string; surface: PostSurface; parts: readonly string[]; when: TypefullyWhen; accountId?: string | number | null; deps?: { call?: typeof callToolByServerId } },
): Promise<TypefullyResult> {
  const call = args.deps?.call ?? callToolByServerId
  const where = POST_SURFACE_NAME[args.surface] ?? 'X'
  const server = await findTypefullyConnection(supabase, args.userId)
  if (!server) return { success: false, code: 'NOT_CONNECTED', error: 'Typefully is not connected (or is switched off). Connect it first; nothing was posted.' }
  const create = createDraftTool(server)
  if (!create) return { success: false, code: 'TOOL_NOT_FOUND', error: "Couldn't find Typefully's draft tool on this connection (refresh its tools in Settings); nothing was posted." }
  if (isMcpToolHidden(server, create.name)) return { success: false, code: 'TOOL_OFF', error: `${create.name} on Typefully is switched off; nothing was posted.` }
  if (!admitsPublishAt(create, PUBLISH_AT[args.when])) {
    return { success: false, code: 'SHAPE_MISMATCH', error: `Typefully's ${create.name} doesn't take a publish time of "${PUBLISH_AT[args.when]}", so it couldn't post this; nothing was posted. This needs checking against a real Typefully connection.` }
  }
  let socialSetId: string | number | null = null
  let account: string | null = null
  try {
    if (takes(create, 'social_set_id')) {
      const list = listSocialSetsTool(server)
      if (!list) return { success: false, code: 'NO_SOCIAL_SET', error: "Couldn't find which Typefully account to post from; nothing was posted." }
      const listed = await call(supabase, server.id, list.name, {}, args.userId)
      const sets = listed.isError ? null : socialSets(mcpContentText(listed.content))
      const picked = sets ? pickAccount(sets, args.accountId) : 'NO_SOCIAL_SET'
      if (picked === 'NO_SOCIAL_SET') return { success: false, code: 'NO_SOCIAL_SET', error: "Couldn't read your Typefully accounts; nothing was posted." }
      if (picked === 'NEEDS_ACCOUNT') return { success: false, code: 'NEEDS_ACCOUNT', error: 'You have more than one Typefully account (or the one this card named is gone), so Dial8 won\'t guess which to post as; nothing was posted. Post it from the link instead.' }
      socialSetId = picked.id
      account = picked.label
    }
  } catch (err) {
    if (err instanceof McpTokenExpiredError) return { success: false, code: 'NOT_CONNECTED', error: 'Typefully needs reconnecting; nothing was posted.' }
    return { success: false, code: 'NO_SOCIAL_SET', error: `Couldn't read your Typefully accounts (${err instanceof Error ? err.message : String(err)}); nothing was posted.`.slice(0, 300) }
  }
  const input = draftInput({ surface: args.surface, parts: args.parts, when: args.when, socialSetId })
  const fits = checkToolInputAtRun(input, create.inputSchema)
  if (!fits.ok) {
    return { success: false, code: 'SHAPE_MISMATCH', error: `Typefully's ${create.name} takes a different input than Dial8 sends (${fits.error}); nothing was posted. This needs checking against a real Typefully connection.` }
  }
  try {
    const out = await call(supabase, server.id, create.name, input, args.userId)
    if (out.isError) return { success: false, code: 'TYPEFULLY_ERROR', error: `Typefully refused it: ${mcpContentText(out.content).slice(0, 200) || 'no reason given'}. Check your Typefully before trying again.` }
  } catch (err) {
    return { success: false, code: 'TYPEFULLY_ERROR', error: `Sending to Typefully failed (${err instanceof Error ? err.message : String(err)}); check your Typefully before trying again.`.slice(0, 300) }
  }
  const as = account ? ` as ${account}` : ''
  return {
    success: true,
    when: args.when,
    account,
    message: args.when === 'now' ? `Sent to Typefully to post on ${where}${as} now.` : `Added to your Typefully queue for ${where}${as}: it posts at your next free slot.`,
  }
}

/** One line, clipped, for a card. */
function clip(text: string, max = 80): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

/**
 * The approval card's words for a post through Typefully: exactly what goes
 * out, from the call's own input (never a model's words). Pure.
 */
export function typefullyCardCopy(tool: 'publish_post' | 'schedule_post', input: { surface?: unknown; text?: unknown; parts?: unknown; account?: unknown }): { title: string; why: string } {
  const surface = (typeof input.surface === 'string' && input.surface in POST_SURFACE_NAME ? input.surface : 'x') as PostSurface
  const where = POST_SURFACE_NAME[surface]
  const parts = Array.isArray(input.parts) ? input.parts.filter((p): p is string => typeof p === 'string') : []
  const text = typeof input.text === 'string' && input.text.trim() ? input.text : (parts[0] ?? '')
  const thread = parts.length > 1 ? ` (a thread of ${parts.length})` : ''
  const as = typeof input.account === 'string' && input.account.trim() ? ` as ${input.account.trim()}` : ''
  const title =
    tool === 'publish_post'
      ? `Post to ${where}${as} via Typefully now${thread}: '${clip(text)}'`
      : `Add to your Typefully queue for ${where}${as}${thread}, next free slot: '${clip(text)}'`
  const why =
    tool === 'publish_post'
      ? `This posts publicly on ${where}${as || ' as you'}, through your Typefully, once, with exactly the text below, when you accept. Nothing is posted otherwise.`
      : `This puts the post in your Typefully queue for ${where}; it goes out publicly at your next free slot. Once, with exactly the text below, when you accept.`
  return { title: title.slice(0, 200), why }
}

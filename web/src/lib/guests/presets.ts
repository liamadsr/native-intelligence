/**
 * What a guest's agent may do (guest access, migrations 427 and 429): every
 * tool the owner can give a person, in the sections the People tab shows
 * with Always allow / Needs approval / Blocked per tool (held in
 * agent_guest.tools, waiting for the owner's yes in agent_guest.ask_tools),
 * and the two presets they start from.
 *
 *   Household  nearly everything for the home: the calendar (seeing it and
 *              changing it), tasks, contacts, drafting, web research and
 *              bookings. Payments and deletes ask the owner first, until the
 *              owner turns either off for that person.
 *   Colleague  when the owner is free (never what they are doing), and
 *              meeting requests, which always ask the owner first.
 *
 * Every guest's agent can also always reach the owner (GUEST_ALWAYS_TOOLS).
 * Nothing here widens a guest past the guest class (src/lib/safety/caller.ts):
 * an outward call is the owner's card whatever is picked, and a tool this
 * file does not offer is dropped (normalizeGuestTools).
 *
 * Pure and client-safe.
 */
import { ATTENDED_ONLY_TOOL_NAMES, CHAT_NATIVE_TOOL_NAMES, TOOL_CATEGORIES, getToolDefinition, getToolSideEffect } from '@/lib/ai/tool-registry'
import { GUEST_ALWAYS_TOOLS, GUEST_ONLY_TOOLS } from './tools'

/** What always waits for the owner's yes (agent_guest.ask_before). Outward calls always do. */
export const GUEST_ASK_BEFORE = ['payments', 'deletes', 'changes'] as const
export type GuestAskBefore = (typeof GUEST_ASK_BEFORE)[number]

export const GUEST_ASK_BEFORE_LABELS: Record<GuestAskBefore, string> = {
  payments: 'Paying for anything',
  deletes: 'Deleting anything',
  changes: 'Any change at all',
}

export const GUEST_PRESET_IDS = ['household', 'colleague'] as const
export type GuestPresetId = (typeof GUEST_PRESET_IDS)[number]
/**
 * agent_guest.preset: a preset, or custom once the owner changed its tools or
 * asks. 'customer' is a business's customer (migration 458,
 * src/lib/customers/): made by a text to the business's number, never picked
 * in the People tab, its tools fixed in code (CUSTOMER_TOOLS).
 */
export type GuestPresetValue = GuestPresetId | 'custom' | 'customer'

/** The chat agent's own tools a guest may hold (not registry tools: they run inside the agent). */
export const GUEST_NATIVE_TOOLS: readonly string[] = ['web_search', 'web_fetch']

/**
 * Registry tools no guest is ever offered, on top of what the guest class can
 * never hold (main-chat only, attended-only, automation writes): the chat's
 * own uploads and cards (a text has neither), the tools that need the owner's
 * JWT (a guest's turn carries none), the browser tools that show or steer the
 * owner's own browser, a live meeting's note-taker, and the evals and post
 * tools (the owner's own workbench).
 */
export const GUEST_NEVER_TOOLS: ReadonlySet<string> = new Set([
  'read_chat_file',
  'attach_chat_file',
  'show',
  'read_card',
  'generate_email_drafts',
  'draft_followup_email',
  'open_browser',
  'close_browser',
  'screenshot_browser',
  'tell_note_taker',
  // The owner's own held calls' results (GEN-1172), read by approval_id: never a guest's.
  'get_tool_approval_result',
  // The business's customers, quotes and bookings (roadmap B): the owner's, never a guest's.
  'list_quotes',
  'get_quote',
  'update_quote',
  'get_business_profile',
  'update_business_profile',
  'create_quote_form_link',
  'find_booking_slots',
  'list_bookings',
  // The owner's answer to a quote (roadmap F3): theirs alone, on their own card.
  'send_quote',
  'book_quote',
])
const NEVER_CATEGORIES: ReadonlySet<string> = new Set(['evals', 'content'])

/** True for a registry tool the People tab may offer a guest. */
function offerableRegistryTool(name: string, sideEffect: string): boolean {
  if (GUEST_NEVER_TOOLS.has(name) || CHAT_NATIVE_TOOL_NAMES.has(name) || ATTENDED_ONLY_TOOL_NAMES.has(name)) return false
  return sideEffect === 'read' || sideEffect === 'internal-write' || sideEffect === 'delete' || sideEffect === 'external-write'
}

export interface GuestToolSection {
  id: string
  label: string
  tools: readonly string[]
}

/** The sections a guest's agent's day-to-day help lives in, first; the rest follow in the registry's order. */
const SECTION_ORDER = ['calendar', 'calendar_capture', 'actions', 'contacts', 'emails', 'web', 'browser']

/**
 * Every tool the People tab can give a guest, in sections (the registry's
 * categories, as the connector's Tool permissions shows them): get_free_busy
 * heads Calendar, and the agent's own web tools are their own section. The
 * always-on tools are not here (GUEST_ALWAYS_TOOLS: fixed rows).
 */
export const GUEST_TOOL_SECTIONS: readonly GuestToolSection[] = (() => {
  const sections: GuestToolSection[] = []
  for (const category of TOOL_CATEGORIES) {
    if (NEVER_CATEGORIES.has(category.id)) continue
    const tools = category.tools.filter((t) => offerableRegistryTool(t.name, t.sideEffect)).map((t) => t.name)
    if (category.id === 'calendar') tools.unshift('get_free_busy')
    if (tools.length) sections.push({ id: category.id, label: category.label, tools })
  }
  sections.push({ id: 'web', label: 'Web', tools: [...GUEST_NATIVE_TOOLS] })
  const rank = (id: string) => (SECTION_ORDER.includes(id) ? SECTION_ORDER.indexOf(id) : SECTION_ORDER.length)
  return sections.map((section, i) => ({ section, i })).sort((a, b) => rank(a.section.id) - rank(b.section.id) || a.i - b.i).map(({ section }) => section)
})()

/** Every tool the People tab can give a guest, in the sections' order, then the always-on ones. */
export const GUEST_OFFERABLE_TOOLS: readonly string[] = [...new Set([...GUEST_TOOL_SECTIONS.flatMap((s) => s.tools), ...GUEST_ALWAYS_TOOLS])]
const OFFERABLE: ReadonlySet<string> = new Set(GUEST_OFFERABLE_TOOLS)

/**
 * The tools that start on Needs approval when a guest is given them: an
 * outward call (it sends or changes something outside Dial8), and a delete
 * while the person's "Deleting anything asks you first" is on (askBefore
 * 'deletes' or 'changes'). Missing asks read as every ask (fail closed).
 *
 * Only a default (Liam, 2026-11-02: "I should be able to decide what she can
 * do, nothing should be not allowed at all ... they can have a default but I
 * get to control"): the owner can set any of them to Always allow, and each
 * tool's own setting is the truth after that. Before, these could never be
 * Always allow, so his wife's agent could never change his calendar without
 * a card.
 */
export function guestToolAsksByDefault(name: string, askBefore?: readonly string[] | null): boolean {
  const effect = getToolSideEffect(name)
  if (effect === 'external-write') return true
  const asks = Array.isArray(askBefore) ? askBefore : GUEST_ASK_BEFORE
  // "Any change at all" starts every write on Needs approval too.
  if (effect === 'internal-write') return asks.includes('changes')
  if (effect !== 'delete') return false
  return asks.includes('deletes') || asks.includes('changes')
}

export interface GuestToolGroup {
  id: string
  label: string
  description: string
  tools: readonly string[]
  /**
   * What holding every tool of the group lets the guest's agent do, in its
   * own prompt (guest-spec.ts guestReachLines): `{owner}` is the owner's
   * name. Written for the agent, never the People tab's copy ("you" there is
   * the owner; here it would read as the agent).
   */
  reach: string
}

/** The groups the presets are made of (and the first People tab's switches). */
export const GUEST_TOOL_GROUPS: readonly GuestToolGroup[] = [
  { id: 'free_busy', label: 'When you’re free', description: 'Busy times only, never what the event is', tools: ['get_free_busy'], reach: 'See whether {owner} is free or busy at a time: busy times only, never what an event is' },
  { id: 'calendar', label: 'Your calendar', description: 'Events with their titles, places and people', tools: ['get_calendar_events', 'get_upcoming_meetings'], reach: 'See {owner}’s calendar events, with their titles, places and people' },
  { id: 'meeting_requests', label: 'Add events', description: 'Put something on your calendar', tools: ['create_calendar_event'], reach: 'Propose an event on {owner}’s calendar' },
  { id: 'calendar_changes', label: 'Change events', description: 'Move or cancel events on your calendar', tools: ['update_calendar_event', 'delete_calendar_event'], reach: 'Move or cancel events on {owner}’s calendar' },
  { id: 'tasks', label: 'Tasks and reminders', description: 'See, add and finish your tasks', tools: ['list_actions', 'get_action', 'create_action', 'update_action', 'complete_action'], reach: 'See, add and finish {owner}’s tasks' },
  { id: 'contacts', label: 'Contacts', description: 'Look up people you know', tools: ['list_contacts', 'get_contact'], reach: 'Look up the people {owner} knows' },
  { id: 'drafting', label: 'Draft emails', description: 'Leave drafts in your mail, never send', tools: ['create_email_draft'], reach: 'Leave email drafts in {owner}’s mail, never sent' },
  { id: 'web', label: 'Web research', description: 'Search and read the web', tools: ['web_search', 'web_fetch'], reach: 'Search and read the web' },
  { id: 'bookings', label: 'Bookings', description: 'Reservations and forms in the agent’s browser', tools: ['run_browser_task', 'wait_for_browser_command', 'read_browser_page', 'get_browser_text'], reach: 'Make reservations and fill in forms in your own browser' },
]

export interface GuestPreset {
  id: GuestPresetId
  label: string
  description: string
  groups: readonly string[]
  askBefore: readonly GuestAskBefore[]
}

export const GUEST_PRESETS: Record<GuestPresetId, GuestPreset> = {
  household: {
    id: 'household',
    label: 'Household',
    description: 'Your calendar, tasks, contacts, drafts, web research and bookings',
    groups: ['free_busy', 'calendar', 'meeting_requests', 'calendar_changes', 'tasks', 'contacts', 'drafting', 'web', 'bookings'],
    askBefore: ['payments', 'deletes'],
  },
  colleague: {
    id: 'colleague',
    label: 'Colleague',
    description: 'When you’re free, and meeting requests you approve',
    groups: ['free_busy', 'meeting_requests'],
    askBefore: ['payments', 'deletes', 'changes'],
  },
}

export function isGuestPresetId(value: unknown): value is GuestPresetId {
  return typeof value === 'string' && (GUEST_PRESET_IDS as readonly string[]).includes(value)
}

/** The tools of these groups (unknown group ids are ignored), in offer order, with the always-on ones. */
export function toolsForGroups(groupIds: Iterable<string>): string[] {
  const picked = new Set<string>(GUEST_ALWAYS_TOOLS)
  const wanted = new Set(groupIds)
  for (const group of GUEST_TOOL_GROUPS) if (wanted.has(group.id)) for (const tool of group.tools) picked.add(tool)
  return GUEST_OFFERABLE_TOOLS.filter((tool) => picked.has(tool))
}

export interface GuestToolSettings {
  tools: string[]
  /** Held, but every call waits for the owner's yes (Needs approval). Always a subset of tools. */
  askTools: string[]
  askBefore: GuestAskBefore[]
}

/**
 * A preset's tools and asks, as a new guest's row starts. Needs approval:
 * what always asks (outward calls, deletes) and, under "any change at all",
 * every write.
 */
export function presetSettings(id: GuestPresetId): GuestToolSettings {
  const preset = GUEST_PRESETS[id]
  const tools = toolsForGroups(preset.groups)
  const askBefore = [...preset.askBefore]
  const everyChange = askBefore.includes('changes')
  const askTools = tools.filter((name) => guestToolAsksByDefault(name, askBefore) || (everyChange && getToolSideEffect(name) === 'internal-write'))
  return { tools, askTools: normalizeAskTools(askTools, tools, askBefore), askBefore }
}

/**
 * A stored or requested tool list, cleaned: only offerable names, the
 * always-on ones added, deduped, in offer order. Anything else (a registry
 * tool guests aren't offered, a typo, a non-string) is dropped: fail closed.
 */
export function normalizeGuestTools(tools: unknown): string[] {
  const given = new Set(Array.isArray(tools) ? tools.filter((t): t is string => typeof t === 'string' && OFFERABLE.has(t)) : [])
  for (const tool of GUEST_ALWAYS_TOOLS) given.add(tool)
  return GUEST_OFFERABLE_TOOLS.filter((tool) => given.has(tool))
}

/**
 * Stored or requested Needs approval tools, cleaned against the (cleaned)
 * held tools: only held ones, never an always-on tool, in offer order. Each
 * held tool's own setting is the truth (a held tool not listed is Always
 * allow). A missing or malformed list (never saved) reads as each held tool's
 * default (guestToolAsksByDefault), so a bad row narrows, never widens.
 */
export function normalizeAskTools(askTools: unknown, tools: readonly string[], askBefore?: readonly string[] | null): string[] {
  const held = new Set(tools)
  const always = new Set<string>(GUEST_ALWAYS_TOOLS)
  const given = Array.isArray(askTools)
    ? new Set(askTools.filter((t): t is string => typeof t === 'string' && held.has(t) && !always.has(t)))
    : new Set(tools.filter((t) => !always.has(t) && guestToolAsksByDefault(t, askBefore)))
  return GUEST_OFFERABLE_TOOLS.filter((tool) => given.has(tool))
}

/**
 * Needs approval when a save names no asks of its own: what was saved, plus
 * each tool in `fresh` (just given, or a delete whose "Deleting anything asks
 * you first" just came on) that asks by default. A tool the owner already set
 * keeps its setting.
 */
export function askToolsWithDefaults(saved: readonly string[], fresh: readonly string[], tools: readonly string[], askBefore?: readonly string[] | null): string[] {
  return normalizeAskTools([...saved, ...fresh.filter((t) => guestToolAsksByDefault(t, askBefore))], tools, askBefore)
}

/**
 * Stored asks, cleaned. A missing or malformed value reads as every ask
 * (nothing runs without the owner's yes), so a bad row narrows, never widens.
 */
export function normalizeAskBefore(askBefore: unknown): GuestAskBefore[] {
  if (!Array.isArray(askBefore)) return [...GUEST_ASK_BEFORE]
  const given = new Set(askBefore)
  return GUEST_ASK_BEFORE.filter((ask) => given.has(ask))
}

/** Which preset these settings are exactly, else custom. */
export function presetOf(settings: { tools: readonly string[]; askTools?: readonly string[]; askBefore: readonly string[] }): GuestPresetValue {
  const tools = normalizeGuestTools(settings.tools)
  const askBefore = normalizeAskBefore(settings.askBefore)
  const toolKey = tools.join(',')
  const askToolKey = normalizeAskTools(settings.askTools ?? [], tools, askBefore).join(',')
  const askKey = askBefore.join(',')
  for (const id of GUEST_PRESET_IDS) {
    const preset = presetSettings(id)
    if (preset.tools.join(',') === toolKey && preset.askTools.join(',') === askToolKey && preset.askBefore.join(',') === askKey) return id
  }
  return 'custom'
}

/** A tool's label for the People tab: the guest-only or registry definition's, else the name. */
export function guestToolLabel(name: string): string {
  const own = GUEST_ONLY_TOOLS.find((tool) => tool.name === name)
  if (own) return own.label
  if (name === 'web_search') return 'Search the web'
  if (name === 'web_fetch') return 'Read a web page'
  return getToolDefinition(name)?.label ?? name
}

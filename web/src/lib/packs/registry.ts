/**
 * The expertise-pack registry (docs/plans/one-agent-and-chat-pages.md, Part 3).
 *
 * One agent does everything; what it needs to be good at one area of Native Intelligence is
 * that area's pack: a playbook (a system skill tagged with the area), the
 * area's skills, and later what it has learned about the person (S2). A pack
 * never walls off tools. It only teaches.
 *
 * This file is plain data plus lookups, with no server or model dependency, so
 * the skill editor (client), the chat spec rebuild and the background run
 * prompts all read the same map. The chat-agent can't import it (the eve
 * bundler doesn't reach src/), so the spec hands it what it needs per pack
 * (src/lib/packs/chat-packs.ts).
 *
 * The first 16 areas are the 16 pages, Agents & skills being `library`. Each
 * is gated by the edition feature that owns its page: a pack never loads in a
 * workspace whose feature for it is off. `content` and `marketing` (P8,
 * eve-alignment.md §6 decision 4) are areas with no page of their own: know-how
 * for posts and for the product doc as brand context, gated with `core`, so
 * every workspace can ask for them. A pack only teaches: nothing in either one
 * runs until the person asks (§5b).
 */
import type { FeatureKey } from '@/lib/editions/manifest'
import { TOOL_CATEGORIES, TOOL_REGISTRY_MAP } from '@/lib/ai/tool-registry'

/** The area keys, the same list the area CHECKs allow (migration 316, widened by 384 and, for `studio`, 621). */
export const AREA_KEYS = [
  'calendar',
  'actions',
  'captures',
  'documents',
  'knowledge',
  'initiatives',
  'projects',
  'flows',
  'mail',
  'crm',
  'prospecting',
  'sequences',
  'campaigns',
  'evals',
  'browser',
  'library',
  'content',
  'marketing',
  'studio',
] as const

export type AreaKey = (typeof AREA_KEYS)[number]

const AREA_SET: ReadonlySet<string> = new Set(AREA_KEYS)

export function isAreaKey(value: unknown): value is AreaKey {
  return typeof value === 'string' && AREA_SET.has(value)
}

/**
 * What makes a pack load, decided by code so a weak model can't forget:
 *   - `search_tools`: a search reveals one of the area's tools;
 *   - `tool_call`: the first call of one of the area's tools (in practice the
 *     core tools of Actions, Calendar and Captures, offered without a search);
 *   - `card`: the agent shows a card of the area's kind (wired with `show`);
 *   - `agent_menu`: the person focuses a conversation on the area (S3);
 *   - `load_skill`: the agent loads the area's playbook by name.
 * Every area loads on all of them; the per-area data that feeds them is its
 * tool groups and card kinds below.
 */
export const PACK_TRIGGERS = ['search_tools', 'tool_call', 'card', 'agent_menu', 'load_skill'] as const
export type PackTrigger = (typeof PACK_TRIGGERS)[number]

export interface PackDefinition {
  key: AreaKey
  /** The plain area name, as the page and the face say it. */
  name: string
  /** The edition feature that owns the area's page: off, and the pack never loads. */
  feature: FeatureKey
  /** TOOL_CATEGORIES ids whose tools belong to this area. */
  toolGroups: readonly string[]
  /**
   * The card kinds of the area, for `show` (Part 1): a bare `kind`
   * ('calendar', 'mail') or `kind:entity_type` for list, board and record
   * cards ('list:action', 'record:contact').
   */
  cardKinds: readonly string[]
}

/** List, board and record cards over some entity types. */
function entityCards(...entityTypes: string[]): string[] {
  return entityTypes.flatMap((t) => [`list:${t}`, `board:${t}`, `record:${t}`])
}

export const PACKS: Record<AreaKey, PackDefinition> = {
  calendar: {
    key: 'calendar',
    name: 'Calendar',
    feature: 'core',
    toolGroups: ['calendar', 'calendar_capture'],
    cardKinds: ['calendar', 'record:event'],
  },
  actions: {
    key: 'actions',
    name: 'Actions',
    feature: 'core',
    toolGroups: ['actions'],
    // A team board card is one team's actions (pages in the chat, P3).
    cardKinds: ['team_board', ...entityCards('action')],
  },
  captures: {
    key: 'captures',
    name: 'Captures',
    feature: 'core',
    // Decisions are what captures extract; they have no page of their own.
    toolGroups: ['captures', 'decisions'],
    cardKinds: entityCards('capture', 'decision'),
  },
  documents: {
    key: 'documents',
    name: 'Documents',
    feature: 'docs',
    // Tables (phase 5) are gated with Docs: their page sits with the docs.
    toolGroups: ['documents', 'tables'],
    cardKinds: [...entityCards('document'), 'tables'],
  },
  knowledge: {
    key: 'knowledge',
    name: 'Knowledge',
    feature: 'knowledge',
    toolGroups: ['knowledge'],
    cardKinds: ['knowledge', ...entityCards('claim')],
  },
  initiatives: {
    key: 'initiatives',
    name: 'Initiatives',
    feature: 'projects',
    toolGroups: ['initiatives'],
    cardKinds: entityCards('initiative'),
  },
  projects: {
    key: 'projects',
    name: 'Projects',
    feature: 'projects',
    toolGroups: ['projects', 'cycles'],
    cardKinds: entityCards('project'),
  },
  flows: {
    key: 'flows',
    name: 'Flows',
    feature: 'flows',
    toolGroups: ['flows'],
    cardKinds: ['flows', ...entityCards('flow')],
  },
  mail: {
    key: 'mail',
    name: 'Mail',
    feature: 'email',
    toolGroups: ['emails'],
    cardKinds: ['mail', ...entityCards('email_thread')],
  },
  crm: {
    key: 'crm',
    name: 'CRM',
    feature: 'crm',
    toolGroups: ['contacts'],
    // Deals are the pipelines' page (Tables, phase 7).
    cardKinds: [...entityCards('contact', 'company'), 'pipelines'],
  },
  prospecting: {
    key: 'prospecting',
    name: 'Prospecting',
    feature: 'prospecting',
    toolGroups: ['prospecting'],
    cardKinds: ['prospecting', ...entityCards('prospect_list', 'prospect_list_entry')],
  },
  sequences: {
    key: 'sequences',
    name: 'Sequences',
    feature: 'sequences',
    toolGroups: ['sequences'],
    cardKinds: ['sequences', ...entityCards('sequence')],
  },
  campaigns: {
    key: 'campaigns',
    name: 'Campaigns',
    feature: 'campaigns',
    toolGroups: ['campaigns'],
    cardKinds: ['campaigns', ...entityCards('campaign')],
  },
  evals: {
    key: 'evals',
    name: 'Evals',
    feature: 'evals',
    toolGroups: ['evals'],
    cardKinds: ['evals', ...entityCards('eval_suite', 'eval_case', 'eval_run')],
  },
  browser: {
    key: 'browser',
    name: 'Browser',
    feature: 'browser',
    toolGroups: ['browser'],
    cardKinds: [],
  },
  library: {
    key: 'library',
    name: 'Agents & skills',
    feature: 'core',
    toolGroups: ['library'],
    cardKinds: ['library', ...entityCards('agent', 'skill')],
  },
  // P8 (content C0): posts. Its tools check a draft; nothing in it posts.
  content: {
    key: 'content',
    name: 'Content',
    feature: 'core',
    toolGroups: ['content'],
    cardKinds: [],
  },
  // P8 (marketing M0): the product doc as brand context, positioning,
  // customer language. No tools of its own: it reads calls, claims and docs,
  // and edits the product doc with the canon tools. It loads by its playbook.
  marketing: {
    key: 'marketing',
    name: 'Marketing',
    feature: 'core',
    toolGroups: [],
    cardKinds: [],
  },
  // Studio (migration 620): videos and ads, their storyboards, cast and edits.
  studio: {
    key: 'studio',
    name: 'Studio',
    feature: 'studio',
    toolGroups: ['studio'],
    cardKinds: ['studio'],
  },
}

/**
 * Tool groups that belong to no area: cross-cutting reads and the chat's own
 * plumbing. Every TOOL_CATEGORIES id is either here or in exactly one pack
 * (registry.test.ts), so a new group has to be placed on purpose.
 */
export const NO_AREA_TOOL_GROUPS: readonly string[] = ['attachments', 'comments', 'dashboard', 'notifications', 'search']

/**
 * Tools inside an area's group that belong to no area: the `actions` group
 * also holds the bot relay, the local agents and the reads and acts on background work, and
 * `library` holds `remember`, `update_now`, `finish_getting_started`, `connect_link`, `save_business_profile` and `get_tool_approval_result`. Calling them is running the show, not working
 * in Actions or on skills.
 */
export const NO_AREA_TOOL_NAMES: ReadonlySet<string> = new Set([
  'start_helper',
  'stop_helper',
  'settle_card',
  'list_bot_work',
  'get_bot_item',
  'settle_work_item',
  'send_work_answer',
  'send_bot_message',
  'wait_for_bot_reply',
  // Renaming, deleting and merging the person's agents (GEN-1168): running the show too.
  'rename_bot',
  'delete_bot',
  'merge_bots',
  // The local agents on the person's Mac (docs/plans/local-agents.md): running the show too.
  'local_agents',
  'start_local_agent',
  'message_local_agent',
  'read_local_agent',
  'stop_local_agent',
  // …and their cloud counterpart (docs/plans/environments.md E2).
  'start_cloud_coding_run',
  // Answering a guest's agent (guest access): the main agent's own relay, like the bot relay.
  'answer_guest',
  // Asking a linked person's agent (agent links): the main agent's own relay too.
  'ask_agent',
  // Memory is every area's: saving a line names its area itself.
  'remember',
  // The person's Now file (docs/plans/now-file.md): the main agent's own sketchpad, of no area.
  'update_now',
  // Ending the person's getting started (docs/plans/getting-started-skill.md): of no area either.
  'finish_getting_started',
  // Setup by text (src/lib/onboarding/text-setup.ts): a texted connect link and the business's profile, of no area.
  'connect_link',
  'save_business_profile',
  // How a held call ended (GEN-1172): any area's approval, never working on skills.
  'get_tool_approval_result',
])

/** The system skill slug of an area's playbook: `mail-playbook`. */
export function playbookSlug(area: AreaKey): string {
  return `${area}-playbook`
}

const GROUP_TO_AREA: ReadonlyMap<string, AreaKey> = new Map(
  AREA_KEYS.flatMap((area) => PACKS[area].toolGroups.map((group) => [group, area] as const)),
)

/** The area a tool group belongs to, or null. */
export function areaForToolGroup(groupId: string): AreaKey | null {
  return GROUP_TO_AREA.get(groupId) ?? null
}

/** The area a registry tool belongs to, or null (a cross-cutting tool, or not a registry tool). */
export function areaForTool(name: string): AreaKey | null {
  if (NO_AREA_TOOL_NAMES.has(name)) return null
  const entry = TOOL_REGISTRY_MAP.get(name)
  return entry ? areaForToolGroup(entry.category.id) : null
}

/** Every registry tool of an area, in registry order. */
export function toolNamesForArea(area: AreaKey): string[] {
  const groups = new Set(PACKS[area].toolGroups)
  return TOOL_CATEGORIES.filter((c) => groups.has(c.id))
    .flatMap((c) => c.tools.map((t) => t.name))
    .filter((name) => !NO_AREA_TOOL_NAMES.has(name))
}

/** The distinct areas of some tool names, in first-seen order. */
export function areasForToolNames(names: Iterable<string>): AreaKey[] {
  const out: AreaKey[] = []
  for (const name of names) {
    const area = areaForTool(name)
    if (area && !out.includes(area)) out.push(area)
  }
  return out
}

/** The distinct areas of some tool group ids, in first-seen order. */
export function areasForToolGroups(groupIds: Iterable<string>): AreaKey[] {
  const out: AreaKey[] = []
  for (const id of groupIds) {
    const area = areaForToolGroup(id)
    if (area && !out.includes(area)) out.push(area)
  }
  return out
}

/** A card as `show` describes it, as far as its area goes. */
export interface CardRef {
  kind: string
  entity_type?: string | null
  record_type?: string | null
}

const CARD_KIND_TO_AREA: ReadonlyMap<string, AreaKey> = new Map(
  AREA_KEYS.flatMap((area) => PACKS[area].cardKinds.map((kind) => [kind, area] as const)),
)

/** The area a card belongs to: its `kind:type` first, then its bare kind. Null for none. */
export function areaForCard(card: CardRef): AreaKey | null {
  const type = card.kind === 'record' ? card.record_type : card.entity_type
  if (type) {
    const typed = CARD_KIND_TO_AREA.get(`${card.kind}:${type}`)
    if (typed) return typed
  }
  return CARD_KIND_TO_AREA.get(card.kind) ?? null
}

/** The areas in registry order, with names: what the skill editor's area picker lists. */
export const AREA_OPTIONS: ReadonlyArray<{ key: AreaKey; name: string }> = AREA_KEYS.map((key) => ({
  key,
  name: PACKS[key].name,
}))

/**
 * Validate an incoming skill `area` (the skills API). `undefined` leaves the
 * field alone, null or '' clears it, an area key sets it. Anything else is an
 * error that names the fix.
 */
export function parseSkillArea(
  raw: unknown,
): { ok: true; area: AreaKey | null | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, area: undefined }
  if (raw === null || raw === '') return { ok: true, area: null }
  if (isAreaKey(raw)) return { ok: true, area: raw }
  return {
    ok: false,
    error: `area must be one of ${AREA_KEYS.join(', ')}, or null for none. Got ${String(JSON.stringify(raw)).slice(0, 60)}.`,
  }
}

import { TOOL_CATEGORIES } from '@/lib/ai/tool-registry'
import { inlineToSpeech, parseSpeechBlocks } from '@/lib/read-aloud/speech-text'
import type { BriefContext } from '../context'
import { Speech, clause, listOf, notesSummary } from '../speech'

/**
 * An agent or a skill on the Agents & Skills page (a `recipe` row): what it
 * is and whose, what it's for (its description), how it runs, the tools it
 * may use, then what its prompt says first and what its sections cover
 * (Liam, 2026-09-28: "read the agents prompt and skills and give an overview
 * of what it is and how the agent or skill works").
 *
 * No model writes it: the overview is the item's own settings and its
 * prompt's own words. A built-in prompt runs well past a thousand words (8 to
 * 11 minutes aloud), so its opening is read and its sections are named, not
 * all of it.
 *
 *   "Meeting prep, a built-in skill. Prepares you for one specific meeting.
 *    Run it from chat by typing slash meeting prep. Its prompt says: You
 *    prepare the user for ONE specific meeting. … It covers Pin the meeting,
 *    Who is coming, What happened last time and six more."
 *
 * Read on the user's own client: recipe_select_visibility shows them the
 * built-ins, the public ones in Discover, and their workspace's (a personal
 * one only to its maker), just as the page lists them.
 */
export async function librarySpeech(ctx: BriefContext, id: string): Promise<Speech | null> {
  const { data, error } = await ctx.supabase
    .from('recipe')
    .select('id, name, description, category, slug, is_system, visibility, workspace_id, created_by, system_prompt, agent_config')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    console.warn('[listen-brief] library item failed:', error.message)
    return null
  }
  const item = data as LibraryItemRow | null
  return item ? libraryWords(item, ctx) : null
}

/** How much of a prompt's opening is read. */
const OPENING_SAID = 4

/** What the row says, as words. Pure. */
export function libraryWords(item: LibraryItemRow, who: { workspaceId: string; userId: string }): Speech {
  const speech = new Speech()
  const agent = item.category === 'agent'
  const kind = agent ? 'agent' : 'skill'

  // What it is, and whose.
  speech.say(`${clause(item.name) || `This ${kind}`}, ${whose(item, who, agent)}`)
  speech.say(item.description)

  // How it runs: an agent on meetings, a skill from chat.
  if (agent) speech.say(howItRuns(item.agent_config))
  const slug = item.slug?.replace(/[-_]+/g, ' ').trim()
  if (!agent && slug) speech.say(`Run it from chat by typing slash ${slug}`)

  // The tools it may use (a skill's apply when it runs on its own, in a flow).
  const tools = listOf(toolLabels(item.agent_config), 4, 'more')
  if (tools) speech.say(agent ? `It can use ${tools}` : `When it runs on its own in a flow, it can use ${tools}`)

  // Its prompt: what it says first, then what its sections cover.
  const prompt = item.system_prompt ?? ''
  const [first, ...rest] = notesSummary(prompt, OPENING_SAID)
  if (first) {
    speech.say('Its prompt says:', first)
    speech.sayAll(rest)
  }
  const sections = listOf(headingsOf(prompt), 4, 'more')
  if (sections) speech.say(`It covers ${sections}`)
  return speech
}

/** "a built-in agent", "your own skill", "a skill in your workspace", "an
 *  agent from Discover". */
function whose(item: LibraryItemRow, who: { workspaceId: string; userId: string }, agent: boolean): string {
  const kind = agent ? 'agent' : 'skill'
  const a = agent ? 'an' : 'a'
  if (item.is_system) return `a built-in ${kind}`
  if (item.workspace_id !== who.workspaceId) return `${a} ${kind} from Discover`
  if (item.visibility === 'personal' && item.created_by === who.userId) return `your own ${kind}`
  return `${a} ${kind} in your workspace`
}

/** How an agent takes part in a meeting (lib/types/library AgentConfig). */
function howItRuns(config: Record<string, unknown> | null): string {
  return config?.capture_mode === 'assist_only'
    ? 'In a live meeting it only helps you, answering and asking, and a pass after the call writes the notes'
    : 'It sits in on your meetings: it takes the notes, writes the summary and proposes changes'
}

/** Its tool scope, by the names the page shows ("Captures", "Contacts &
 *  Companies"); an id the page doesn't know, as words. */
function toolLabels(config: Record<string, unknown> | null): string[] {
  const enabled = Array.isArray(config?.enabled_tools) ? (config.enabled_tools as unknown[]) : []
  return enabled
    .filter((id): id is string => typeof id === 'string' && !!id.trim())
    .map((id) => TOOL_CATEGORIES.find((c) => c.id === id)?.label ?? id.replace(/[_-]+/g, ' ').trim())
}

/** A prompt's section titles, in order. */
function headingsOf(prompt: string): string[] {
  return parseSpeechBlocks(prompt)
    .filter((b) => b.kind === 'heading')
    .map((b) => clause(inlineToSpeech(b.lines.join(' '))))
    .filter((t): t is string => !!t)
}

export interface LibraryItemRow {
  id: string
  name: string | null
  description: string | null
  /** agent | skill */
  category: string | null
  slug: string | null
  is_system: boolean | null
  /** personal | workspace | public */
  visibility: string | null
  workspace_id: string | null
  /** An auth user id. */
  created_by: string | null
  system_prompt: string | null
  agent_config: Record<string, unknown> | null
}

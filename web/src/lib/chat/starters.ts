/**
 * First-run starters (docs/plans/one-agent-and-chat-pages.md, Part 2 "Two
 * things must exist before the nav can go"): what Native Intelligence can do, as a few
 * prompts grouped by area. Without a nav, this is how a new person learns what
 * Native Intelligence has. The empty main chat's composer rotates them through its
 * placeholder, between its default hint, and Tab sends the one showing
 * (chat/composer-suggestions.tsx).
 *
 * Two prompts for each of the areas that matter most, sales first (the edition
 * focus), and only for areas that are on in the workspace: the same view gate
 * the `/` pages and the page cards use (isViewAllowed over the composed edition).
 * Each prompt is a whole request in plain words, sent as the person's own
 * message, so none needs anything filled in.
 *
 * Client-safe and pure.
 */
import { isViewAllowed, type EditionDefinition, type EditionView } from '@/lib/editions/manifest'
import { editionWords } from '@/lib/editions/words'

export interface StarterArea {
  id: string
  label: string
  /** The page whose gate the area shares. */
  view: EditionView
  /** The person's own data: shown only where the chat may call this tool (as the `/` pages). */
  personalTool?: 'get_calendar_events' | 'list_emails'
  prompts: readonly string[]
}

export const STARTER_AREAS: readonly StarterArea[] = [
  {
    id: 'prospecting',
    label: 'Prospecting',
    view: 'prospecting',
    prompts: ['Find companies that fit my ideal customer', 'Research my company and suggest who to sell to'],
  },
  { id: 'crm', label: 'CRM', view: 'contacts', prompts: ['Who should I follow up with this week?', 'Show my newest contacts'] },
  { id: 'sequences', label: 'Sequences', view: 'sequences', prompts: ['How are my sequences doing?', 'Draft a three-step follow-up sequence'] },
  { id: 'calendar', label: 'Calendar', view: 'calendar', personalTool: 'get_calendar_events', prompts: ['What’s on my calendar today?', 'Prepare me for my next meeting'] },
  { id: 'mail', label: 'Mail', view: 'mail', personalTool: 'list_emails', prompts: ['Which emails need a reply?', 'Summarize my inbox'] },
  { id: 'actions', label: 'Actions', view: 'todo', prompts: ['What’s due this week?', 'Show my open actions'] },
  { id: 'captures', label: 'Captures', view: 'captures', prompts: ['Summarize my last meeting', 'What did we decide this week?'] },
  { id: 'knowledge', label: 'Knowledge', view: 'knowledge', prompts: ['What do we know about our customers?', 'Which questions are still open?'] },
]

/**
 * The areas this workspace has on, in order; calendar and mail only where the
 * chat may read them (`personalTools`, page-menu's personalToolsFor; absent:
 * every tool may).
 *
 * An edition with starters of its own (EditionWords.starters: a service
 * business asks about today's jobs, not prospects) picks the areas, their order
 * and their prompts; each keeps its own gates.
 */
export function startersFor(edition: EditionDefinition, personalTools?: (tool: string) => boolean): StarterArea[] {
  const own = editionWords(edition).starters
  const areas = own
    ? own.flatMap((s) => {
        const area = STARTER_AREAS.find((a) => a.view === s.view)
        return area ? [{ ...area, prompts: s.prompts }] : []
      })
    : STARTER_AREAS
  return areas.filter(
    (area) => isViewAllowed(edition, area.view) && (!area.personalTool || (personalTools?.(area.personalTool) ?? true)),
  )
}

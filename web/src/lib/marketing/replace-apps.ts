/**
 * The apps the /replace-apps calculator can add up, each with the price its
 * vendor publishes and the page that price was read from.
 *
 * WHAT IS IN THE LIST. Only apps whose whole job Native Intelligence does
 * today (a mail client, team chat, meeting notes, scheduling, tasks, docs,
 * tables, a CRM), priced per user, with a number read from
 * the vendor's own pages on PRICES_READ_ON. Left out on purpose: the mailbox
 * and calendar themselves (Google Workspace, Microsoft 365: we connect to
 * them, we do not replace them), video meetings with people outside the team,
 * screen recording, SEO tools and file storage (not a full replacement yet),
 * AI assistants (ours is part of the workspace, but a team may keep its own
 * as well), anything priced per account or per workspace rather than per
 * user, and any price that could only be found second hand.
 *
 * THE PRICE USED is the lower one where a vendor shows two: per user per
 * month on annual billing where the vendor's page states it, otherwise the
 * price the page shows (`billing` says which). That understates what the apps
 * cost a team paying monthly, which is the side to err on.
 *
 * Prices change. Re-read every `source` before changing a number, and move
 * PRICES_READ_ON with it; the page prints that date.
 */

export const REPLACED_CATEGORIES = [
  'Mail client',
  'Team chat',
  'Meeting notes',
  'Scheduling',
  'Tasks and projects',
  'Docs and wiki',
  'Tables',
  'CRM',
] as const

export type ReplacedCategory = (typeof REPLACED_CATEGORIES)[number]

export interface ReplacedApp {
  name: string
  category: ReplacedCategory
  /** The vendor's name for the plan priced here. */
  plan: string
  /** US dollars per user per month. */
  price: number
  /** `annual`: the page states it is the annual-billing price. `monthly`: the monthly list price. `shown`: the page shows it without saying which. */
  billing: 'annual' | 'monthly' | 'shown'
  /** The vendor's own page the price was read from. */
  source: string
}

/** The day every price below was read from its source. */
export const PRICES_READ_ON = '14 November 2026'

/** Native Intelligence, US dollars per seat per month (app/pricing/page.tsx). */
export const NI_PRICE_PER_SEAT = 99

export const REPLACED_APPS: readonly ReplacedApp[] = [
  { name: 'Superhuman', category: 'Mail client', plan: 'Mail Business', price: 33, billing: 'annual', source: 'https://superhuman.com/plans/mail' },

  { name: 'Slack', category: 'Team chat', plan: 'Pro', price: 7.25, billing: 'annual', source: 'https://slack.com/pricing' },

  { name: 'Otter', category: 'Meeting notes', plan: 'Business', price: 19.99, billing: 'annual', source: 'https://otter.ai/pricing' },
  { name: 'Fireflies', category: 'Meeting notes', plan: 'Business', price: 19, billing: 'annual', source: 'https://guide.fireflies.ai/articles/9606045468-fireflies-billing-terms' },
  { name: 'Granola', category: 'Meeting notes', plan: 'Business', price: 14, billing: 'shown', source: 'https://www.granola.ai/pricing' },

  { name: 'Calendly', category: 'Scheduling', plan: 'Teams', price: 16, billing: 'annual', source: 'https://calendly.com/pricing' },
  { name: 'Cal.com', category: 'Scheduling', plan: 'Teams', price: 12, billing: 'shown', source: 'https://cal.com/pricing' },

  { name: 'Linear', category: 'Tasks and projects', plan: 'Business', price: 16, billing: 'annual', source: 'https://linear.app/pricing' },
  { name: 'Jira', category: 'Tasks and projects', plan: 'Standard', price: 8.48, billing: 'shown', source: 'https://www.atlassian.com/en/software/jira/pricing' },
  { name: 'Asana', category: 'Tasks and projects', plan: 'Advanced', price: 24.99, billing: 'annual', source: 'https://asana.com/pricing' },
  { name: 'ClickUp', category: 'Tasks and projects', plan: 'Business', price: 17, billing: 'annual', source: 'https://clickup.com/pricing' },
  { name: 'monday.com', category: 'Tasks and projects', plan: 'Standard', price: 12, billing: 'annual', source: 'https://monday.com/pricing' },

  { name: 'Notion', category: 'Docs and wiki', plan: 'Business', price: 20, billing: 'shown', source: 'https://www.notion.com/pricing' },
  { name: 'Confluence', category: 'Docs and wiki', plan: 'Standard', price: 5.78, billing: 'shown', source: 'https://www.atlassian.com/en/software/confluence/pricing' },

  { name: 'Airtable', category: 'Tables', plan: 'Team', price: 20, billing: 'annual', source: 'https://airtable.com/pricing' },

  { name: 'HubSpot', category: 'CRM', plan: 'Sales Hub Professional', price: 100, billing: 'monthly', source: 'https://legal.hubspot.com/hubspot-product-and-services-catalog' },
  { name: 'Salesforce', category: 'CRM', plan: 'Pro Suite', price: 100, billing: 'annual', source: 'https://www.salesforce.com/sales/pricing/' },

]

/** What the calculator opens on: one common choice in each category. */
export const DEFAULT_SELECTION: readonly string[] = ['Superhuman', 'Slack', 'Otter', 'Calendly', 'Linear', 'Notion', 'Airtable', 'HubSpot']

export interface StackCost {
  /** The selected apps, per seat per month. */
  appsPerSeat: number
  appsPerYear: number
  niPerYear: number
  /** Negative when Native Intelligence costs more than the apps selected. */
  savingPerYear: number
}

/** The yearly bill for `selected` apps over `seats` seats, beside ours. Unknown names count for nothing. */
export function stackCost(selected: ReadonlySet<string>, seats: number): StackCost {
  const cents = REPLACED_APPS.filter((app) => selected.has(app.name)).reduce((sum, app) => sum + Math.round(app.price * 100), 0)
  const appsPerSeat = cents / 100
  const appsPerYear = (cents * seats * 12) / 100
  const niPerYear = NI_PRICE_PER_SEAT * seats * 12
  return { appsPerSeat, appsPerYear, niPerYear, savingPerYear: appsPerYear - niPerYear }
}

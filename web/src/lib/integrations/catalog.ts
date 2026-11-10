/**
 * The integration catalog — ONE definition per (provider, capability) pair.
 *
 * Before this module the same four facts (display name, description, lucide
 * fallback icon, brand mark) were written out by hand in four places:
 *
 *   1. the old Integrations card grid (now Settings › Connectors, connectors-view.tsx)
 *   2. settings/connectors/[provider]/[capability]/page.tsx — the full-page route
 *   3. (dashboard)/settings-overlay.tsx                   — the overlay's resolveView()
 *   4. .../integration-detail-view.tsx                    — ICON_COLORS + BRAND_ICONS
 *
 * Adding a provider meant editing all four, and missing #3 FAILED SILENTLY:
 * resolveView() returns null for an unknown pair and the overlay falls back to
 * the Preferences pane, so the integration simply appeared to not exist when
 * opened from the dashboard. That shipped three times (HubSpot, Asana, Jira).
 * `overlay-resolves-catalog.test.tsx` now derives its cases from CATALOG, so
 * the same omission is a red test rather than a silent misroute.
 *
 * ── Server/client boundary ────────────────────────────────────────────────
 * This module is PLAIN DATA on purpose: page.tsx is a server component and only
 * needs name/description, so it must not pull React components into its graph.
 * The brand marks and lucide icons live in the client-only companion module
 * `catalog-icons.tsx`, keyed by the same `${provider}:${capability}` id.
 *
 * ── Deliberately NOT here ─────────────────────────────────────────────────
 * OAuth scopes (`@/lib/oauth/config`) stay separate — that module is imported
 * by API routes and is kept free of anything UI. Likewise
 * `push-to-tracker-menu.tsx`'s LINK_PROVIDERS stays a literal so no
 * server-touching module is dragged into that client bundle.
 */

/** Stable key for a catalog entry: `${provider}:${capability}`. */
export type IntegrationKey = string

export interface IntegrationCatalogEntry {
  provider: string
  capability: string
  /** Heading shown on the card, the detail page, and the browser tab title. */
  name: string
  /** One-line subtitle under the name, identical on card and detail view. */
  description: string
  /**
   * Tailwind class tinting the lucide fallback icon. Only reached when the pair
   * has no brand mark in `catalog-icons.tsx`; every pair has one today, so this
   * is the value that would show if a mark were ever removed.
   */
  iconColor: string
}

export const INTEGRATION_CATALOG: readonly IntegrationCatalogEntry[] = [
  {
    provider: 'google',
    capability: 'calendar',
    name: 'Calendar',
    description: 'Schedule and manage calendar events',
    iconColor: 'text-blue-600',
  },
  {
    provider: 'google',
    capability: 'email',
    name: 'Gmail',
    description: 'Manage emails and drafts',
    iconColor: 'text-red-500',
  },
  {
    provider: 'microsoft',
    capability: 'calendar',
    name: 'Outlook Calendar',
    description: 'Schedule and manage calendar events',
    iconColor: 'text-blue-500',
  },
  {
    provider: 'microsoft',
    capability: 'email',
    name: 'Outlook Mail',
    description: 'Manage emails and drafts',
    iconColor: 'text-blue-700',
  },
  {
    provider: 'github',
    capability: 'github',
    name: 'GitHub',
    description: 'Link repositories and pull requests to projects and actions',
    iconColor: 'text-black dark:text-white',
  },
  {
    provider: 'google',
    capability: 'contacts',
    name: 'Google Contacts',
    description: 'Bring your contacts into the CRM (read only)',
    iconColor: 'text-blue-500',
  },
  {
    provider: 'hubspot',
    capability: 'crm',
    name: 'HubSpot',
    description: 'Sync contacts and companies from your HubSpot CRM',
    iconColor: 'text-[#FF7A59]',
  },
  {
    provider: 'brevo',
    capability: 'contacts',
    name: 'Brevo',
    description: 'Bring your Brevo contacts, companies and deals into the CRM (read only)',
    iconColor: 'text-[#0B996E]',
  },
  {
    provider: 'asana',
    capability: 'tasks',
    name: 'Asana',
    description: 'Push action items to Asana and keep completion in sync',
    iconColor: 'text-[#F06A6A]',
  },
  {
    provider: 'jira',
    capability: 'tasks',
    name: 'Jira',
    description: 'Push action items to Jira and keep issue status in sync',
    iconColor: 'text-[#0052CC]',
  },
  {
    provider: 'linear',
    capability: 'tasks',
    name: 'Linear',
    description: 'Push action items to Linear and keep issue state in sync',
    iconColor: 'text-[#5E6AD2]',
  },
]

export function integrationKey(provider: string, capability: string): IntegrationKey {
  return `${provider}:${capability}`
}

const BY_KEY = new Map<IntegrationKey, IntegrationCatalogEntry>(
  INTEGRATION_CATALOG.map((entry) => [integrationKey(entry.provider, entry.capability), entry]),
)

/** The catalog entry for a pair, or undefined when the pair isn't an integration. */
export function getIntegration(
  provider: string,
  capability: string,
): IntegrationCatalogEntry | undefined {
  return BY_KEY.get(integrationKey(provider, capability))
}

/**
 * The local macOS Exchange calendar. NOT in INTEGRATION_CATALOG: it isn't an
 * OAuth provider (EventKit permission, no `/api/oauth/*` route), it has its own
 * detail view and its own card footer, and it only exists on the desktop build.
 * Kept here so its copy lives beside the rest rather than in a component.
 */
export const LOCAL_EXCHANGE_ENTRY = {
  provider: 'local_exchange',
  capability: 'calendar',
  name: 'Exchange (Local Calendar)',
  description: 'Sync Exchange events from macOS Calendar app',
  iconColor: 'text-orange-500',
} as const

/**
 * Native Intelligence's own Slack app (docs/plans/slack-connect.md). NOT in
 * INTEGRATION_CATALOG either: nothing is synced and there's no OAuth account.
 * An admin adds the app to their Slack workspace, each person links their own
 * Slack account with a code, and they talk to their agent there. Its page is
 * `connectors/slack`. Not Slack's MCP server, which would be its own connector.
 */
export const SLACK_APP_ENTRY = {
  provider: 'slack',
  capability: 'messaging',
  name: 'Slack',
  description: 'Message your agent from Slack: DM it, or @mention it in a thread',
} as const

/**
 * Texting your agent (docs/plans/text-and-calling.md). Its page is Settings ›
 * Phone, the name the opt-in, terms and carrier registration all use; this row
 * only makes it findable from Connectors.
 */
export const TEXTING_ENTRY = {
  provider: 'sms',
  capability: 'messaging',
  name: 'Texting',
  description: 'Text your agent from your phone, and get a text when it needs your OK',
} as const

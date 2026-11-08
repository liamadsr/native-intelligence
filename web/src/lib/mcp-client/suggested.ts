/**
 * The vetted MCP servers Settings › Connectors' Discover offers with one
 * Connect (and the agent's connect tool can propose). The OAuth flow uses
 * standard RFC 9728/8414/7591 discovery against `server_url`.
 *
 * Being here is trust: a catalog server's own read-only hints count
 * (approval-policy.ts isCatalogServer), new connections skip the URL-server
 * ask-pins (tool-access.ts initialRequireApprovalTools), and a flow step that
 * read outside text may still call it without a card unless the input carries
 * a URL (input-policy.ts connectorCallPolicy, outside_egress). The entry is
 * matched by HOST (suggestedMcpServerFor), so a lookalike URL is never it.
 * So an entry is added only when ALL of these hold (and recorded in `vetted`):
 *
 *   1. The vendor runs it on its own domain: the server AND its sign-in
 *      (authorization server) are the vendor's.
 *   2. It is listed in Anthropic's Connectors Directory and/or the official
 *      MCP Registry under the vendor's own verified domain (the open
 *      registry alone is not trust: anyone publishes, and a namespace does
 *      not prove the URL is theirs).
 *   3. People sign in at the vendor with OAuth; no pasted API keys. Our
 *      start route needs dynamic client registration: check that the
 *      vendor accepts Native Intelligence's client and redirect (https://dial8.ai/api/
 *      mcp-oauth/callback) and that its authorize page loads (Figma, Canva,
 *      Gamma, Intercom and Vercel refused it on 2026-10-22; Asana, HubSpot,
 *      GitHub, Slack, Box, DocuSign and PagerDuty need a registered app).
 *   4. Its writes are judged: `alwaysAskWrites` when they reach other
 *      people or the public, run automations or requests, or change a live
 *      database or product (feature flags).
 *
 * Payment apps (Stripe, PayPal, Square) are held back on purpose, and an
 * endpoint built for one client (`…/anthropic`, `…/claude_app_mcp`) is never
 * used. Anything else is still connectable by URL (Add custom connector).
 */
import type { ConnectorCategory } from '@/lib/integrations/connector-categories'

export interface SuggestedMcpServer {
  id: string
  display_name: string
  server_url: string
  transport: 'streamable_http' | 'sse'
  description: string
  /** Discover's category (connector-categories.ts). */
  category: ConnectorCategory
  /**
   * The inclusion check above: when it was last done, and where the vendor
   * lists this server ('anthropic': the Connectors Directory; 'registry':
   * the official MCP Registry under the vendor's verified domain).
   */
  vetted: { checked: string; listedIn: readonly ('anthropic' | 'registry')[] }
  /** Brand colour token used to tint the icon background. Tailwind class. */
  accent: string
  /**
   * Inline SVG path data for a monochrome brand mark, tinted via the `accent`
   * background chip. Use this for single-colour marks. For full-colour official
   * logos, set `iconSvg` instead (it takes precedence and renders on a neutral
   * white chip so the brand colours read correctly).
   */
  iconPath?: string
  iconViewBox?: string
  /**
   * Full-colour official logo as raw inner SVG markup (paths/defs, no wrapping
   * <svg>). When set, it renders on a white chip instead of the tinted `accent`
   * background. The wrapping <svg> supplies the viewBox from `iconViewBox`.
   */
  iconSvg?: string
  /** Notes shown under the title — e.g., scope summary, "requires admin". */
  note?: string
  /**
   * Every tool that is not a plain read ALWAYS asks before each call,
   * whatever the person or the agent set (approval-policy.ts
   * catalogAlwaysAsks): for an app that publishes for the person.
   */
  alwaysAskWrites?: boolean
}

/** The host a server URL points at, lowercased; '' for an unparseable one. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** The catalog entry by id, if there is one. */
export function suggestedMcpServerById(id: string): SuggestedMcpServer | undefined {
  return SUGGESTED_MCP_SERVERS.find((s) => s.id === id)
}

/** Host → entry, built on first use (the policy asks per tool, per turn). */
let byHost: Map<string, SuggestedMcpServer> | null = null

/**
 * The catalog entry a server URL belongs to (same host: Linear's old /sse
 * endpoint and its /mcp one are the same app), if any. A URL on any other
 * host is not a catalog server, whatever it is named.
 */
export function suggestedMcpServerFor(url: string): SuggestedMcpServer | undefined {
  const host = hostOf(url)
  if (!host) return undefined
  byHost ??= new Map(SUGGESTED_MCP_SERVERS.map((s) => [hostOf(s.server_url), s]))
  return byHost.get(host)
}

export const SUGGESTED_MCP_SERVERS: SuggestedMcpServer[] = [
  {
    id: 'atlassian',
    display_name: 'Atlassian',
    // Atlassian's hosted MCP endpoint — see developer.atlassian.com.
    server_url: 'https://mcp.atlassian.com/v1/sse',
    transport: 'sse',
    category: 'projects',
    description: 'Jira issues and Confluence pages',
    note: 'Authenticate with your Atlassian account',
    accent: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
    // Official Atlassian corporate logo (blue gradient "A"). Full colour → white chip.
    iconViewBox: '0 0 256 256',
    iconSvg:
      '<defs><linearGradient x1="99.7%" y1="15.8%" x2="39.8%" y2="97.4%" id="atlassian-mcp-a"><stop stop-color="#0052CC" offset="0%"/><stop stop-color="#2684FF" offset="92.3%"/></linearGradient></defs><path d="M76 118c-4-4-10-4-13 1L1 245a7 7 0 0 0 6 10h88c3 0 5-1 6-4 19-39 8-98-25-133Z" fill="url(#atlassian-mcp-a)"/><path d="M122 4c-35 56-33 117-10 163l42 84c1 3 4 4 7 4h87a7 7 0 0 0 7-10L134 4c-2-5-9-5-12 0Z" fill="#2681FF"/>',
    vetted: { checked: '2026-10-22', listedIn: ['anthropic', 'registry'] },
  },
  {
    id: 'linear',
    display_name: 'Linear',
    // Linear deprecated the SSE endpoint on 2026-04-08 in favour of
    // Streamable HTTP at /mcp.
    server_url: 'https://mcp.linear.app/mcp',
    transport: 'streamable_http',
    category: 'projects',
    description: 'Issues, projects, and cycles',
    note: 'Authenticate with your Linear workspace',
    accent: 'bg-violet-500/10 text-violet-600 dark:text-violet-400',
    // Official Linear mark in brand purple (#5E6AD2). Full colour → white chip.
    iconViewBox: '0 0 100 100',
    iconSvg:
      '<path fill="#5E6AD2" d="M1.225 61.523c-.222-.949.908-1.546 1.597-.857l36.512 36.512c.69.69.092 1.82-.857 1.597-18.425-4.323-32.93-18.827-37.252-37.252ZM.002 46.889a.99.99 0 0 0 .29.76L52.35 99.71c.201.2.478.307.76.29 2.37-.149 4.695-.46 6.963-.927.765-.157 1.03-1.096.478-1.648L2.576 39.448c-.552-.551-1.491-.286-1.648.479a50.067 50.067 0 0 0-.926 6.962ZM4.21 29.705a.988.988 0 0 0 .208 1.1l64.776 64.776c.289.29.726.375 1.1.208a49.908 49.908 0 0 0 5.185-2.684.981.981 0 0 0 .183-1.54L8.436 24.336a.981.981 0 0 0-1.541.183 49.896 49.896 0 0 0-2.684 5.185Zm8.448-11.631a.986.986 0 0 1-.045-1.354C21.78 6.46 35.111 0 49.952 0 77.592 0 100 22.407 100 50.048c0 14.84-6.46 28.172-16.72 37.338a.986.986 0 0 1-1.354-.045L12.659 18.074Z"/>',
    vetted: { checked: '2026-10-22', listedIn: ['anthropic', 'registry'] },
  },
  {
    // Social posts and threads for X, LinkedIn, Threads, Bluesky and Mastodon
    // (docs/plans/content-skill-set.md §8, the C2a route). Typefully's own
    // MCP server, per-person OAuth (the template's app-wide API key is what we
    // avoid). The endpoint is the one Vercel's typefully-eve-template uses.
    // Checked 2026-10-20 from its public metadata (no account connected):
    // mcp.typefully.com/.well-known/oauth-protected-resource names the
    // authorization server api.typefully.com, whose metadata advertises
    // dynamic client registration (/oauth2/register, which our start route
    // needs), PKCE S256 and a public client (auth method none), scope
    // full_access. Its tool names are not verified (no account connected), so
    // nothing below depends on them.
    id: 'typefully',
    display_name: 'Typefully',
    server_url: 'https://mcp.typefully.com/mcp',
    transport: 'streamable_http',
    category: 'sales',
    description: 'Draft, schedule and publish social posts',
    note: 'Authenticate with your Typefully account',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    // No brand mark here: its initial shows (RowIcon) until we have Typefully's own.
    // Decision 2, "user always approves": every tool that is not a plain read
    // (a read-shaped name, no hint saying otherwise) asks before every call,
    // whatever anyone sets. By shape, not by name, since the names are not
    // verified: create_draft and edit_draft publish when given a publish_at,
    // so they ask too. Letting an inert draft (no publish_at) run is an
    // input-aware rule (pattern P7), P7's to build, not a setting here.
    alwaysAskWrites: true,
    vetted: { checked: '2026-10-22', listedIn: ['registry'] },
  },
  // Added 2026-10-22 under the rules above (each checked with Native Intelligence's real
  // discovery, registration and authorize steps). Brand marks are simple-icons
  // 16.33.0 path data (CC0); a vendor it lacks shows its initial.
  {
    id: 'notion',
    display_name: 'Notion',
    server_url: 'https://mcp.notion.com/mcp',
    transport: 'streamable_http',
    category: 'projects',
    description: 'Pages, databases and notes in your workspace',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    iconViewBox: '0 0 24 24',
    iconSvg: '<path fill="currentColor" d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z"/>',
    vetted: { checked: '2026-10-22', listedIn: ['anthropic', 'registry'] },
  },
  {
    id: 'monday',
    display_name: 'monday.com',
    server_url: 'https://mcp.monday.com/mcp',
    transport: 'streamable_http',
    category: 'projects',
    description: 'Boards, items and updates',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    vetted: { checked: '2026-10-22', listedIn: ['anthropic', 'registry'] },
  },
  {
    id: 'clickup',
    display_name: 'ClickUp',
    server_url: 'https://mcp.clickup.com/mcp',
    transport: 'streamable_http',
    category: 'projects',
    description: 'Tasks, docs and your workspace hierarchy',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    iconViewBox: '0 0 24 24',
    iconSvg: '<path fill="#7B68EE" d="M2 18.439l3.69-2.828c1.961 2.56 4.044 3.739 6.363 3.739 2.307 0 4.33-1.166 6.203-3.704L22 18.405C19.298 22.065 15.941 24 12.053 24 8.178 24 4.788 22.078 2 18.439zM12.04 6.15l-6.568 5.66-3.036-3.52L12.055 0l9.543 8.296-3.05 3.509z"/>',
    vetted: { checked: '2026-10-22', listedIn: ['anthropic'] },
  },
  {
    id: 'airtable',
    display_name: 'Airtable',
    server_url: 'https://mcp.airtable.com/mcp',
    transport: 'streamable_http',
    category: 'projects',
    description: 'Bases, tables and records',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    iconViewBox: '0 0 24 24',
    iconSvg: '<path fill="#18BFFF" d="M11.992 1.966c-.434 0-.87.086-1.28.257L1.779 5.917c-.503.208-.49.908.012 1.116l8.982 3.558a3.266 3.266 0 0 0 2.454 0l8.982-3.558c.503-.196.503-.908.012-1.116l-8.957-3.694a3.255 3.255 0 0 0-1.272-.257zM23.4 8.056a.589.589 0 0 0-.222.045l-10.012 3.877a.612.612 0 0 0-.38.564v8.896a.6.6 0 0 0 .821.552L23.62 18.1a.583.583 0 0 0 .38-.551V8.653a.6.6 0 0 0-.6-.596zM.676 8.095a.644.644 0 0 0-.48.19C.086 8.396 0 8.53 0 8.69v8.355c0 .442.515.737.908.54l6.27-3.006.307-.147 2.969-1.436c.466-.22.43-.908-.061-1.092L.883 8.138a.57.57 0 0 0-.207-.044z"/>',
    vetted: { checked: '2026-10-22', listedIn: ['registry'] },
  },
  {
    id: 'miro',
    display_name: 'Miro',
    server_url: 'https://mcp.miro.com/',
    transport: 'streamable_http',
    category: 'projects',
    description: 'Boards, diagrams and docs',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    iconViewBox: '0 0 24 24',
    iconSvg: '<path fill="currentColor" d="M17.392 0H13.9L17 4.808 10.444 0H6.949l3.102 6.3L3.494 0H0l3.05 8.131L0 24h3.494L10.05 6.985 6.949 24h3.494L17 5.494 13.899 24h3.493L24 3.672 17.392 0z"/>',
    vetted: { checked: '2026-10-22', listedIn: ['anthropic'] },
  },
  {
    id: 'calendly',
    display_name: 'Calendly',
    server_url: 'https://mcp.calendly.com/',
    transport: 'streamable_http',
    category: 'calendar',
    description: 'Event types, availability and bookings',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    iconViewBox: '0 0 24 24',
    iconSvg: '<path fill="#006BFF" d="M19.655 14.262c.281 0 .557.023.828.064 0 .005-.005.01-.005.014-.105.267-.234.534-.381.786l-1.219 2.106c-1.112 1.936-3.177 3.127-5.411 3.127h-2.432c-2.23 0-4.294-1.191-5.412-3.127l-1.218-2.106a6.251 6.251 0 0 1 0-6.252l1.218-2.106C6.736 4.832 8.8 3.641 11.035 3.641h2.432c2.23 0 4.294 1.191 5.411 3.127l1.219 2.106c.147.252.271.519.381.786 0 .004.005.009.005.014-.267.041-.543.064-.828.064-1.816 0-2.501-.607-3.291-1.306-.764-.676-1.711-1.517-3.44-1.517h-1.029c-1.251 0-2.387.455-3.2 1.278-.796.805-1.233 1.904-1.233 3.099v1.411c0 1.196.437 2.295 1.233 3.099.813.823 1.949 1.278 3.2 1.278h1.034c1.729 0 2.676-.841 3.439-1.517.791-.703 1.471-1.306 3.287-1.301Zm.005-3.237c.399 0 .794-.036 1.179-.11-.002-.004-.002-.01-.002-.014-.073-.414-.193-.823-.349-1.218.731-.12 1.407-.396 1.986-.819 0-.004-.005-.013-.005-.018-.331-1.085-.832-2.101-1.489-3.03-.649-.915-1.435-1.719-2.331-2.395-1.867-1.398-4.088-2.138-6.428-2.138-1.448 0-2.855.28-4.175.841-1.273.543-2.423 1.315-3.407 2.299S2.878 6.552 2.341 7.83c-.557 1.324-.842 2.726-.842 4.175 0 1.448.281 2.855.842 4.174.542 1.274 1.314 2.423 2.298 3.407s2.129 1.761 3.407 2.299c1.324.556 2.727.841 4.175.841 2.34 0 4.561-.74 6.428-2.137a10.815 10.815 0 0 0 2.331-2.396c.652-.929 1.158-1.949 1.489-3.03 0-.004.005-.014.005-.018-.579-.423-1.255-.699-1.986-.819.161-.395.276-.804.349-1.218.005-.009.005-.014.005-.023.869.166 1.692.506 2.404 1.035.685.505.552 1.075.446 1.416C22.184 20.437 17.619 24 12.221 24c-6.625 0-12-5.375-12-12s5.37-12 12-12c5.398 0 9.963 3.563 11.471 8.464.106.341.239.915-.446 1.421-.717.529-1.535.873-2.404 1.034.128.716.128 1.45 0 2.166-.387-.074-.782-.11-1.182-.11-4.184 0-3.968 2.823-6.736 2.823h-1.029c-1.899 0-3.15-1.357-3.15-3.095v-1.411c0-1.738 1.251-3.094 3.15-3.094h1.034c2.768 0 2.552 2.823 6.731 2.827Z"/>',
    alwaysAskWrites: true,
    vetted: { checked: '2026-10-22', listedIn: ['anthropic'] },
  },
  {
    id: 'granola',
    display_name: 'Granola',
    server_url: 'https://mcp.granola.ai/mcp',
    transport: 'streamable_http',
    category: 'meetings',
    description: 'Your meeting notes and transcripts',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    vetted: { checked: '2026-10-22', listedIn: ['anthropic'] },
  },
  {
    id: 'fireflies',
    display_name: 'Fireflies',
    server_url: 'https://api.fireflies.ai/mcp',
    transport: 'streamable_http',
    category: 'meetings',
    description: 'Meeting transcripts, summaries and action items',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    vetted: { checked: '2026-10-22', listedIn: ['registry'] },
  },
  {
    id: 'guru',
    display_name: 'Guru',
    server_url: 'https://mcp.api.getguru.com/mcp',
    transport: 'streamable_http',
    category: 'meetings',
    description: 'Your team\'s verified knowledge cards',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    vetted: { checked: '2026-10-22', listedIn: ['registry'] },
  },
  {
    id: 'egnyte',
    display_name: 'Egnyte',
    server_url: 'https://mcp-server.egnyte.com/mcp',
    transport: 'streamable_http',
    category: 'meetings',
    description: 'Files and folders in Egnyte',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    alwaysAskWrites: true,
    vetted: { checked: '2026-10-22', listedIn: ['registry'] },
  },
  {
    id: 'attio',
    display_name: 'Attio',
    server_url: 'https://mcp.attio.com/mcp',
    transport: 'streamable_http',
    category: 'sales',
    description: 'CRM records, notes and tasks',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    vetted: { checked: '2026-10-22', listedIn: ['anthropic'] },
  },
  {
    id: 'close',
    display_name: 'Close',
    server_url: 'https://mcp.close.com/mcp',
    transport: 'streamable_http',
    category: 'sales',
    description: 'Leads, contacts and sales activity',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    alwaysAskWrites: true,
    vetted: { checked: '2026-10-22', listedIn: ['anthropic', 'registry'] },
  },
  {
    id: 'klaviyo',
    display_name: 'Klaviyo',
    server_url: 'https://mcp.klaviyo.com/mcp',
    transport: 'streamable_http',
    category: 'sales',
    description: 'Email and SMS campaigns, flows and metrics',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    alwaysAskWrites: true,
    vetted: { checked: '2026-10-22', listedIn: ['anthropic'] },
  },
  {
    id: 'supermetrics',
    display_name: 'Supermetrics',
    server_url: 'https://mcp.supermetrics.com/mcp',
    transport: 'streamable_http',
    category: 'sales',
    description: 'Marketing data from ads, analytics and social',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    vetted: { checked: '2026-10-22', listedIn: ['anthropic', 'registry'] },
  },
  {
    id: 'sentry',
    display_name: 'Sentry',
    server_url: 'https://mcp.sentry.dev/mcp',
    transport: 'streamable_http',
    category: 'engineering',
    description: 'Errors, issues and releases',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    iconViewBox: '0 0 24 24',
    iconSvg: '<path fill="currentColor" d="M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z"/>',
    vetted: { checked: '2026-10-22', listedIn: ['anthropic'] },
  },
  {
    id: 'gitlab',
    display_name: 'GitLab',
    server_url: 'https://gitlab.com/api/v4/mcp',
    transport: 'streamable_http',
    category: 'engineering',
    description: 'Projects, issues and merge requests',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    iconViewBox: '0 0 24 24',
    iconSvg: '<path fill="#FC6D26" d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z"/>',
    alwaysAskWrites: true,
    vetted: { checked: '2026-10-22', listedIn: ['registry'] },
  },
  {
    id: 'supabase',
    display_name: 'Supabase',
    server_url: 'https://mcp.supabase.com/mcp',
    transport: 'streamable_http',
    category: 'engineering',
    description: 'Projects, tables and database queries',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    iconViewBox: '0 0 24 24',
    iconSvg: '<path fill="#3FCF8E" d="M11.9 1.036c-.015-.986-1.26-1.41-1.874-.637L.764 12.05C-.33 13.427.65 15.455 2.409 15.455h9.579l.113 7.51c.014.985 1.259 1.408 1.873.636l9.262-11.653c1.093-1.375.113-3.403-1.645-3.403h-9.642z"/>',
    alwaysAskWrites: true,
    vetted: { checked: '2026-10-22', listedIn: ['registry'] },
  },
  {
    id: 'posthog',
    display_name: 'PostHog',
    server_url: 'https://mcp.posthog.com/mcp',
    transport: 'streamable_http',
    category: 'engineering',
    description: 'Product analytics, insights and feature flags',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    iconViewBox: '0 0 24 24',
    iconSvg: '<path fill="currentColor" d="M9.854 14.5 5 9.647.854 5.5A.5.5 0 0 0 0 5.854V8.44a.5.5 0 0 0 .146.353L5 13.647l.147.146L9.854 18.5l.146.147v-.049c.065.03.134.049.207.049h2.586a.5.5 0 0 0 .353-.854L9.854 14.5zm0-5-4-4a.487.487 0 0 0-.409-.144.515.515 0 0 0-.356.21.493.493 0 0 0-.089.288V8.44a.5.5 0 0 0 .147.353l9 9a.5.5 0 0 0 .853-.354v-2.585a.5.5 0 0 0-.146-.354l-5-5zm1-4a.5.5 0 0 0-.854.354V8.44a.5.5 0 0 0 .147.353l4 4a.5.5 0 0 0 .853-.354V9.854a.5.5 0 0 0-.146-.354l-4-4zm12.647 11.515a3.863 3.863 0 0 1-2.232-1.1l-4.708-4.707a.5.5 0 0 0-.854.354v6.585a.5.5 0 0 0 .5.5H23.5a.5.5 0 0 0 .5-.5v-.6c0-.276-.225-.497-.499-.532zm-5.394.032a.8.8 0 1 1 0-1.6.8.8 0 0 1 0 1.6zM.854 15.5a.5.5 0 0 0-.854.354v2.293a.5.5 0 0 0 .5.5h2.293c.222 0 .39-.135.462-.309a.493.493 0 0 0-.109-.545L.854 15.501zM5 14.647.854 10.5a.5.5 0 0 0-.854.353v2.586a.5.5 0 0 0 .146.353L4.854 18.5l.146.147h2.793a.5.5 0 0 0 .353-.854L5 14.647z"/>',
    alwaysAskWrites: true,
    vetted: { checked: '2026-10-22', listedIn: ['anthropic'] },
  },
  {
    id: 'amplitude',
    display_name: 'Amplitude',
    server_url: 'https://mcp.amplitude.com/mcp',
    transport: 'streamable_http',
    category: 'engineering',
    description: 'Product analytics charts and metrics',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    vetted: { checked: '2026-10-22', listedIn: ['registry'] },
  },
  {
    id: 'postman',
    display_name: 'Postman',
    server_url: 'https://mcp.postman.com/mcp',
    transport: 'streamable_http',
    category: 'engineering',
    description: 'API collections, requests and workspaces',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    iconViewBox: '0 0 24 24',
    iconSvg: '<path fill="#FF6C37" d="M13.527.099C6.955-.744.942 3.9.099 10.473c-.843 6.572 3.8 12.584 10.373 13.428 6.573.843 12.587-3.801 13.428-10.374C24.744 6.955 20.101.943 13.527.099zm2.471 7.485a.855.855 0 0 0-.593.25l-4.453 4.453-.307-.307-.643-.643c4.389-4.376 5.18-4.418 5.996-3.753zm-4.863 4.861l4.44-4.44a.62.62 0 1 1 .847.903l-4.699 4.125-.588-.588zm.33.694l-1.1.238a.06.06 0 0 1-.067-.032.06.06 0 0 1 .01-.073l.645-.645.512.512zm-2.803-.459l1.172-1.172.879.878-1.979.426a.074.074 0 0 1-.085-.039.072.072 0 0 1 .013-.093zm-3.646 6.058a.076.076 0 0 1-.069-.083.077.077 0 0 1 .022-.046h.002l.946-.946 1.222 1.222-2.123-.147zm2.425-1.256a.228.228 0 0 0-.117.256l.203.865a.125.125 0 0 1-.211.117h-.003l-.934-.934-.294-.295 3.762-3.758 1.82-.393.874.874c-1.255 1.102-2.971 2.201-5.1 3.268zm5.279-3.428h-.002l-.839-.839 4.699-4.125a.952.952 0 0 0 .119-.127c-.148 1.345-2.029 3.245-3.977 5.091zm3.657-6.46l-.003-.002a1.822 1.822 0 0 1 2.459-2.684l-1.61 1.613a.119.119 0 0 0 0 .169l1.247 1.247a1.817 1.817 0 0 1-2.093-.343zm2.578 0a1.714 1.714 0 0 1-.271.218h-.001l-1.207-1.207 1.533-1.533c.661.72.637 1.832-.054 2.522zM18.855 6.05a.143.143 0 0 0-.053.157.416.416 0 0 1-.053.45.14.14 0 0 0 .023.197.141.141 0 0 0 .084.03.14.14 0 0 0 .106-.05.691.691 0 0 0 .087-.751.138.138 0 0 0-.194-.033z"/>',
    alwaysAskWrites: true,
    vetted: { checked: '2026-10-22', listedIn: ['registry'] },
  },
  {
    id: 'jam',
    display_name: 'Jam',
    server_url: 'https://mcp.jam.dev/mcp',
    transport: 'streamable_http',
    category: 'engineering',
    description: 'Bug reports with recordings and logs',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    vetted: { checked: '2026-10-22', listedIn: ['registry'] },
  },
  {
    id: 'clickhouse',
    display_name: 'ClickHouse',
    server_url: 'https://mcp.clickhouse.cloud/mcp',
    transport: 'streamable_http',
    category: 'engineering',
    description: 'ClickHouse Cloud services and queries',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    iconViewBox: '0 0 24 24',
    iconSvg: '<path fill="currentColor" d="M21.333 10H24v4h-2.667ZM16 1.335h2.667v21.33H16Zm-5.333 0h2.666v21.33h-2.666ZM0 22.665V1.335h2.667v21.33zm5.333-21.33H8v21.33H5.333Z"/>',
    vetted: { checked: '2026-10-22', listedIn: ['anthropic'] },
  },
  {
    id: 'contentful',
    display_name: 'Contentful',
    server_url: 'https://mcp.contentful.com/mcp',
    transport: 'streamable_http',
    category: 'sites',
    description: 'Content types, entries and assets',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    iconViewBox: '0 0 24 24',
    iconSvg: '<path fill="#2478CC" d="M21.875 16.361c-.043-.048-1.067-1.18-2.365-1.19-.68 0-1.288.283-1.815.858-.773.842-2.35 1.85-4.25 1.921-1.598.059-3.085-.548-4.423-1.805-1.644-1.544-2.155-4.016-1.302-6.297.834-2.23 2.752-3.616 5.131-3.707l.044-.004c.024-.003 2.302-.258 4.325 1.548.17.185 1.154 1.197 2.475 1.228.823.018 1.586-.336 2.27-1.055.602-.632.87-1.342.797-2.112-.154-1.61-1.806-2.876-2.03-3.04-.212-.184-1.878-1.578-4.476-2.294-2.52-.695-6.42-.853-10.685 2.349a7.31 7.31 0 0 0-.557.49c-.28.208-.523.462-.716.753a12.469 12.469 0 0 0-3.064 8.677c.207 6.283 5.265 9.293 5.646 9.51.262.17 2.906 1.81 6.495 1.809 2.106 0 4.538-.565 7.005-2.322.248-.138 1.714-1.012 2.103-2.52.23-.894.042-1.815-.562-2.737l-.046-.06zm-16.932 1.97c0-1.09.887-1.977 1.977-1.977s1.977.886 1.977 1.977c0 1.09-.887 1.977-1.977 1.977s-1.977-.887-1.977-1.977zm.139-13.657c.236-.275.451-.498.628-.67a1.965 1.965 0 0 1 1.088-.329c1.09 0 1.977.887 1.977 1.977S7.888 7.63 6.798 7.63s-1.977-.887-1.977-1.977c0-.356.096-.69.261-.978zM13.249.999c3.954 0 6.657 2.336 6.826 2.486l.043.034c.42.3 1.532 1.301 1.63 2.324.044.469-.126.898-.52 1.313-.477.5-.983.752-1.504.738-.964-.019-1.743-.887-1.76-.905l-.042-.044c-2.292-2.063-4.83-1.855-5.13-1.822a6.82 6.82 0 0 0-3.012.818 3 3 0 0 0-2.34-3.214C9.543 1.45 11.516.999 13.248.999zM3.884 6.34a3 3 0 0 0 2.914 2.31c.122 0 .24-.01.358-.024a7.336 7.336 0 0 0-.39.866c-.75 2.003-.59 4.14.359 5.854-.068-.005-.136-.01-.205-.01a2.999 2.999 0 0 0-2.967 2.6 10.075 10.075 0 0 1-1.7-5.288 11.43 11.43 0 0 1 1.63-6.309zM21.497 18.9c-.3 1.174-1.615 1.89-1.627 1.896l-.058.036c-6.287 4.499-12.137.667-12.382.502l-.036-.022a2.848 2.848 0 0 1-.034-.02 2.998 2.998 0 0 0 2.543-3.228c1.124.64 2.336.951 3.58.906 2.214-.083 4.057-1.264 4.962-2.25.327-.356.67-.53 1.048-.53h.005c.762.004 1.46.688 1.593.826.421.658.558 1.291.406 1.884z"/>',
    alwaysAskWrites: true,
    vetted: { checked: '2026-10-22', listedIn: ['anthropic'] },
  },
  {
    id: 'webflow',
    display_name: 'Webflow',
    server_url: 'https://mcp.webflow.com/mcp',
    transport: 'streamable_http',
    category: 'sites',
    description: 'Sites, pages and CMS collections',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    iconViewBox: '0 0 24 24',
    iconSvg: '<path fill="#146EF5" d="m24 4.515-7.658 14.97H9.149l3.205-6.204h-.144C9.566 16.713 5.621 18.973 0 19.485v-6.118s3.596-.213 5.71-2.435H0V4.515h6.417v5.278l.144-.001 2.622-5.277h4.854v5.244h.144l2.72-5.244H24Z"/>',
    alwaysAskWrites: true,
    vetted: { checked: '2026-10-22', listedIn: ['registry'] },
  },
  {
    id: 'wix',
    display_name: 'Wix',
    server_url: 'https://mcp.wix.com/mcp',
    transport: 'streamable_http',
    category: 'sites',
    description: 'Sites, stores and bookings',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    iconViewBox: '0 0 24 24',
    iconSvg: '<path fill="#0C6EFC" d="m0 7.354 2.113 9.292h.801a1.54 1.54 0 0 0 1.506-1.218l1.351-6.34a.171.171 0 0 1 .167-.137c.08 0 .15.058.167.137l1.352 6.34a1.54 1.54 0 0 0 1.506 1.218h.805l2.113-9.292h-.565c-.62 0-1.159.43-1.296 1.035l-1.26 5.545-1.106-5.176a1.76 1.76 0 0 0-2.19-1.324c-.639.176-1.113.716-1.251 1.365l-1.094 5.127-1.26-5.537A1.33 1.33 0 0 0 .563 7.354H0zm13.992 0a.951.951 0 0 0-.951.95v8.342h.635a.952.952 0 0 0 .951-.95V7.353h-.635zm1.778 0 3.158 4.66-3.14 4.632h1.325c.368 0 .712-.181.918-.486l1.756-2.59a.12.12 0 0 1 .197 0l1.754 2.59c.206.305.55.486.918.486h1.326l-3.14-4.632L24 7.354h-1.326c-.368 0-.712.181-.918.486l-1.772 2.617a.12.12 0 0 1-.197 0L18.014 7.84a1.108 1.108 0 0 0-.918-.486H15.77z"/>',
    alwaysAskWrites: true,
    vetted: { checked: '2026-10-22', listedIn: ['registry'] },
  },
  {
    id: 'zapier',
    display_name: 'Zapier',
    server_url: 'https://mcp.zapier.com/api/v1/connect',
    transport: 'streamable_http',
    category: 'automation',
    description: 'Run your Zaps and thousands of app actions',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    iconViewBox: '0 0 24 24',
    iconSvg: '<path fill="#FF4F00" d="M4.157 0A4.151 4.151 0 0 0 0 4.161v15.678A4.151 4.151 0 0 0 4.157 24h15.682A4.152 4.152 0 0 0 24 19.839V4.161A4.152 4.152 0 0 0 19.839 0H4.157Zm10.61 8.761h.03a.577.577 0 0 1 .23.038.585.585 0 0 1 .201.124.63.63 0 0 1 .162.431.612.612 0 0 1-.162.435.58.58 0 0 1-.201.128.58.58 0 0 1-.23.042.529.529 0 0 1-.235-.042.585.585 0 0 1-.332-.328.559.559 0 0 1-.038-.235.613.613 0 0 1 .17-.431.59.59 0 0 1 .405-.162Zm2.853 1.572c.03.004.061.004.095.004.325-.011.646.064.937.219.238.144.431.355.552.609.128.279.189.582.185.888v.193a2 2 0 0 1 0 .219h-2.498c.003.227.075.45.204.642a.78.78 0 0 0 .646.265.714.714 0 0 0 .484-.136.642.642 0 0 0 .23-.318l.915.257a1.398 1.398 0 0 1-.28.537c-.14.159-.321.284-.521.355a2.234 2.234 0 0 1-.836.136 1.923 1.923 0 0 1-1.001-.245 1.618 1.618 0 0 1-.665-.703 2.221 2.221 0 0 1-.227-1.036 1.95 1.95 0 0 1 .48-1.398 1.9 1.9 0 0 1 1.3-.488Zm-9.607.023c.162.004.325.026.48.079.207.065.4.174.563.314.26.302.393.692.366 1.088v2.276H8.53l-.109-.711h-.065c-.064.163-.155.31-.272.439a1.122 1.122 0 0 1-.374.264 1.023 1.023 0 0 1-.453.083 1.334 1.334 0 0 1-.866-.264.965.965 0 0 1-.329-.801.993.993 0 0 1 .076-.431 1.02 1.02 0 0 1 .242-.363 1.478 1.478 0 0 1 1.043-.303h.952v-.181a.696.696 0 0 0-.136-.454.553.553 0 0 0-.438-.154.695.695 0 0 0-.378.086.48.48 0 0 0-.193.254l-.99-.144a1.26 1.26 0 0 1 .257-.563c.14-.174.321-.302.533-.378.261-.091.54-.136.82-.129.053-.003.106-.007.163-.007Zm4.384.007c.174 0 .347.038.506.114.182.083.34.211.458.374.257.423.377.911.351 1.406a2.53 2.53 0 0 1-.355 1.448 1.148 1.148 0 0 1-1.009.517c-.204 0-.401-.045-.582-.136a1.052 1.052 0 0 1-.48-.457 1.298 1.298 0 0 1-.114-.234h-.045l.004 1.784h-1.059v-4.713h.904l.117.805h.057c.068-.208.177-.401.328-.56a1.129 1.129 0 0 1 .843-.344h.076v-.004Zm7.559.084h.903l.113.805h.053a1.37 1.37 0 0 1 .235-.484.813.813 0 0 1 .313-.242.82.82 0 0 1 .39-.076h.234v1.051h-.401a.662.662 0 0 0-.313.008.623.623 0 0 0-.272.155.663.663 0 0 0-.174.26.683.683 0 0 0-.027.314v1.875h-1.054v-3.666Zm-17.515.003h3.262v.896L3.73 13.104l.034.113h1.973l.042.9H2.4v-.9l1.931-1.754-.045-.117H2.441v-.896Zm11.815 0h1.055v3.659h-1.055V10.45Zm3.443.684.019.016a.69.69 0 0 0-.351.045.756.756 0 0 0-.287.204c-.11.155-.174.336-.189.522h1.545c-.034-.526-.257-.787-.74-.787h.003Zm-5.718.163c-.026 0-.057 0-.083.004a.78.78 0 0 0-.31.053.746.746 0 0 0-.257.189 1.016 1.016 0 0 0-.204.695v.064c-.015.257.057.507.204.711a.634.634 0 0 0 .253.196.638.638 0 0 0 .314.061.644.644 0 0 0 .578-.265c.14-.223.204-.48.189-.74a1.216 1.216 0 0 0-.181-.711.677.677 0 0 0-.503-.257Zm-4.509 1.266a.464.464 0 0 0-.268.102.373.373 0 0 0-.114.276c0 .053.008.106.027.155a.375.375 0 0 0 .087.132.576.576 0 0 0 .397.11v.004a.863.863 0 0 0 .563-.182.573.573 0 0 0 .211-.457v-.14h-.903Z"/>',
    alwaysAskWrites: true,
    vetted: { checked: '2026-10-22', listedIn: ['registry'] },
  },
  {
    id: 'make',
    display_name: 'Make',
    server_url: 'https://mcp.make.com',
    transport: 'streamable_http',
    category: 'automation',
    description: 'Run your Make scenarios',
    accent: 'bg-zinc-500/10 text-zinc-700 dark:text-zinc-300',
    iconViewBox: '0 0 24 24',
    iconSvg: '<path fill="currentColor" d="M13.38 3.498c-.27 0-.511.19-.566.465L9.85 18.986a.578.578 0 0 0 .453.678l4.095.826a.58.58 0 0 0 .682-.455l2.963-15.021a.578.578 0 0 0-.453-.678l-4.096-.826a.589.589 0 0 0-.113-.012zm-5.876.098a.576.576 0 0 0-.516.318L.062 17.697a.575.575 0 0 0 .256.774l3.733 1.877a.578.578 0 0 0 .775-.258l6.926-13.781a.577.577 0 0 0-.256-.776L7.762 3.658a.571.571 0 0 0-.258-.062zm11.74.115a.576.576 0 0 0-.576.576v15.426c0 .318.258.578.576.578h4.178a.58.58 0 0 0 .578-.578V4.287a.578.578 0 0 0-.578-.576Z"/>',
    alwaysAskWrites: true,
    vetted: { checked: '2026-10-22', listedIn: ['registry'] },
  },
]

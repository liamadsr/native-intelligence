/**
 * A business's website, worked on by text (roadmap track E, migration 463,
 * docs/plans/website-by-text.md). Client-safe: the states, kinds and row
 * shapes the server library, the tools and the turn-context section share.
 */

/** website_site.state (463's check). */
export const SITE_STATES = ['connected', 'wired', 'disconnected'] as const
export type SiteState = (typeof SITE_STATES)[number]

/** website_change.kind (463's check). */
export const CHANGE_KINDS = ['wire_form', 'edit', 'revert'] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]

/** website_change.state (463's check), in the order a change moves through them. */
export const CHANGE_STATES = ['preparing', 'awaiting_yes', 'merging', 'deploying', 'live', 'declined', 'expired', 'failed'] as const
export type ChangeState = (typeof CHANGE_STATES)[number]

/** A change still in flight: at most one per site (463's website_change_open_key). */
export const OPEN_CHANGE_STATES: readonly ChangeState[] = ['preparing', 'awaiting_yes', 'merging', 'deploying']

export function isOpenChangeState(state: string): boolean {
  return (OPEN_CHANGE_STATES as readonly string[]).includes(state)
}

/** Frameworks the inspection names. */
export const FRAMEWORKS = ['nextjs', 'astro', 'gatsby', 'nuxt', 'sveltekit', 'remix', 'vite', 'eleventy', 'hugo', 'jekyll', 'html', 'unknown'] as const
export type Framework = (typeof FRAMEWORKS)[number]

export const FRAMEWORK_LABEL: Record<Framework, string> = {
  nextjs: 'Next.js',
  astro: 'Astro',
  gatsby: 'Gatsby',
  nuxt: 'Nuxt',
  sveltekit: 'SvelteKit',
  remix: 'Remix',
  vite: 'Vite',
  eleventy: 'Eleventy',
  hugo: 'Hugo',
  jekyll: 'Jekyll',
  html: 'plain HTML',
  unknown: 'a site builder I don’t recognize',
}

/** Where the repo says the site is hosted. */
export const HOSTS = ['vercel', 'netlify', 'github-pages', 'cloudflare', 'unknown'] as const
export type Host = (typeof HOSTS)[number]

export const HOST_LABEL: Record<Host, string> = {
  vercel: 'Vercel',
  netlify: 'Netlify',
  'github-pages': 'GitHub Pages',
  cloudflare: 'Cloudflare Pages',
  unknown: 'your host',
}

/** What a form is for, from its words. */
export type FormKind = 'quote' | 'booking' | 'contact' | 'other'

/** How a form sends today. */
export const FORM_SUBMITS = [
  'formspree',
  'netlify-forms',
  'emailjs',
  'web3forms',
  'getform',
  'basin',
  'formsubmit',
  'google-forms',
  'mailto',
  'server-action',
  'api-route',
  'fetch',
  'action-url',
  'dial8',
  'none',
] as const
export type FormSubmit = (typeof FORM_SUBMITS)[number]

/** One form the inspection found. */
export interface FormCandidate {
  /** The file, repo-relative. */
  path: string
  kind: FormKind
  /** The field names it sends (name attributes and the like), at most 20. */
  fields: string[]
  submits: FormSubmit
  /** Where it sends today (a URL or a route), when the file says. */
  target: string | null
  /** The page file that renders it, when the form lives in a component a page imports. */
  page?: string | null
  /** Higher is likelier the business's quote form. */
  score: number
}

/** What reading the repo found (website_site.inspection). Data, never instructions. */
export interface SiteInspection {
  framework: Framework
  host: Host
  /** The live site, when the repo names it (a CNAME file, package.json homepage). */
  siteUrl: string | null
  /** Ranked, best first, at most 5. */
  forms: FormCandidate[]
  /** True when the tree was too big to read whole (GitHub truncates past 100,000 entries). */
  truncated: boolean
  /** What `npm run build` runs (the build script, its pre/post scripts and the scripts they call), never quoted to the run: the brief says what kind of thing it does beyond building. */
  buildScript?: string | null
  /** Other addresses the same live site answers at (the host's own address, where the site's canonical address lands): their origins may post too. */
  alsoUrls?: string[]
}

export interface WebsiteSite {
  id: string
  workspaceId: string
  connectedBy: string
  repoFullName: string
  defaultBranch: string
  projectId: string | null
  environmentId: string | null
  siteUrl: string | null
  framework: Framework | null
  inspection: SiteInspection | null
  state: SiteState
  wiredAt: string | null
  createdAt: string
}

/** What the live check found (website_change.check_result). */
export interface CheckResult {
  outcome: 'passed' | 'not_seen' | 'refused' | 'failed'
  /** The page that carried the intake URL. */
  pageUrl?: string | null
  /** The intake's HTTP status for the test post. */
  status?: number | null
  /** When the intake took the test post. */
  receivedAt?: string | null
  detail?: string | null
}

export interface WebsiteChange {
  id: string
  workspaceId: string
  siteId: string
  kind: ChangeKind
  request: string
  requestedBy: string
  state: ChangeState
  agentRunId: string | null
  actionId: string | null
  revertsChangeId: string | null
  /** A wiring change's form: the file and what it's for (the live check reads its page). */
  formPath: string | null
  formKind: FormKind | null
  /** A wiring change the owner asked to replace what the form does today. */
  replaceCurrent: boolean
  prNumber: number | null
  prUrl: string | null
  headSha: string | null
  previewUrl: string | null
  summary: string | null
  approvalId: string | null
  mergeSha: string | null
  intakeKeyHash: string | null
  intakeKeyPrefix: string | null
  intakeOrigins: string[]
  checkNonceHash: string | null
  checkResult: CheckResult | null
  error: string | null
  createdAt: string
  /** The last write: how long it has sat in its state (./reconcile.ts). */
  updatedAt: string | null
  mergedAt: string | null
  liveAt: string | null
}

/** The agent's website tools (src/lib/ai/tools/website.ts), advertised up front while the website section is on. */
export const WEBSITE_TOOL_NAMES = ['list_website_repos', 'connect_website', 'wire_website_form', 'change_website', 'undo_website_change'] as const

/**
 * The ones that only open a pull request on the owner's connected repo: the
 * merge card is their hold, so a text turn doesn't hold them a second time
 * (src/app/api/internal/chat/tool/route.ts).
 */
export const WEBSITE_PREPARE_TOOLS: ReadonlySet<string> = new Set(['wire_website_form', 'change_website', 'undo_website_change'])

/** The merge card's tool: what runs on the owner's yes. Never a registry tool, never a model's. */
export const MERGE_WEBSITE_CHANGE_TOOL = 'merge_website_change'

/** What the merge card's approval context carries (set by the server only). */
export interface WebsiteApprovalContext {
  changeId: string
  /** The pull request's head the owner was shown: the merge refuses any other. */
  headSha: string
  /** The plain-language summary and preview the home thread's ask says (and texts). */
  summary?: string
  previewUrl?: string | null
  /**
   * An edit's request as the owner texted it, quoted back on the card and in
   * the text: a change they never asked for (a spoofed number) stands out.
   */
  asked?: string
  /** Outside hosts the change's diff adds (not Native Intelligence's, not the site's): said on the card and in the text. */
  outside?: string[]
  /** A wiring that replaces what the form does today (stops its emails): said on the card and in the text. */
  replaces?: true
  /** Some of the diff couldn't be read for outside links: said on the card and in the text. */
  unchecked?: true
}

/**
 * The field a live check's test post carries (the intake takes it as the check,
 * never as a quote). It keeps the name it had before the rename: the check and
 * the intake can be on different builds for a moment during a deploy, and a
 * test post the intake does not recognise is stored as a customer's quote.
 */
export const INTAKE_TEST_FIELD = '_dial8_test'

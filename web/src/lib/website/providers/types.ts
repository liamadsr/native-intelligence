/**
 * Where a business's website lives (roadmap issue #13, migration 723,
 * docs/plans/hosted-site-builders.md): a GitHub repo (463, a pull request per
 * change) or a site builder (a page written through the builder's own API,
 * per change). Client-safe.
 *
 * Liam, 11-27, on issue #13: "let's do it": quote forms and website changes by
 * text for sites on WordPress, Wix, Webflow, Framer and Shopify, not just ones
 * in a GitHub repo. Every outward change still waits for the person's yes, as
 * the GitHub path does: one card, the exact text before and after on it.
 */

/** website_site.provider (723's check). */
export const SITE_PROVIDERS = ['github', 'wordpress', 'wpcom', 'webflow', 'wix', 'shopify'] as const
export type SiteProvider = (typeof SITE_PROVIDERS)[number]

/** The builders, as opposed to a GitHub repo. */
export type BuilderProvider = Exclude<SiteProvider, 'github'>

/** The builders this build can connect (the plan's phase 1 is WordPress, self-hosted). */
export const BUILT_BUILDERS: readonly BuilderProvider[] = ['wordpress']

export const PROVIDER_LABEL: Record<SiteProvider, string> = {
  github: 'GitHub',
  wordpress: 'WordPress',
  wpcom: 'WordPress.com',
  webflow: 'Webflow',
  wix: 'Wix',
  shopify: 'Shopify',
}

export function isSiteProvider(v: unknown): v is SiteProvider {
  return typeof v === 'string' && (SITE_PROVIDERS as readonly string[]).includes(v)
}

/** A page (or post) of a builder site, as the agent lists them. */
export interface ContentRef {
  kind: 'page' | 'post'
  id: string
  title: string
  /** The live address, when the builder says. */
  url: string | null
  /** publish, draft, private… as the builder says. */
  status: string
}

/** One page's editable text, as read now. */
export interface ContentSnapshot {
  ref: ContentRef
  title: string
  /** The page's own markup as the builder stores it (a WordPress page's raw block markup). */
  body: string
  /** When the builder last changed it, as it says. */
  modified: string | null
}

export type BuilderResult<T> = { ok: true; value: T } | { ok: false; status: number; error: string }

/** What a builder's login can do, read at connect. */
export interface BuilderIdentity {
  /** The site's own name. */
  name: string
  /** The live site. */
  siteUrl: string
  /** The login's name, for the owner's words. */
  user: string
  /** The login may change pages and posts. */
  canEdit: boolean
  /** The login may put a script on a page (WordPress's unfiltered_html): a form embed needs it. */
  canEmbed: boolean
}

/**
 * One builder's API, as the provider-neutral flow (../builder.ts) uses it.
 * Each call answers a result, never throws for the builder's answer.
 */
export interface BuilderClient {
  provider: BuilderProvider
  identity(): Promise<BuilderResult<BuilderIdentity>>
  listContent(opts?: { search?: string | null; limit?: number }): Promise<BuilderResult<ContentRef[]>>
  readContent(ref: Pick<ContentRef, 'kind' | 'id'>): Promise<BuilderResult<ContentSnapshot>>
  /** Write a page's text: the builder keeps its own revision (WordPress does). */
  writeContent(ref: Pick<ContentRef, 'kind' | 'id'>, next: { title?: string; body: string }): Promise<BuilderResult<{ modified: string | null; revision: string | null }>>
  /** The builder's own block for a piece of HTML (our form embed): appended to a page's body. Pure. */
  embedBlock(html: string): string
}

/**
 * website_change.staged (723): a builder change's write. `beforeHash` is the
 * page as read when the card was made (the yes refuses a page that moved
 * since); `afterHash` is what the card showed (head_sha holds it).
 */
export interface StagedWrite {
  provider: BuilderProvider
  ref: ContentRef
  before: { title: string; body: string }
  after: { title: string; body: string }
  beforeHash: string
  afterHash: string
  /** The text replaced, as the card quotes it: at most a few pairs. */
  edits: Array<{ find: string; replace: string }>
  /** Set once written: what the builder answered. */
  written?: { modified: string | null; revision: string | null; at: string }
}

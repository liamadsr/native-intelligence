/**
 * Reading a business's website repo (roadmap track E, step 2 "Inspect"):
 * which framework it is built with, where it is hosted, its live address,
 * and the forms a customer fills in (quote, booking, contact), with how each
 * one sends today. General on purpose: nothing here knows any one business.
 *
 *   framework   package.json's dependencies first (next, astro, gatsby,
 *               nuxt, @sveltejs/kit, @remix-run/*, vite, @11ty/eleventy),
 *               then config files (hugo.toml, _config.yml), else plain HTML
 *               when the repo serves .html files.
 *   host        vercel.json / .vercel, netlify.toml / _redirects, a Pages
 *               workflow or a CNAME file, wrangler.toml; else who makes the
 *               repo's GitHub deployments (a host's app: a site linked in the
 *               host's dashboard has no deploy file), else the host's own
 *               address in the repo's homepage (x.vercel.app).
 *   site url    a CNAME file, else package.json's homepage.
 *   forms       the page and component files most likely to hold a form
 *               (their path names a quote, estimate, booking, contact or
 *               form, or they are pages; never API routes or migrations),
 *               read up to a budget; each file with a <form>, an onSubmit, a
 *               form library, or inputs it POSTs is a candidate, ranked by
 *               what it is for (a quote first: the words inside the form,
 *               then the file's name, then the rest of the file), how it
 *               sends (Formspree, Netlify Forms, EmailJS, a mailto, an API
 *               route, a server action, a fetch), and its fields (named
 *               inputs, or the keys of the JSON body it posts).
 *   build       package.json's build script (the brief says when it does
 *               more than build, like migrating a database).
 *
 * Pure over a file list and a reader ({@link inspectFiles}); {@link
 * inspectRepo} reads through GitHub. What a file says is data: the result
 * is fenced as such wherever a model reads it.
 */
import { deploymentHost, getFileText, getTree, type GithubDeps, type TreeEntry } from './github'
import type { Framework, FormCandidate, FormKind, FormSubmit, Host, SiteInspection } from './types'

/** Files the inspection reads at most, and their bytes all together. */
export const INSPECT_MAX_FILES = 40
export const INSPECT_MAX_BYTES = 1_500_000
/** One file larger than this is skipped (a bundle, a data dump). */
const FILE_MAX_BYTES = 150_000

/** Folders never read: dependencies, build output, tests, vendored code, database migrations. */
const SKIPPED_DIRS = /(^|\/)(node_modules|\.next|\.nuxt|\.svelte-kit|\.astro|\.vercel|\.netlify|dist|build|out|public\/build|coverage|vendor|\.git|\.github|__tests__|tests?|e2e|cypress|playwright|storybook-static|\.cache|migrations?)(\/|$)/i
/** A server endpoint (app/api/…, pages/api/…): never where a customer fills a form in. */
const API_ROUTE = /(^|\/)(app|pages)\/api\//
/** Folders of code that isn't a page or a component (services, helpers, state): their script files are read last. */
const NOT_UI = /(^|\/)(services?|lib|utils?|helpers?|hooks|contexts?|store|stores|models?|types|schemas?|server|scripts|db|prisma|config)\//i
/** A script file that can hold no markup (a .tsx, .jsx, .svelte, .vue or .astro file can). */
const SCRIPT_ONLY = /\.(ts|mjs|cjs)$/
/** The business's own back office (admin, dashboard, account, sign-in): never where a customer asks for a job. */
const BACK_OFFICE = /(^|\/)(\(?(admin|dashboard|account|accounts|login|signin|sign-in|signup|sign-up|auth|portal|internal|staff|crm)\)?)(\/|[-_.]|$)/i
const PAGE_EXT = /\.(html?|jsx|tsx|js|ts|mjs|vue|svelte|astro|mdx|njk|liquid|hbs|ejs|php)$/i
const MINIFIED = /\.min\.(js|css)$|[-.][0-9a-f]{8,}\.(js|css)$/i

const PATH_WORDS: Array<{ re: RegExp; kind: FormKind; weight: number }> = [
  { re: /quote|estimate|pricing|price|calculator|get-?started|free-?quote/i, kind: 'quote', weight: 6 },
  { re: /book|schedul|appointment|reserv|pickup/i, kind: 'booking', weight: 5 },
  { re: /contact|inquir|enquir|reach|message|support/i, kind: 'contact', weight: 4 },
  { re: /form/i, kind: 'other', weight: 3 },
]

/** The words in a form's file that say what it is for. */
const CONTENT_WORDS: Array<{ re: RegExp; kind: FormKind }> = [
  { re: /\b(get (a|your) (free )?(quote|estimate)|request (a )?(quote|estimate)|free (quote|estimate)|instant (quote|estimate)|quote request|estimate)\b/i, kind: 'quote' },
  { re: /\b(book (now|a|an|your)|schedule (a|an|your)|appointment|reserve|pick-?up date|preferred date)\b/i, kind: 'booking' },
  { re: /\b(contact us|get in touch|send (us )?a message|your message)\b/i, kind: 'contact' },
]

/** A form element, an onSubmit handler, or a form library: the file holds a form. */
const HAS_FORM = /<form[\s>]|\bonSubmit\s*=|\bon:submit\b|@submit\b|\buseForm\s*\(|\bformAction\b|<Form[\s>]|\bhandleSubmit\s*\(/
/** Inputs a file POSTs with a button's handler (no <form>): a form too. */
const HAS_INPUTS = /<(input|textarea|select)\b/i
const POSTS = /\bmethod\s*:\s*["'`]POST["'`]|\baxios\.post\(/i

/** A repo path the inspection keeps: no whitespace or control characters, at most 200 characters. */
const SAFE_PATH = /^[^\s\p{Cc}]{1,200}$/u

const KIND_RANK: Record<FormKind, number> = { quote: 30, booking: 22, contact: 16, other: 6 }

/** How a file's form sends, the most specific match first. */
const SUBMIT_RULES: Array<{ submits: FormSubmit; re: RegExp; target?: RegExp }> = [
  { submits: 'dial8', re: /\/api\/intake\/quotes\/qk_/, target: /(https?:\/\/[^\s"'`]+\/api\/intake\/quotes\/qk_[A-Za-z0-9_-]+)/ },
  { submits: 'formspree', re: /formspree\.io|@formspree\//i, target: /(https:\/\/formspree\.io\/f\/[A-Za-z0-9]+)/ },
  { submits: 'netlify-forms', re: /\bdata-netlify\s*=\s*["']?true|\bnetlify(=|\s|>)|netlify-honeypot|form-name/i },
  { submits: 'emailjs', re: /emailjs|@emailjs\//i },
  { submits: 'web3forms', re: /web3forms\.com/i, target: /(https:\/\/api\.web3forms\.com\/submit)/ },
  { submits: 'getform', re: /getform\.io/i, target: /(https:\/\/getform\.io\/f\/[A-Za-z0-9]+)/ },
  { submits: 'basin', re: /usebasin\.com/i, target: /(https:\/\/usebasin\.com\/f\/[A-Za-z0-9]+)/ },
  { submits: 'formsubmit', re: /formsubmit\.co/i, target: /(https:\/\/formsubmit\.co\/[^\s"'`]+)/ },
  { submits: 'google-forms', re: /docs\.google\.com\/forms/i, target: /(https:\/\/docs\.google\.com\/forms\/[^\s"'`]+)/ },
  { submits: 'mailto', re: /action\s*=\s*["']mailto:|href\s*=\s*\{?["'`]mailto:[^"'`]*\?/i },
  { submits: 'server-action', re: /['"]use server['"]|\baction\s*=\s*\{\s*[a-zA-Z_$][\w$]*\s*\}|\bformAction\s*=\s*\{/ },
  { submits: 'api-route', re: /fetch\(\s*[`'"]\/api\/[\w\-/]+/, target: /fetch\(\s*[`'"](\/api\/[\w\-/]+)/ },
  { submits: 'fetch', re: /\bfetch\(|\baxios\.(post|put)\(/, target: /(?:fetch|axios\.post)\(\s*[`'"](https?:\/\/[^\s"'`]+)/ },
  { submits: 'action-url', re: /<form[^>]*\baction\s*=\s*["'][^"'#]+["']/i, target: /<form[^>]*\baction\s*=\s*["']([^"'#]+)["']/i },
]

const SUBMIT_RANK: Partial<Record<FormSubmit, number>> = { none: -4 }

/** The top-level keys of the object literals a file posts as JSON (body: JSON.stringify({ name, email: … })). Pure. */
function jsonBodyKeys(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/\bbody\s*:\s*JSON\.stringify\(\s*\{((?:[^{}]|\{[^{}]{0,500}\}){0,1500})\}/g)) {
    // A nested object's own keys aren't the form's: dropped before the split.
    for (const part of m[1].replace(/\{[^{}]*\}/g, '{}').split(',')) {
      const key = part.match(/^\s*["']?([A-Za-z_$][\w$-]{0,59})["']?\s*(?::|$)/)?.[1]
      if (key && !out.includes(key)) out.push(key)
    }
  }
  return out
}

/** Names a form sends: name="…", name={'…'}, register('…'), formData.append('…'), its JSON body's keys, and the like. Pure. */
export function formFields(text: string): string[] {
  const out = new Set<string>()
  const patterns = [
    /\bname\s*=\s*["']([A-Za-z0-9_.\-[\]]{1,60})["']/g,
    /\bname\s*=\s*\{\s*["'`]([A-Za-z0-9_.\-[\]]{1,60})["'`]\s*\}/g,
    /\bregister\(\s*["'`]([A-Za-z0-9_.-]{1,60})["'`]/g,
    /\bv-model\s*=\s*["'](?:form\.)?([A-Za-z0-9_]{1,60})["']/g,
    /\b(?:form|fd|data|body|payload)\w*\.append\(\s*["'`]([A-Za-z0-9_.-]{1,60})["'`]\s*,/gi,
  ]
  const add = (raw: string) => {
    const name = raw.trim()
    // Not a field: a meta tag's, a font's, a component prop's usual names.
    if (!name || /^(viewport|description|keywords|theme-color|robots|author|og:|twitter:)/i.test(name)) return
    out.add(name)
  }
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      add(m[1])
      if (out.size >= 20) return [...out]
    }
  }
  // Inputs held in component state, with no name: what the form sends is its JSON body.
  for (const key of jsonBodyKeys(text)) {
    add(key)
    if (out.size >= 20) break
  }
  return [...out]
}

/** A file upload's endpoint (photos sent before the form): not where the form's request goes. Matched at the start of a word of its path. */
const UPLOAD_WORD = /^(upload|image|photo|file|blob|presign|signed|media|avatar|attachment)/i
/** An endpoint whose last segment says it takes the submission (over one that updates or verifies along the way). */
const SUBMIT_WORD = /^(submi|creat|send|request|quote|estimat|contact|lead|inquir|enquir|book|order|message)/i
const isUpload = (target: string) => target.split(/[/\-_.?=&]/).some((w) => UPLOAD_WORD.test(w))
const isSubmit = (target: string) => (target.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? '').split(/[-_.]/).some((w) => SUBMIT_WORD.test(w))

/** How the file's form sends today, and where to, when it says (past any photo upload it does first). Pure. */
export function formSubmits(text: string): { submits: FormSubmit; target: string | null } {
  for (const rule of SUBMIT_RULES) {
    if (!rule.re.test(text)) continue
    let target: string | null = null
    if (rule.target) {
      const all = [...text.matchAll(new RegExp(rule.target.source, rule.target.flags.includes('g') ? rule.target.flags : `${rule.target.flags}g`))].map((m) => m[1])
      const sent = all.filter((t) => !isUpload(t))
      target = sent.find(isSubmit) ?? sent[0] ?? all[0] ?? null
    }
    return { submits: rule.submits, target: target ? target.slice(0, 200) : null }
  }
  return { submits: 'none', target: null }
}

/** The text inside the file's <form> … </form>, or null when it has none. */
function formBlock(text: string): string | null {
  const start = text.search(/<form[\s>]|<Form[\s>]/)
  if (start < 0) return null
  const end = Math.max(text.lastIndexOf('</form>'), text.lastIndexOf('</Form>'))
  return end > start ? text.slice(start, end) : null
}

/**
 * What a form is for: the words inside the form first, then what the file is
 * named (its author's own label), then the rest of the file. A page's other
 * copy (a "Schedule your pickup" button under a contact form) never decides it
 * when the form or the file's name says.
 */
function kindOf(path: string, text: string): FormKind {
  const inForm = formBlock(text)
  if (inForm) for (const { re, kind } of CONTENT_WORDS) if (re.test(inForm)) return kind
  const named = PATH_WORDS.find(({ re, kind }) => kind !== 'other' && re.test(path.split('/').slice(-2).join('/')))
  if (named) return named.kind
  for (const { re, kind } of CONTENT_WORDS) if (re.test(text)) return kind
  return 'other'
}

/** A form candidate from one file, or null when the file holds no form. Pure. */
export function formCandidate(path: string, text: string): FormCandidate | null {
  // A path is quoted to the agent as data: no whitespace (no prose), one line, a sane length.
  if (!SAFE_PATH.test(path) || !(HAS_FORM.test(text) || (HAS_INPUTS.test(text) && POSTS.test(text)))) return null
  const kind = kindOf(path, text)
  const fields = formFields(text)
  const { submits, target } = formSubmits(text)
  const contactish = fields.filter((f) => /e-?mail|phone|tel|mobile|name/i.test(f)).length
  // A search box or a newsletter sign-up is a form, but not one a customer asks for a job with.
  const searchOnly = fields.length > 0 && fields.every((f) => /^(q|query|search|s|keyword)$/i.test(f))
  const newsletterOnly = fields.length > 0 && fields.length <= 2 && fields.every((f) => /e-?mail|subscribe|newsletter/i.test(f)) && kind !== 'quote'
  if (searchOnly) return null
  const pathBoost = PATH_WORDS.find(({ re }) => re.test(path))?.weight ?? 0
  const score = KIND_RANK[kind] + pathBoost + Math.min(contactish, 3) * 3 + Math.min(fields.length, 8) + (SUBMIT_RANK[submits] ?? 2) - (newsletterOnly ? 25 : 0) - (BACK_OFFICE.test(path) ? 40 : 0) - path.split('/').length * 0.1
  return { path, kind, fields, submits, target, score: Math.round(score * 10) / 10 }
}

/** The files worth reading for forms, likeliest first, within the budget. Pure. */
export function filesToRead(files: readonly TreeEntry[]): TreeEntry[] {
  const pages = files.filter((f) => PAGE_EXT.test(f.path) && !SKIPPED_DIRS.test(f.path) && !API_ROUTE.test(f.path) && !MINIFIED.test(f.path) && f.size <= FILE_MAX_BYTES && !/\.(d\.ts|config\.(js|ts|mjs))$/.test(f.path))
  const rank = (f: TreeEntry): number => {
    const word = PATH_WORDS.find(({ re }) => re.test(f.path))
    let r = word ? 100 + word.weight * 10 : 0
    // Script files that hold no markup (a .ts file, a service's .js) and the back office: read after every page and component, still likeliest first.
    if (SCRIPT_ONLY.test(f.path) || (NOT_UI.test(f.path) && /\.js$/.test(f.path)) || BACK_OFFICE.test(f.path)) r -= 1000
    if (/(^|\/)(index|home|page|\+page|App)\.(html?|tsx|jsx|astro|vue|svelte)$/i.test(f.path)) r += 40
    if (/(^|\/)(app|pages|src\/pages|src\/app|components|src\/components|sections|src\/routes|routes|layouts|_includes)\//i.test(f.path)) r += 20
    if (/\.html?$/i.test(f.path) && !f.path.includes('/')) r += 30
    return r - f.path.split('/').length
  }
  const ranked = [...pages].sort((a, b) => rank(b) - rank(a) || a.path.localeCompare(b.path))
  const picked: TreeEntry[] = []
  let bytes = 0
  for (const f of ranked) {
    if (picked.length >= INSPECT_MAX_FILES) break
    if (bytes + f.size > INSPECT_MAX_BYTES) continue
    picked.push(f)
    bytes += f.size
  }
  return picked
}

interface PackageJson {
  dependencies?: Record<string, unknown>
  devDependencies?: Record<string, unknown>
  homepage?: unknown
  scripts?: Record<string, unknown>
}

/**
 * What `npm run build` runs: the build script, its prebuild and postbuild
 * (npm runs those too), and the scripts they call (`npm run x`, `pnpm x`,
 * `yarn x`), a few levels down; null with no build script. Pure.
 */
const NOT_SCRIPTS = new Set(['install', 'i', 'ci', 'exec', 'dlx', 'add', 'run', 'test', 'start', 'x'])

export function buildStepsOf(scripts: Record<string, unknown> | undefined): string | null {
  const script = (name: string) => (typeof scripts?.[name] === 'string' ? String(scripts[name]).trim() : '')
  if (!script('build')) return null
  const seen = new Set<string>()
  const steps: string[] = []
  const visit = (name: string, depth: number) => {
    if (seen.has(name) || depth > 3) return
    seen.add(name)
    for (const text of [script(`pre${name}`), script(name), script(`post${name}`)]) {
      if (!text) continue
      steps.push(text)
      for (const m of text.matchAll(/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?([\w:.-]{1,60})/g)) {
        if (!NOT_SCRIPTS.has(m[1])) visit(m[1], depth + 1)
      }
    }
  }
  visit('build', 0)
  return steps.join(' && ').slice(0, 600)
}

/** The framework, from package.json's dependencies and the repo's files. Pure. */
export function detectFramework(paths: ReadonlySet<string>, pkg: PackageJson | null): Framework {
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) }
  const has = (name: string) => Object.prototype.hasOwnProperty.call(deps, name)
  if (has('next')) return 'nextjs'
  if (has('astro')) return 'astro'
  if (has('gatsby')) return 'gatsby'
  if (has('nuxt') || has('nuxt3')) return 'nuxt'
  if (has('@sveltejs/kit')) return 'sveltekit'
  if (Object.keys(deps).some((d) => d.startsWith('@remix-run/'))) return 'remix'
  if (has('@11ty/eleventy')) return 'eleventy'
  if (has('vite')) return 'vite'
  const list = [...paths]
  if (list.some((p) => /^(hugo\.(toml|yaml|json)|config\.toml)$/.test(p)) && list.some((p) => p.startsWith('layouts/') || p.startsWith('content/'))) return 'hugo'
  if (paths.has('_config.yml') && (paths.has('Gemfile') || list.some((p) => p.startsWith('_layouts/') || p.startsWith('_posts/')))) return 'jekyll'
  if (list.some((p) => /\.html?$/i.test(p) && !SKIPPED_DIRS.test(p))) return 'html'
  return 'unknown'
}

/** The host, from the repo's deploy files. Pure. */
export function detectHost(paths: ReadonlySet<string>): Host {
  const list = [...paths]
  if (paths.has('vercel.json') || list.some((p) => p.startsWith('.vercel/'))) return 'vercel'
  if (paths.has('netlify.toml') || paths.has('_redirects') || paths.has('public/_redirects')) return 'netlify'
  if (paths.has('wrangler.toml') || paths.has('wrangler.json')) return 'cloudflare'
  if (paths.has('CNAME') || paths.has('public/CNAME') || paths.has('static/CNAME') || list.some((p) => /^\.github\/workflows\/.*pages.*\.ya?ml$/i.test(p))) return 'github-pages'
  return 'unknown'
}

/** The hosts' own addresses (a site's address before, or beside, a domain of its own), and the host each means. */
const PLATFORM_ADDRESSES: Array<{ re: RegExp; host: Host }> = [
  { re: /(^|\.)vercel\.app$/i, host: 'vercel' },
  { re: /(^|\.)netlify\.app$/i, host: 'netlify' },
  { re: /(^|\.)pages\.dev$/i, host: 'cloudflare' },
  { re: /(^|\.)github\.io$/i, host: 'github-pages' },
  { re: /(^|\.)(onrender\.com|surge\.sh|web\.app|firebaseapp\.com)$/i, host: 'unknown' },
]

/** The host whose own address `url` is (x.vercel.app → vercel), 'unknown' for another platform's, or null for a domain of the business's own. Pure. */
export function platformHostOf(url: string | null | undefined): Host | null {
  if (!url) return null
  try {
    const host = new URL(url).hostname
    return PLATFORM_ADDRESSES.find(({ re }) => re.test(host))?.host ?? null
  } catch {
    return null
  }
}

/**
 * A bare domain or URL as the live site's https URL, or null: its origin,
 * plus the first path segment for a GitHub Pages project site
 * (user.github.io/repo serves from /repo). Pure.
 */
export function siteUrlOf(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let text = value.trim().split(/\s+/)[0] ?? ''
  if (!text) return null
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`
  try {
    const url = new URL(text)
    const host = url.hostname.toLowerCase()
    if (!/\./.test(host) || host.endsWith('.github.com') || host === 'github.com' || /^[\d.]+$/.test(host) || host.includes(':')) return null
    const project = host.endsWith('.github.io') ? url.pathname.split('/').filter(Boolean)[0] : undefined
    return `https://${host}${project && /^[A-Za-z0-9._-]{1,100}$/.test(project) ? `/${project}` : ''}`
  } catch {
    return null
  }
}

/** A file a framework serves as a page (app/…/page.tsx, pages/…, src/routes/…/+page.svelte, an .html file). Pure. */
export function isPageFile(path: string): boolean {
  return /(^|\/)(app\/(.*\/)?page|pages\/.+|routes\/(.*\/)?\+page)\.(tsx|jsx|ts|js|astro|vue|svelte|mdx|md)$/.test(path) || /\.html?$/i.test(path)
}

/** The first page file among `texts` that imports the component at `path` (by its file name). Pure. */
export function importingPage(path: string, texts: ReadonlyArray<{ path: string; text: string | null }>): string | null {
  const base = path.split('/').pop()?.replace(/\.(tsx|jsx|ts|js|astro|vue|svelte)$/, '')
  if (!base || base === 'index') return null
  const imports = new RegExp(`from\\s+['"][^'"]*\\/${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\.[a-z]+)?['"]`)
  return texts.find((t) => t.text && t.path !== path && isPageFile(t.path) && imports.test(t.text))?.path ?? null
}

export interface InspectInput {
  files: readonly TreeEntry[]
  truncated: boolean
  read: (path: string) => Promise<string | null>
}

/** Inspect a repo from its file list and a reader (see the header). */
export async function inspectFiles(input: InspectInput): Promise<SiteInspection> {
  const paths = new Set(input.files.map((f) => f.path))
  const pkgText = paths.has('package.json') ? await input.read('package.json') : null
  let pkg: PackageJson | null = null
  try {
    pkg = pkgText ? (JSON.parse(pkgText) as PackageJson) : null
  } catch {
    pkg = null
  }
  const framework = detectFramework(paths, pkg)
  const host = detectHost(paths)
  const buildScript = buildStepsOf(pkg?.scripts)
  const cnamePath = ['CNAME', 'public/CNAME', 'static/CNAME'].find((p) => paths.has(p))
  const cname = cnamePath ? await input.read(cnamePath) : null
  const siteUrl = siteUrlOf(cname) ?? siteUrlOf(pkg?.homepage)

  const forms: FormCandidate[] = []
  const toRead = filesToRead(input.files)
  const texts = await Promise.all(toRead.map(async (f) => ({ path: f.path, text: await input.read(f.path).catch(() => null) })))
  for (const { path, text } of texts) {
    if (!text) continue
    const found = formCandidate(path, text)
    if (!found) continue
    // A form in a component: the page file that imports it is where it renders (the live check reads that page).
    if (!isPageFile(path)) {
      const page = importingPage(path, texts)
      if (page) found.page = page
    }
    forms.push(found)
  }
  forms.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return { framework, host, siteUrl, forms: forms.slice(0, 5), truncated: input.truncated, buildScript }
}

/**
 * Inspect the repo at its default branch, through GitHub as the owner. With no
 * deploy file in the repo, the host is who makes its GitHub deployments, else
 * the host whose own address is the repo's homepage.
 */
export async function inspectRepo(
  deps: GithubDeps,
  repo: string,
  branch: string,
  extra: { homepage?: string | null } = {},
): Promise<{ ok: true; inspection: SiteInspection } | { ok: false; error: string }> {
  const tree = await getTree(deps, repo, branch)
  if (!tree.ok) return { ok: false, error: tree.status === 404 || tree.status === 409 ? 'The repository is empty or its main branch is missing.' : `GitHub would not list the files (${tree.error}).` }
  const inspection = await inspectFiles({ files: tree.value.files, truncated: tree.value.truncated, read: (path) => getFileText(deps, repo, path, branch) })
  if (inspection.host === 'unknown') {
    const deployed = await deploymentHost(deps, repo).catch(() => null)
    const byAddress = platformHostOf(siteUrlOf(extra.homepage) ?? inspection.siteUrl)
    inspection.host = deployed ?? (byAddress && byAddress !== 'unknown' ? byAddress : 'unknown')
  }
  return { ok: true, inspection }
}

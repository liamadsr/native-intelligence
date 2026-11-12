// Fonts for videos: a shelf of type that reads well in motion, plus any family from two free sources, Fontshare
// (ITF's free-for-commercial-use library) and Fontsource (every Google Font, open licences). Installing a family
// downloads its files once per workspace into the Studio's storage (`fonts/<slug>/<file>.woff2`, variable files when
// the font has them, so any weight in its range is real) and records it in studio_record, collection `fonts`.
// The editor's preview loads the faces from the workspace's file route (same origin); an export carries the faces
// its video uses (job-contract ExportInput.fonts) and the worker stages those files beside the bundle.
//
// Outbound requests go only to the four hosts the sources answer from (FONT_HOSTS), each with a timeout and a size
// cap. Every URL is built here or read from a source's own answer, never taken from the person's request: they name
// a family, and only a family the catalogues list is downloaded.
import { DEFAULT_FAMILIES, familyOf, type FontFace } from '../engine/font-names'
import type { EditorProject } from '../engine/contracts'
import { getBlob, putBlobBytes } from './blobs'
import type { StudioContext } from './context'
import { StudioError } from './errors'
import { getRecord, listRecords, putRecord } from './records'

/** The collection installed families are recorded in, keyed by normalised family name. */
export const FONTS_COLLECTION = 'fonts'

export type FontFile = { file: string; weight: string; style: 'normal' | 'italic' }
export type InstalledFont = {
  family: string
  slug: string
  source: 'fontshare' | 'fontsource'
  category: string
  variable: boolean
  weights: [number, number]
  italic: boolean
  axes?: Record<string, { min: number; max: number; default: number }>
  files: FontFile[]
  license: string
}
export type CatalogFont = { family: string; source: 'fontshare' | 'fontsource'; id: string; category: string; mood: string; variable?: boolean }
/** A face as the editor's player loads it: `file` is the blob key (read through the asset base), `src` its address. */
export type ServedFace = FontFace & { src: string }

/** The only hosts a font request may reach. */
export const FONT_HOSTS = ['api.fontshare.com', 'cdn.fontshare.com', 'api.fontsource.org', 'cdn.jsdelivr.net'] as const
const LISTING_TIMEOUT_MS = 20_000
const FILE_TIMEOUT_MS = 30_000
/** One font file's cap. A full variable family is well under 1 MB; nothing legitimate comes near this. */
export const FONT_FILE_MAX_BYTES = 5 * 1024 * 1024
const LISTING_MAX_BYTES = 16 * 1024 * 1024
const LISTING_TTL_MS = 86_400_000
/** Families installed in the background for one request, at most. */
const ENSURE_MAX = 12

type Group = readonly (readonly [string, 'fontshare' | 'fontsource', string])[]
const group = (list: Group, category: string, mood: string): CatalogFont[] => list.map(([family, source, id]) => ({ family, source, id, category, mood }))

/** Type that reads well in motion, grouped by what it's for. The picker starts here; anything else is a search away. */
export const SHELF: CatalogFont[] = [
  ...group([['Inter', 'fontsource', 'inter'], ['Inter Tight', 'fontsource', 'inter-tight'], ['Satoshi', 'fontshare', 'satoshi'], ['General Sans', 'fontshare', 'general-sans'], ['Switzer', 'fontshare', 'switzer'],
    ['Geist', 'fontsource', 'geist'], ['Manrope', 'fontsource', 'manrope'], ['DM Sans', 'fontsource', 'dm-sans'], ['Plus Jakarta Sans', 'fontsource', 'plus-jakarta-sans'], ['Supreme', 'fontshare', 'supreme']], 'sans', 'clean, modern, product UI'),
  ...group([['Clash Display', 'fontshare', 'clash-display'], ['Cabinet Grotesk', 'fontshare', 'cabinet-grotesk'], ['Clash Grotesk', 'fontshare', 'clash-grotesk'], ['Bricolage Grotesque', 'fontsource', 'bricolage-grotesque'],
    ['Space Grotesk', 'fontsource', 'space-grotesk'], ['Syne', 'fontsource', 'syne'], ['Chillax', 'fontshare', 'chillax'], ['Unbounded', 'fontsource', 'unbounded'], ['Familjen Grotesk', 'fontsource', 'familjen-grotesk'],
    ['Sora', 'fontsource', 'sora'], ['Archivo', 'fontsource', 'archivo']], 'display', 'bold headlines with character'),
  ...group([['Anton', 'fontsource', 'anton'], ['Bebas Neue', 'fontsource', 'bebas-neue'], ['Big Shoulders Display', 'fontsource', 'big-shoulders-display'], ['Tanker', 'fontshare', 'tanker'],
    ['Archivo Black', 'fontsource', 'archivo-black'], ['Dela Gothic One', 'fontsource', 'dela-gothic-one'], ['Panchang', 'fontshare', 'panchang']], 'impact', 'big, loud, condensed or heavy'),
  ...group([['Instrument Serif', 'fontsource', 'instrument-serif'], ['Fraunces', 'fontsource', 'fraunces'], ['Gambetta', 'fontshare', 'gambetta'], ['Zodiak', 'fontshare', 'zodiak'], ['Sentient', 'fontshare', 'sentient'],
    ['Boska', 'fontshare', 'boska'], ['Erode', 'fontshare', 'erode'], ['Playfair Display', 'fontsource', 'playfair-display'], ['DM Serif Display', 'fontsource', 'dm-serif-display'], ['Young Serif', 'fontsource', 'young-serif'],
    ['Gloock', 'fontsource', 'gloock']], 'serif', 'editorial, premium, warm'),
  ...group([['Melodrama', 'fontshare', 'melodrama'], ['Stardom', 'fontshare', 'stardom'], ['Britney', 'fontshare', 'britney'], ['Bonny', 'fontshare', 'bonny'], ['Chubbo', 'fontshare', 'chubbo'],
    ['Climate Crisis', 'fontsource', 'climate-crisis'], ['Tilt Warp', 'fontsource', 'tilt-warp'], ['Shrikhand', 'fontsource', 'shrikhand'], ['Rubik Mono One', 'fontsource', 'rubik-mono-one'],
    ['Monoton', 'fontsource', 'monoton'], ['Bungee', 'fontsource', 'bungee'], ['Righteous', 'fontsource', 'righteous'], ['Kola', 'fontshare', 'kola'], ['Excon', 'fontshare', 'excon'], ['Technor', 'fontshare', 'technor']], 'funky', 'playful, retro, expressive'),
  ...group([['JetBrains Mono', 'fontsource', 'jetbrains-mono'], ['IBM Plex Mono', 'fontsource', 'ibm-plex-mono'], ['Space Mono', 'fontsource', 'space-mono'], ['Geist Mono', 'fontsource', 'geist-mono']], 'mono', 'code, data, technical'),
  ...group([['Caveat', 'fontsource', 'caveat'], ['Permanent Marker', 'fontsource', 'permanent-marker'], ['Kalam', 'fontshare', 'kalam']], 'hand', 'handwritten notes and annotations'),
]

/** A family name as compared everywhere here: lower case, letters and digits only. */
export const normFamily = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

// ---- outbound requests -------------------------------------------------------------------------------------

/** A source URL as a URL object, or a refusal when it is not https on one of FONT_HOSTS. Protocol-relative is https. */
export function allowedFontUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.startsWith('//') ? `https:${raw}` : raw)
  } catch {
    throw new StudioError('A font source gave an address that is not a URL.', 502, 'FONT_SOURCE')
  }
  if (url.protocol !== 'https:' || !(FONT_HOSTS as readonly string[]).includes(url.hostname) || url.username || url.password || url.port)
    throw new StudioError('A font source pointed outside the font hosts.', 502, 'FONT_SOURCE')
  return url
}

/** GET an allowed URL, reading at most `maxBytes` (more is refused, not truncated). */
async function fetchCapped(raw: string, maxBytes: number, timeoutMs: number): Promise<Uint8Array> {
  let url = allowedFontUrl(raw)
  const signal = AbortSignal.timeout(timeoutMs)
  let response = await fetch(url, { signal, redirect: 'manual' })
  // A redirect is followed only to another allowed host, a few times at most.
  for (let hops = 0; response.status >= 300 && response.status < 400 && hops < 3; hops++) {
    const location = response.headers.get('location')
    if (!location) break
    url = allowedFontUrl(new URL(location, url).toString())
    response = await fetch(url, { signal, redirect: 'manual' })
  }
  if (!response.ok) throw new Error(`${url.hostname}${url.pathname} answered ${response.status}`)
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${url.pathname} is larger than ${maxBytes} bytes`)
  if (!response.body) return new Uint8Array(await response.arrayBuffer())
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error(`${url.pathname} is larger than ${maxBytes} bytes`)
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.byteLength
  }
  return out
}

const fetchText = async (url: string, maxBytes = LISTING_MAX_BYTES) => new TextDecoder().decode(await fetchCapped(url, maxBytes, LISTING_TIMEOUT_MS))
const fetchJson = async <T>(url: string): Promise<T> => JSON.parse(await fetchText(url)) as T

// ---- the two catalogues ------------------------------------------------------------------------------------

type ShareStyle = { is_variable: boolean; is_italic: boolean; weight: { number: number } }
type ShareAxis = { property: string; range_left: number; range_right: number; range_default: number }
export type ShareFont = { name: string; slug: string; category: string; styles: ShareStyle[]; axes?: ShareAxis[] }
export type SourceFont = { id: string; family: string; category: string; variable: boolean; weights: number[]; styles: string[]; subsets: string[] }

/** Fontshare's list, only the fields used here. */
export function parseFontshare(raw: unknown): ShareFont[] {
  const fonts = (raw as { fonts?: unknown })?.fonts
  if (!Array.isArray(fonts)) return []
  return fonts.flatMap((f) => {
    if (!f || typeof f.name !== 'string' || typeof f.slug !== 'string' || !Array.isArray(f.styles)) return []
    const styles = (f.styles as ShareStyle[])
      .filter((s) => s && typeof s.weight?.number === 'number')
      .map((s) => ({ is_variable: !!s.is_variable, is_italic: !!s.is_italic, weight: { number: s.weight.number } }))
    const axes = Array.isArray(f.axes)
      ? (f.axes as ShareAxis[]).map((a) => ({ property: String(a.property), range_left: Number(a.range_left), range_right: Number(a.range_right), range_default: Number(a.range_default) }))
      : undefined
    return [{ name: f.name, slug: f.slug, category: typeof f.category === 'string' ? f.category : '', styles, ...(axes ? { axes } : {}) }]
  })
}

/** Fontsource's list, Latin families only, only the fields used here. */
export function parseFontsource(raw: unknown): SourceFont[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((f) => {
    if (!f || typeof f.id !== 'string' || typeof f.family !== 'string' || !Array.isArray(f.subsets) || !f.subsets.includes('latin')) return []
    return [{
      id: f.id,
      family: f.family,
      category: typeof f.category === 'string' ? f.category : '',
      variable: !!f.variable,
      weights: Array.isArray(f.weights) ? f.weights.filter((w: unknown): w is number => typeof w === 'number') : [],
      styles: Array.isArray(f.styles) ? f.styles.filter((s: unknown): s is string => typeof s === 'string') : [],
      subsets: ['latin'],
    }]
  })
}

const listings = new Map<string, { at: number; data: Promise<unknown> }>()
/** A source's list, kept for a day in this process (a failed fetch is forgotten at once). */
function listing<T>(name: string, url: string, pick: (raw: unknown) => T): Promise<T> {
  const cached = listings.get(name)
  if (cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.data as Promise<T>
  const data = fetchJson<unknown>(url).then(pick)
  listings.set(name, { at: Date.now(), data })
  data.catch(() => listings.delete(name))
  return data
}
const fontshare = () => listing('fontshare', 'https://api.fontshare.com/v2/fonts', parseFontshare)
const fontsource = () => listing('fontsource', 'https://api.fontsource.org/v1/fonts', parseFontsource)

/** Forget the cached lists (tests). */
export const resetFontListings = () => listings.clear()

/** Families matching a search, from both sources, the shelf first, no family twice. */
export async function searchFonts(query: string, limit = 40): Promise<CatalogFont[]> {
  const q = normFamily(query)
  const lower = query.toLowerCase()
  const out: CatalogFont[] = []
  const seen = new Set<string>()
  const add = (f: CatalogFont) => {
    if (seen.has(normFamily(f.family))) return
    seen.add(normFamily(f.family))
    out.push(f)
  }
  for (const f of SHELF) if (!q || normFamily(f.family).includes(q) || f.category.includes(q) || f.mood.includes(lower)) add(f)
  const [share, source] = await Promise.all([fontshare().catch(() => [] as ShareFont[]), fontsource().catch(() => [] as SourceFont[])])
  for (const f of share)
    if (normFamily(f.name).includes(q) || normFamily(f.category).includes(q))
      add({ family: f.name, source: 'fontshare', id: f.slug, category: f.category.toLowerCase(), mood: 'Fontshare', variable: f.styles.some((s) => s.is_variable) })
  for (const f of source)
    if (normFamily(f.family).includes(q) || f.category === lower)
      add({ family: f.family, source: 'fontsource', id: f.id, category: f.category, mood: 'Google Fonts', variable: f.variable })
  return out.slice(0, limit)
}

// ---- which files a family is made of ------------------------------------------------------------------------

/** One file to fetch: where from and the blob key it is kept under. */
export type PlannedFile = FontFile & { url: string }

/** The Fontshare styles to ask its CSS for: the variable ones when there are any, else every weight. */
export function fontshareCssUrl(f: ShareFont): string {
  const variable = f.styles.filter((s) => s.is_variable)
  const wanted = variable.length ? variable.map((s) => s.weight.number) : [...new Set(f.styles.map((s) => s.weight.number))]
  return `https://api.fontshare.com/v2/css?${wanted.map((w) => `f[]=${encodeURIComponent(f.slug)}@${w}`).join('&')}&display=swap`
}

/** The woff2 files Fontshare's CSS names, one per @font-face block. */
export function fontshareFiles(f: ShareFont, css: string): PlannedFile[] {
  const files: PlannedFile[] = []
  for (const block of css.split('@font-face').slice(1)) {
    const src = /url\('([^']+\.woff2)'\)/.exec(block)?.[1]
    const weight = /font-weight:\s*([\d ]+);/.exec(block)?.[1]?.trim()
    const style = /font-style:\s*(\w+)/.exec(block)?.[1] === 'italic' ? 'italic' : 'normal'
    if (!src || !weight) continue
    allowedFontUrl(src)
    files.push({ url: src.startsWith('//') ? `https:${src}` : src, file: `fonts/${f.slug}/${f.slug}-${weight.replace(' ', '-')}-${style}.woff2`, weight, style })
  }
  return files
}

/** What a Fontshare family records once its files are in. */
export function fontshareRecord(f: ShareFont, files: FontFile[]): InstalledFont {
  const variable = f.styles.filter((s) => s.is_variable)
  const weights = f.styles.filter((s) => !s.is_variable).map((s) => (s.weight.number % 100 === 0 ? s.weight.number : s.weight.number - 1))
  const axis = f.axes?.find((a) => a.property === 'wght')
  return {
    family: f.name, slug: f.slug, source: 'fontshare', category: f.category.toLowerCase(), variable: variable.length > 0, italic: files.some((x) => x.style === 'italic'),
    weights: axis ? [axis.range_left, axis.range_right] : [Math.min(...weights), Math.max(...weights)],
    ...(f.axes ? { axes: Object.fromEntries(f.axes.map((a) => [a.property, { min: a.range_left, max: a.range_right, default: a.range_default }])) } : {}),
    files, license: 'ITF Free Font License (free for commercial use)',
  }
}

const SOURCE_CDN = 'https://cdn.jsdelivr.net/fontsource/fonts'
type Axes = NonNullable<InstalledFont['axes']>

/** A Fontsource variable family's axes (italic left out), from its /variable answer. */
export function fontsourceAxes(meta: unknown): Axes | undefined {
  const axes = (meta as { axes?: Record<string, { min: string; max: string; default: string }> } | null)?.axes
  if (!axes || typeof axes !== 'object') return undefined
  return Object.fromEntries(Object.entries(axes).filter(([k]) => k !== 'ital').map(([k, v]) => [k, { min: Number(v.min), max: Number(v.max), default: Number(v.default) }]))
}

/** The candidates for one style of a variable Fontsource family, best first: every axis, then weight only. */
export function fontsourceVariableCandidates(f: SourceFont, axes: Axes | undefined, style: 'normal' | 'italic'): PlannedFile[] {
  const wght = axes?.wght
  return (Object.keys(axes ?? {}).length > 1 ? ['full', 'wght'] : ['wght']).map((kind) => ({
    url: `${SOURCE_CDN}/${encodeURIComponent(f.id)}:vf@latest/latin-${kind}-${style}.woff2`,
    file: `fonts/${f.id}/${f.id}-${kind}-${style}.woff2`,
    weight: wght ? `${wght.min} ${wght.max}` : '400',
    style,
  }))
}

/** A static Fontsource family's files: every weight in every style it has. */
export function fontsourceStaticFiles(f: SourceFont): PlannedFile[] {
  const styles = f.styles.includes('italic') ? (['normal', 'italic'] as const) : (['normal'] as const)
  return f.weights.flatMap((weight) => styles.map((style) => ({
    url: `${SOURCE_CDN}/${encodeURIComponent(f.id)}@latest/latin-${weight}-${style}.woff2`,
    file: `fonts/${f.id}/${f.id}-${weight}-${style}.woff2`,
    weight: String(weight),
    style,
  })))
}

/** What a Fontsource family records once its files are in. */
export function fontsourceRecord(f: SourceFont, files: FontFile[], axes: Axes | undefined): InstalledFont {
  return {
    family: f.family, slug: f.id, source: 'fontsource', category: f.category, variable: f.variable && files.some((x) => x.weight.includes(' ')), italic: files.some((x) => x.style === 'italic'),
    weights: [Math.min(...f.weights), Math.max(...f.weights)], ...(axes ? { axes } : {}), files, license: 'Open font licence (Google Fonts)',
  }
}

// ---- installing ---------------------------------------------------------------------------------------------

/** Whether bytes are a font file by their own header: WOFF2, WOFF, TrueType or OpenType. Pure. */
export function isFontFile(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false
  const tag = String.fromCharCode(...bytes.subarray(0, 4))
  return tag === 'wOF2' || tag === 'wOFF' || tag === 'OTTO' || tag === 'true' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)
}

/** Put one font file in the workspace's storage, unless it is there already. Anything but a font is refused. */
async function storeFile(ctx: StudioContext, planned: PlannedFile): Promise<FontFile> {
  if (!(await getBlob(ctx, planned.file))) {
    const bytes = await fetchCapped(planned.url, FONT_FILE_MAX_BYTES, FILE_TIMEOUT_MS)
    if (!isFontFile(bytes)) throw new Error(`${planned.url} is not a font file`)
    await putBlobBytes(ctx, planned.file, bytes, 'font/woff2')
  }
  return { file: planned.file, weight: planned.weight, style: planned.style }
}

async function installFontshare(ctx: StudioContext, f: ShareFont): Promise<InstalledFont> {
  const css = await fetchText(fontshareCssUrl(f), 1024 * 1024)
  const planned = fontshareFiles(f, css)
  if (!planned.length) throw new StudioError(`Fontshare gave no files for ${f.name}.`, 502, 'FONT_SOURCE')
  const files: FontFile[] = []
  for (const file of planned) files.push(await storeFile(ctx, file))
  return fontshareRecord(f, files)
}

async function installFontsource(ctx: StudioContext, f: SourceFont): Promise<InstalledFont> {
  const files: FontFile[] = []
  let axes: Axes | undefined
  if (f.variable) {
    axes = fontsourceAxes(await fetchJson(`https://api.fontsource.org/v1/variable/${encodeURIComponent(f.id)}`).catch(() => null))
    for (const style of f.styles.includes('italic') ? (['normal', 'italic'] as const) : (['normal'] as const)) {
      for (const candidate of fontsourceVariableCandidates(f, axes, style)) {
        try {
          files.push(await storeFile(ctx, candidate))
          break
        } catch {
          /* the next candidate */
        }
      }
    }
  }
  if (!files.length) {
    for (const file of fontsourceStaticFiles(f)) {
      try {
        files.push(await storeFile(ctx, file))
      } catch {
        /* not in this style */
      }
    }
  }
  if (!files.length) throw new StudioError(`Fontsource gave no files for ${f.family}.`, 502, 'FONT_SOURCE')
  return fontsourceRecord(f, files, axes)
}

/** Every installed family of the workspace. */
export async function installedFonts(ctx: StudioContext): Promise<InstalledFont[]> {
  return (await listRecords<InstalledFont>(ctx, FONTS_COLLECTION)).map((row) => row.value)
}

const installing = new Map<string, Promise<InstalledFont>>()

/**
 * Download a family (once per workspace) by its name: the shelf's source first, then Fontshare, then Fontsource.
 * One install of a family per workspace runs at a time; a second ask joins it.
 */
export function installFont(ctx: StudioContext, family: unknown): Promise<InstalledFont> {
  if (typeof family !== 'string' || !family.trim() || family.length > 120) return Promise.reject(new StudioError('Name a font family.'))
  const key = normFamily(family)
  if (!key) return Promise.reject(new StudioError('Name a font family.'))
  const slot = `${ctx.workspaceId}:${key}`
  const running = installing.get(slot)
  if (running) return running
  const work = (async () => {
    const have = await getRecord<InstalledFont>(ctx, FONTS_COLLECTION, key)
    if (have && (await Promise.all(have.files.map((x) => getBlob(ctx, x.file)))).every(Boolean)) return have
    const shelf = SHELF.find((f) => normFamily(f.family) === key)
    const share = (await fontshare().catch(() => [] as ShareFont[])).find((f) => normFamily(f.name) === key || (shelf?.source === 'fontshare' && f.slug === shelf.id))
    const source = (await fontsource().catch(() => [] as SourceFont[])).find((f) => normFamily(f.family) === key || (shelf?.source === 'fontsource' && f.id === shelf.id))
    const font = shelf?.source === 'fontsource' && source
      ? await installFontsource(ctx, source)
      : share ? await installFontshare(ctx, share)
      : source ? await installFontsource(ctx, source)
      : null
    if (!font) throw new StudioError(`No font called "${family.trim()}" on Fontshare or Google Fonts.`, 404, 'NOT_FOUND')
    await putRecord(ctx, FONTS_COLLECTION, key, font)
    return font
  })().finally(() => installing.delete(slot))
  installing.set(slot, work)
  return work
}

/** The families a video's text uses (named families, and the defaults behind sans/display/serif/mono/heavy). */
export function projectFamilies(project: Pick<EditorProject, 'layers'>): string[] {
  const out = new Set<string>()
  for (const layer of project.layers ?? []) {
    if (['text', 'card', 'notification', 'chips', 'image', 'icons'].includes(layer.kind) || layer.style.text) out.add(familyOf(layer.style.font))
    for (const f of layer.style.scene?.fonts ?? []) out.add(familyOf(f))
  }
  return [...out]
}

/** The families to make sure of: the ones named, generic names resolved (and the five defaults, unless told not to). */
export function familiesToEnsure(named: string[], withDefaults = true): string[] {
  const out = new Map<string, string>()
  for (const family of [...(withDefaults ? Object.values(DEFAULT_FAMILIES) : []), ...named.map((f) => familyOf(f))]) {
    const key = normFamily(family)
    if (key && !out.has(key)) out.set(key, family)
  }
  return [...out.values()]
}

/** Install every family named (and the defaults) that is not installed yet. Failures are reported, not thrown. */
export async function ensureFonts(
  ctx: StudioContext,
  named: string[],
  options: { withDefaults?: boolean; log?: (line: string) => void } = {},
): Promise<{ installed: string[]; failed: string[] }> {
  const log = options.log ?? (() => {})
  const have = new Set((await installedFonts(ctx)).map((f) => normFamily(f.family)))
  const missing = familiesToEnsure(named, options.withDefaults ?? true).filter((f) => !have.has(normFamily(f))).slice(0, ENSURE_MAX + Object.keys(DEFAULT_FAMILIES).length)
  const installed: string[] = []
  const failed: string[] = []
  for (const family of missing) {
    const slot = `${ctx.workspaceId}:${normFamily(family)}`
    const lastFailure = recentFailures.get(slot)
    if (lastFailure && Date.now() - lastFailure < RETRY_AFTER_MS) {
      failed.push(family)
      continue
    }
    try {
      log(`Downloading the ${family} font`)
      await installFont(ctx, family)
      recentFailures.delete(slot)
      installed.push(family)
    } catch (error) {
      recentFailures.set(slot, Date.now())
      failed.push(family)
      log(`Couldn't get ${family}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { installed, failed }
}

/** A family that could not be installed is not tried again by ensureFonts for a while (the editor polls). */
const RETRY_AFTER_MS = 10 * 60_000
const recentFailures = new Map<string, number>()

/** Start installing what is missing without waiting (the editor polls GET /fonts until the faces arrive). */
export function ensureFontsInBackground(ctx: StudioContext, named: string[]): void {
  void ensureFonts(ctx, named).catch((error) => console.error('[studio] installing fonts failed:', error instanceof Error ? error.message : error))
}

/** Families named in a `families` query value ("A|B"), checked: at most ENSURE_MAX, each a plausible name. */
export function parseFamilies(value: string | null | undefined): string[] {
  if (!value) return []
  return [...new Set(value.split('|').map((f) => f.trim()).filter((f) => f.length > 0 && f.length <= 120 && /^[\p{L}\p{N} '&.-]+$/u.test(f)))].slice(0, ENSURE_MAX)
}

/** Faces of installed families (all of them, or those named), as the composition loads them. */
export function facesOf(fonts: InstalledFont[], families?: string[]): FontFace[] {
  const want = families ? new Set(families.map((f) => normFamily(familyOf(f)))) : null
  return fonts.filter((f) => !want || want.has(normFamily(f.family))).flatMap((f) => f.files.map((x) => ({ family: f.family, file: x.file, weight: x.weight, style: x.style })))
}

/** Faces with the address the browser loads them from: the workspace's file route, same origin. */
export function servedFaces(workspaceId: string, faces: FontFace[]): ServedFace[] {
  return faces.map((face) => ({ ...face, src: `/api/account/studio/file/${workspaceId}/${face.file}` }))
}

/** What an export carries: the faces of the families its video uses, installing any missing first (errors aside). */
export async function exportFonts(ctx: StudioContext, project: Pick<EditorProject, 'layers'>): Promise<FontFace[]> {
  const families = projectFamilies(project)
  await ensureFonts(ctx, families, { withDefaults: false }).catch(() => undefined)
  return facesOf(await installedFonts(ctx), families)
}

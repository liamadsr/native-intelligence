// A Studio project's brand kit (ads-contract.ts BrandKit): one record (studio_record, collection `brand-kit`, key =
// the Studio project id) with its files elsewhere: the logo masks are library images, the brand's own font files
// are stored under brand-kits/<project>/fonts/. Saving a kit keeps the project's brand summary (studio_project.brand,
// what the overview page shows) in step, and records uploaded fonts as the workspace's fonts, so the editor and
// exports draw a motion ad's words in them.
//
// A kit can be pasted in the shape a brand folder keeps it (brand.json, fonts.json, rules.json, sound.json, alone or
// under their file names): normaliseKit merges it. Font files a pasted fonts.json names wait for their upload, which
// matches them by file name.
import type { EditorAsset } from '../engine/contracts'
import {
  BrandKitSchema, brandSummary, emptyKit, fontFileName, isStoredFontKey, missingRoles, normaliseKit,
  type BrandKit, type JobFontFace, type JobKit, type KitFontFace, type KitFontRole,
} from './ads-contract'
import { getAssets } from './assets'
import { putBlobBytes } from './blobs'
import { must, isUuid, type StudioContext } from './context'
import { asStudioError, notFoundError, StudioError } from './errors'
import { FONT_FILE_MAX_BYTES, FONTS_COLLECTION, installFont, normFamily, type InstalledFont } from './fonts'
import { SINGLE, realProject, updateProject } from './projects'
import { getRecord, putRecord } from './records'
import { sha256Hex } from './stable'

/** The collection kits are kept in, keyed by Studio project id. */
export const BRAND_KIT_COLLECTION = 'brand-kit'

/** A kit as the page and the agent read it: the kit, its logo images, and what it still needs before ads render. */
export type BrandKitView = {
  projectId: string
  kit: BrandKit | null
  logos: { primary?: EditorAsset; mark?: EditorAsset }
  /** What is missing for static ads (template roles, logos, font files) and for motion ads (sounds), as sentences. */
  needs: string[]
}

async function liveProject(ctx: StudioContext, id: string): Promise<void> {
  const row = isUuid(id)
    ? (must(await ctx.supabase.from('studio_project').select('id').eq('workspace_id', ctx.workspaceId).eq('id', id).is('archived_at', null).maybeSingle(), 'open that Studio project') as { id: string } | null)
    : null
  if (!row) throw notFoundError('Studio project not found')
}

/** The stored kit of a project, or null. */
export async function readKit(ctx: StudioContext, projectId: string): Promise<BrandKit | null> {
  if (projectId.startsWith(SINGLE) || !isUuid(projectId)) return null
  const value = await getRecord<unknown>(ctx, BRAND_KIT_COLLECTION, projectId)
  if (!value) return null
  const parsed = BrandKitSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/** What a kit still needs, as sentences (empty when static ads can render). */
export function kitNeeds(kit: BrandKit | null, logos: BrandKitView['logos']): string[] {
  if (!kit) return ['No brand kit yet: paste the brand\'s files or fill in the palette, fonts and logos']
  const out: string[] = []
  if (!Object.keys(kit.palette).length) out.push('The palette is empty')
  const roles = missingRoles(kit)
  if (roles.length) out.push(`Map these template roles to palette colours (roles): ${roles.join(', ')}`)
  if (!Object.keys(kit.logoOn).length) out.push('Say which logo colour goes on which ground (logoOn)')
  if (!logos.primary) out.push('Upload the primary logo mask (a PNG with transparency)')
  if (!logos.mark) out.push('Upload the logo mark (a PNG with transparency); the primary logo stands in until then')
  for (const role of ['serif', 'sans'] as const) {
    const f = kit.fonts[role]
    const pending = f.faces.filter((x) => !isStoredFontKey(x.file)).map((x) => x.file)
    if (pending.length) out.push(`Upload the ${role}'s font files: ${pending.join(', ')}${typeof f.standIn === 'string' ? ` (${f.standIn} stands in until then)` : ''}`)
    else if (!f.faces.length && typeof f.standIn !== 'string') out.push(`The ${role} has no font files and no free family as its stand-in`)
  }
  return out
}

async function view(ctx: StudioContext, projectId: string, kit: BrandKit | null): Promise<BrandKitView> {
  const ids = kit ? [kit.logos.primary?.assetId, kit.logos.mark?.assetId].filter((x): x is string => !!x) : []
  const found = await getAssets(ctx, ids)
  const logos = {
    ...(kit?.logos.primary && found.get(kit.logos.primary.assetId) ? { primary: found.get(kit.logos.primary.assetId)! } : {}),
    ...(kit?.logos.mark && found.get(kit.logos.mark.assetId) ? { mark: found.get(kit.logos.mark.assetId)! } : {}),
  }
  return { projectId, kit, logos, needs: kitNeeds(kit, logos) }
}

/** A project's kit as the page reads it. A lone video's virtual project has none. */
export async function getBrandKit(ctx: StudioContext, projectId: string): Promise<BrandKitView> {
  if (!projectId.startsWith(SINGLE)) await liveProject(ctx, projectId)
  return view(ctx, projectId, await readKit(ctx, projectId))
}

/** Uploaded font files as one of the workspace's installed fonts, so the editor and exports load them by family. */
async function recordBrandFont(ctx: StudioContext, role: KitFontRole): Promise<void> {
  const faces = role.faces.filter((f) => isStoredFontKey(f.file))
  if (!faces.length) return
  const weights = faces.flatMap((f) => String(f.weight).split(' ').map(Number)).filter((n) => Number.isFinite(n))
  const font = {
    family: role.family,
    slug: normFamily(role.family),
    source: 'brand',
    category: 'brand',
    variable: faces.some((f) => /\d+ \d+/.test(String(f.weight))),
    weights: [Math.min(...weights), Math.max(...weights)] as [number, number],
    italic: faces.some((f) => f.style === 'italic'),
    files: faces.map((f) => ({ file: f.file, weight: String(f.weight), style: f.style })),
    license: 'The brand\'s own licensed files, uploaded to this workspace',
  }
  await putRecord(ctx, FONTS_COLLECTION, normFamily(role.family), font as unknown as InstalledFont)
}

/** Check, store and summarise a kit. */
async function storeKit(ctx: StudioContext, projectId: string, kit: BrandKit): Promise<BrandKitView> {
  const ids = [kit.logos.primary?.assetId, kit.logos.mark?.assetId].filter((x): x is string => !!x)
  const found = await getAssets(ctx, ids)
  for (const id of ids) {
    const a = found.get(id)
    if (!a) throw new StudioError('A logo the kit names is not in the media library: upload it first.', 400, 'INVALID')
    if (a.kind !== 'image' || !/\.png$/.test(a.file)) throw new StudioError(`The logo "${a.name}" must be a PNG with transparency (a mask).`, 400, 'INVALID')
  }
  await putRecord(ctx, BRAND_KIT_COLLECTION, projectId, kit)
  await updateProject(ctx, projectId, { brand: brandSummary(kit) })
  for (const role of [kit.fonts.serif, kit.fonts.sans]) await recordBrandFont(ctx, role)
  return view(ctx, projectId, kit)
}

/**
 * Save a kit: the kit's own shape, or a brand folder's files pasted (alone or under their names), merged into what
 * is there. A lone video's virtual project becomes a real project first. Answers the kit as the page reads it.
 */
export async function saveBrandKit(ctx: StudioContext, projectId: string, value: unknown): Promise<BrandKitView> {
  const id = await realProject(ctx, projectId)
  await liveProject(ctx, id)
  let kit: BrandKit
  try {
    kit = normaliseKit(value, await readKit(ctx, id))
  } catch (error) {
    throw asStudioError(error, 'The brand kit')
  }
  return storeKit(ctx, id, kit)
}

/** Font file signatures: OpenType (CFF), TrueType, WOFF, WOFF2. */
const fontKind = (bytes: Uint8Array): string | null => {
  const tag = String.fromCharCode(...bytes.subarray(0, 4))
  if (tag === 'OTTO') return 'otf'
  if (tag === 'wOFF') return 'woff'
  if (tag === 'wOF2') return 'woff2'
  if (tag === 'true' || (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0)) return 'ttf'
  return null
}

/** A cut's weight and style read from its file name ("Brand-LightItalic.otf" → 300 italic). */
export function faceFromName(name: string): Pick<KitFontFace, 'weight' | 'style'> {
  const n = name.toLowerCase()
  const style = /italic|oblique/.test(n) ? 'italic' as const : 'normal' as const
  if (/variable|vf\b|\[wght/.test(n)) return { weight: '100 900', style }
  const table: [RegExp, number][] = [[/hairline|thin/, 100], [/extra-?light|ultra-?light/, 200], [/light/, 300], [/book|regular|roman|normal/, 400], [/medium/, 500], [/semi-?bold|demi/, 600], [/extra-?bold|ultra-?bold/, 800], [/black|heavy/, 900], [/bold/, 700]]
  for (const [re, w] of table) if (re.test(n)) return { weight: w, style }
  return { weight: 400, style }
}

/**
 * Upload one of the brand's licensed font files for a role (base64 in the body: font files are small). A face a
 * pasted fonts.json named by this file name takes it; otherwise it is added, its weight and style read from its name
 * unless given.
 */
export async function uploadBrandFont(ctx: StudioContext, projectId: string, body: { role?: unknown; name?: unknown; data?: unknown; weight?: unknown; style?: unknown }): Promise<BrandKitView> {
  const role = body.role === 'serif' || body.role === 'sans' ? body.role : null
  if (!role) throw new StudioError('Say which role the font is for: serif or sans.')
  const name = typeof body.name === 'string' ? body.name.split(/[\\/]/).pop()!.trim().slice(0, 120) : ''
  if (!name) throw new StudioError('Name the font file.')
  if (typeof body.data !== 'string' || !body.data) throw new StudioError('Send the font file\'s bytes (base64).')
  const bytes = new Uint8Array(Buffer.from(body.data, 'base64'))
  if (!bytes.length || bytes.length > FONT_FILE_MAX_BYTES) throw new StudioError('A font file is at most 5 MB.')
  const kind = fontKind(bytes)
  if (!kind) throw new StudioError(`${name} is not a font file (OTF, TTF, WOFF or WOFF2).`)
  const id = await realProject(ctx, projectId)
  await liveProject(ctx, id)
  const sha = sha256Hex(bytes)
  const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[^a-zA-Z0-9]+/, '') || `font.${kind}`
  const key = `brand-kits/${id}/fonts/${sha.slice(0, 8)}-${safe}`
  await putBlobBytes(ctx, key, bytes, `font/${kind === 'otf' ? 'otf' : kind}`, sha)
  const kit = (await readKit(ctx, id)) ?? emptyKit()
  const current = kit.fonts[role]
  const guessed = faceFromName(name)
  const weight = typeof body.weight === 'number' || (typeof body.weight === 'string' && /^\d{1,4}( \d{1,4})?$/.test(body.weight)) ? (body.weight as KitFontFace['weight']) : undefined
  const style = body.style === 'italic' || body.style === 'normal' ? body.style : undefined
  const sameName = (f: KitFontFace) => (isStoredFontKey(f.file) ? fontFileName(f.file) : f.file) === safe || f.file === name
  const pending = current.faces.find(sameName)
  const face: KitFontFace = { file: key, weight: weight ?? pending?.weight ?? guessed.weight, style: style ?? pending?.style ?? guessed.style }
  const faces = pending ? current.faces.map((f) => (f === pending ? face : f)) : [...current.faces, face]
  const next = BrandKitSchema.parse({ ...kit, fonts: { ...kit.fonts, [role]: { ...current, faces } } })
  return storeKit(ctx, id, next)
}

/** Set a logo slot (primary or mark) to a library image (a PNG mask with transparency, uploaded through the import). */
export async function setBrandLogo(ctx: StudioContext, projectId: string, body: { slot?: unknown; assetId?: unknown }): Promise<BrandKitView> {
  const slot = body.slot === 'primary' || body.slot === 'mark' ? body.slot : null
  if (!slot) throw new StudioError('Say which logo: primary or mark.')
  if (typeof body.assetId !== 'string') throw new StudioError('Name the logo\'s image (assetId).')
  const id = await realProject(ctx, projectId)
  await liveProject(ctx, id)
  const kit = (await readKit(ctx, id)) ?? emptyKit()
  return storeKit(ctx, id, { ...kit, logos: { ...kit.logos, [slot]: { assetId: body.assetId } } })
}

/** A role's faces as a job draws them: its uploaded files, else its free stand-in family (installed if need be). */
async function roleFaces(ctx: StudioContext, role: KitFontRole, which: 'serif' | 'sans', notes: string[]): Promise<{ faces: JobFontFace[]; family: string }> {
  const stored = role.faces.filter((f) => isStoredFontKey(f.file))
  const pending = role.faces.filter((f) => !isStoredFontKey(f.file))
  if (stored.length) {
    if (pending.length) notes.push(`The ${which} is missing ${pending.map((f) => f.file).join(', ')} (not uploaded); the nearest uploaded cut is used`)
    return { faces: stored.map((f) => ({ file: f.file, weight: String(f.weight), style: f.style })), family: role.family }
  }
  const standIn = typeof role.standIn === 'string' ? role.standIn : null
  if (!standIn) throw new StudioError(`The brand kit's ${which} has no font files: upload them, or name a free family as its stand-in.`)
  const installed = await installFont(ctx, standIn)
  notes.push(`${role.brand ?? role.family} → ${installed.family} (a free stand-in: upload the brand's own files to use them)`)
  return { faces: installed.files.map((f) => ({ file: f.file, weight: f.weight, style: f.style })), family: installed.family }
}

/** The kit as a job carries it, or a sentence saying what it still needs. */
export async function jobKit(ctx: StudioContext, projectId: string): Promise<JobKit> {
  const kit = await readKit(ctx, projectId)
  if (!kit) throw new StudioError('This Studio project has no brand kit yet. Add one on its overview page (or with set_studio_brand_kit).', 400, 'NO_BRAND_KIT')
  const v = await view(ctx, projectId, kit)
  const blocking = v.needs.filter((n) => !/logo mark|stands in/.test(n))
  if (blocking.length) throw new StudioError(`The brand kit isn't ready: ${blocking.join('; ')}.`, 400, 'BRAND_KIT_INCOMPLETE')
  const notes: string[] = []
  if (!v.logos.mark) notes.push('No logo mark uploaded: the primary logo stands in for it')
  const serif = await roleFaces(ctx, kit.fonts.serif, 'serif', notes)
  const sans = await roleFaces(ctx, kit.fonts.sans, 'sans', notes)
  return {
    kit,
    logos: { primary: v.logos.primary!, mark: v.logos.mark ?? v.logos.primary! },
    fonts: { serif: serif.faces, sans: sans.faces },
    editorFamilies: { serif: serif.family, sans: sans.family },
    fontNotes: notes,
  }
}

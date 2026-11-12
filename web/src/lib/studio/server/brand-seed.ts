// A new Studio project's brand starts from what the workspace already has, and nothing invented: its name is the
// workspace's name, and the workspace's logo (workspace.logo_url), when there is one, is kept as a link in the
// project's notes. The logo is not imported into the media library here: an import is a worker job over stored
// bytes, and fetching an outside URL on the server needs its own fence (https only, a size cap, a timeout, no
// private addresses), so the link waits in the notes for the person (or the agent) to bring it in. No model is
// called. The brand's colors and fonts are left empty: the workspace records none.
import type { CampaignBrand } from '../engine/server-types'
import type { StudioContext } from './context'

/** The longest logo link kept (a longer one is not a link anyone pasted). */
const LOGO_URL_MAX = 1000

/** A logo link worth keeping: an https URL of a sane length, else null. */
export function logoLink(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const url = value.trim()
  if (!url || url.length > LOGO_URL_MAX || !/^https:\/\/[^\s]+$/i.test(url)) return null
  try {
    return new URL(url).protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** The line a seeded logo link reads as in a project's notes. */
export const logoNote = (url: string) => `Logo (from the workspace): ${url}`

/** What the workspace row gives a new project, pure: its brand (the name) and its notes (the logo link), or nothing. */
export function seedFromWorkspace(workspace: { name?: unknown; logo_url?: unknown } | null): { brand: CampaignBrand | null; notes: string | null } {
  const name = typeof workspace?.name === 'string' ? workspace.name.trim().slice(0, 120) : ''
  const logo = logoLink(workspace?.logo_url)
  return { brand: name ? { name } : null, notes: logo ? logoNote(logo) : null }
}

/** The workspace's seed for a new project; nothing when it can't be read (a project is never refused for it). */
export async function workspaceSeed(ctx: StudioContext): Promise<{ brand: CampaignBrand | null; notes: string | null }> {
  try {
    const { data, error } = await ctx.supabase.from('workspace').select('name, logo_url').eq('id', ctx.workspaceId).maybeSingle()
    if (error) throw new Error(error.message)
    return seedFromWorkspace(data as { name?: unknown; logo_url?: unknown } | null)
  } catch (error) {
    console.warn('[studio] reading the workspace for a new project\'s brand failed:', error instanceof Error ? error.message : error)
    return { brand: null, notes: null }
  }
}

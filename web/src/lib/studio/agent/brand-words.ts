/**
 * Where a Studio project's words live. A Studio project's brand holds its look
 * (a name, colors, fonts, a logo); what the videos SAY comes from the
 * workspace's canon documents: the `product` document (positioning, messaging,
 * the product's voice), the person's own `person:voice` (how they write) and
 * their `content-brief:<channel>` briefs. This answers pointers to them (keys
 * and titles, never their text), for the agent to read with read_canon before
 * it writes a script; and names the two that matter when they are missing.
 *
 * Reads the canon registry (src/lib/documents/canon-registry.ts: the reader's
 * own personal canon only, nothing they can't see), service-role safe. Never
 * throws: a failed read answers no pointers.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadCanonRegistry } from '@/lib/documents/canon-registry'
import type { CanonEntry } from '@/lib/documents/canon'

/** One canon document the brand's words come from. */
export interface BrandWordsPointer {
  key: string
  title: string
  /** What it holds, for the Studio. */
  holds: string
  /** The call that reads it. */
  read: string
}

export interface BrandWords {
  canon: BrandWordsPointer[]
  /** The keys that would hold the words and don't exist yet. */
  missing: string[]
  note: string
}

const HOLDS: Record<string, string> = {
  product: "the product's positioning, messaging and voice",
  'person:voice': 'how the person writes and speaks',
}

/** Is a canon key one a video's words come from? */
const isBrandWordsKey = (key: string) => key === 'product' || key === 'person:voice' || key.startsWith('content-brief:')

/** The pointers among a reader's canon entries, product first, then the voice, then the briefs. Pure. */
export function brandWordsFrom(entries: readonly CanonEntry[]): BrandWords {
  const order = (key: string) => (key === 'product' ? 0 : key === 'person:voice' ? 1 : 2)
  const canon = entries
    .filter((e) => isBrandWordsKey(e.key))
    .sort((a, b) => order(a.key) - order(b.key) || a.key.localeCompare(b.key))
    .map((e) => ({
      key: e.key,
      title: e.title,
      holds: HOLDS[e.key] ?? `the brief for ${e.key.slice('content-brief:'.length)}`,
      read: `read_canon(key: "${e.key}")`,
    }))
  const have = new Set(canon.map((c) => c.key))
  const missing = ['product', 'person:voice'].filter((k) => !have.has(k))
  return {
    canon,
    missing,
    note:
      'A Studio project\'s brand is its look (name, colors, fonts, logo). Its words come from these canon documents: read them with read_canon before writing a script, and keep to them.' +
      (missing.length ? ` Not written yet: ${missing.join(', ')} (offer to write it rather than inventing positioning or a voice).` : ''),
  }
}

/** The brand's words for the person in the workspace (pointers only). */
export async function studioBrandWords(supabase: SupabaseClient, workspaceId: string, userId: string): Promise<BrandWords> {
  try {
    return brandWordsFrom(await loadCanonRegistry(supabase, { workspaceId, userId }))
  } catch {
    return brandWordsFrom([])
  }
}

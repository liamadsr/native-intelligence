/**
 * What the business itself calls things, from its profile, for the edition's
 * words (src/lib/editions/words.ts): today its word for a booking
 * (`business_profile.booking_kind`: "pickup", "visit"). Read only for an
 * edition that names bookings at all, so every other workspace costs nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EditionDefinition } from '@/lib/editions/manifest'
import { editionWords, renderEditionWordsSection, type BusinessWords } from '@/lib/editions/words'
import { getBusinessProfile } from './store'

/** The business's words, or none. Never throws: a failed read is the edition's own words. */
export async function businessWordsFor(
  supabase: SupabaseClient,
  workspaceId: string,
  edition: Pick<EditionDefinition, 'words'>,
): Promise<BusinessWords> {
  if (!editionWords(edition).terms.booking) return {}
  try {
    const profile = await getBusinessProfile(supabase, workspaceId)
    return profile ? { bookingKind: profile.bookingKind } : {}
  } catch {
    return {}
  }
}

/** The agent's words section for a workspace, with the business's own words in it ('' for none). Never throws. */
export async function workspaceWordsSection(
  supabase: SupabaseClient,
  workspaceId: string,
  edition: Pick<EditionDefinition, 'words'>,
): Promise<string> {
  return renderEditionWordsSection(edition, await businessWordsFor(supabase, workspaceId, edition)) ?? ''
}

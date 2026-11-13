/**
 * The members list's small note on how someone came in (member.joined_via,
 * migration 645). An emailed invite and the older rows say nothing: the
 * note is there for the two ways in nobody was asked about one by one.
 */
export function joinedViaNote(joinedVia: string | null | undefined): string | null {
  if (joinedVia === 'link') return 'Joined with the link'
  if (joinedVia === 'domain') return 'Joined by email domain'
  return null
}

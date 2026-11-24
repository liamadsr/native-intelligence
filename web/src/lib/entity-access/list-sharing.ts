/**
 * A list row's word on its sharing (688; docs/plans/record-sharing.md, Phase
 * 3): "Shared with you" on a record shared with the reader, "Shared · N" on
 * its owner's row, nothing otherwise. A private record's privacy is the eye
 * after its title (components/views/list/entity-row.tsx), not this chip.
 * Client-safe and pure.
 */
export interface RowSharing {
  shared_count?: number
  shared_with_me?: boolean
}

export function listSharingText(sharing: RowSharing | null | undefined): string | null {
  if (!sharing) return null
  if (sharing.shared_with_me) return 'Shared with you'
  return (sharing.shared_count ?? 0) > 0 ? `Shared · ${sharing.shared_count}` : null
}

import { describe, it, expect } from 'vitest'
import {
  partitionClaimsForDeletion,
  prunedSharedEvidence,
  edgesToDelete,
  type DeletedSource,
  type ClaimSourceRow,
  type EntityLinkRow,
} from '@/lib/captures/delete-artifacts'

// A capture being permanently deleted, plus one of its attachments. Matches
// how migration 178 builds the pair set (capture + attachments.note_id set).
const CAPTURE: DeletedSource = { source_type: 'capture', source_id: 'cap-1' }
const ATTACHMENT: DeletedSource = { source_type: 'attachment', source_id: 'att-1' }
const captureAndAttachment = [CAPTURE, ATTACHMENT]

describe('partitionClaimsForDeletion', () => {
  it('sole-sources a claim whose only evidence is the deleted capture', () => {
    const rows: ClaimSourceRow[] = [
      { claim_id: 'c1', source_type: 'capture', source_id: 'cap-1' },
    ]
    const { soleSourced, shared } = partitionClaimsForDeletion([CAPTURE], rows)
    expect(soleSourced).toEqual(['c1'])
    expect(shared).toEqual([])
  })

  it("counts the capture's attachment as belonging to the capture", () => {
    const rows: ClaimSourceRow[] = [
      { claim_id: 'c1', source_type: 'capture', source_id: 'cap-1' },
      { claim_id: 'c1', source_type: 'attachment', source_id: 'att-1' },
    ]
    const { soleSourced } = partitionClaimsForDeletion(captureAndAttachment, rows)
    expect(soleSourced).toEqual(['c1'])
  })

  it('keeps a claim shared when it also has evidence from another capture', () => {
    const rows: ClaimSourceRow[] = [
      { claim_id: 'c1', source_type: 'capture', source_id: 'cap-1' },
      { claim_id: 'c1', source_type: 'capture', source_id: 'other-cap' },
    ]
    const { soleSourced, shared } = partitionClaimsForDeletion([CAPTURE], rows)
    expect(soleSourced).toEqual([])
    expect(shared).toEqual(['c1'])
  })

  it('keeps a claim shared when it has manual/external evidence', () => {
    const rows: ClaimSourceRow[] = [
      { claim_id: 'c1', source_type: 'capture', source_id: 'cap-1' },
      { claim_id: 'c1', source_type: 'manual', source_id: null },
    ]
    const { shared } = partitionClaimsForDeletion([CAPTURE], rows)
    expect(shared).toEqual(['c1'])
  })

  it('treats an attachment from a DIFFERENT capture as outside evidence', () => {
    const rows: ClaimSourceRow[] = [
      { claim_id: 'c1', source_type: 'capture', source_id: 'cap-1' },
      { claim_id: 'c1', source_type: 'attachment', source_id: 'foreign-att' },
    ]
    const { shared } = partitionClaimsForDeletion(captureAndAttachment, rows)
    expect(shared).toEqual(['c1'])
  })

  it('ignores claims that have no evidence pointing at a deleted source', () => {
    const rows: ClaimSourceRow[] = [
      { claim_id: 'unrelated', source_type: 'capture', source_id: 'other-cap' },
    ]
    const { soleSourced, shared } = partitionClaimsForDeletion([CAPTURE], rows)
    expect(soleSourced).toEqual([])
    expect(shared).toEqual([])
  })

  it('partitions a mixed set', () => {
    const rows: ClaimSourceRow[] = [
      { claim_id: 'sole', source_type: 'capture', source_id: 'cap-1' },
      { claim_id: 'mixed', source_type: 'capture', source_id: 'cap-1' },
      { claim_id: 'mixed', source_type: 'email', source_id: 'email-1' },
      { claim_id: 'untouched', source_type: 'document', source_id: 'doc-9' },
    ]
    const { soleSourced, shared } = partitionClaimsForDeletion([CAPTURE], rows)
    expect(soleSourced).toEqual(['sole'])
    expect(shared).toEqual(['mixed'])
  })
})

describe('prunedSharedEvidence', () => {
  it('returns only the deleted-source rows of SHARED claims (never sole-sourced ones)', () => {
    const rows: ClaimSourceRow[] = [
      // sole-sourced — whole claim goes, its rows cascade, not pruned here
      { claim_id: 'sole', source_type: 'capture', source_id: 'cap-1' },
      // shared — prune just its capture-pointing row, keep the email row
      { claim_id: 'shared', source_type: 'capture', source_id: 'cap-1' },
      { claim_id: 'shared', source_type: 'email', source_id: 'email-1' },
    ]
    const pruned = prunedSharedEvidence([CAPTURE], rows)
    expect(pruned).toEqual([
      { claim_id: 'shared', source_type: 'capture', source_id: 'cap-1' },
    ])
  })

  it('prunes attachment-pointing evidence of a shared claim too', () => {
    const rows: ClaimSourceRow[] = [
      { claim_id: 'shared', source_type: 'attachment', source_id: 'att-1' },
      { claim_id: 'shared', source_type: 'capture', source_id: 'other-cap' },
    ]
    const pruned = prunedSharedEvidence(captureAndAttachment, rows)
    expect(pruned).toEqual([
      { claim_id: 'shared', source_type: 'attachment', source_id: 'att-1' },
    ])
  })
})

describe('edgesToDelete', () => {
  const soleRows: ClaimSourceRow[] = [
    { claim_id: 'sole', source_type: 'capture', source_id: 'cap-1' },
  ]

  it('removes every edge touching a sole-sourced (deleted) claim, both directions', () => {
    const edges: EntityLinkRow[] = [
      { id: 'e1', source_type: 'claim', source_id: 'sole', target_type: 'contact', target_id: 'ct-1' },
      { id: 'e2', source_type: 'project', source_id: 'pr-1', target_type: 'claim', target_id: 'sole' },
      { id: 'e3', source_type: 'claim', source_id: 'sole', target_type: 'capture', target_id: 'cap-1' },
    ]
    const removed = edgesToDelete([CAPTURE], soleRows, edges).map((e) => e.id)
    expect(removed.sort()).toEqual(['e1', 'e2', 'e3'])
  })

  it('removes the capture-endpoint edge even when the other endpoint is unrelated', () => {
    // capture↔contact edge — the capture itself is being deleted.
    const edges: EntityLinkRow[] = [
      { id: 'cap-edge', source_type: 'capture', source_id: 'cap-1', target_type: 'contact', target_id: 'ct-9' },
      { id: 'keep', source_type: 'contact', source_id: 'ct-9', target_type: 'project', target_id: 'pr-1' },
    ]
    const removed = edgesToDelete([CAPTURE], [], edges).map((e) => e.id)
    expect(removed).toEqual(['cap-edge'])
  })

  it('prunes the mirrored edge of a SHARED claim to the deleted capture but keeps the claim itself intact elsewhere', () => {
    const rows: ClaimSourceRow[] = [
      { claim_id: 'shared', source_type: 'capture', source_id: 'cap-1' },
      { claim_id: 'shared', source_type: 'email', source_id: 'email-1' },
    ]
    const edges: EntityLinkRow[] = [
      // mirror of this capture's evidence — must be pruned
      { id: 'mirror-cap', source_type: 'claim', source_id: 'shared', target_type: 'capture', target_id: 'cap-1' },
      // mirror of the surviving email evidence — must be KEPT
      { id: 'mirror-email', source_type: 'claim', source_id: 'shared', target_type: 'email', target_id: 'email-1' },
      // an unrelated 'about' edge to a contact — must be KEPT
      { id: 'about-contact', source_type: 'claim', source_id: 'shared', target_type: 'contact', target_id: 'ct-2' },
    ]
    const removed = edgesToDelete([CAPTURE], rows, edges).map((e) => e.id)
    expect(removed).toEqual(['mirror-cap'])
  })

  it('does not touch edges unrelated to the deleted source or its claims', () => {
    const edges: EntityLinkRow[] = [
      { id: 'x', source_type: 'action', source_id: 'a-1', target_type: 'project', target_id: 'pr-1' },
    ]
    expect(edgesToDelete([CAPTURE], soleRows, edges)).toEqual([])
  })
})

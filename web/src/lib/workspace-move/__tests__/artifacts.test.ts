import { describe, it, expect } from 'vitest'
import {
  partitionClaimsForSources,
  type ClaimSourceRow,
} from '@/lib/workspace-move/artifacts'

/**
 * Unit tests for the generic claim partition used by the project/document
 * move preflights. The rule must match `_wsmove_claims` in migration 221:
 * a claim travels only when EVERY evidence row points at a moving entity.
 */

const row = (
  claim_id: string,
  source_type: string,
  source_id: string | null,
): ClaimSourceRow => ({ claim_id, source_type, source_id })

describe('partitionClaimsForSources', () => {
  it('moves a claim whose every source is in the moving set', () => {
    const result = partitionClaimsForSources(
      ['c1'],
      [row('c1', 'document', 'doc-1'), row('c1', 'document', 'doc-2')],
      [
        { type: 'document', id: 'doc-1' },
        { type: 'document', id: 'doc-2' },
      ],
    )
    expect(result).toEqual({ soleSourced: ['c1'], shared: [] })
  })

  it('leaves a claim with a single outside source behind', () => {
    const result = partitionClaimsForSources(
      ['c1'],
      [row('c1', 'document', 'doc-1'), row('c1', 'capture', 'cap-9')],
      [{ type: 'document', id: 'doc-1' }],
    )
    expect(result).toEqual({ soleSourced: [], shared: ['c1'] })
  })

  it('treats a claim with no visible evidence as shared', () => {
    const result = partitionClaimsForSources(['c1'], [], [
      { type: 'document', id: 'doc-1' },
    ])
    expect(result).toEqual({ soleSourced: [], shared: ['c1'] })
  })

  it('matches on type AND id, not on id alone', () => {
    // Same uuid, different source_type — not the entity that is moving.
    const result = partitionClaimsForSources(
      ['c1'],
      [row('c1', 'capture', 'shared-id')],
      [{ type: 'document', id: 'shared-id' }],
    )
    expect(result).toEqual({ soleSourced: [], shared: ['c1'] })
  })

  it('never treats a null source_id as a match', () => {
    const result = partitionClaimsForSources(
      ['c1'],
      [row('c1', 'document', null)],
      [{ type: 'document', id: 'doc-1' }],
    )
    expect(result).toEqual({ soleSourced: [], shared: ['c1'] })
  })

  it('mixes types in the moving set (project move: documents + attachments)', () => {
    const rows = [
      row('sole', 'document', 'doc-1'),
      row('sole', 'attachment', 'att-1'),
      row('mixed', 'document', 'doc-1'),
      row('mixed', 'capture', 'cap-1'),
      row('other', 'document', 'doc-outside'),
    ]
    const result = partitionClaimsForSources(
      ['sole', 'mixed', 'other'],
      rows,
      [
        { type: 'document', id: 'doc-1' },
        { type: 'attachment', id: 'att-1' },
      ],
    )
    expect(result).toEqual({ soleSourced: ['sole'], shared: ['mixed', 'other'] })
  })

  it('ignores evidence rows for claims outside the id list', () => {
    const result = partitionClaimsForSources(
      ['c1'],
      [row('c1', 'document', 'doc-1'), row('c2', 'capture', 'cap-1')],
      [{ type: 'document', id: 'doc-1' }],
    )
    expect(result).toEqual({ soleSourced: ['c1'], shared: [] })
  })

  it('returns empty partitions for an empty claim list', () => {
    expect(
      partitionClaimsForSources([], [row('c1', 'document', 'doc-1')], [
        { type: 'document', id: 'doc-1' },
      ]),
    ).toEqual({ soleSourced: [], shared: [] })
  })

  it('leaves everything behind when nothing is moving', () => {
    const result = partitionClaimsForSources(
      ['c1'],
      [row('c1', 'document', 'doc-1')],
      [],
    )
    expect(result).toEqual({ soleSourced: [], shared: ['c1'] })
  })
})

import { describe, it, expect } from 'vitest'
import {
  computeConfirmedActionSignals,
  partitionClaimsBySource,
  splitParticipantContacts,
} from '@/lib/captures/move-artifacts'

describe('computeConfirmedActionSignals', () => {
  const action = (over: Partial<{ id: string; identifier: string; title: string; description: string | null }> = {}) => ({
    id: 'a1',
    identifier: 'ENG-1',
    title: 'Ship the widget',
    description: 'From the meeting',
    ...over,
  })

  it('marks an untouched action (matches its applied proposal) as not edited', () => {
    const [signal] = computeConfirmedActionSignals({
      actions: [action()],
      proposals: [
        { result_entity_id: 'a1', title: 'Ship the widget', description: 'From the meeting' },
      ],
      commentedActionIds: [],
      labeledActionIds: [],
      prLinkedActionIds: [],
    })
    expect(signal.edited).toBe(false)
    expect(signal.edit_reasons).toEqual([])
  })

  it('flags a title that drifted from the extraction proposal', () => {
    const [signal] = computeConfirmedActionSignals({
      actions: [action({ title: 'Ship the widget — REVISED SCOPE' })],
      proposals: [
        { result_entity_id: 'a1', title: 'Ship the widget', description: 'From the meeting' },
      ],
      commentedActionIds: [],
      labeledActionIds: [],
      prLinkedActionIds: [],
    })
    expect(signal.edited).toBe(true)
    expect(signal.edit_reasons).toContain('title edited')
  })

  it('flags a description that drifted from the extraction proposal', () => {
    const [signal] = computeConfirmedActionSignals({
      actions: [action({ description: 'Rewritten by hand' })],
      proposals: [
        { result_entity_id: 'a1', title: 'Ship the widget', description: 'From the meeting' },
      ],
      commentedActionIds: [],
      labeledActionIds: [],
      prLinkedActionIds: [],
    })
    expect(signal.edit_reasons).toEqual(['description edited'])
  })

  it('ignores whitespace-only differences', () => {
    const [signal] = computeConfirmedActionSignals({
      actions: [action({ title: '  Ship the widget  ', description: 'From the meeting\n' })],
      proposals: [
        { result_entity_id: 'a1', title: 'Ship the widget', description: 'From the meeting' },
      ],
      commentedActionIds: [],
      labeledActionIds: [],
      prLinkedActionIds: [],
    })
    expect(signal.edited).toBe(false)
  })

  it('treats a null action description same as an empty proposal description', () => {
    const [signal] = computeConfirmedActionSignals({
      actions: [action({ description: null })],
      proposals: [{ result_entity_id: 'a1', title: 'Ship the widget', description: '' }],
      commentedActionIds: [],
      labeledActionIds: [],
      prLinkedActionIds: [],
    })
    expect(signal.edited).toBe(false)
  })

  it('does not diff fields the proposal never recorded (null proposal fields)', () => {
    const [signal] = computeConfirmedActionSignals({
      actions: [action()],
      proposals: [{ result_entity_id: 'a1', title: null, description: null }],
      commentedActionIds: [],
      labeledActionIds: [],
      prLinkedActionIds: [],
    })
    expect(signal.edited).toBe(false)
  })

  it('does not mark an action edited just because no proposal snapshot exists', () => {
    const [signal] = computeConfirmedActionSignals({
      actions: [action()],
      proposals: [],
      commentedActionIds: [],
      labeledActionIds: [],
      prLinkedActionIds: [],
    })
    expect(signal.edited).toBe(false)
  })

  it('flags accreted work: comments, labels, PR links', () => {
    const signals = computeConfirmedActionSignals({
      actions: [
        action({ id: 'a1', identifier: 'ENG-1' }),
        action({ id: 'a2', identifier: 'ENG-2' }),
        action({ id: 'a3', identifier: 'ENG-3' }),
      ],
      proposals: [],
      commentedActionIds: ['a1'],
      labeledActionIds: ['a2'],
      prLinkedActionIds: ['a3'],
    })
    expect(signals[0].edit_reasons).toEqual(['has comments'])
    expect(signals[1].edit_reasons).toEqual(['has labels'])
    expect(signals[2].edit_reasons).toEqual(['linked to a pull request'])
    expect(signals.every((s) => s.edited)).toBe(true)
  })

  it('accumulates multiple reasons on one action', () => {
    const [signal] = computeConfirmedActionSignals({
      actions: [action({ title: 'Changed' })],
      proposals: [
        { result_entity_id: 'a1', title: 'Ship the widget', description: 'From the meeting' },
      ],
      commentedActionIds: ['a1'],
      labeledActionIds: [],
      prLinkedActionIds: ['a1'],
    })
    expect(signal.edit_reasons).toEqual([
      'title edited',
      'has comments',
      'linked to a pull request',
    ])
  })

  it('flags an action synced to an external tracker (the move severs the link)', () => {
    const [signal] = computeConfirmedActionSignals({
      actions: [action()],
      proposals: [],
      commentedActionIds: [],
      labeledActionIds: [],
      prLinkedActionIds: [],
      externalLinkedActionIds: ['a1'],
    })
    expect(signal.edited).toBe(true)
    expect(signal.edit_reasons).toEqual(['synced to an external tracker'])
  })

  it('orders the external-tracker reason after the accretion reasons', () => {
    const [signal] = computeConfirmedActionSignals({
      actions: [action()],
      proposals: [],
      commentedActionIds: ['a1'],
      labeledActionIds: ['a1'],
      prLinkedActionIds: ['a1'],
      externalLinkedActionIds: ['a1'],
    })
    expect(signal.edit_reasons).toEqual([
      'has comments',
      'has labels',
      'linked to a pull request',
      'synced to an external tracker',
    ])
  })

  it('leaves unlinked actions alone and stays backward compatible when the input is omitted', () => {
    const signals = computeConfirmedActionSignals({
      actions: [action({ id: 'a1' }), action({ id: 'a2' })],
      proposals: [],
      commentedActionIds: [],
      labeledActionIds: [],
      prLinkedActionIds: [],
      externalLinkedActionIds: ['a2'],
    })
    expect(signals[0].edited).toBe(false)
    expect(signals[1].edit_reasons).toEqual(['synced to an external tracker'])

    // Callers that predate the input never see the reason.
    const [legacy] = computeConfirmedActionSignals({
      actions: [action()],
      proposals: [],
      commentedActionIds: [],
      labeledActionIds: [],
      prLinkedActionIds: [],
    })
    expect(legacy.edited).toBe(false)
  })

  it('matches proposals by result_entity_id and ignores unrelated ones', () => {
    const [signal] = computeConfirmedActionSignals({
      actions: [action()],
      proposals: [
        { result_entity_id: 'other-action', title: 'Different', description: null },
        { result_entity_id: null, title: 'Never applied', description: null },
      ],
      commentedActionIds: [],
      labeledActionIds: [],
      prLinkedActionIds: [],
    })
    expect(signal.edited).toBe(false)
  })

  it('passes identifier and title through for the dialog', () => {
    const [signal] = computeConfirmedActionSignals({
      actions: [action({ id: 'a9', identifier: 'GEN-74', title: 'Fix pagination' })],
      proposals: [],
      commentedActionIds: [],
      labeledActionIds: [],
      prLinkedActionIds: [],
    })
    expect(signal).toMatchObject({ id: 'a9', identifier: 'GEN-74', title: 'Fix pagination' })
  })
})

describe('partitionClaimsBySource', () => {
  const captureId = 'cap-1'
  const attachmentIds = ['att-1', 'att-2']

  it('classifies a claim evidenced only by the capture as sole-sourced', () => {
    const result = partitionClaimsBySource(
      ['claim-1'],
      [{ claim_id: 'claim-1', source_type: 'capture', source_id: captureId }],
      captureId,
      attachmentIds,
    )
    expect(result.soleSourced).toEqual(['claim-1'])
    expect(result.shared).toEqual([])
  })

  it('counts evidence from the capture attachments as belonging to the capture', () => {
    const result = partitionClaimsBySource(
      ['claim-1'],
      [
        { claim_id: 'claim-1', source_type: 'capture', source_id: captureId },
        { claim_id: 'claim-1', source_type: 'attachment', source_id: 'att-2' },
      ],
      captureId,
      attachmentIds,
    )
    expect(result.soleSourced).toEqual(['claim-1'])
  })

  it('classifies a claim with evidence from another capture as shared', () => {
    const result = partitionClaimsBySource(
      ['claim-1'],
      [
        { claim_id: 'claim-1', source_type: 'capture', source_id: captureId },
        { claim_id: 'claim-1', source_type: 'capture', source_id: 'other-capture' },
      ],
      captureId,
      attachmentIds,
    )
    expect(result.soleSourced).toEqual([])
    expect(result.shared).toEqual(['claim-1'])
  })

  it('classifies a claim with manual/external evidence as shared', () => {
    const result = partitionClaimsBySource(
      ['claim-1'],
      [
        { claim_id: 'claim-1', source_type: 'capture', source_id: captureId },
        { claim_id: 'claim-1', source_type: 'manual', source_id: null },
      ],
      captureId,
      attachmentIds,
    )
    expect(result.shared).toEqual(['claim-1'])
  })

  it("treats an attachment from a DIFFERENT capture as outside evidence", () => {
    const result = partitionClaimsBySource(
      ['claim-1'],
      [
        { claim_id: 'claim-1', source_type: 'capture', source_id: captureId },
        { claim_id: 'claim-1', source_type: 'attachment', source_id: 'foreign-att' },
      ],
      captureId,
      attachmentIds,
    )
    expect(result.shared).toEqual(['claim-1'])
  })

  it('treats a claim with no visible source rows as shared (conservative)', () => {
    const result = partitionClaimsBySource(['claim-1'], [], captureId, attachmentIds)
    expect(result.shared).toEqual(['claim-1'])
  })

  it('partitions a mixed set', () => {
    const result = partitionClaimsBySource(
      ['sole', 'mixed'],
      [
        { claim_id: 'sole', source_type: 'capture', source_id: captureId },
        { claim_id: 'mixed', source_type: 'capture', source_id: captureId },
        { claim_id: 'mixed', source_type: 'email', source_id: 'email-1' },
      ],
      captureId,
      attachmentIds,
    )
    expect(result.soleSourced).toEqual(['sole'])
    expect(result.shared).toEqual(['mixed'])
  })
})

describe('splitParticipantContacts', () => {
  it('classifies capture_participant and calendar_sync contacts with email as auto-created', () => {
    const { autoCreated, other } = splitParticipantContacts([
      { id: 'c1', full_name: 'Ada', email: 'ada@example.com', source: 'capture_participant' },
      { id: 'c2', full_name: 'Grace', email: 'grace@example.com', source: 'calendar_sync' },
    ])
    expect(autoCreated.map((c) => c.id)).toEqual(['c1', 'c2'])
    expect(other).toEqual([])
  })

  it('keeps manually created and imported contacts out of the copy set', () => {
    const { autoCreated, other } = splitParticipantContacts([
      { id: 'c1', full_name: 'Ada', email: 'ada@example.com', source: 'manual' },
      { id: 'c2', full_name: 'Grace', email: 'grace@example.com', source: 'csv_import' },
      { id: 'c3', full_name: 'Linus', email: 'linus@example.com', source: 'email_sync' },
      { id: 'c4', full_name: 'Marge', email: 'marge@example.com', source: null },
    ])
    expect(autoCreated).toEqual([])
    expect(other.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4'])
  })

  it('excludes auto-created contacts without an email — nothing to dedupe or re-link on', () => {
    const { autoCreated, other } = splitParticipantContacts([
      { id: 'c1', full_name: 'No Email', email: null, source: 'capture_participant' },
      { id: 'c2', full_name: 'Empty Email', email: '', source: 'calendar_sync' },
    ])
    expect(autoCreated).toEqual([])
    expect(other.map((c) => c.id)).toEqual(['c1', 'c2'])
  })
})

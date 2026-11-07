/**
 * The eval self participant, and the one row shape migration 252's trigger
 * accepts.
 *
 * WHY THIS FILE IS LOAD-BEARING. `enforce_eval_capture_participant_links`
 * refuses a non-null `contact_id` on an eval capture unconditionally — the
 * self row included, because the self CONTACT is a real CRM row with a real
 * timeline. The shared `seedSelfParticipant` in `@/lib/crm/contacts` writes
 * `contact_id: selfContact?.id ?? null` on both its paths, so on any workspace
 * whose owner has a self-contact (the normal case) it raises `check_violation`.
 *
 * Both eval call sites wrap the seed in try/catch and `console.warn`, so that
 * exception would NOT surface as an error: the self row would simply be absent,
 * and the route's `currentMemberId` / `isMineExplicit` / self-binding
 * resolution — precisely what a trial grades — would behave like a call with
 * no owner. Every assignee-to-me proposal would score unlike a real meeting and
 * nothing would say why. These tests pin the shape that keeps that from
 * happening.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase, filterArgs, findQuery, type Captured } from './fake-supabase'
import { seedEvalSelfParticipant } from '../seed-self-participant'

const WS = 'ws-1'
const CAPTURE = 'cap-1'
const USER = 'user-1'

/** Answers the member lookup, and reports "no self row yet" for the probe. */
function handler(q: Captured) {
  if (q.table === 'member') return { data: { id: 'member-1', display_name: 'Dana' } }
  return { data: null }
}

describe('seedEvalSelfParticipant', () => {
  it('writes the ONLY shape the trigger accepts: member_id set, contact_id NULL', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    expect(await seedEvalSelfParticipant(client, {
      workspaceId: WS, captureId: CAPTURE, userId: USER,
    })).toBe(true)

    const row = (findQuery(queries, 'capture_participant', 'insert')!
      .payload as Record<string, unknown>)
    expect(row.contact_id).toBeNull()
    expect(row.member_id).toBe('member-1')
    expect(row.is_self).toBe(true)
    expect(row.capture_id).toBe(CAPTURE)
    expect(row.role).toBe('organizer')
  })

  it('never writes contact_id, even when the workspace has a self contact', async () => {
    // The `contact` table is never consulted at all — there is no code path
    // that could reach a contact id, rather than a path that reaches one and
    // then discards it.
    const { client, queries } = makeFakeSupabase(() => ({
      data: { id: 'member-1', display_name: 'Dana', contact_id: 'contact-99' },
    }))
    await seedEvalSelfParticipant(client, {
      workspaceId: WS, captureId: CAPTURE, userId: USER,
    })
    expect(queries.some((q) => q.table === 'contact')).toBe(false)
  })

  it('scopes the member lookup to the workspace and the user', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await seedEvalSelfParticipant(client, {
      workspaceId: WS, captureId: CAPTURE, userId: USER,
    })
    const eqs = filterArgs(findQuery(queries, 'member', 'select')!, 'eq')
    expect(eqs).toContainEqual(['workspace_id', WS])
    expect(eqs).toContainEqual(['user_id', USER])
  })

  it('is idempotent — an existing self row means no second insert', async () => {
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table === 'member') return { data: { id: 'member-1', display_name: 'Dana' } }
      if (q.table === 'capture_participant') {
        return { data: { id: 'existing', speaker_label: 'local_1' } }
      }
      return { data: null }
    })
    expect(await seedEvalSelfParticipant(client, {
      workspaceId: WS, captureId: CAPTURE, userId: USER, speakerLabel: 'local_1',
    })).toBe(true)
    expect(findQuery(queries, 'capture_participant', 'insert')).toBeUndefined()
    // Already carries the label we wanted — nothing to promote either.
    expect(findQuery(queries, 'capture_participant', 'update')).toBeUndefined()
  })

  it('does nothing when the user is not a member of the workspace', async () => {
    const { client, queries } = makeFakeSupabase(() => ({ data: null }))
    expect(await seedEvalSelfParticipant(client, {
      workspaceId: WS, captureId: CAPTURE, userId: USER,
    })).toBe(false)
    expect(findQuery(queries, 'capture_participant', 'insert')).toBeUndefined()
  })

  it('swallows the unique-index race but THROWS on any other insert failure', async () => {
    // 23505 = a concurrent seed already wrote the row we wanted: benign.
    const race = makeFakeSupabase((q) =>
      q.table === 'member'
        ? { data: { id: 'member-1', display_name: 'Dana' } }
        : q.op === 'insert'
          ? { error: { message: 'duplicate key', code: '23505' } }
          : { data: null },
    )
    await expect(seedEvalSelfParticipant(race.client, {
      workspaceId: WS, captureId: CAPTURE, userId: USER,
    })).resolves.toBe(true)

    // Anything else — the trigger's check_violation included — must be LOUD.
    // A silently missing self row changes what every trial grades.
    const denied = makeFakeSupabase((q) =>
      q.table === 'member'
        ? { data: { id: 'member-1', display_name: 'Dana' } }
        : q.op === 'insert'
          ? { error: { message: 'contact_id must be NULL on an eval capture', code: '23514' } }
          : { data: null },
    )
    await expect(seedEvalSelfParticipant(denied.client, {
      workspaceId: WS, captureId: CAPTURE, userId: USER,
    })).rejects.toThrow(/contact_id must be NULL/)
  })
})

/**
 * THE SPEAKER LABEL — the half of the self row that decides whether an
 * assignee-to-me case can pass at all.
 *
 * A real desktop capture's self row ends up `speaker_label: 'local_1'`,
 * `self_binding: 'position'` (via `resolveSelfBinding`). Two things read it:
 * `resolvePersonForCapture`'s speaker map turns the label the agent attributed
 * a line to into this row's `member_id`, and the route's auto-apply gate then
 * requires `assigneeResolvedViaSpeakerMap`. An eval self row with a NULL label
 * is invisible to that map, so a proposal for something the owner said they
 * would do comes back with a null assignee and every `assignee: 'self'`
 * must_have fails — which is the batch trial that produced this fix.
 */
describe('seedEvalSelfParticipant — the speaker label', () => {
  it('writes the label with the position evidence tier when one is given', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await seedEvalSelfParticipant(client, {
      workspaceId: WS, captureId: CAPTURE, userId: USER, speakerLabel: 'local_1',
    })

    const row = (findQuery(queries, 'capture_participant', 'insert')!
      .payload as Record<string, unknown>)
    expect(row.speaker_label).toBe('local_1')
    // 'position' — the tier migration 174's CHECK allows and a solo-desk
    // capture genuinely earns. NOT 'confirmed' (nobody clicked) and NOT
    // 'voice' (there is no voiceprint): either would grade a stronger binding
    // than a real call gets.
    expect(row.self_binding).toBe('position')
    // The label never arrives without its evidence: the route reads
    // `self_binding === 'none'` as "no voice is verified as the user", so a
    // labelled-but-unbound row would buy nothing.
    expect(row.self_binding).not.toBe('none')
  })

  it('seeds unlabeled and unbound when no label is given (unchanged behaviour)', async () => {
    const { client, queries } = makeFakeSupabase(handler)
    await seedEvalSelfParticipant(client, {
      workspaceId: WS, captureId: CAPTURE, userId: USER,
    })

    const row = (findQuery(queries, 'capture_participant', 'insert')!
      .payload as Record<string, unknown>)
    expect(row.speaker_label).toBeNull()
    expect(row.self_binding).toBe('none')
  })

  it('treats a blank label as no label rather than writing an empty string', async () => {
    // An empty `speaker_label` would sit in the speaker map matching nothing
    // while claiming a binding the capture does not have.
    const { client, queries } = makeFakeSupabase(handler)
    await seedEvalSelfParticipant(client, {
      workspaceId: WS, captureId: CAPTURE, userId: USER, speakerLabel: '  ',
    })
    const row = (findQuery(queries, 'capture_participant', 'insert')!
      .payload as Record<string, unknown>)
    expect(row.speaker_label).toBeNull()
    expect(row.self_binding).toBe('none')
  })

  it('PROMOTES an existing unlabeled self row rather than leaving it broken', async () => {
    // A case authored before labels existed keeps its self row forever. Left
    // alone it mis-grades ownership on every future trial, so the seeder
    // upgrades it in place.
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table === 'member') return { data: { id: 'member-1', display_name: 'Dana' } }
      if (q.table === 'capture_participant') {
        return { data: { id: 'existing', speaker_label: null } }
      }
      return { data: null }
    })
    await seedEvalSelfParticipant(client, {
      workspaceId: WS, captureId: CAPTURE, userId: USER, speakerLabel: 'local_1',
    })

    const update = findQuery(queries, 'capture_participant', 'update')!
    expect(update.payload).toEqual({ speaker_label: 'local_1', self_binding: 'position' })
    expect(filterArgs(update, 'eq')).toContainEqual(['id', 'existing'])
    // Still no duplicate row: the partial unique index would reject it anyway.
    expect(findQuery(queries, 'capture_participant', 'insert')).toBeUndefined()
  })

  it('never promotes when no label is given — it cannot CLEAR an existing one', async () => {
    const { client, queries } = makeFakeSupabase((q) => {
      if (q.table === 'member') return { data: { id: 'member-1', display_name: 'Dana' } }
      if (q.table === 'capture_participant') {
        return { data: { id: 'existing', speaker_label: 'local_1' } }
      }
      return { data: null }
    })
    await seedEvalSelfParticipant(client, {
      workspaceId: WS, captureId: CAPTURE, userId: USER,
    })
    expect(findQuery(queries, 'capture_participant', 'update')).toBeUndefined()
  })

  it('labels the row the 23505 race winner wrote, if that row has no label', async () => {
    // The concurrent seed may have been an older caller with no label. Losing
    // the race must not mean losing the binding.
    const { client, queries } = makeFakeSupabase((q) =>
      q.table === 'member'
        ? { data: { id: 'member-1', display_name: 'Dana' } }
        : q.op === 'insert'
          ? { error: { message: 'duplicate key', code: '23505' } }
          : { data: null },
    )
    await expect(seedEvalSelfParticipant(client, {
      workspaceId: WS, captureId: CAPTURE, userId: USER, speakerLabel: 'local_1',
    })).resolves.toBe(true)

    const update = findQuery(queries, 'capture_participant', 'update')!
    expect(update.payload).toEqual({ speaker_label: 'local_1', self_binding: 'position' })
    // Scoped to the CLONE's own self row, and only while it is still unlabeled
    // — never clobbering a label the winner already set.
    expect(filterArgs(update, 'eq')).toContainEqual(['capture_id', CAPTURE])
    expect(filterArgs(update, 'eq')).toContainEqual(['is_self', true])
    expect(filterArgs(update, 'is')).toContainEqual(['speaker_label', null])
  })
})

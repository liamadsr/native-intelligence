import { inngest } from '@/lib/inngest/client'
import type { StatusChangeOrigin } from './types'

/** The origin every writer gets unless it says otherwise: a person, no hops. */
export const USER_STATUS_CHANGE_ORIGIN: StatusChangeOrigin = { actor: 'user', depth: 0 }

/**
 * Emit the `flow/entity.status_changed` trigger event for a status transition.
 *
 * GEN-112: this emit used to live inline in the actions PATCH route only, so
 * Flows fired from UI writers (board drag + in-ticket dropdown both PATCH) but
 * NOT from any writer that mutated status another way. Centralising it here
 * means every writer that changes a status can fire the trigger consistently
 * by calling this one function — there's a single emit point to keep correct.
 *
 * Fire-and-forget: the Inngest send is awaited only enough to attach a catch;
 * callers should NOT block their response on flow delivery. The Inngest
 * function (`flowDispatchOnStatusChange`) filters by entity_type + workspace +
 * (optionally) team + from/to, performs the HTTP call, and writes a flow_run
 * row per attempt — so delivery is observable in `flow_run` regardless of caller.
 *
 * No-op when teamId is missing (flows are team-scoped) or when the status did
 * not actually change — callers can pass both ids and let the guard decide.
 *
 * `origin` tags WHO made the write (see StatusChangeOrigin). Unattended tool
 * routes and the verdict apply pass theirs; every other writer is a person at
 * depth 0. The dispatcher's loop guard reads it — never the emitter.
 */
export function emitStatusChange(args: {
  entityType: 'action'
  entityId: string
  workspaceId: string
  teamId: string | null | undefined
  fromStatusId: string | null | undefined
  toStatusId: string | null | undefined
  actorUserId: string
  firedAt?: string
  origin?: StatusChangeOrigin
}): void {
  const { entityType, entityId, workspaceId, teamId, fromStatusId, toStatusId, actorUserId, firedAt } = args
  const origin = args.origin ?? USER_STATUS_CHANGE_ORIGIN

  // Guard: only emit on a real transition into a new status, and only when we
  // know the team (flow matching is team-scoped).
  if (!toStatusId || toStatusId === fromStatusId) return
  if (!teamId) return

  inngest
    .send({
      name: 'flow/entity.status_changed',
      data: {
        entity_type: entityType,
        entity_id: entityId,
        workspace_id: workspaceId,
        team_id: teamId,
        from_status_id: fromStatusId ?? null,
        to_status_id: toStatusId,
        actor_user_id: actorUserId,
        fired_at: firedAt ?? new Date().toISOString(),
        origin,
      },
    })
    .catch((err) => {
      console.error('[flows] inngest.send failed', err)
    })
}

/**
 * Who may do what with joining. Pure rules, enforced by the API routes; the
 * settings page only follows them.
 *
 *   Owners and admins switch everything (the link, auto-join, members can
 *   invite), copy and reset the link, and invite as admin, member or guest.
 *   Members, while "members can invite" is on, copy the link and invite as
 *   member or guest, never admin. Guests never invite or see the link.
 */

export type WorkspaceRole = 'owner' | 'admin' | 'member' | 'guest'

export const INVITE_ROLES = ['admin', 'member', 'guest'] as const
export type InviteRole = (typeof INVITE_ROLES)[number]

export function canManageJoining(role: string | null | undefined): boolean {
  return role === 'owner' || role === 'admin'
}

/** May this person copy the workspace's join link (when it is on)? */
export function canCopyJoinLink(role: string | null | undefined, membersCanInvite: boolean): boolean {
  return canManageJoining(role) || (role === 'member' && membersCanInvite)
}

/** May this person send email invites at all? */
export function canInvite(role: string | null | undefined, membersCanInvite: boolean): boolean {
  return canManageJoining(role) || (role === 'member' && membersCanInvite)
}

/** The roles this person may invite as. */
export function invitableRoles(role: string | null | undefined, membersCanInvite: boolean): InviteRole[] {
  if (canManageJoining(role)) return [...INVITE_ROLES]
  if (role === 'member' && membersCanInvite) return ['member', 'guest']
  return []
}

export type InviteDecision =
  | { ok: true; role: InviteRole }
  | { ok: false; status: 400 | 403; message: string }

/** May `callerRole` invite someone as `requested` (default member)? */
export function decideInvite(
  callerRole: string | null | undefined,
  membersCanInvite: boolean,
  requested: unknown,
): InviteDecision {
  const role = requested === undefined || requested === null || requested === '' ? 'member' : requested
  if (typeof role !== 'string' || !(INVITE_ROLES as readonly string[]).includes(role)) {
    return { ok: false, status: 400, message: 'Invalid role' }
  }
  if (canManageJoining(callerRole)) return { ok: true, role: role as InviteRole }
  if (callerRole === 'member') {
    if (!membersCanInvite) return { ok: false, status: 403, message: 'Only owners and admins can invite' }
    if (role === 'admin') return { ok: false, status: 403, message: 'Members can invite people as members or guests' }
    return { ok: true, role: role as InviteRole }
  }
  return { ok: false, status: 403, message: 'Only owners and admins can invite' }
}

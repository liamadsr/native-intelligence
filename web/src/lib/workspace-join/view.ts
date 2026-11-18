/**
 * What the settings page is told about joining, shaped for the caller's role:
 * the link's address only for someone who may copy it, and only while it is on.
 */
import type { User } from '@supabase/supabase-js'
import { BASE_URL } from '@/lib/email'
import { claimRefusalText, claimableDomain } from './domains'
import { canCopyJoinLink, canManageJoining, invitableRoles } from './roles'
import type { JoinSettings } from './settings'
import { joinLinkPath } from './token'

export interface JoinSettingsView {
  role: string | null
  canManage: boolean
  membersCanInvite: boolean
  invitableRoles: string[]
  link: { enabled: boolean; url: string | null }
  byDomain: {
    /** Domains whose verified addresses may join with one click. */
    domains: string[]
    /** The caller's own domain when they could list it, else null. */
    yourDomain: string | null
    /** Why the caller can't list their domain, or null when they can. */
    unavailableReason: string | null
  }
}

/**
 * `demo`: the workspace is a demo workspace (migration 669). It is joined by
 * an emailed invite from its owner or an admin only, so nobody is shown a
 * join link there (the join itself refuses one, add-member.ts) and a member
 * is offered no one to invite, whatever the stored switches say.
 */
export function joinSettingsView(stored: JoinSettings, role: string | null, user: User, demo = false): JoinSettingsView {
  const settings: JoinSettings = demo ? { ...stored, membersCanInvite: false, link: null } : stored
  const claim = claimableDomain(user)
  const mayCopy = canCopyJoinLink(role, settings.membersCanInvite)
  const linkOn = settings.link?.enabled === true
  return {
    role,
    canManage: canManageJoining(role),
    membersCanInvite: settings.membersCanInvite,
    invitableRoles: invitableRoles(role, settings.membersCanInvite),
    link: {
      enabled: linkOn,
      url: mayCopy && linkOn && settings.link ? `${BASE_URL}${joinLinkPath(settings.link.token)}` : null,
    },
    byDomain: {
      domains: settings.domains,
      yourDomain: claim.ok ? claim.domain : null,
      unavailableReason: claimRefusalText(claim),
    },
  }
}

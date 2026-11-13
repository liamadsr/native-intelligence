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
  autoJoin: {
    /** The domain this workspace has claimed, or null when auto-join is off. */
    domain: string | null
    /** The caller's own domain, the only one they could switch on. */
    yourDomain: string | null
    /** Why the caller can't switch it on, or null when they can. */
    blockedReason: string | null
  }
}

export function joinSettingsView(settings: JoinSettings, role: string | null, user: User): JoinSettingsView {
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
    autoJoin: {
      domain: settings.autoJoinDomain,
      yourDomain: claim.domain,
      blockedReason: claimRefusalText(claim),
    },
  }
}

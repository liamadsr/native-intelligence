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
    byDomain: {
      domains: settings.domains,
      yourDomain: claim.ok ? claim.domain : null,
      unavailableReason: claimRefusalText(claim),
    },
  }
}

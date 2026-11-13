'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { usePostHog } from 'posthog-js/react'
import {
  AlertTriangle,
  Building2,
  Check,
  Clock,
  Crown,
  Loader2,
  LogOut,
  Mail,
  RefreshCw,
  Shield,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useWorkspaceCacheRefresh } from '@/app/account/workspace-switcher'
import { MergeWorkspaceSheet } from './merge-workspace-sheet'
import { OutsideAgentLinksSection } from './outside-agent-links-section'
import { JoiningSection, useJoinSettings } from './joining-section'
import { joinedViaNote } from '@/lib/workspace-join/labels'
import {
  DEFAULT_EDITION_ID,
  EDITIONS,
  FEATURES,
  FEATURE_LIST,
  isEditionId,
  type EditionId,
  type FeatureKey,
  type FeatureOverrides,
} from '@/lib/editions'
import {
  dependentsOf,
  effectiveFeatureSet,
  listFeatureLabels,
  useFeatureToggle,
} from '@/lib/editions/use-feature-toggle'
import { ProductDocCard } from './product-doc-card'

interface Workspace {
  id: string
  name: string
  slug: string
  plan: string
  settings: Record<string, unknown>
  logo_url: string | null
  created_at: string
  updated_at: string
}

interface Member {
  id: string
  user_id: string
  display_name: string
  avatar_url: string | null
  role: string
  email: string
  created_at: string
  /** How they joined (migration 644): 'invite', 'link', 'domain', or null. */
  joined_via?: string | null
}

interface Invite {
  id: string
  email: string
  role: string
  expires_at: string
  created_at: string
}

const ROLE_LABELS: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  guest: 'Guest',
}

const ROLE_VARIANTS: Record<string, 'default' | 'secondary' | 'outline'> = {
  owner: 'default',
  admin: 'secondary',
  member: 'outline',
  guest: 'outline',
}

// `effectiveFeatureSet`, `dependentsOf` and `listFeatureLabels` used to be
// defined here. They now live beside `useFeatureToggle` in lib/editions, so
// this card and the nav rail's quick-toggle popover share one definition of
// what "on" means and one set of toggle semantics.

function getInitials(name: string) {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

export function WorkspaceSettingsView() {
  const router = useRouter()
  const posthog = usePostHog()
  // Edition and feature writes change the app's SURFACE (nav rail, tab bar,
  // command palette), all of which render from the workspace cache rather than
  // from this view. Without invalidating it, a toggle saves correctly but the
  // nav stays stale until a full page reload.
  const refreshWorkspaceCache = useWorkspaceCacheRefresh()

  const [workspace, setWorkspace] = useState<Workspace | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [currentRole, setCurrentRole] = useState<string | null>(null)
  const [currentMemberId, setCurrentMemberId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState('')

  // Edit state
  const [editName, setEditName] = useState('')
  const [editSlug, setEditSlug] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [saveSuccess, setSaveSuccess] = useState('')

  // The workspace's edition — READ ONLY here. The switcher lives in the admin
  // console (`/admin/users/[id]`), not in workspace settings, but the Features
  // card below still needs the edition to know which toggles are defaults and
  // which are Custom, so the state stays and is populated from the features
  // response (which already carries it).
  const [edition, setEdition] = useState<EditionId>(DEFAULT_EDITION_ID)

  // Feature overrides — the tri-state on top of the edition. Stored RAW (absent
  // = follow the edition) rather than as resolved booleans, because the card has
  // to distinguish "on because the edition says so" from "on because someone
  // turned it on" to render the Custom marker and the Reset affordance. The
  // effective state is derived from this plus `edition` on every render, which
  // is also what makes an admin-side edition change re-base the whole card for
  // free on the next load.
  const [overrides, setOverrides] = useState<FeatureOverrides>({})

  // Invite state
  const [inviteEmail, setInviteEmail] = useState('')
  const [inviteRole, setInviteRole] = useState('member')
  const [inviting, setInviting] = useState(false)
  const [inviteError, setInviteError] = useState('')

  // Resend invite state
  const [resendingId, setResendingId] = useState<string | null>(null)
  const [resentIds, setResentIds] = useState<Set<string>>(new Set())

  // Remove member dialog
  const [removeMember, setRemoveMember] = useState<Member | null>(null)
  const [removing, setRemoving] = useState(false)
  const [removeError, setRemoveError] = useState('')

  // Danger zone state
  const [leaveOpen, setLeaveOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [transferOpen, setTransferOpen] = useState(false)
  const [transferTargetId, setTransferTargetId] = useState('')
  const [mergeOpen, setMergeOpen] = useState(false)
  const [dangerLoading, setDangerLoading] = useState(false)
  const [dangerError, setDangerError] = useState('')

  const isOwnerOrAdmin = currentRole === 'owner' || currentRole === 'admin'
  const isOwner = currentRole === 'owner'

  // Joining (link, join by domain, members can invite). A member sees the invite
  // form while "members can invite" is on, offering member and guest only;
  // the invites route enforces the same rule.
  const { view: joinView, setView: setJoinView } = useJoinSettings()
  const inviteRoles = joinView?.invitableRoles ?? (isOwnerOrAdmin ? ['admin', 'member', 'guest'] : [])
  const canSendInvites = inviteRoles.length > 0

  // Derived on every render from (edition, overrides), never stored: an
  // edition change therefore re-bases the whole card — defaults, Custom
  // markers and all — while explicit overrides persist. That IS the tri-state,
  // made visible.
  const effective = effectiveFeatureSet(edition, overrides)
  const defaults = effectiveFeatureSet(edition, {})

  useEffect(() => {
    fetchWorkspace()
    fetchFeatures()
  }, [])

  // The EDITION and the OVERRIDES both come from this one response — the
  // features route already normalizes and returns the stored edition, so the
  // card never needs a second round trip to know what its defaults are.
  // `effectiveFeatures` is deliberately NOT taken from it: it is recomputed
  // locally from (edition, overrides) so the card can apply the `requires`
  // closure itself and stay correct between writes.
  async function fetchFeatures() {
    try {
      const res = await fetch('/api/account/workspace/features')
      if (!res.ok) return
      const data = await res.json()
      setEdition(isEditionId(data.edition) ? data.edition : DEFAULT_EDITION_ID)
      if (data.overrides && typeof data.overrides === 'object') {
        setOverrides(data.overrides as FeatureOverrides)
      }
    } catch {
      // Non-fatal: the card renders the default edition's own defaults until a
      // toggle.
    }
  }

  /**
   * Write one feature's state. Optimistic: `next` is applied locally first and
   * rolled back if the PATCH is rejected, so a switch never sits in a pending
   * limbo the user has to interpret.
   *
   * Returns the overrides map the server actually stored, which is NOT
   * necessarily `next` — the route auto-collapses a state matching the edition
   * default by deleting the key. Callers chaining several PATCHes (a feature
   * plus its requirements) must thread that returned map into the next call, or
   * the second write would be computed against a stale local map.
   */
  // The toggle semantics (requires-cascade, write ordering, the single cache
  // refresh) live in `useFeatureToggle`, shared with the nav rail's popover —
  // see the long note there for why the ordering is load-bearing.
  const handleOverrides = useCallback((next: FeatureOverrides) => setOverrides(next), [])
  const {
    toggleFeature: handleFeatureToggle,
    resetFeature: handleFeatureReset,
    busy: featureBusy,
    error: featureError,
  } = useFeatureToggle({
    overrides,
    edition,
    onOverrides: handleOverrides,
    refreshCache: refreshWorkspaceCache,
  })

  async function fetchWorkspace() {
    setIsLoading(true)
    setError('')
    try {
      const res = await fetch('/api/account/workspace')
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to load workspace')
      }
      const data = await res.json()
      setWorkspace(data.workspace)
      setMembers(data.members)
      setInvites(data.invites)
      setCurrentRole(data.currentRole)
      setCurrentMemberId(data.currentMemberId)
      setEditName(data.workspace.name)
      setEditSlug(data.workspace.slug)

    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setIsLoading(false)
    }
  }

  async function handleSave() {
    setSaving(true)
    setSaveError('')
    setSaveSuccess('')
    try {
      const res = await fetch('/api/account/workspace', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName, slug: editSlug }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to save')
      }
      const data = await res.json()
      setWorkspace(data.workspace)
      setSaveSuccess('Workspace updated')
      setTimeout(() => setSaveSuccess(''), 3000)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault()
    if (!inviteEmail.trim()) return

    setInviting(true)
    setInviteError('')
    try {
      const res = await fetch('/api/account/workspace/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: inviteEmail.trim(),
          role: inviteRole,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to send invite')
      }
      const data = await res.json()
      setInvites((prev) => [data.invite, ...prev])
      setInviteEmail('')
      // 201 with `email_sent: false`: the invite exists (kept in the list, can
      // be resent) but the email never left.
      if (data.email_sent === false) {
        setInviteError('Invite created, but the email could not be sent')
      }
    } catch (err) {
      setInviteError(err instanceof Error ? err.message : 'Failed to invite')
    } finally {
      setInviting(false)
    }
  }

  async function handleRevokeInvite(inviteId: string) {
    try {
      const res = await fetch(`/api/account/workspace/invites/${inviteId}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to revoke')
      }
      setInvites((prev) => prev.filter((i) => i.id !== inviteId))
    } catch {
      // Silently fail, could add error state per-invite if needed
    }
  }

  async function handleResendInvite(inviteId: string) {
    setResendingId(inviteId)
    setInviteError('')
    try {
      const res = await fetch(`/api/account/workspace/invites/${inviteId}`, {
        method: 'POST',
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Failed to resend')
      }
      setResentIds((prev) => new Set(prev).add(inviteId))
    } catch (err) {
      // A failed send (502 "Failed to send email") used to look like nothing happened.
      setInviteError(err instanceof Error ? err.message : 'Failed to resend')
    } finally {
      setResendingId(null)
    }
  }

  async function handleChangeInviteRole(inviteId: string, newRole: string) {
    try {
      const res = await fetch(`/api/account/workspace/invites/${inviteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      })
      if (!res.ok) return
      const data = await res.json()
      setInvites((prev) =>
        prev.map((i) => (i.id === inviteId ? { ...i, role: data.invite.role } : i)),
      )
    } catch {
      // Could show inline error
    }
  }

  async function handleChangeRole(memberId: string, newRole: string) {
    try {
      const res = await fetch(
        `/api/account/workspace/members/${memberId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: newRole }),
        },
      )
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to update role')
      }
      setMembers((prev) =>
        prev.map((m) => (m.id === memberId ? { ...m, role: newRole } : m)),
      )
    } catch {
      // Could show inline error
    }
  }

  async function handleRemoveMember() {
    if (!removeMember) return
    setRemoving(true)
    setRemoveError('')
    try {
      const res = await fetch(
        `/api/account/workspace/members/${removeMember.id}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Failed to remove')
      }
      setMembers((prev) => prev.filter((m) => m.id !== removeMember.id))
      setRemoveMember(null)
    } catch (err) {
      // The dialog stays open and says why, so a failed removal never looks done.
      setRemoveError(err instanceof Error ? err.message : 'Failed to remove')
    } finally {
      setRemoving(false)
    }
  }

  // ── Danger zone handlers ────────────────────────────────────────────────────

  async function handleLeave() {
    if (!workspace) return
    setDangerLoading(true)
    setDangerError('')
    try {
      // The route leaves the workspace named here, never the cookie's.
      const res = await fetch('/api/account/workspace/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspace_id: workspace.id }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to leave workspace')
      }
      // Hard-navigate so the workspace cache re-initialises from scratch.
      window.location.href = '/account'
    } catch (err) {
      setDangerError(err instanceof Error ? err.message : 'Something went wrong')
      setDangerLoading(false)
    }
  }

  async function handleDelete() {
    setDangerLoading(true)
    setDangerError('')
    try {
      const res = await fetch('/api/account/workspace', { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to delete workspace')
      }
      // Hard-navigate so the workspace cache re-initialises from scratch.
      window.location.href = '/account'
    } catch (err) {
      setDangerError(err instanceof Error ? err.message : 'Something went wrong')
      setDangerLoading(false)
    }
  }

  async function handleTransfer() {
    if (!transferTargetId) return
    setDangerLoading(true)
    setDangerError('')
    try {
      const res = await fetch('/api/account/workspace/transfer-owner', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_id: transferTargetId }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to transfer ownership')
      }
      setTransferOpen(false)
      setTransferTargetId('')
      // Reload workspace data to reflect the new role.
      await fetchWorkspace()
    } catch (err) {
      setDangerError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setDangerLoading(false)
    }
  }

  // ── Derived values for Danger Zone ─────────────────────────────────────────

  const otherMembers = members.filter((m) => m.id !== currentMemberId)
  // Members eligible to receive ownership (anyone except the current owner).
  const transferableMembers = members.filter(
    (m) => m.id !== currentMemberId && m.role !== 'owner',
  )

  // ── Render ──────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-10">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="mt-2 h-4 w-72" />
          <div className="mt-8 space-y-4">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-10">
          <div className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-400">
            {error}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-10">
        <h1 className="text-2xl font-bold">Workspace</h1>
        <p className="mt-1 text-muted-foreground">
          Manage your workspace settings, members, and invites.
        </p>

        {/* General Settings */}
        <div className="mt-8">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Building2 className="h-4 w-4" />
            General
          </div>
          <Separator className="mt-2 mb-4" />

          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4">
              <div className="flex-1">
                <Label htmlFor="ws-name" className="text-sm font-medium">
                  Workspace Name
                </Label>
                <Input
                  id="ws-name"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  disabled={!isOwner}
                  className="mt-1"
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div className="flex-1">
                <Label htmlFor="ws-slug" className="text-sm font-medium">
                  Slug
                </Label>
                <p className="text-xs text-muted-foreground">
                  Used in URLs and references
                </p>
                <Input
                  id="ws-slug"
                  value={editSlug}
                  onChange={(e) =>
                    setEditSlug(
                      e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''),
                    )
                  }
                  disabled={!isOwner}
                  className="mt-1"
                />
              </div>
            </div>

            <div className="flex items-center justify-between gap-4">
              <div>
                <Label className="text-sm font-medium">Plan</Label>
                <p className="text-xs text-muted-foreground">
                  Your current workspace plan
                </p>
              </div>
              <Badge variant="secondary" className="capitalize">
                {workspace?.plan}
              </Badge>
            </div>

            {/* Product facts — the doc the live agent states product facts
                from on calls. Owners/admins pick it; members see it. */}
            <ProductDocCard canManage={isOwnerOrAdmin} />

            {/* Features — the per-feature tri-state on top of the edition.
                The edition (set at signup, changeable only from the admin
                console) picks a preset; this is where it stops being a prison.
                Effective state is derived, so an edition change re-bases every
                row while explicit choices keep their Custom marker. */}
            <div id="features" className="scroll-mt-8">
              <Label className="text-sm font-medium">Features</Label>
              <p className="text-xs text-muted-foreground">
                Turn anything on or off — each one brings its whole bundle:
                the sidebar item and the AI tools that go with it.
              </p>

              <div className="mt-2 divide-y rounded-lg border">
                {FEATURE_LIST.map((feature) => {
                  const isOn = effective.has(feature.id)
                  const isDefault = defaults.has(feature.id)
                  const isCustom = !feature.locked && isOn !== isDefault
                  const busy = featureBusy === feature.id

                  // Copy that tells the truth about the bundle BEFORE the click,
                  // which is what lets this stay modal-free: the row says what
                  // else will move, so nothing needs confirming after the fact.
                  //
                  // `requires` names this feature's unmet requirements. Under
                  // off-wins those are the REASON this row is off (a dependency
                  // switched off takes its dependents down), so the note leads
                  // with that fact and then says what turning it on will do.
                  // `dependents` names what a switch-off will take with it —
                  // still true, and now enforced by the manifest rather than by
                  // this card issuing extra PATCHes.
                  const requires = feature.requires.filter((k) => !effective.has(k))
                  const dependents = isOn ? dependentsOf(feature.id).filter((k) => effective.has(k)) : []
                  const note = feature.locked
                    ? null
                    : !isOn && requires.length > 0
                      ? `Requires ${listFeatureLabels(requires)}. Turning this on also enables ${
                          requires.length === 1 ? 'it' : 'them'
                        }.`
                      : isOn && dependents.length > 0
                        ? `Turning this off also disables ${listFeatureLabels(dependents)}.`
                        : null

                  return (
                    <div
                      key={feature.id}
                      className="flex items-center justify-between gap-4 px-4 py-3"
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <p className="text-sm font-medium">{feature.label}</p>
                          {isCustom && (
                            <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                              Custom
                            </Badge>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {feature.description}
                        </p>
                        {/* An OPT-IN feature is in no edition's preset, so it
                            reads as off even on a Full workspace. Say why,
                            the same way the row says what a bundle pulls in. */}
                        {feature.optIn && (
                          <p className="mt-0.5 text-xs text-muted-foreground/80">
                            Off by default. Turn it on to add it to this workspace.
                          </p>
                        )}
                        {note && (
                          <p className="mt-0.5 text-xs text-muted-foreground/80">{note}</p>
                        )}
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        {isCustom && isOwnerOrAdmin && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs text-muted-foreground"
                            disabled={busy}
                            onClick={() => handleFeatureReset(feature.id)}
                          >
                            Reset
                          </Button>
                        )}
                        {feature.locked ? (
                          <span className="text-xs text-muted-foreground">Always on</span>
                        ) : (
                          <>
                            {busy && (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                            )}
                            <Switch
                              checked={isOn}
                              disabled={!isOwnerOrAdmin || busy}
                              aria-label={feature.label}
                              onCheckedChange={(val) => handleFeatureToggle(feature.id, val)}
                            />
                          </>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>

              {featureError && (
                <p className="mt-1.5 text-sm text-destructive">{featureError}</p>
              )}
            </div>

            {isOwner && (
              <div className="flex items-center gap-2">
                <Button
                  onClick={handleSave}
                  disabled={
                    saving ||
                    (editName === workspace?.name &&
                      editSlug === workspace?.slug)
                  }
                >
                  {saving ? 'Saving...' : 'Save Changes'}
                </Button>
                {saveError && (
                  <p className="text-sm text-destructive">{saveError}</p>
                )}
                {saveSuccess && (
                  <p className="text-sm text-green-600 dark:text-green-400">{saveSuccess}</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Members */}
        <div className="mt-10">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Users className="h-4 w-4" />
            Members
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              {members.length}
            </span>
          </div>
          <Separator className="mt-2 mb-4" />

          <div className="divide-y rounded-lg border">
            {members.map((member) => {
              const isSelf = member.id === currentMemberId
              const canManage =
                isOwnerOrAdmin && !isSelf && member.role !== 'owner'

              return (
                <div
                  key={member.id}
                  className="flex items-center justify-between gap-4 px-4 py-3"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Avatar className="h-9 w-9 shrink-0">
                      <AvatarImage src={member.avatar_url ?? undefined} />
                      <AvatarFallback className="text-xs">
                        {getInitials(member.display_name)}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium">
                        {member.display_name}
                        {isSelf && (
                          <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                            you
                          </span>
                        )}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {member.email}
                      </p>
                      {joinedViaNote(member.joined_via) && (
                        <p className="truncate text-xs text-muted-foreground/70">
                          {joinedViaNote(member.joined_via)}
                        </p>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {canManage ? (
                      <>
                        <Select
                          value={member.role}
                          onValueChange={(val) =>
                            handleChangeRole(member.id, val)
                          }
                        >
                          <SelectTrigger className="h-7 w-[100px] text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="admin">
                              <div className="flex items-center gap-1.5">
                                <Shield className="h-3 w-3" />
                                Admin
                              </div>
                            </SelectItem>
                            <SelectItem value="member">Member</SelectItem>
                            <SelectItem value="guest">Guest</SelectItem>
                          </SelectContent>
                        </Select>
                        {/* Only the owner removes members (the route's rule). */}
                        {isOwner && (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => setRemoveMember(member)}
                                  className="text-destructive/60 hover:text-destructive hover:bg-destructive/10"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Remove member</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                      </>
                    ) : (
                      <Badge
                        variant={ROLE_VARIANTS[member.role] ?? 'outline'}
                        className="text-xs"
                      >
                        {member.role === 'owner' && (
                          <Crown className="mr-1 h-3 w-3" />
                        )}
                        {member.role === 'admin' && (
                          <Shield className="mr-1 h-3 w-3" />
                        )}
                        {ROLE_LABELS[member.role] ?? member.role}
                      </Badge>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Invites: owners and admins, and members while they may invite */}
        {canSendInvites && (
          <div className="mt-10">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <Mail className="h-4 w-4" />
              Invitations
            </div>
            <Separator className="mt-2 mb-4" />

            <form onSubmit={handleInvite} className="flex items-end gap-3">
              <div className="flex-1">
                <Label htmlFor="invite-email" className="text-sm font-medium">
                  Email address
                </Label>
                <Input
                  id="invite-email"
                  type="email"
                  placeholder="colleague@example.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="mt-1"
                />
              </div>
              <div className="w-32">
                <Label htmlFor="invite-role" className="text-sm font-medium">
                  Role
                </Label>
                <Select value={inviteRole} onValueChange={setInviteRole}>
                  <SelectTrigger className="mt-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {inviteRoles.map((r) => (
                      <SelectItem key={r} value={r}>
                        {ROLE_LABELS[r] ?? r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="submit" disabled={inviting || !inviteEmail.trim()}>
                {inviting ? 'Sending...' : 'Send Invite'}
              </Button>
            </form>

            {inviteError && (
              <p className="mt-2 text-sm text-destructive">{inviteError}</p>
            )}

            {isOwnerOrAdmin && invites.length > 0 && (
              <div className="mt-6 space-y-3">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Pending Invites
                </p>
                <div className="divide-y rounded-lg border">
                  {invites.map((invite) => {
                    const isSent = resentIds.has(invite.id)
                    const isSending = resendingId === invite.id

                    return (
                      <div
                        key={invite.id}
                        className="flex items-center justify-between px-4 py-3 transition-colors"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted">
                            <Mail className="h-3.5 w-3.5 text-muted-foreground" />
                          </div>
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">
                              {invite.email}
                            </p>
                            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                              <Clock className="h-3 w-3" />
                              Expires{' '}
                              {new Date(invite.expires_at).toLocaleDateString()}
                            </div>
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0 ml-3">
                          <Select
                            value={invite.role}
                            onValueChange={(val) => handleChangeInviteRole(invite.id, val)}
                          >
                            <SelectTrigger className="h-7 w-[100px] text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="admin">Admin</SelectItem>
                              <SelectItem value="member">Member</SelectItem>
                              <SelectItem value="guest">Guest</SelectItem>
                            </SelectContent>
                          </Select>
                          <Button
                            variant={isSent ? 'ghost' : 'outline'}
                            size="sm"
                            disabled={isSending || isSent}
                            onClick={() => handleResendInvite(invite.id)}
                            className={
                              isSent
                                ? 'pointer-events-none gap-1.5 text-emerald-600 dark:text-emerald-400'
                                : 'gap-1.5'
                            }
                          >
                            {isSent ? (
                              <>
                                <Check className="h-3.5 w-3.5" />
                                Resent
                              </>
                            ) : isSending ? (
                              <>
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Sending
                              </>
                            ) : (
                              <>
                                <RefreshCw className="h-3.5 w-3.5" />
                                Resend
                              </>
                            )}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleRevokeInvite(invite.id)}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <X className="h-4 w-4" />
                          </Button>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Joining: the invite link, join by email domain, members can invite */}
        <JoiningSection view={joinView} onChange={setJoinView} />

        {/* Agents outside this workspace (agent links, decision 5) */}
        {currentRole && <OutsideAgentLinksSection />}

        {/* ── Danger Zone ──────────────────────────────────────────────────── */}
        {currentRole && (
          <div className="mt-10">
            <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Danger Zone
            </div>
            <Separator className="mt-2 mb-4 bg-destructive/20" />

            <div className="divide-y divide-destructive/10 rounded-lg border border-destructive/20">
              {/* Transfer Ownership — owners only, when other members exist */}
              {isOwner && transferableMembers.length > 0 && (
                <div className="flex items-center justify-between px-4 py-4">
                  <div>
                    <p className="text-sm font-medium">Transfer Ownership</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Pass owner status to another member. You&apos;ll become an
                      admin.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setTransferOpen(true)
                      setDangerError('')
                    }}
                  >
                    Transfer
                  </Button>
                </div>
              )}

              {/* Leave Workspace — non-owners only */}
              {!isOwner && (
                <div className="flex items-center justify-between px-4 py-4">
                  <div>
                    <p className="text-sm font-medium">Leave Workspace</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Remove yourself from this workspace.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => {
                      setLeaveOpen(true)
                      setDangerError('')
                    }}
                  >
                    <LogOut className="mr-1.5 h-3.5 w-3.5" />
                    Leave
                  </Button>
                </div>
              )}

              {/* Merge another workspace into this one — owners only (of both) */}
              {isOwner && (
                <div className="flex items-center justify-between px-4 py-4">
                  <div>
                    <p className="text-sm font-medium">Merge Another Workspace Into This One</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Move everything from another workspace you own into{' '}
                      {workspace?.name ?? 'this one'}. That workspace is removed
                      once it is empty.
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setMergeOpen(true)
                      setDangerError('')
                    }}
                  >
                    Merge…
                  </Button>
                </div>
              )}

              {/* Delete Workspace — owners only */}
              {isOwner && (
                <div className="flex items-center justify-between px-4 py-4">
                  <div>
                    <p className="text-sm font-medium">Delete Workspace</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Permanently delete this workspace and all its data.
                    </p>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      setDeleteOpen(true)
                      setDangerError('')
                    }}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </div>

            {dangerError && !leaveOpen && !deleteOpen && !transferOpen && (
              <p className="mt-3 text-sm text-destructive">{dangerError}</p>
            )}
          </div>
        )}
      </div>

      {/* ── Remove member confirmation ────────────────────────────────────── */}
      <AlertDialog
        open={!!removeMember}
        onOpenChange={(open) => {
          if (!open && !removing) {
            setRemoveMember(null)
            setRemoveError('')
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove member</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to remove{' '}
              <strong>{removeMember?.display_name}</strong> from this workspace?
              They will lose access immediately. Their comments and drafts stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {removeError && (
            <p className="px-1 text-sm text-destructive">{removeError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault()
                void handleRemoveMember()
              }}
              disabled={removing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removing ? 'Removing...' : 'Remove'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Leave workspace confirmation ─────────────────────────────────── */}
      <AlertDialog
        open={leaveOpen}
        onOpenChange={(open) => {
          if (!open && !dangerLoading) setLeaveOpen(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave workspace</AlertDialogTitle>
            <AlertDialogDescription>
              You&apos;ll lose access to all of{' '}
              <strong>{workspace?.name}</strong>&apos;s content. If you need
              access again, you&apos;ll have to be invited back. Your comments
              stay, and your drafts come back if you rejoin.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dangerError && (
            <p className="px-1 text-sm text-destructive">{dangerError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dangerLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleLeave}
              disabled={dangerLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {dangerLoading ? 'Leaving...' : 'Leave workspace'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Delete workspace confirmation ────────────────────────────────── */}
      <AlertDialog
        open={deleteOpen}
        onOpenChange={(open) => {
          if (!open && !dangerLoading) setDeleteOpen(false)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete workspace</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  This will permanently delete{' '}
                  <strong className="text-foreground">{workspace?.name}</strong>{' '}
                  and all of its data — actions, captures, documents, and
                  settings.
                </p>
                {otherMembers.length > 0 && (
                  <p>
                    <strong className="text-foreground">
                      {otherMembers.length}
                    </strong>{' '}
                    other{' '}
                    {otherMembers.length === 1 ? 'member' : 'members'} will also
                    lose access.
                  </p>
                )}
                <p>This cannot be undone.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          {dangerError && (
            <p className="px-1 text-sm text-destructive">{dangerError}</p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dangerLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={dangerLoading}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {dangerLoading ? 'Deleting...' : 'Delete workspace'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Transfer ownership ───────────────────────────────────────────── */}
      <AlertDialog
        open={transferOpen}
        onOpenChange={(open) => {
          if (!open && !dangerLoading) {
            setTransferOpen(false)
            setTransferTargetId('')
            setDangerError('')
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Transfer ownership</AlertDialogTitle>
            <AlertDialogDescription>
              Choose a member to become the new owner. You&apos;ll become an
              admin after transferring.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-1 py-2">
            <Select
              value={transferTargetId}
              onValueChange={setTransferTargetId}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a member…" />
              </SelectTrigger>
              <SelectContent>
                {transferableMembers.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <div className="flex items-center gap-2">
                      <Avatar className="h-5 w-5">
                        <AvatarImage src={m.avatar_url ?? undefined} />
                        <AvatarFallback className="text-[10px]">
                          {getInitials(m.display_name)}
                        </AvatarFallback>
                      </Avatar>
                      <span>{m.display_name}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {dangerError && (
              <p className="mt-2 text-sm text-destructive">{dangerError}</p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={dangerLoading}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleTransfer}
              disabled={dangerLoading || !transferTargetId}
            >
              {dangerLoading ? 'Transferring...' : 'Transfer ownership'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {workspace && isOwner && (
        <MergeWorkspaceSheet
          open={mergeOpen}
          onClose={() => setMergeOpen(false)}
          destination={{ id: workspace.id, name: workspace.name }}
        />
      )}
    </div>
  )
}

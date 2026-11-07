'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Eye, EyeOff, Loader2 } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from '@/components/ui/select'
import { cachedJson } from '@/lib/cached-fetch'
import { PREFERENCE_ACTION_CLASS, usePreferencesActions } from '@/components/views/preference-action'
import { cn } from '@/lib/utils'

/**
 * "Workspace" vs "Only me": the one scope control, for captures (migration
 * 223) and documents (migration 369). Same pill, same two options, same
 * optimistic write; only the noun in the copy and the route it PATCHes differ.
 */
export type Visibility = 'workspace' | 'private'

/** What the control is about: the noun its copy uses. */
export type VisibilityNoun = 'capture' | 'document'

/** Same two-option shape as contact-share-dialog's VISIBILITY_CONFIG, trimmed
 *  to the two tiers captures and documents have (no 'team' tier, no
 *  per-member grants). Visibility metaphor rather than an audience/permission
 *  one: an open `Eye` for the workspace tier (others can see this) and a
 *  struck-through `EyeOff` for private (nobody but you can). A globe would be
 *  wrong here — this is never "public on the internet", it is "the people in
 *  my workspace". */
function visibilityConfig(
  noun: VisibilityNoun,
): Record<Visibility, { icon: typeof Eye; label: string; description: string }> {
  return {
    workspace: {
      icon: Eye,
      label: 'Workspace',
      description: `Everyone in this workspace can see this ${noun}.`,
    },
    private: {
      icon: EyeOff,
      label: 'Only me',
      description: `Only you can see this ${noun}.`,
    },
  }
}

const VISIBILITY_ORDER: Visibility[] = ['workspace', 'private']

/**
 * May this viewer be offered the scope control?
 *
 * Two ways to know they're the creator:
 *  - `ownerId` matches `viewerId` — the direct answer, available as soon as
 *    the detail payload carries the owner (a capture's user id, a document's
 *    creator member id; the viewer id must be the same kind).
 *  - the item is ALREADY private and they can read it. Only the creator is
 *    ever served a private capture or document (RLS + the routes'
 *    predicates), so reading one IS proof of authorship. This is what keeps a
 *    private item flippable back to 'workspace' on a payload with no owner —
 *    without it, going private would be one-way in the UI.
 *
 * On a WORKSPACE item with unknown ownership there is no such proof, so the
 * control stays hidden rather than offering a flip that would 403. Solo
 * workspaces are excluded by the caller: "who can see this" has no answer worth
 * asking when the answer is only ever you.
 */
export function canOfferVisibilityControl(
  ownerId: string | null | undefined,
  visibility: Visibility,
  viewerId: string | null,
  memberCount: number | null,
): boolean {
  if ((memberCount ?? 0) <= 1) return false
  if (!viewerId) return false
  if (ownerId) return ownerId === viewerId
  return visibility === 'private'
}

interface WorkspacePayload {
  currentMemberId?: string | null
  members?: { id: string; user_id: string }[]
}

/**
 * The viewer's auth user id, member id and the workspace member count, all
 * read off the single cached /api/account/workspace payload every dashboard
 * surface already pulls. The workspace cache context exposes `currentMemberId`
 * but NOT the auth uid, and `captures.user_id` is a uid — so the member row is
 * the bridge (a document's creator is the member id itself). No new endpoint:
 * this is a cache hit in practice.
 */
export function useVisibilityViewer(workspaceId: string | null | undefined) {
  const [userId, setUserId] = useState<string | null>(null)
  const [memberId, setMemberId] = useState<string | null>(null)
  const [memberCount, setMemberCount] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void cachedJson<WorkspacePayload>('/api/account/workspace', { scope: workspaceId })
      .then((data) => {
        if (cancelled || !data) return
        const members = data.members ?? []
        setMemberCount(members.length)
        const me = data.currentMemberId
          ? members.find((m) => m.id === data.currentMemberId)
          : undefined
        setUserId(me?.user_id ?? null)
        setMemberId(me?.id ?? null)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId])

  return { userId, memberId, memberCount }
}

interface VisibilityControlProps {
  noun: VisibilityNoun
  /** The route the control PATCHes with `{ visibility }`. */
  endpoint: string
  visibility: Visibility
  /** Applied optimistically by the parent; called again with the old value on failure. */
  onVisibilityChange: (visibility: Visibility) => void
}

/**
 * Scope control — "Workspace" vs "Only me". Render it only for the creator
 * (the routes enforce that too, with a 403).
 *
 * Styled as the same pill dropdown as the mail folder selector in
 * `src/components/email/email-layout.tsx` — same SelectTrigger class string,
 * same `h-3 w-3` leading icon — so the two read as one control family.
 */
export function VisibilityControl({
  noun,
  endpoint,
  visibility,
  onVisibilityChange,
}: VisibilityControlProps) {
  const [saving, setSaving] = useState(false)
  const inPreferences = usePreferencesActions()
  const config = visibilityConfig(noun)

  const handleSelect = useCallback(
    async (next: Visibility) => {
      if (next === visibility || saving) return
      const previous = visibility
      // Optimistic: the trigger's icon and label flip before the round trip,
      // and roll back together on failure.
      onVisibilityChange(next)
      setSaving(true)
      try {
        const res = await fetch(endpoint, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ visibility: next }),
        })
        if (!res.ok) {
          const body = await res.json().catch(() => null)
          throw new Error(body?.error || 'Failed to update visibility')
        }
      } catch (err) {
        onVisibilityChange(previous)
        toast.error(err instanceof Error ? err.message : 'Failed to update visibility')
      } finally {
        setSaving(false)
      }
    },
    [endpoint, visibility, saving, onVisibilityChange],
  )

  const TriggerIcon = config[visibility].icon

  return (
    <Select
      value={visibility}
      onValueChange={(v) => void handleSelect(v as Visibility)}
    >
      <SelectTrigger
        className={cn('h-7 w-auto gap-1.5 rounded-full border border-border bg-transparent px-3 text-xs shadow-sm hover:bg-muted/50 focus:ring-0 focus:ring-offset-0 dark:shadow-none', inPreferences && PREFERENCE_ACTION_CLASS)}
        aria-label={`Change who can see this ${noun}`}
        title={config[visibility].description}
      >
        {saving ? (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <TriggerIcon className="h-3 w-3 shrink-0" />
        )}
        <span>{inPreferences ? `Visible to: ${config[visibility].label}` : config[visibility].label}</span>
      </SelectTrigger>
      <SelectContent align="start">
        {VISIBILITY_ORDER.map((v) => {
          const option = config[v]
          const Icon = option.icon
          return (
            <SelectItem key={v} value={v} className="items-start py-2">
              <div className="flex items-start gap-2">
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <div className="flex flex-col gap-0.5">
                  <span>{option.label}</span>
                  <span className="text-[11px] leading-normal text-muted-foreground">
                    {option.description}
                  </span>
                </div>
              </div>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}

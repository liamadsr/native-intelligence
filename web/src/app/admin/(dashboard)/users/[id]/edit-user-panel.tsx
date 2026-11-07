'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Separator } from '@/components/ui/separator'
import { Badge } from '@/components/ui/badge'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { Pencil, Ban, ShieldCheck, Clock, X } from 'lucide-react'
import { DateTimePicker } from '@/components/ui/datetime-picker'
import { format } from 'date-fns'

/** Metadata keys with their own field (or owned by auth): not in the custom JSON box. */
const STANDARD_METADATA_KEYS = [
  'admin_notes', 'avatar_url', 'picture', 'photo_url',
  'full_name', 'name', 'email', 'email_verified',
  'iss', 'sub', 'provider_id', 'custom_claims',
  'trial_end_override',
]

export function EditUserPanel({
  userId,
  currentEmail,
  currentMetadata,
  isBanned,
}: {
  userId: string
  currentEmail: string
  currentMetadata: Record<string, unknown>
  isBanned: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  // Form fields
  const [email, setEmail] = useState(currentEmail)
  const [fullName, setFullName] = useState(
    String(currentMetadata.full_name ?? currentMetadata.name ?? ''),
  )
  const [notes, setNotes] = useState(String(currentMetadata.admin_notes ?? ''))
  const [banned, setBanned] = useState(isBanned)
  // Trial extension state
  const currentTrialOverride = currentMetadata.trial_end_override
    ? String(currentMetadata.trial_end_override)
    : null
  const [trialEndOverride, setTrialEndOverride] = useState<string | null>(
    currentTrialOverride,
  )
  // The picked day as a local Date (the picker shows local days).
  const [customTrialDate, setCustomTrialDate] = useState<Date | undefined>(undefined)

  const trialOverrideDate = trialEndOverride ? new Date(trialEndOverride) : null
  const isTrialOverrideActive = trialOverrideDate ? trialOverrideDate > new Date() : false

  function extendTrial(days: number) {
    const base = trialOverrideDate && trialOverrideDate > new Date()
      ? trialOverrideDate
      : new Date()
    const extended = new Date(base)
    extended.setDate(extended.getDate() + days)
    setTrialEndOverride(extended.toISOString())
  }

  function applyCustomDate() {
    if (!customTrialDate) return
    const date = new Date(format(customTrialDate, 'yyyy-MM-dd') + 'T23:59:59.999Z')
    if (isNaN(date.getTime())) return
    setTrialEndOverride(date.toISOString())
    setCustomTrialDate(undefined)
  }

  const [metadataJson, setMetadataJson] = useState(() => {
    const custom = Object.fromEntries(
      Object.entries(currentMetadata).filter(([k]) => !STANDARD_METADATA_KEYS.includes(k)),
    )
    return Object.keys(custom).length > 0 ? JSON.stringify(custom, null, 2) : ''
  })

  async function handleSave() {
    setSaving(true)
    setError(null)
    setSuccess(null)

    try {
      // Validate metadata JSON
      let extraMetadata: Record<string, unknown> = {}
      if (metadataJson.trim()) {
        let parsed: unknown
        try {
          parsed = JSON.parse(metadataJson)
        } catch {
          parsed = undefined
        }
        // Must be an object: its keys are diffed against the stored ones below.
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          setError('Invalid JSON in custom metadata field')
          setSaving(false)
          return
        }
        extraMetadata = parsed as Record<string, unknown>
      }

      // updateUserById merges user_metadata shallowly: a key is removed only
      // when sent as null. So a cleared field, or a custom key deleted from
      // the JSON box, is sent as null.
      const removedCustomKeys = Object.keys(currentMetadata).filter(
        (k) => !STANDARD_METADATA_KEYS.includes(k) && !(k in extraMetadata),
      )
      const user_metadata: Record<string, unknown> = {
        ...Object.fromEntries(removedCustomKeys.map((k) => [k, null])),
        ...extraMetadata,
        full_name: fullName.trim() || null,
        admin_notes: notes.trim() || null,
      }

      // Include trial override (or null to clear it)
      if (trialEndOverride !== currentTrialOverride) {
        user_metadata.trial_end_override = trialEndOverride
      }

      const res = await fetch(`/api/admin/users/${userId}/update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_metadata,
          ...(email !== currentEmail ? { email } : {}),
          // Only when the admin toggled it: a save must never touch a ban
          // set elsewhere.
          ...(banned !== isBanned ? { ban: banned } : {}),
        }),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error ?? 'Failed to update user')
      }

      setSuccess('User updated')
      setTimeout(() => {
        setOpen(false)
        setSuccess(null)
        router.refresh()
      }, 600)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil className="mr-1.5 h-3.5 w-3.5" />
          Edit
        </Button>
      </SheetTrigger>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Edit User</SheetTitle>
        </SheetHeader>
        <div className="mt-6 space-y-6">
          {/* Email */}
          <div className="space-y-2">
            <Label htmlFor="edit-email">Email</Label>
            <Input
              id="edit-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Changing the email will send a confirmation to the new address.
            </p>
          </div>

          {/* Full Name */}
          <div className="space-y-2">
            <Label htmlFor="edit-name">Display Name</Label>
            <Input
              id="edit-name"
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="User's display name"
            />
          </div>

          {/* Admin Notes */}
          <div className="space-y-2">
            <Label htmlFor="edit-notes">Admin Notes</Label>
            <Textarea
              id="edit-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Internal notes about this user..."
              rows={3}
            />
          </div>

          <Separator />

          {/* Trial Extension */}
          <div className="space-y-3">
            <Label>Trial Extension</Label>
            {trialEndOverride ? (
              <div className="flex items-center gap-2">
                <Badge
                  variant={isTrialOverrideActive ? 'default' : 'secondary'}
                  className="gap-1"
                >
                  <Clock className="h-3 w-3" />
                  {isTrialOverrideActive
                    ? `Extended until ${trialOverrideDate!.toLocaleDateString()}`
                    : `Extension expired ${trialOverrideDate!.toLocaleDateString()}`}
                </Badge>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setTrialEndOverride(null)}
                  type="button"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Standard trial (14 days from signup)
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => extendTrial(7)}
                type="button"
              >
                +1 Week
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => extendTrial(14)}
                type="button"
              >
                +2 Weeks
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => extendTrial(30)}
                type="button"
              >
                +1 Month
              </Button>
            </div>

            <div className="flex gap-2">
              <DateTimePicker
                value={customTrialDate}
                onChange={(d) => {
                  if (d) {
                    setCustomTrialDate(d)
                  }
                }}
                granularity="day"
                placeholder="Pick a date"
                displayFormat={{ hour24: 'MMM d, yyyy' }}
                className="flex-1"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={applyCustomDate}
                disabled={!customTrialDate}
                type="button"
              >
                Set Date
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Extends trial beyond the default 14 days. The app picks this up on
              next sync.
            </p>
          </div>

          <Separator />

          {/* Ban toggle */}
          <div className="space-y-2">
            <Label>Account Status</Label>
            <div className="flex items-center gap-3">
              {banned ? (
                <>
                  <Badge variant="destructive" className="gap-1">
                    <Ban className="h-3 w-3" /> Banned
                  </Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setBanned(false)}
                    type="button"
                  >
                    <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                    Unban
                  </Button>
                </>
              ) : (
                <>
                  <Badge variant="outline" className="gap-1 text-green-600 border-green-600/30">
                    <ShieldCheck className="h-3 w-3" /> Active
                  </Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setBanned(true)}
                    type="button"
                    className="text-destructive hover:bg-destructive hover:text-destructive-foreground"
                  >
                    <Ban className="mr-1.5 h-3.5 w-3.5" />
                    Ban User
                  </Button>
                </>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Banned users cannot sign in or use the app.
            </p>
          </div>

          <Separator />

          {/* Custom metadata */}
          <div className="space-y-2">
            <Label htmlFor="edit-metadata">Custom Metadata (JSON)</Label>
            <Textarea
              id="edit-metadata"
              value={metadataJson}
              onChange={(e) => setMetadataJson(e.target.value)}
              placeholder='{"key": "value"}'
              rows={4}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              Additional metadata stored on the user record. Must be valid JSON.
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
          {success && <p className="text-sm text-green-600">{success}</p>}

          <Button onClick={handleSave} disabled={saving} className="w-full">
            {saving ? 'Saving...' : 'Save Changes'}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  ADMIN_FEATURE_LIST,
  ADMIN_TOGGLEABLE_FEATURE_KEYS,
  EDITIONS,
  EDITION_LIST,
  FEATURES,
  STANDARD_FEATURE_KEYS,
  effectiveFeatureKeys,
  isEditionId,
  type EditionId,
  type FeatureKey,
  type FeatureOverrides,
} from '@/lib/editions'

/**
 * The admin console's edition + feature controls for ONE workspace.
 *
 * This is the home of the edition switcher that used to live in workspace
 * settings: an edition changes the nav rail, the AI's tool ceiling, and what
 * automation may create for every member, so it is set on the workspace's
 * behalf here rather than by the users themselves — who keep the per-feature
 * toggles in their own settings.
 *
 * Semantics are identical to the user-facing Features card
 * (account/settings/workspace/workspace-settings-view.tsx): effective state is
 * DERIVED on every render from (edition, overrides) rather than stored, so
 * switching the edition re-bases every row — defaults, Custom markers and all —
 * with no refetch, while explicit overrides persist. That IS the tri-state,
 * made visible.
 */

interface WorkspaceRow {
  id: string
  name: string
  slug: string | null
  plan: string | null
  role: string
  edition: EditionId
  overrides: FeatureOverrides
}

/**
 * The features currently in effect, as a set.
 *
 * `'all'` expands to STANDARD_FEATURE_KEYS, not to this panel's own row list:
 * `'all'` means "every DEFAULT-ON feature", so expanding it to the admin list
 * would show Evals (opt-in) as on for every `full` workspace.
 */
function effectiveFeatureSet(
  edition: EditionId,
  overrides: FeatureOverrides,
): Set<FeatureKey> {
  const keys = effectiveFeatureKeys(EDITIONS[edition], overrides)
  if (keys === 'all') return new Set(STANDARD_FEATURE_KEYS)
  return new Set(keys)
}

/** Features that require `key` — the ones that must go off when it does. */
function dependentsOf(key: FeatureKey): FeatureKey[] {
  return ADMIN_TOGGLEABLE_FEATURE_KEYS.filter((k) => FEATURES[k].requires.includes(key))
}

/** "CRM", or "CRM and Sequences", or "CRM, Sequences, and Email". */
function listFeatureLabels(keys: readonly FeatureKey[]): string {
  const labels = keys.map((k) => FEATURES[k].label)
  if (labels.length <= 1) return labels[0] ?? ''
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`
}

export function WorkspaceFeaturesPanel({ workspaces }: { workspaces: WorkspaceRow[] }) {
  if (workspaces.length === 0) {
    return <p className="text-sm text-muted-foreground">No workspaces.</p>
  }

  return (
    <div className="space-y-6">
      {workspaces.map((ws) => (
        <WorkspaceCard key={ws.id} workspace={ws} />
      ))}
    </div>
  )
}

function WorkspaceCard({ workspace }: { workspace: WorkspaceRow }) {
  const router = useRouter()
  const [edition, setEdition] = useState<EditionId>(workspace.edition)
  const [overrides, setOverrides] = useState<FeatureOverrides>(workspace.overrides)
  const [editionSaving, setEditionSaving] = useState(false)
  const [featureBusy, setFeatureBusy] = useState<FeatureKey | null>(null)
  const [error, setError] = useState('')

  // Derived on every render from (edition, overrides), never stored.
  const effective = effectiveFeatureSet(edition, overrides)
  const defaults = effectiveFeatureSet(edition, {})

  async function handleEditionChange(next: EditionId) {
    const previous = edition
    if (next === previous) return
    // Optimistic: the control reflects the choice immediately, and reverts if
    // the write is rejected.
    setEdition(next)
    setEditionSaving(true)
    setError('')
    try {
      const res = await fetch(`/api/admin/workspaces/${workspace.id}/edition`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ edition: next }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? 'Failed to change edition')
      }
      const body = await res.json()
      if (isEditionId(body.edition)) setEdition(body.edition)
      router.refresh()
    } catch (err) {
      setEdition(previous)
      setError(err instanceof Error ? err.message : 'Failed to change edition')
    } finally {
      setEditionSaving(false)
    }
  }

  /**
   * Write one feature's state.
   *
   * Returns the overrides map the server actually stored, which is NOT
   * necessarily what was sent — the route auto-collapses a state matching the
   * edition default by deleting the key. A caller chaining several PATCHes (a
   * feature plus its requirements) must thread that returned map into the next
   * call, or the second write would be computed against a stale local map.
   */
  async function patchFeature(
    feature: FeatureKey,
    state: 'on' | 'off' | 'default',
    base: FeatureOverrides,
  ): Promise<FeatureOverrides> {
    const res = await fetch(`/api/admin/workspaces/${workspace.id}/features`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ feature, state }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error ?? 'Failed to update feature')
    }
    const body = await res.json()
    return (body.overrides && typeof body.overrides === 'object'
      ? body.overrides
      : base) as FeatureOverrides
  }

  /**
   * Toggle a feature, carrying its REQUIREMENTS with it.
   *
   * A feature is a coherent BUNDLE, so the panel never leaves a half-state:
   * turning Sequences on also turns CRM on. The OFF direction needs no cascade —
   * `effectiveFeatureKeys` gives an explicit `off` precedence over `requires` and
   * takes every dependent down with it.
   */
  async function handleFeatureToggle(feature: FeatureKey, next: boolean) {
    const previous = overrides
    const cascade = next ? FEATURES[feature].requires.filter((k) => !effective.has(k)) : []

    const optimistic: FeatureOverrides = { ...previous }
    for (const key of [...cascade, feature]) optimistic[key] = next ? 'on' : 'off'
    setOverrides(optimistic)
    setFeatureBusy(feature)
    setError('')

    try {
      let latest = previous
      // REQUIREMENTS FIRST, then the feature itself: under off-wins a
      // `sequences: 'on'` written while CRM is still off changes nothing and
      // would be pruned away, so the gesture would half-land.
      for (const key of [...cascade, feature]) {
        latest = await patchFeature(key, next ? 'on' : 'off', latest)
      }
      setOverrides(latest)
      router.refresh()
    } catch (err) {
      setOverrides(previous)
      setError(err instanceof Error ? err.message : 'Failed to update feature')
    } finally {
      setFeatureBusy(null)
    }
  }

  /** Drop the override so the feature follows the edition preset again. */
  async function handleFeatureReset(feature: FeatureKey) {
    const previous = overrides
    const optimistic = { ...previous }
    delete optimistic[feature]
    setOverrides(optimistic)
    setFeatureBusy(feature)
    setError('')
    try {
      setOverrides(await patchFeature(feature, 'default', previous))
      router.refresh()
    } catch (err) {
      setOverrides(previous)
      setError(err instanceof Error ? err.message : 'Failed to reset feature')
    } finally {
      setFeatureBusy(null)
    }
  }

  return (
    <div className="rounded-md border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{workspace.name}</p>
          <p className="truncate font-mono text-xs text-muted-foreground">
            {workspace.slug ?? workspace.id}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Badge variant="outline" className="capitalize">
            {workspace.role}
          </Badge>
          <Badge variant="secondary" className="capitalize">
            {workspace.plan ?? 'free'}
          </Badge>
        </div>
      </div>

      {/* Edition — the switcher removed from user-facing workspace settings. */}
      <div className="mt-4">
        <Label htmlFor={`edition-${workspace.id}`} className="text-sm font-medium">
          Edition
        </Label>
        <p className="text-xs text-muted-foreground">
          Tailors the sidebar, AI tools, and automations. Nothing is deleted when
          it changes — surfaces just come back.
        </p>
        <div className="mt-1 flex items-center gap-2">
          <Select
            value={edition}
            onValueChange={(val) => handleEditionChange(val as EditionId)}
            disabled={editionSaving}
          >
            <SelectTrigger id={`edition-${workspace.id}`} className="w-full sm:w-[220px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EDITION_LIST.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {e.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {editionSaving && (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
          )}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {EDITIONS[edition].description}
        </p>
      </div>

      {/* Features — the per-feature tri-state on top of the edition. */}
      <div className="mt-4">
        <Label className="text-sm font-medium">Features</Label>
        <div className="mt-2 divide-y rounded-lg border">
          {ADMIN_FEATURE_LIST.map((feature) => {
            const isOn = effective.has(feature.id)
            const isDefault = defaults.has(feature.id)
            const isCustom = !feature.locked && isOn !== isDefault
            const busy = featureBusy === feature.id

            // Copy that tells the truth about the bundle BEFORE the click.
            // `requires` names unmet requirements — under off-wins those are the
            // REASON this row is off. `dependents` names what a switch-off takes
            // with it.
            const requires = feature.requires.filter((k) => !effective.has(k))
            const dependents = isOn
              ? dependentsOf(feature.id).filter((k) => effective.has(k))
              : []
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
                className="flex items-center justify-between gap-4 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{feature.label}</p>
                    {feature.hidden && (
                      <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                        Staff only
                      </Badge>
                    )}
                    {isCustom && (
                      <Badge variant="outline" className="h-5 px-1.5 text-[10px]">
                        Custom
                      </Badge>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {feature.description}
                  </p>
                  {feature.hidden ? (
                    <p className="mt-0.5 text-xs text-muted-foreground/80">
                      Off in every edition. Only this switch turns it on.
                    </p>
                  ) : feature.optIn ? (
                    <p className="mt-0.5 text-xs text-muted-foreground/80">
                      Off by default in every edition. The workspace can also
                      turn it on themselves in workspace settings.
                    </p>
                  ) : null}
                  {note && (
                    <p className="mt-0.5 text-xs text-muted-foreground/80">{note}</p>
                  )}
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {isCustom && (
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
                        disabled={busy}
                        aria-label={`${workspace.name} — ${feature.label}`}
                        onCheckedChange={(val) => handleFeatureToggle(feature.id, val)}
                      />
                    </>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {error && <p className="mt-2 text-sm text-destructive">{error}</p>}
    </div>
  )
}

'use client'

import { useCallback, useEffect, useState } from 'react'
import { notifyTaskDestinationsChanged } from '@/lib/tasks/destinations-events'

/**
 * The machinery all three task-destination pickers (Asana, Jira, Linear) share,
 * and ONLY that.
 *
 * The three provider sections in integration-detail-view.tsx were written in
 * parallel on purpose — the rule-of-three extraction waited until Linear landed
 * so it had three honest examples. What the third example confirmed is that the
 * SHAPES differ (a 2-, 3- and 1-step cascade; two editable bucket maps and one
 * read-only one; one clear shape versus two) while the PLUMBING is identical:
 * classify a picker failure, retry the pickers, load settings + the top-level
 * picker together, and PATCH with optimistic-update-and-revert.
 *
 * So this hook owns the plumbing and nothing else. The cascade effects, the
 * derived ids, the sentinels and the bucket maps stay in the host component,
 * per provider, because every one of them encodes a real difference rather than
 * a configuration value. See the two options below for the only two places a
 * provider genuinely diverges INSIDE the plumbing.
 */

/**
 * Error codes the task-picker routes use for "the stored authorization is
 * unusable" — a dead refresh token (`reconnect_required`) reads the same to the
 * user as a disconnected account (`not_connected`), and both are fixed by
 * reconnecting.
 *
 * SHARED by all three providers on purpose: asana-picker.ts, jira-picker.ts and
 * linear-picker.ts deliberately emit the same two codes so a fourth provider
 * doesn't need its own banner vocabulary. (Jira and Linear reach
 * `reconnect_required` one extra way — both rotate the refresh token on every
 * use — but the user's fix is identical.)
 */
export const TASK_PICKER_RECONNECT_CODES = new Set(['reconnect_required', 'not_connected'])

/**
 * Reads one picker response, or null when the caller should leave state alone.
 *
 * `isCancelled` is the effect run's own `cancelled` flag, read AFTER the body
 * has been parsed. Pass it from any effect that already drops a stale SUCCESS,
 * so the same run's FAILURE is dropped on the same terms — see the load effect.
 */
export type PickerReader = (
  res: Response,
  what: string,
  isCancelled?: () => boolean,
) => Promise<Record<string, unknown> | null>

interface DestinationPickerOptions<TConfig> {
  /** Off for every provider whose capability isn't the one being viewed. */
  enabled: boolean
  /** `GET`/`PATCH` endpoint for the saved destination. */
  settingsUrl: string
  /** Human noun for the settings load's failure message ("your Asana settings"). */
  settingsLabel: string
  /** Message for the save funnel's generic failure ("Failed to save Asana settings"). */
  saveErrorMessage: string
  /**
   * The top-level picker loaded ALONGSIDE the settings on mount and on retry —
   * Asana's workspaces, Jira's sites, Linear's teams. Everything below it
   * cascades off a derived id and stays in the host component.
   */
  firstPicker: {
    url: string
    label: string
    /**
     * Called with the parsed body on success. Providers read different keys.
     * MUST be stable (a `useCallback` with no changing deps) — it is an effect
     * dependency, so an inline function would re-run the load every render.
     */
    onLoad: (data: Record<string, unknown>) => void
  }
  /**
   * LINEAR ONLY. Adopt `body.config` from a successful PATCH into local state.
   *
   * Linear's server derives `state_map` at save time and it exists in no other
   * response, so ignoring the echo leaves the read-only mapping blank until a
   * reload. Asana and Jira compute nothing server-side that the client needs
   * back, so they leave this off and keep their optimistic state.
   */
  adoptResponseConfig?: boolean
  /**
   * LINEAR ONLY. Route a save FAILURE carrying a reconnect code to the banner
   * instead of the inline error.
   *
   * Deliberately not "consistent" across the three: only Linear's PATCH can
   * answer `reconnect_required`, because only Linear's route talks to the
   * provider on save (deriving the state map). Widening this to Asana and Jira
   * would be a behaviour change to their save paths that nothing asked for and
   * no route can currently trigger.
   */
  reconnectOnSaveFailure?: boolean
}

interface DestinationPicker<TConfig, TPatch> {
  config: TConfig | null
  setConfig: React.Dispatch<React.SetStateAction<TConfig | null>>
  saving: boolean
  /** Failure to SAVE (the PATCH) — distinct from failing to LOAD the pickers. */
  error: string | null
  /** A picker fetch returned a reconnect code: the dropdowns can never populate. */
  reconnectRequired: boolean
  /** Any other picker failure (5xx, network): inline message + retry. */
  loadError: string | null
  /** Bumped by the retry button; include it in every cascade effect's deps. */
  retryKey: number
  setLoadError: (message: string) => void
  /** Classifies a picker response. Stable — safe as an effect dependency. */
  readPicker: PickerReader
  /** Clear both failure states and re-run every picker effect. */
  retry: () => void
  /** PATCH with optimistic update + revert. `optimistic` REPLACES rather than merges. */
  save: (patch: TPatch, optimistic?: TConfig) => Promise<void>
}

export function useDestinationPicker<TConfig extends object, TPatch>(
  options: DestinationPickerOptions<TConfig>,
): DestinationPicker<TConfig, TPatch> {
  const {
    enabled,
    settingsUrl,
    settingsLabel,
    saveErrorMessage,
    firstPicker,
    adoptResponseConfig = false,
    reconnectOnSaveFailure = false,
  } = options

  const [config, setConfig] = useState<TConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reconnectRequired, setReconnectRequired] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  /**
   * Read one picker response, classifying failures instead of collapsing them
   * to an empty list.
   *
   * Falling back to `[]` on every failure was indistinguishable from "you have
   * no projects": a revoked token rendered empty dropdowns and no reason. A
   * reconnect code raises the banner; anything else becomes a retryable inline
   * error. Returns null when the caller should leave its state alone.
   *
   * A CANCELLED run classifies nothing. The success path was always guarded by
   * the caller's `cancelled` flag, but these two setters fire from inside here,
   * where the flag wasn't in scope — so a slow first request that finally
   * answered `reconnect_required` (or 5xx) raised its banner over the pickers a
   * successful retry had already rendered healthy. Failures are stale for
   * exactly the same reason successes are.
   */
  const readPicker = useCallback<PickerReader>(async (res, what, isCancelled) => {
    if (res.ok) return (await res.json()) as Record<string, unknown>
    const body = (await res.json().catch(() => ({}))) as { code?: string; error?: string }
    if (isCancelled?.()) return null
    if (body.code && TASK_PICKER_RECONNECT_CODES.has(body.code)) {
      setReconnectRequired(true)
      return null
    }
    setLoadError(body.error || `Couldn't load ${what}.`)
    return null
  }, [])

  const retry = useCallback(() => {
    setReconnectRequired(false)
    setLoadError(null)
    setRetryKey((k) => k + 1)
  }, [])

  // Load the saved destination, then the top-level picker's options. The two
  // are independent requests deliberately: a settings read that works while the
  // picker's token is dead still shows what is configured.
  const { url: firstPickerUrl, label: firstPickerLabel, onLoad: onFirstPickerLoad } = firstPicker
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    // Read lazily, not captured: `readPicker` asks AFTER awaiting the body, by
    // which time a retry may have superseded this run.
    const isCancelled = () => cancelled
    setReconnectRequired(false)
    setLoadError(null)

    fetch(settingsUrl)
      .then((r) => readPicker(r, settingsLabel, isCancelled))
      .then((data) => {
        if (!cancelled && data) {
          setConfig((data.config ?? {}) as TConfig)
        }
      })
      .catch(() => {
        if (!cancelled) setLoadError(`Couldn't load ${settingsLabel}.`)
      })

    fetch(firstPickerUrl)
      .then((r) => readPicker(r, firstPickerLabel, isCancelled))
      .then((data) => {
        if (!cancelled && data) onFirstPickerLoad(data)
      })
      .catch(() => {
        if (!cancelled) setLoadError(`Couldn't load ${firstPickerLabel}.`)
      })

    return () => {
      cancelled = true
    }
  }, [
    enabled,
    retryKey,
    readPicker,
    settingsUrl,
    settingsLabel,
    firstPickerUrl,
    firstPickerLabel,
    onFirstPickerLoad,
  ])

  /**
   * PATCH the destination with optimistic UI + revert. `patch` is merged
   * server-side (read-modify-write), so a map-only save can't drop the project.
   *
   * `optimistic` replaces (rather than merges into) the local config for the
   * PATCHes whose server-side effect REMOVES keys — the destination clear, and
   * the switches that also drop what hung below the thing that moved.
   */
  // A plain function, not a useCallback: it closes over `config` to capture the
  // pre-save value for the revert, exactly as the three savers it replaces did,
  // and no effect depends on its identity.
  const save = async (patch: TPatch, optimistic?: TConfig) => {
    const previous = config
    setConfig(optimistic ?? ({ ...(previous ?? {}), ...(patch as object) } as TConfig))
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(settingsUrl, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      })
      if (res.ok) {
        if (adoptResponseConfig) {
          const body = (await res.json().catch(() => null)) as { config?: TConfig } | null
          // The server-derived part of the config only exists in this response.
          if (body?.config) setConfig(body.config)
        }
        // The "Push to…" menu caches this workspace's destinations, and it is
        // usually mounted right behind this page (the settings OVERLAY floats
        // above the capture whose rows carry it). This is the ONE funnel every
        // destination write passes through — project, map, attribution,
        // clear — so announcing here covers all of them, and the menu stops
        // insisting the provider is unconfigured the moment it becomes
        // configured.
        notifyTaskDestinationsChanged()
      } else {
        const body = await res.json().catch(() => ({}))
        setConfig(previous)
        if (reconnectOnSaveFailure && body?.code && TASK_PICKER_RECONNECT_CODES.has(body.code)) {
          // A save that could not verify the destination comes back as
          // `reconnect_required` and stores NOTHING — surface the banner
          // rather than a bare error, because retrying will not help.
          setReconnectRequired(true)
        } else {
          setError(body?.error ?? saveErrorMessage)
        }
      }
    } catch {
      setConfig(previous)
      setError(saveErrorMessage)
    } finally {
      setSaving(false)
    }
  }

  const reportLoadError = useCallback((message: string) => setLoadError(message), [])

  return {
    config,
    setConfig,
    saving,
    error,
    reconnectRequired,
    loadError,
    retryKey,
    setLoadError: reportLoadError,
    readPicker,
    retry,
    save,
  }
}

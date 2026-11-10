'use client'

/**
 * PERMISSIONS — the desktop-only "set up Native Intelligence on your computer" step
 * (Circleback-style): stacked permission cards that unlock in sequence —
 * microphone first, then system audio. The wizard's resume logic only ever
 * lands here inside the Tauri shell; on web the step is skipped entirely.
 *
 * Why it gates: a denied microphone is INVISIBLE to the capture pipeline
 * (macOS delivers zero-filled buffers and start_recording succeeds — see the
 * mic gate in use-recording.ts), so the one reliable moment to secure both
 * grants is before the user ever reaches the dashboard. Continue stays
 * disabled until each permission is granted or declared unsupported (desktop
 * builds without the permission commands, macOS without Core Audio taps) —
 * with a skip link that appears only after a denial, so nobody is ever
 * trapped mid-onboarding.
 *
 * Mechanics per card:
 *  • Microphone — checkMicPermission() is passive, so the card seeds from it
 *    and re-polls every 1.5s: a grant flipped directly in System Settings
 *    completes the card without another click. Allow →
 *    requestMicPermission(): shows the real OS prompt while not-determined;
 *    once denied macOS never re-prompts, so the command opens the Settings
 *    mic pane instead and the poll picks up the change.
 *  • System audio — checkSystemAudioPermission() is passive too (a TCC
 *    preflight for the Audio Capture service; it can never prompt), so this
 *    card seeds from it and re-polls every 1.5s exactly like the mic card.
 *    Allow → requestSystemAudioPermission(): the real OS prompt while
 *    not-determined; once denied macOS never re-prompts, so the command opens
 *    the Screen & System Audio Recording pane and the poll picks up the
 *    toggle. The request only ever runs from a click — never on mount or on
 *    the timer.
 *  • Old desktop builds reject the passive check. The card then keeps its old
 *    probe-only behaviour ("legacy"): no polling; Allow runs the legacy tap
 *    probe (creating a Core Audio tap is what raises the prompt there), and
 *    "Check again" re-probes after the user flips the toggle.
 *  • Windows: the mic is never prompted for, only turned on in Settings (the
 *    request command opens it), and there is no system-audio permission at
 *    all (the check says "not_applicable", which settles the card), so that
 *    card isn't shown.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowRight, Check, Loader2, Mic, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { clsx } from 'clsx'
import { tauriBridge } from '@/lib/tauri-bridge'
import { requestSystemAudioWithFallback } from '@/hooks/use-audio-permissions'
import { useDesktopOS } from '@/components/desktop-titlebar'
import { APP_IN_SYSTEM_SETTINGS } from '@/lib/desktop-app-name'

/** Where each permission ended up when the user continued — for analytics. */
export interface PermissionsOutcome {
  microphone: MicState
  systemAudio: SystemAudioState
  skipped: boolean
}

type MicState = 'checking' | 'not-determined' | 'denied' | 'granted' | 'unsupported'
type SystemAudioState =
  | 'checking'
  | 'idle'
  | 'requesting'
  | 'denied'
  | 'granted'
  | 'unsupported'

/** Map check_mic_permission's vocabulary onto card state. Unknown strings and
 *  rejections (command missing on pre-0.2.41 desktop builds) both resolve to
 *  'unsupported' — the card completes itself rather than blocking onboarding
 *  on a permission we cannot even ask for. */
function toMicState(status: string): MicState {
  switch (status) {
    case 'granted':
      return 'granted'
    case 'denied':
    case 'restricted':
      return 'denied'
    case 'not-determined':
      return 'not-determined'
    default:
      return 'unsupported'
  }
}

/** Map check_system_audio_permission's vocabulary onto card state.
 *  'unavailable' (the private TCC query is missing on this macOS) is idle, not
 *  a verdict: Allow still reaches the prompt / Settings pane through the
 *  request command. 'unsupported' is macOS < 14.4 (no Core Audio taps). Like
 *  the mic, anything unrecognised ('not_applicable' off macOS) completes the
 *  card rather than block onboarding on a permission we can't ask for.
 *  (Rejections are handled separately — they switch the card to legacy.) */
function toSystemAudioState(status: string): SystemAudioState {
  switch (status) {
    case 'granted':
      return 'granted'
    case 'denied':
      return 'denied'
    case 'not-determined':
    case 'unavailable':
      return 'idle'
    default:
      return 'unsupported'
  }
}

const settled = (state: MicState | SystemAudioState) =>
  state === 'granted' || state === 'unsupported'

export function PermissionsStep({
  onContinue,
  onResult,
  submitting,
}: {
  onContinue: (outcome: PermissionsOutcome) => void
  /** Fired once per user-visible permission outcome as it happens (every
   *  Allow / Check-again result, a grant detected via the Settings toggle, a
   *  permission already granted — or unsupported — at step entry) — the
   *  wizard forwards these to analytics so the funnel shows WHERE grants
   *  stall, not just the final states at Continue. */
  onResult?: (permission: 'microphone' | 'system_audio', result: string) => void
  submitting: boolean
}) {
  const [mic, setMic] = useState<MicState>('checking')
  const [micBusy, setMicBusy] = useState(false)
  const windows = useDesktopOS() === 'windows'
  const [system, setSystem] = useState<SystemAudioState>('checking')
  // The passive system-audio check REJECTED: a desktop build that predates it.
  // Latched — the card then behaves exactly as it did before the check
  // existed (see the header): no polling, and Allow runs the legacy probe.
  const [systemLegacy, setSystemLegacy] = useState(false)

  // Passive-transition telemetry (poll-driven, so it can't be reported at a
  // click site): already-granted at entry, granted-via-settings after a
  // denial, unsupported at entry. Click outcomes report inline in the
  // handlers; the prev-state guard keeps the two sources disjoint.
  const prevMicRef = useRef<MicState>('checking')
  useEffect(() => {
    const prev = prevMicRef.current
    prevMicRef.current = mic
    if (prev === mic) return
    if (prev === 'checking' && mic === 'granted') onResult?.('microphone', 'already-granted')
    else if (prev === 'checking' && mic === 'unsupported') onResult?.('microphone', 'unsupported')
    else if (prev === 'denied' && mic === 'granted') onResult?.('microphone', 'granted-via-settings')
  }, [mic, onResult])

  // Same passive transitions for system audio. Click outcomes pass through
  // 'requesting' first, so they never double-report here.
  const prevSystemRef = useRef<SystemAudioState>('checking')
  useEffect(() => {
    const prev = prevSystemRef.current
    prevSystemRef.current = system
    if (prev === system) return
    if (prev === 'checking' && system === 'granted') onResult?.('system_audio', 'already-granted')
    else if (prev === 'checking' && system === 'unsupported') onResult?.('system_audio', 'unsupported')
    else if (prev === 'denied' && system === 'granted') onResult?.('system_audio', 'granted-via-settings')
  }, [system, onResult])

  // ── Microphone: passive status poll ─────────────────────────
  // Seeds the card and keeps it live so a toggle flipped in System Settings
  // (the only recourse after a denial) completes the card automatically.
  // The poll is passive — it can never trigger an OS prompt.
  useEffect(() => {
    if (settled(mic)) return
    let cancelled = false
    const readStatus = async () => {
      try {
        const status = await tauriBridge.checkMicPermission()
        if (!cancelled)
          setMic((current) => {
            if (settled(current)) return current
            const next = toMicState(status)
            // A poll read initiated just before the user answered the OS
            // prompt can land in the same update batch as Allow's 'denied'
            // and misreport the mic as still undetermined — never downgrade
            // denied → not-determined. From 'denied', the poll's only job is
            // to detect the Settings-pane grant (→ 'granted').
            if (current === 'denied' && next === 'not-determined') return current
            return next
          })
      } catch {
        // Command not registered (old desktop build) — nothing to gate on.
        if (!cancelled) setMic('unsupported')
      }
    }
    void readStatus()
    const interval = setInterval(readStatus, 1500)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [mic])

  const handleMicAllow = useCallback(async () => {
    setMicBusy(true)
    try {
      // not-determined → the real OS prompt (blocks until answered);
      // denied → opens the System Settings mic pane (macOS never re-prompts).
      const result = await tauriBridge.requestMicPermission()
      onResult?.('microphone', result)
      if (result === 'granted') setMic('granted')
      else if (result === 'denied' || result === 'opened-settings') setMic('denied')
      else setMic('unsupported')
    } catch {
      onResult?.('microphone', 'error')
      setMic('unsupported')
    } finally {
      setMicBusy(false)
    }
  }, [onResult])

  // ── System audio: passive status poll ───────────────────────
  // Same job as the mic poll: seed the card, then catch a toggle flipped in
  // System Settings. Paused while a request is in flight (that answer lands
  // in handleSystemAllow) and off entirely in legacy mode.
  useEffect(() => {
    if (systemLegacy || settled(system) || system === 'requesting') return
    let cancelled = false
    const readStatus = async () => {
      try {
        const status = await tauriBridge.checkSystemAudioPermission()
        if (!cancelled)
          setSystem((current) => {
            if (settled(current) || current === 'requesting') return current
            const next = toSystemAudioState(status)
            // Same never-downgrade rule as the mic: from 'denied' the poll only
            // detects the Settings-pane grant; a stale read that still says
            // not-determined must not flip the card back to Allow.
            if (current === 'denied' && next === 'idle') return current
            return next
          })
      } catch {
        // Command not registered (old desktop build) → legacy mode.
        if (!cancelled) {
          setSystemLegacy(true)
          setSystem((current) => (current === 'checking' ? 'idle' : current))
        }
      }
    }
    void readStatus()
    const interval = setInterval(readStatus, 1500)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [system, systemLegacy])

  // ── System audio: request only on explicit user gesture ─────
  const handleSystemAllow = useCallback(async () => {
    setSystem('requesting')
    try {
      // Legacy: the probe, exactly as before — it creates+destroys a real Core
      // Audio tap, which shows the OS "Audio Capture" prompt the first time;
      // once denied it opens the Settings pane. Otherwise the real request
      // command (itself falling back to the probe should it reject): prompts
      // while not-determined, opens the Settings pane once denied.
      const result = systemLegacy
        ? await tauriBridge.requestScreenCapturePermission()
        : (await requestSystemAudioWithFallback()).result
      onResult?.('system_audio', result)
      if (result === 'granted') setSystem('granted')
      // 'opened-settings': already denied, so the pane opened — the poll
      // completes the card once the user flips the toggle.
      else if (result === 'denied' || result === 'opened-settings') setSystem('denied')
      else setSystem('unsupported')
    } catch {
      onResult?.('system_audio', 'error')
      setSystem('unsupported')
    }
  }, [onResult, systemLegacy])

  const micDone = settled(mic)
  const systemDone = settled(system)
  const ready = micDone && systemDone
  const anyDenied = mic === 'denied' || system === 'denied'

  // The skip link only ever appears after a denial — the happy path stays
  // gated, but a user who can't (or won't) flip a Settings toggle mid-flow is
  // never trapped. The recording-start gate still protects them later.
  const skippedRef = useRef(false)
  const finish = useCallback(
    (skipped: boolean) => {
      if (skippedRef.current) return
      skippedRef.current = true
      onContinue({ microphone: mic, systemAudio: system, skipped })
    },
    [onContinue, mic, system],
  )

  return (
    <div className="flex flex-col">
      <motion.h1
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        className="text-3xl font-bold tracking-tight"
      >
        Set up Native Intelligence on your computer
      </motion.h1>
      <motion.p
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.1 }}
        className="mt-2 text-muted-foreground"
      >
        {windows
          ? 'Native Intelligence needs access to your microphone to record meetings.'
          : 'Native Intelligence needs access to your microphone and system audio to record meetings.'}
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
        className="mt-8 space-y-3"
      >
        <PermissionCard
          icon={Mic}
          title="Allow microphone access"
          body={
            mic === 'denied'
              ? windows
                ? 'Microphone access is turned off in Settings → Privacy & security → Microphone. Turn on Microphone access and “Let desktop apps access your microphone”, and we’ll detect it here automatically.'
                : `Microphone access is turned off in System Settings. Flip the toggle for ${APP_IN_SYSTEM_SETTINGS} and we’ll detect it here automatically.`
              : 'Native Intelligence only uses your microphone while you’re recording a meeting.'
          }
          state={
            mic === 'granted'
              ? 'done'
              : mic === 'unsupported'
                ? 'skipped'
                : 'active'
          }
          action={
            mic === 'checking' ? null : (
              <Button size="sm" onClick={handleMicAllow} disabled={micBusy}>
                {micBusy && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                {mic === 'denied' ? (windows ? 'Open Settings' : 'Open System Settings') : 'Allow'}
              </Button>
            )
          }
        />

        {/* No system-audio permission on Windows: no card. */}
        {!windows && (
          <PermissionCard
            icon={Volume2}
            title="Allow system audio access"
            body={
              system === 'denied'
                ? systemLegacy
                  ? `System audio is blocked. Enable ${APP_IN_SYSTEM_SETTINGS} under Screen & System Audio Recording in System Settings, then check again.`
                  : `System audio is blocked. Enable ${APP_IN_SYSTEM_SETTINGS} under Screen & System Audio Recording in System Settings — we’ll detect it here automatically.`
                : 'Lets Native Intelligence hear the other people in your meetings — captured only while you’re recording.'
            }
            state={
              system === 'granted'
                ? 'done'
                : system === 'unsupported'
                  ? 'skipped'
                  : micDone
                    ? 'active'
                    : 'locked'
            }
            action={
              system === 'checking' ? null : (
                <Button
                  size="sm"
                  onClick={handleSystemAllow}
                  disabled={system === 'requesting'}
                >
                  {system === 'requesting' && (
                    <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                  )}
                  {system === 'denied'
                    ? systemLegacy
                      ? 'Check again'
                      : 'Open System Settings'
                    : 'Allow'}
                </Button>
              )
            }
          />
        )}
      </motion.div>

      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.3 }}
        className="mt-10 flex flex-col items-center gap-3"
      >
        <Button
          onClick={() => finish(false)}
          disabled={!ready || submitting}
          className="w-full"
          size="lg"
        >
          {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Continue
          {!submitting && <ArrowRight className="ml-2 h-4 w-4" />}
        </Button>
        {anyDenied && !ready && (
          <button
            type="button"
            onClick={() => finish(true)}
            className="text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            Skip for now — you can grant access later in Settings
          </button>
        )}
      </motion.div>
    </div>
  )
}

// ─── The stacked permission card ──────────────────────────────
// Four states, Circleback-style: locked (collapsed, waiting on the previous
// card), active (expanded with its body + action), done (check, collapsed),
// skipped (collapsed, quietly marked unavailable — old build or unsupported
// macOS; never blocks Continue).

function PermissionCard({
  icon: Icon,
  title,
  body,
  state,
  action,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  body: string
  state: 'locked' | 'active' | 'done' | 'skipped'
  action: React.ReactNode
}) {
  const collapsed = state !== 'active'
  return (
    <div
      className={clsx(
        'rounded-2xl border p-5 transition-colors',
        state === 'active' && 'border-foreground/60 bg-secondary/60',
        state === 'locked' && 'border-border opacity-50',
        (state === 'done' || state === 'skipped') && 'border-border',
      )}
    >
      <div className="flex items-center gap-3">
        <Icon className="h-5 w-5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 font-medium text-foreground">
          {title}
          {state === 'skipped' && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              unavailable on this build
            </span>
          )}
        </span>
        {state === 'done' && (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-foreground">
            <Check className="h-3 w-3 text-background" />
          </span>
        )}
      </div>
      {!collapsed && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="overflow-hidden"
        >
          <p className="mt-2 text-sm text-muted-foreground">{body}</p>
          <div className="mt-4 flex justify-end">{action}</div>
        </motion.div>
      )}
    </div>
  )
}

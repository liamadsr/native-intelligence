'use client'

/**
 * Desktop set-up that needs no choice from the user. Runs the local-modules
 * keeper (lib/local-modules-keeper.ts), which sets up on-device speech on its
 * own with nothing to choose and nothing shown. Mounted with the /account providers, so it starts the moment
 * a new user reaches onboarding and keeps going through the dashboard and
 * settings.
 *
 * One window runs it at a time. The first window to mount takes a Web Lock;
 * any other window waits for the lock and takes over when that window closes.
 * Without Web Locks (older WebKit), every window runs one. The desktop's
 * commands are idempotent, so that only costs a duplicate retry.
 *
 * A capture in any window holds new downloads back: this window's own
 * recording state, plus the capture quiet-lock every recording window holds
 * (lib/sounds/quiet.ts), checked every few seconds.
 *
 * It also turns echo cancellation and meeting detection back on where an
 * older Settings switch turned them off. Neither is a choice any more
 * (Liam, 2026-10-08): a capture runs echo cancellation whenever system audio
 * is captured, and detection always runs (Auto-record decides whether a
 * detected meeting records by itself or asks first).
 *
 * Telemetry (lib/speech-diagnostics.ts): every desktop window registers the
 * Mac and app version as PostHog super properties, so every event can be
 * broken down by macOS version and chip. The window running the keeper also
 * sends one `local_modules_status` snapshot per launch, keeps the person's
 * `local_*_state` properties current, and attaches the module's own log lines
 * to a failure.
 *
 * It also hands Read anywhere the read-aloud voice once per window, which
 * keeps a voice picked before the two shared one (2026-10-22) in step
 * (lib/read-aloud/read-anywhere-voice.ts).
 *
 * Every window also answers Read anywhere's text from a chat or mail app with
 * who said what (lib/read-aloud/read-anywhere-chat.ts); the desktop takes the
 * first answer.
 *
 * Renders nothing.
 */

import { useEffect, useRef } from 'react'
import { usePostHog } from 'posthog-js/react'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { isDesktopApp } from '@/lib/platform'
import { listLocalModules } from '@/lib/local-modules'
import { LocalModulesKeeper } from '@/lib/local-modules-keeper'
import { desktopContext, logTail, modulePropKey, snapshotProps } from '@/lib/speech-diagnostics'
import { refreshVoiceStatus } from '@/lib/voice/status-store'
import { syncReadAnywhereVoice } from '@/lib/read-aloud/read-anywhere-voice'
import { answerReadAnywhereChats } from '@/lib/read-aloud/read-anywhere-chat'
import { isLockHeld } from '@/lib/sounds/cross-window'
import { QUIET_LOCK_PREFIX } from '@/lib/sounds/quiet'
import { tauriBridge } from '@/lib/tauri-bridge'
import { listenScoped } from '@/lib/tauri-unlisten'

const LOCK_NAME = 'ni:local-modules-keeper'
/** Keeper events that get the module's last log lines attached. */
const WITH_LOG_TAIL = new Set(['local_module_failed', 'local_module_unavailable', 'local_module_retries_exhausted'])

/** Held by every window while its capture records (recording-context.tsx). */
const CAPTURE_LOCK_PREFIX = `${QUIET_LOCK_PREFIX}capture:`
const CAPTURE_POLL_MS = 5_000

interface LockManagerLike {
  request(name: string, options: { signal?: AbortSignal }, callback: () => Promise<void>): Promise<unknown>
}

function lockManager(): LockManagerLike | null {
  if (typeof navigator === 'undefined') return null
  const lm = (navigator as unknown as { locks?: LockManagerLike }).locks
  return lm && typeof lm.request === 'function' ? lm : null
}

export function DesktopSetupMount() {
  const recordingCtx = useOptionalRecordingStable()
  const recording = !!(recordingCtx?.isRecording || recordingCtx?.isStarting)
  const recordingRef = useRef(recording)
  recordingRef.current = recording
  /** A capture recording in another window (its quiet-lock). */
  const elsewhereRef = useRef(false)
  const keeperRef = useRef<LocalModulesKeeper | null>(null)
  const posthog = usePostHog()
  const posthogRef = useRef(posthog)
  posthogRef.current = posthog

  // The Mac and app version on every event from this window.
  useEffect(() => {
    if (!isDesktopApp()) return
    let cancelled = false
    void desktopContext().then((context) => {
      if (!cancelled) posthogRef.current?.register(context)
    })
    return () => {
      cancelled = true
    }
  }, [])

  // Read anywhere reads in the read-aloud voice.
  useEffect(() => {
    void syncReadAnywhereVoice()
  }, [])

  // Read anywhere in Teams, Outlook, Slack or Discord: who said what.
  useEffect(() => answerReadAnywhereChats(), [])

  useEffect(() => {
    if (!isDesktopApp()) return
    let cancelled = false
    let keeper: LocalModulesKeeper | null = null

    /** A keeper event to PostHog: the person's `<module>_state` follows it,
     *  and a failure carries the module's own last log lines. */
    const track = (event: string, props: Record<string, unknown>) => {
      const id = typeof props.module === 'string' ? props.module : null
      const person =
        id && typeof props.state === 'string'
          ? {
              $set: {
                [`${modulePropKey(id)}_state`]: props.state,
                ...(event === 'local_module_failed' || event === 'local_module_unavailable'
                  ? { [`${modulePropKey(id)}_error`]: props.error ?? props.reason ?? null }
                  : {}),
                ...(event === 'local_module_ready' ? { [`${modulePropKey(id)}_error`]: null } : {}),
              },
            }
          : {}
      if (id && WITH_LOG_TAIL.has(event)) {
        void logTail(id).then((tail) => {
          posthogRef.current?.capture(event, { ...props, ...person, log_tail: tail })
        })
        return
      }
      posthogRef.current?.capture(event, { ...props, ...person })
    }
    let capturePoll: ReturnType<typeof setInterval> | null = null

    const pollCaptures = () => {
      void isLockHeld(CAPTURE_LOCK_PREFIX).then((held) => {
        if (cancelled) return
        elsewhereRef.current = held
        keeper?.setRecording(recordingRef.current || held)
      })
    }

    const lead = () => {
      // Desktops without the echo setting reject both: nothing to undo there.
      void Promise.resolve()
        .then(() => tauriBridge.getEchoCancellationInCaptures())
        .then((on) => (on === false ? tauriBridge.setEchoCancellationInCaptures(true) : undefined))
        .catch(() => {})
      // Meeting detection is always on too: Auto-record decides whether a
      // detected meeting records by itself or asks first.
      void Promise.resolve()
        .then(() => tauriBridge.getMeetingDetectionState())
        .then((s) => (s && s.isEnabled === false ? tauriBridge.enableMeetingDetection(true) : undefined))
        .catch(() => {})
      keeper = new LocalModulesKeeper({
        list: listLocalModules,
        enable: (id) => tauriBridge.moduleEnable(id),
        disable: (id) => tauriBridge.moduleDisable(id),
        onStatus: (cb) => listenScoped((gate) => tauriBridge.onModuleStatus(gate(cb))),
        onOnline: (cb) => {
          window.addEventListener('online', cb)
          return () => window.removeEventListener('online', cb)
        },
        now: () => Date.now(),
        track,
      })
      keeper.setRecording(recordingRef.current || elsewhereRef.current)
      keeper.start()
      keeperRef.current = keeper
      // Where this Mac's speech models stand at launch, once per launch.
      void Promise.all([listLocalModules(), refreshVoiceStatus().catch(() => null)]).then(([modules, voice]) => {
        if (cancelled) return
        posthogRef.current?.capture('local_modules_status', snapshotProps(modules, voice))
      })
      pollCaptures()
      capturePoll = setInterval(pollCaptures, CAPTURE_POLL_MS)
    }

    const locks = lockManager()
    if (!locks) {
      lead()
      return () => {
        cancelled = true
        if (capturePoll) clearInterval(capturePoll)
        keeper?.stop()
        keeperRef.current = null
      }
    }

    // Hold the lock for as long as this window runs the keeper.
    const abort = new AbortController()
    let release: (() => void) | null = null
    void locks
      .request(LOCK_NAME, { signal: abort.signal }, () => {
        if (cancelled) return Promise.resolve()
        lead()
        return new Promise<void>((resolve) => {
          release = resolve
        })
      })
      .catch(() => {
        /* aborted while waiting (this window unmounted), or no lock: nothing to run */
      })

    return () => {
      cancelled = true
      abort.abort()
      if (capturePoll) clearInterval(capturePoll)
      keeper?.stop()
      keeperRef.current = null
      release?.()
    }
  }, [])

  // A capture holds new downloads back; its end lets them go.
  useEffect(() => {
    keeperRef.current?.setRecording(recording || elsewhereRef.current)
  }, [recording])

  return null
}

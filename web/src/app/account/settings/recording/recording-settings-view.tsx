'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { isDesktopApp } from '@/lib/platform'
import { isLowerEnvironment } from '@/lib/app-env'
import {
  tauriBridge,
  type AudioLevelPayload,
  type MeetingDetectionStatus,
} from '@/lib/tauri-bridge'
import { disposeAll, listenScoped } from '@/lib/tauri-unlisten'
import {
  DeepgramStreamingService,
  TranscriptMerger,
  type TranscriptSegment,
} from '@/lib/deepgram-stream'
import {
  localFallbackMessage,
  prepareLocalTranscription,
  shiftSegmentTime,
  trackLocalFallback,
  type LocalTranscriptionService,
} from '@/lib/local-transcription'
import { LOCAL_STT_MODULE_ID } from '@/lib/local-modules'
import { useLocalModule } from '@/hooks/use-local-module'
import { LocalModuleLink, LocalModuleRow } from '@/components/desktop/local-module-row'
import { toast } from 'sonner'
import { VoiceIdService, type SpeakerIdentification, type AutoAcceptDelay, type TrustTier, getTrustTier, getTrustTierLabel, getNextTierThreshold } from '@/lib/voice-id-service'
import { SpeakerContactSearch } from '@/components/desktop/speaker-contact-search'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
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
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { AudioLevelMeter } from '@/components/desktop/audio-level-meter'
import { AudioPermissionsPanel } from '@/components/desktop/audio-permissions-panel'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Monitor, Phone, Radio, Play, Square, FlaskConical, AlertCircle, UserRound, CircleHelp, Check, Link2, AlertTriangle, RotateCcw, Timer, AudioLines } from 'lucide-react'

// The local-stt models' licenses — the same pages the desktop's bundled
// notices link (dial8-desktop sidecars/local-stt/build.sh). The desktop
// downloads the models straight from NVIDIA's Hugging Face repos.
const NVIDIA_OPEN_MODEL_LICENSE_URL =
  'https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/'
const OPENMDW_LICENSE_URL = 'https://openmdw.ai/license/1-1/'

export function RecordingSettingsView() {
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null)
  const [detectionStatus, setDetectionStatus] =
    useState<MeetingDetectionStatus | null>(null)
  // On-device transcription module. `supported` only inside a desktop build
  // that ships it (modules_list includes local-stt) — otherwise no row at all.
  const localStt = useLocalModule(LOCAL_STT_MODULE_ID)


  // Defer platform check to client to avoid hydration mismatch
  useEffect(() => {
    setIsDesktop(isDesktopApp())
    // No Voice ID preload here. Merely visiting this settings page used to pull
    // the ~100MB WavLM model into a Web Worker (and, unlike the dashboard's old
    // preload, without even an isDesktopApp() gate — so web visitors paid it
    // too). The only things on this page that need the model are the
    // lower-environment test recorder below, which builds its own
    // VoiceIdService and calls initialize() on an explicit click, and real
    // recording — both load it lazily at that point.

    // Fetch enrolled contacts for quality indicator
    const fetchEnrollments = () => fetch('/api/account/voice-enrollments')
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.enrollments) {
          setEnrolledContacts(data.enrollments.map((e: any) => ({
            contactId: e.contactId,
            contactName: e.contactName,
            enrollmentCount: e.enrollmentCount,
            confirmationCount: e.confirmationCount ?? 0,
            totalEnrollmentCount: e.totalEnrollmentCount ?? e.enrollmentCount,
            correctionCount: e.correctionCount ?? 0,
          })))
        }
      })
      .catch(() => { /* silent — not critical */ })
    fetchEnrollments()
  }, [])

  // Load initial state
  useEffect(() => {
    if (!isDesktop) return

    tauriBridge.getMeetingDetectionState().then((s) => {
      console.log('[recording-settings] detection state:', s)
      setDetectionStatus(s)
    }).catch((e) => {
      console.error('[recording-settings] getMeetingDetectionState failed:', e)
      setDetectionStatus({
        state: 'monitoring',
        detectedApp: null,
        // Must match the desktop AppSettings defaults (auto-record is opt-in)
        isAutoRecord: false,
        isEnabled: true,
      })
    })
  }, [isDesktop])

  // Listen for meeting detection events to update status in real-time
  useEffect(() => {
    if (!isDesktop) return

    return disposeAll(
      listenScoped((gate) => tauriBridge.onMeetingDetected(gate((app) => {
        setDetectionStatus((prev) =>
          prev ? { ...prev, state: 'detected', detectedApp: app } : null,
        )
      }))),
      listenScoped((gate) => tauriBridge.onMeetingAutoStart(gate((app) => {
        // Auto-start parks in 'detected' during the cancellable HUD countdown;
        // the poll below surfaces the real transition to 'recording' once the
        // capture actually starts.
        setDetectionStatus((prev) =>
          prev ? { ...prev, state: 'detected', detectedApp: app } : null,
        )
      }))),
      listenScoped((gate) => tauriBridge.onMeetingEnded(gate(() => {
        setDetectionStatus((prev) =>
          prev ? { ...prev, state: 'monitoring', detectedApp: null } : null,
        )
      }))),
    )
  }, [isDesktop])

  // The events above don't cover every native transition (e.g. a stale HUD
  // auto-dismissing emits nothing), so refresh the status pill on a slow
  // poll while the page is open. get_meeting_detection_state is a pure
  // in-memory state read on the Rust side — it never touches audio.
  useEffect(() => {
    if (!isDesktop) return
    const id = setInterval(() => {
      tauriBridge
        .getMeetingDetectionState()
        .then(setDetectionStatus)
        .catch(() => {})
    }, 5000)
    return () => clearInterval(id)
  }, [isDesktop])

  const handleAutoRecordToggle = useCallback(async (enabled: boolean) => {
    try {
      await tauriBridge.setAutoRecord(enabled)
      setDetectionStatus((prev) =>
        prev ? { ...prev, isAutoRecord: enabled } : null,
      )
    } catch (e) {
      console.error('Failed to toggle auto-record:', e)
    }
  }, [])

  // ── Recording Test State (lower-environment diagnostic harness) ──────

  // Speaker identification — maps speaker IDs (e.g. "local_1", "remote_2") to user-assigned names
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({})

  // Voice ID — maps speaker IDs to linked CRM contacts
  const [speakerContacts, setSpeakerContacts] = useState<Record<string, SpeakerIdentification>>({})
  const [voiceIdReady, setVoiceIdReady] = useState(false)
  const voiceIdRef = useRef<VoiceIdService | null>(null)

  // Enrolled contacts — for quality indicator display
  const [enrolledContacts, setEnrolledContacts] = useState<{
    contactId: string; contactName: string; enrollmentCount: number;
    confirmationCount: number; totalEnrollmentCount: number; correctionCount: number;
  }[]>([])

  const refreshEnrolledContacts = useCallback(() => {
    fetch('/api/account/voice-enrollments')
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data?.enrollments) {
          setEnrolledContacts(data.enrollments.map((e: any) => ({
            contactId: e.contactId,
            contactName: e.contactName,
            enrollmentCount: e.enrollmentCount,
            confirmationCount: e.confirmationCount ?? 0,
            totalEnrollmentCount: e.totalEnrollmentCount ?? e.enrollmentCount,
            correctionCount: e.correctionCount ?? 0,
          })))
        }
      })
      .catch(() => { /* silent — not critical */ })
  }, [])

  // Reset confirmation dialog state
  const [resetContactId, setResetContactId] = useState<string | null>(null)
  const resetContactName = enrolledContacts.find((c) => c.contactId === resetContactId)?.contactName ?? ''

  // Auto-accept delay setting (persisted in localStorage)
  const [autoAcceptDelay, setAutoAcceptDelay] = useState<AutoAcceptDelay>(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('voiceId.autoAcceptDelay')
      if (stored === '5' || stored === '10' || stored === '15' || stored === '0') return Number(stored) as AutoAcceptDelay
    }
    return 10
  })

  // Post-session review state. Embeddings for auto-assigned speakers are
  // HELD here — enrollment + confirmation only happen on explicit confirm.
  const [postSessionReview, setPostSessionReview] = useState<{
    sessionId: string
    autoAssigned: { speakerId: string; contactId: string; contactName: string; confidence: number; trustTier: TrustTier; speakingDurationSec: number; embeddings: number[][] }[]
  } | null>(null)

  // Auto-accept countdown timers for 'recognizing' tier suggestions
  const autoAcceptTimers = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map())

  const [isRecording, setIsRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [levels, setLevels] = useState<AudioLevelPayload>({
    micLevel: 0,
    systemLevel: 0,
    timestamp: 0,
  })
  const [transcriptSegments, setTranscriptSegments] = useState<TranscriptSegment[]>([])
  const [recordingError, setRecordingError] = useState<string | null>(null)
  const [recordingResult, setRecordingResult] = useState<{
    sessionId: string
    micFile: string | null
    systemFile: string | null
    durationSeconds: number
  } | null>(null)

  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const transcriptEndRef = useRef<HTMLDivElement>(null)
  // Deepgram, or the on-device engine when local-stt is on (see handleStartRecording).
  const transcriptionServiceRef = useRef<DeepgramStreamingService | LocalTranscriptionService | null>(null)
  const mergerRef = useRef<TranscriptMerger>(new TranscriptMerger())

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [transcriptSegments])

  // Listen for audio levels while recording
  useEffect(() => {
    if (!isDesktop || !isRecording) return

    return listenScoped((gate) => tauriBridge.onAudioLevel(gate((level) => {
      setLevels(level)
    })))
  }, [isDesktop, isRecording])

  const handleStartRecording = useCallback(async () => {
    setRecordingError(null)
    setRecordingResult(null)
    setTranscriptSegments([])
    setSpeakerNames({})
    setSpeakerContacts({})
    mergerRef.current.clear()
    setElapsed(0)

    // A local engine subscribed for this start, until it is published (so the
    // catch below can drop its listeners if the start fails).
    let pendingLocal: LocalTranscriptionService | null = null

    try {
      // Clean up any stale recording state from a previous session/crash
      const status = await tauriBridge.getStatus()
      if (status === 'recording') {
        try { await tauriBridge.stopRecording() } catch { /* ignore */ }
      }

      // Segment sinks for whichever engine runs.
      // Wire onFinalSegment to the Voice ID service for speaker matching
      const onSegment = (segment: TranscriptSegment) => {
        const merged = mergerRef.current.addSegment(segment)
        setTranscriptSegments(merged)
      }
      const onFinalSegment = (finalSegment: TranscriptSegment) => {
        voiceIdRef.current?.onFinalSegment(finalSegment)
      }

      // Engine selection, as in a real recording (use-recording.ts): with the
      // local-stt module enabled + ready, the on-device engine — subscribed
      // BEFORE start_recording, no Deepgram token. Otherwise Deepgram.
      const localPrep = await prepareLocalTranscription(onSegment, onFinalSegment)
      pendingLocal = localPrep.service

      // Start audio capture in the Rust backend
      const session = await tauriBridge.startRecording({
        captureSystemAudio: true,
        ...(localPrep.service ? { transcription: 'local' as const } : {}),
      })

      // Fetch a short-lived Deepgram token from our API (master key stays
      // server-side) and start Deepgram streaming (connects WebSockets, wires
      // Tauri events). `timeOffsets` places a local engine's fallback after
      // the local segments (see shiftSegmentTime).
      const startDeepgram = async (timeOffsets?: Record<'mic' | 'system', number>) => {
        const tokenRes = await fetch('/api/deepgram-token', { method: 'POST' })
        if (!tokenRes.ok) {
          const err = await tokenRes.json().catch(() => ({ error: 'Unknown error' }))
          throw new Error(err.error || `Token fetch failed (${tokenRes.status})`)
        }
        const { token: deepgramToken } = await tokenRes.json()

        const service = new DeepgramStreamingService(
          timeOffsets ? (segment) => onSegment(shiftSegmentTime(segment, timeOffsets[segment.stream])) : onSegment,
          timeOffsets ? (segment) => onFinalSegment(shiftSegmentTime(segment, timeOffsets[segment.stream])) : onFinalSegment,
        )
        service.getUsageAuthHeader = async () => {
          try {
            const { createClient } = await import('@/lib/supabase/client')
            const supabase = createClient()
            const { data } = await supabase.auth.getSession()
            const token = data.session?.access_token
            return token ? `Bearer ${token}` : null
          } catch {
            return null
          }
        }
        await service.start(deepgramToken)
        return service
      }

      let service: DeepgramStreamingService | LocalTranscriptionService
      const local = localPrep.service && session.transcriptionEngine === 'local' ? localPrep.service : null
      if (local) {
        local.start(session.sessionId)
        service = local
        transcriptionServiceRef.current = local
        pendingLocal = null
        // Engine failed → Deepgram for the rest of the test (a token refusal
        // leaves the test recording without a transcript, like a failed start).
        local.setFallbackHandler((reason, phase) => {
          void (async () => {
            if (transcriptionServiceRef.current !== local) return
            const timeOffsets = { mic: local.getAudioSeconds('mic'), system: local.getAudioSeconds('system') }
            void local.stop({ drainTail: false })
            trackLocalFallback(reason, phase, { source: 'settings_test' })
            toast.info(localFallbackMessage(phase))
            try {
              const fallback = await startDeepgram(timeOffsets)
              if (transcriptionServiceRef.current !== local) {
                fallback.stop()
                return
              }
              fallback.onAudioData = local.onAudioData
              transcriptionServiceRef.current = fallback
            } catch (fallbackErr) {
              if (transcriptionServiceRef.current !== local) return
              setRecordingError(fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr))
            }
          })()
        })
      } else {
        if (localPrep.service) {
          // The desktop answered Deepgram — or the module wasn't usable after all.
          void localPrep.service.stop({ drainTail: false })
          pendingLocal = null
        }
        const fallbackReason = localPrep.service
          ? session.transcriptionFallbackReason || 'desktop_declined'
          : localPrep.fallbackReason
        if (fallbackReason) {
          trackLocalFallback(fallbackReason, 'start', { source: 'settings_test' })
          toast.info(localFallbackMessage('start'))
        }
        service = await startDeepgram()
        transcriptionServiceRef.current = service
      }

      setIsRecording(true)
      timerRef.current = setInterval(() => setElapsed((e) => e + 1), 1000)

      // Initialize Voice ID in background — don't block recording start.
      // Model load takes 1-2s even when cached. Recording + transcription
      // start immediately; Voice ID catches up once the model is ready.
      const voiceId = new VoiceIdService()
      voiceId.autoAcceptDelaySec = autoAcceptDelay
      voiceId.onSpeakerIdentified = (speakerId, contactId, contactName, confidence, isAutoMatched) => {
        setSpeakerContacts((prev) => ({
          ...prev,
          [speakerId]: { contactId, contactName, confidence, isAutoMatched },
        }))
        setSpeakerNames((prev) => ({ ...prev, [speakerId]: contactName }))
      }
      voiceId.onSpeakerSuggested = (speakerId, contactId, contactName, confidence) => {
        const identification = voiceId.getIdentification(speakerId)
        const hasCountdown = identification?.autoAcceptCountdown != null
        setSpeakerContacts((prev) => ({
          ...prev,
          [speakerId]: {
            contactId, contactName, confidence, isAutoMatched: false,
            isSuggestion: true, trustTier: identification?.trustTier,
            autoAcceptCountdown: identification?.autoAcceptCountdown,
            isLearningMatch: identification?.isLearningMatch,
          },
        }))

        // Start auto-accept countdown for 'recognizing' tier
        if (hasCountdown) {
          let remaining = identification!.autoAcceptCountdown!
          const timer = setInterval(() => {
            remaining--
            if (remaining <= 0) {
              clearInterval(timer)
              autoAcceptTimers.current.delete(speakerId)
              // Countdown expiry is NOT a human confirmation — flagged
              // 'auto' so it goes through post-session review.
              voiceIdRef.current?.acceptSuggestion(speakerId, { viaTimeout: true })
              setSpeakerContacts((prev) => {
                const existing = prev[speakerId]
                if (!existing?.isSuggestion) return prev
                return {
                  ...prev,
                  [speakerId]: { ...existing, isSuggestion: false, isAutoMatched: false },
                }
              })
              setSpeakerNames((prev) => ({ ...prev, [speakerId]: contactName }))
            } else {
              setSpeakerContacts((prev) => {
                const existing = prev[speakerId]
                if (!existing?.isSuggestion) return prev
                return { ...prev, [speakerId]: { ...existing, autoAcceptCountdown: remaining } }
              })
            }
          }, 1000)
          autoAcceptTimers.current.set(speakerId, timer)
        }
      }

      // Wire audio data from Deepgram's existing listeners to Voice ID ring buffers.
      // This avoids creating duplicate Tauri listeners that add main-thread overhead.
      service.onAudioData = (stream, bytes) => {
        voiceIdRef.current?.feedAudio(stream, bytes)
      }

      // Publish the service BEFORE initialize(). The model load takes 1-2s, and
      // a stop inside that window used to find voiceIdRef.current still null —
      // so stop() never ran on this service, its `stopped` latch was never set,
      // and the late-resolving initialize() happily claimed a live ~100MB worker
      // onto a dead service (nothing left to terminate it) and re-published
      // window.__voiceId after the user had already stopped. Owning the ref up
      // front is what lets handleStopRecording reach stop() and set that latch.
      // The service is inert until the model lands (feedAudio just fills ring
      // buffers, onFinalSegment no-ops without a worker), so publishing early is
      // safe; only the UI-visible `voiceIdReady` waits for a real load.
      voiceIdRef.current = voiceId
      ;(window as any).__voiceId = voiceId

      voiceId.initialize()
        .then(() => voiceId.loadEnrollments())
        .then(() => {
          // Stopped (or superseded by a newer recording) while the model
          // loaded: the ref no longer points at us, so claim nothing and —
          // crucially — do NOT re-publish the console handle. stop() has
          // already terminated the worker via the latch.
          if (voiceIdRef.current !== voiceId) return
          setVoiceIdReady(true)
          console.log('[recording-test] Voice ID ready — use window.__voiceId.getStats() in console')
        })
        .catch((voiceIdErr) => {
          console.warn('[recording-test] Voice ID failed to initialize:', voiceIdErr)
          if (voiceIdRef.current !== voiceId) return
          voiceIdRef.current = null
          delete (window as any).__voiceId
          setVoiceIdReady(false)
        })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[recording-test] start failed:', msg)
      setRecordingError(msg)
      // Clean up if partially started
      try { await tauriBridge.stopRecording() } catch { /* ignore */ }
      void transcriptionServiceRef.current?.stop()
      transcriptionServiceRef.current = null
      void pendingLocal?.stop({ drainTail: false })
      voiceIdRef.current?.stop()
      voiceIdRef.current = null
      // The console debug handle pins the service (and its ~7.7MB of ring
      // buffers) for the life of the page — drop it with the ref.
      delete (window as any).__voiceId
      setVoiceIdReady(false)
    }
  }, [autoAcceptDelay])

  const handleStopRecording = useCallback(async () => {
    try {
      // Native stop FIRST: it joins the batched PCM emitter threads
      // (dial8-desktop session.rs), flushing the ~120ms audio tail through the
      // still-armed listeners into Deepgram/voice-ID before we close them —
      // stopping Deepgram first would clip the last word's tail.
      const result = await tauriBridge.stopRecording()

      // A local engine keeps listening until the desktop signals the tail of
      // the transcript is out (stt://finished, ≤5s); Deepgram stops at once.
      const stopping = transcriptionServiceRef.current?.stop()
      transcriptionServiceRef.current = null
      if (stopping) await stopping

      // Clean up auto-accept timers
      for (const timer of autoAcceptTimers.current.values()) {
        clearInterval(timer)
      }
      autoAcceptTimers.current.clear()

      // Collect Voice ID assignments before stopping
      const voiceId = voiceIdRef.current
      const assignments = voiceId?.getAssignments() || []
      voiceId?.stop()
      voiceIdRef.current = null
      // The console debug handle pins the stopped service (and its ~7.7MB of
      // ring buffers) for the life of the page — drop it with the ref.
      delete (window as any).__voiceId
      setVoiceIdReady(false)
      setIsRecording(false)
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
      setLevels({ micLevel: 0, systemLevel: 0, timestamp: 0 })
      setRecordingResult({
        sessionId: result.sessionId,
        micFile: result.micFile,
        systemFile: result.systemFile,
        durationSeconds: result.durationSeconds,
      })

      // Persist voice enrollments in background — HUMAN-CONFIRMED speakers
      // only (manual assignment or explicitly accepted suggestion). Auto-
      // matches are held for post-session review; a match must never
      // confirm itself.
      if (assignments.length > 0) {
        const humanConfirmed = assignments.filter((a) => a.shouldConfirm)
        const enrollmentsToSave = humanConfirmed.flatMap((a) =>
          a.embeddings.map((embedding) => ({
            contact_id: a.contactId,
            embedding,
            session_id: result.sessionId,
          })),
        )
        // One confirmation per contact — merged speaker labels must not
        // double-increment trust for the same person.
        const confirmationsToSave = Array.from(
          new Set(humanConfirmed.map((a) => a.contactId)),
        ).map((contactId) => ({ contact_id: contactId }))

        if (enrollmentsToSave.length > 0 || confirmationsToSave.length > 0) {
          fetch('/api/account/voice-enrollments', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              enrollments: enrollmentsToSave,
              confirmations: confirmationsToSave,
            }),
          }).catch((err) => console.warn('[recording-test] Failed to save voice enrollments:', err))
        }

        // Save speaker-to-contact assignments for this capture
        fetch(`/api/account/captures/${result.sessionId}/speaker-assignments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            assignments: assignments.map((a) => ({
              speaker_label: a.speakerId,
              contact_id: a.contactId,
              contact_name: a.contactName,
              voice_match_confidence: a.confidence,
            })),
          }),
        }).catch((err) => console.warn('[recording-test] Failed to save speaker assignments:', err))

        // Auto-assigned speakers go to review with their embeddings held —
        // saved only if the user confirms or reassigns them.
        const autoAssigned = assignments
          .filter((a) => !a.shouldConfirm)
          .map((a) => ({
            speakerId: a.speakerId,
            contactId: a.contactId,
            contactName: a.contactName,
            confidence: a.confidence,
            trustTier: a.trustTier ?? ('unrecognized' as TrustTier),
            speakingDurationSec: a.speakingDurationSec,
            embeddings: a.embeddings,
          }))
        if (autoAssigned.length > 0) {
          setPostSessionReview({ sessionId: result.sessionId, autoAssigned })
        }

        // Refresh enrollment quality display after saving
        fetch('/api/account/voice-enrollments')
          .then((res) => res.ok ? res.json() : null)
          .then((data) => {
            if (data?.enrollments) {
              setEnrolledContacts(data.enrollments.map((e: any) => ({
                contactId: e.contactId,
                contactName: e.contactName,
                enrollmentCount: e.enrollmentCount,
                confirmationCount: e.confirmationCount ?? 0,
                totalEnrollmentCount: e.totalEnrollmentCount ?? e.enrollmentCount,
                correctionCount: e.correctionCount ?? 0,
              })))
            }
          })
          .catch(() => { /* silent */ })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      console.error('[recording-test] stop failed:', msg)
      setRecordingError(msg)
    }
  }, [])

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    return `${m}:${s.toString().padStart(2, '0')}`
  }

  // ── Speaker display helpers ──────────────────────────────────

  /** Distinct colors for up to 8 speakers */
  const speakerColors: { bg: string; text: string }[] = [
    { bg: 'bg-blue-100 dark:bg-blue-900', text: 'text-blue-700 dark:text-blue-300' },
    { bg: 'bg-purple-100 dark:bg-purple-900', text: 'text-purple-700 dark:text-purple-300' },
    { bg: 'bg-emerald-100 dark:bg-emerald-900', text: 'text-emerald-700 dark:text-emerald-300' },
    { bg: 'bg-amber-100 dark:bg-amber-900', text: 'text-amber-700 dark:text-amber-300' },
    { bg: 'bg-rose-100 dark:bg-rose-900', text: 'text-rose-700 dark:text-rose-300' },
    { bg: 'bg-cyan-100 dark:bg-cyan-900', text: 'text-cyan-700 dark:text-cyan-300' },
    { bg: 'bg-indigo-100 dark:bg-indigo-900', text: 'text-indigo-700 dark:text-indigo-300' },
    { bg: 'bg-pink-100 dark:bg-pink-900', text: 'text-pink-700 dark:text-pink-300' },
  ]

  /** Get a stable color index for a speaker ID */
  const speakerColorIndex = (speaker: string): number => {
    // local speakers get even indices, remote get odd — visually distinct
    const num = parseInt(speaker.replace(/\D/g, '') || '1', 10) - 1
    if (speaker.startsWith('local')) return (num * 2) % speakerColors.length
    return (num * 2 + 1) % speakerColors.length
  }

  /** Get display name — user-assigned name or default label */
  const speakerDisplayName = (speaker: string): string => {
    if (speakerNames[speaker]) return speakerNames[speaker]
    // Default: "You" for local_1, "Speaker 2 (local)" for local_2+, "Remote 1" for remote_*
    if (speaker === 'local_1') return 'You'
    if (speaker.startsWith('local_')) {
      const num = speaker.replace('local_', '')
      return `Local ${num}`
    }
    if (speaker.startsWith('remote_')) {
      const num = speaker.replace('remote_', '')
      return `Remote ${num}`
    }
    return speaker
  }

  /** Get all unique speakers seen in the transcript */
  const detectedSpeakers = Array.from(
    new Set(transcriptSegments.filter((s) => s.isFinal).map((s) => s.speaker)),
  ).sort((a, b) => {
    // local first, then remote, sorted by number
    const aLocal = a.startsWith('local')
    const bLocal = b.startsWith('local')
    if (aLocal !== bLocal) return aLocal ? -1 : 1
    return a.localeCompare(b, undefined, { numeric: true })
  })

  // Server render & initial client render: show loading placeholder
  if (isDesktop === null) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-10">
          <h1 className="text-2xl font-bold">Recording</h1>
          <p className="mt-1 text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  if (!isDesktop) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-4xl px-8 py-10">
          <h1 className="text-2xl font-bold">Recording</h1>
          <p className="mt-4 text-sm text-muted-foreground">
            Recording settings are only available in the Native Intelligence desktop app.
          </p>
        </div>
      </div>
    )
  }

  // Count final segments for display
  const finalSegmentCount = transcriptSegments.filter((s) => s.isFinal).length

  // Diagnostic UI (the recording-test harness) is for lower
  // environments only — real users on production see meeting detection, the
  // system-audio permission request, and requirements. Meeting detection is
  // desktop-only (the toggles drive Tauri commands).
  const showTestingUI = isLowerEnvironment()
  const showMeetingDetection = isDesktop

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-10">
        <h1 className="text-2xl font-bold">Recording</h1>
        <p className="mt-1 text-muted-foreground">
          {showMeetingDetection
            ? 'Choose how meetings are recorded, and grant audio permissions.'
            : 'Grant audio permissions for recording.'}
        </p>

        {/* Meetings — desktop only (the switch drives a Tauri command; there
            is nothing to configure from a plain browser). One decision
            (Liam, 2026-10-08): whether a meeting records by itself. Detecting
            meetings is not a setting: it is always on (DesktopSetupMount
            turns it back on where an older switch turned it off), and with
            Auto-record off Native Intelligence asks before recording. */}
        {showMeetingDetection && (
        <div className="mt-10">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            <Phone className="h-4 w-4" />
            Meetings
          </div>
          <Separator className="mt-2 mb-4" />

          <div className="space-y-4">
            <div className="flex items-center justify-between gap-4" data-testid="auto-record-row">
              <div>
                <Label htmlFor="auto-record-switch" className="text-sm font-medium">
                  Auto-record meetings
                </Label>
                <p className="text-xs text-muted-foreground">
                  Start recording on its own when you join a call on Zoom,
                  Teams, Slack, Discord, Google Meet or FaceTime. When off,
                  Native Intelligence asks before it records.
                </p>
              </div>
              <Switch
                id="auto-record-switch"
                checked={detectionStatus?.isAutoRecord ?? false}
                onCheckedChange={handleAutoRecordToggle}
              />
            </div>

            {detectionStatus?.isEnabled && (
              <div className="mt-2 flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
                <Radio className="h-4 w-4 text-green-500" />
                <span className="text-xs text-muted-foreground">
                  {detectionStatus.state === 'monitoring'
                    ? 'Monitoring for meeting apps...'
                    : detectionStatus.state === 'detected'
                      ? `Meeting detected: ${detectionStatus.detectedApp?.displayName}`
                      : detectionStatus.state === 'recording'
                        ? 'Recording meeting...'
                        : 'Idle'}
                </span>
              </div>
            )}

            <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
              <p className="text-xs font-medium text-muted-foreground">
                Supported apps
              </p>
              <p className="mt-1 text-xs text-muted-foreground/80">
                Zoom, Microsoft Teams, Slack, Discord, Cisco Webex, Google Meet
                (Chrome), Safari, FaceTime
              </p>
            </div>
          </div>
        </div>
        )}

        {/* Transcription — desktop only, when this build ships the on-device
            engine (modules_list includes local-stt). Browsers and older
            desktop builds don't see it. Nothing here is a choice: the model
            downloads and is used on its own, and echo cancellation always
            runs while system audio is captured (Liam, 2026-10-08). */}
        {isDesktop && localStt.supported && (
        <div className="mt-10">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            <AudioLines className="h-4 w-4" />
            Transcription
          </div>
          <Separator className="mt-2 mb-4" />

          <div className="space-y-4">
          <LocalModuleRow
            module={localStt}
            testId="local-module-row-local-stt"
            title="Local transcription"
            badge="Beta"
            description="Transcribe and identify speakers on this Mac. Meeting audio never leaves your device. Free and unlimited."
            pendingNote="Until it's ready, meetings are transcribed in the cloud. Dictation and voice mode appear once it's ready."
            attribution={
              <>
                Speech models by NVIDIA — Nemotron Speech Streaming (<LocalModuleLink href={NVIDIA_OPEN_MODEL_LICENSE_URL}>NVIDIA Open Model License</LocalModuleLink>)
                and Nemotron 3 Diarization (<LocalModuleLink href={OPENMDW_LICENSE_URL}>OpenMDW-1.1</LocalModuleLink>)
              </>
            }
          />
          </div>
        </div>
        )}

        {/* Permissions — ALWAYS visible (real users need both grants to capture
            a meeting), even though the rest of the recording-test harness
            below is lower-environment-only. The panel polls the passive TCC
            checks, so a toggle flipped in System Settings shows up here on
            its own. (The browser branch is a guard: this view currently
            returns early on web, above.) */}
        <div className="mt-10">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            <Radio className="h-4 w-4" />
            Permissions
          </div>
          <Separator className="mt-2 mb-4" />

          {isDesktop ? (
            <AudioPermissionsPanel />
          ) : (
            <p className="text-xs text-muted-foreground">
              {"Recording in the browser uses your browser's microphone permission. Install the desktop app to capture system audio."}
            </p>
          )}
        </div>

        {/* Recording Test — lower-environment-only diagnostic harness. */}
        {showTestingUI && (
        <div className="mt-10">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            <FlaskConical className="h-4 w-4" />
            Recording Test
          </div>
          <Separator className="mt-2 mb-4" />

          <div className="space-y-4">
            {/* Transcription Config */}
            <div className="space-y-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
              <p className="text-xs font-medium text-muted-foreground">
                Transcription Configuration
              </p>

              <p className="text-[10px] text-muted-foreground">
                Uses Deepgram Nova-3 with real-time streaming, diarization, and smart formatting.
              </p>

              <Separator />

              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-medium">Voice ID Model</p>
                  <p className="text-[10px] text-muted-foreground">
                    Speaker identification model (~100MB, cached locally).
                    {voiceIdReady && <span className="ml-1 text-emerald-600 dark:text-emerald-400">Loaded</span>}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isRecording}
                  onClick={async () => {
                    await VoiceIdService.clearModelCache()
                    alert('Voice ID model cache cleared. It will re-download on next page load.')
                    window.location.reload()
                  }}
                >
                  Clear Cache
                </Button>
              </div>

              <Separator />

              <div className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-medium">Voice ID auto-accept delay</p>
                  <p className="text-[10px] text-muted-foreground">
                    How long to wait before auto-accepting recognized speakers. &ldquo;Off&rdquo; requires manual accept.
                  </p>
                </div>
                <Select
                  value={String(autoAcceptDelay)}
                  onValueChange={(v) => {
                    const val = Number(v) as AutoAcceptDelay
                    setAutoAcceptDelay(val)
                    localStorage.setItem('voiceId.autoAcceptDelay', v)
                  }}
                  disabled={isRecording}
                >
                  <SelectTrigger className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="5">5s</SelectItem>
                    <SelectItem value="10">10s</SelectItem>
                    <SelectItem value="15">15s</SelectItem>
                    <SelectItem value="0">Off</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* Voice Enrollments — Trust Levels */}
            {enrolledContacts.length > 0 && (
              <div className="space-y-2 rounded-lg border border-border bg-muted/30 px-4 py-3">
                <p className="text-xs font-medium text-muted-foreground">
                  Voice Enrollments ({enrolledContacts.length} contact{enrolledContacts.length !== 1 ? 's' : ''})
                </p>
                <div className="space-y-2">
                  {enrolledContacts.map((contact) => {
                    const tier = getTrustTier(contact.confirmationCount)
                    const tierLabel = getTrustTierLabel(tier)
                    const nextThreshold = getNextTierThreshold(contact.confirmationCount)
                    const tierColors: Record<string, string> = {
                      learning: 'text-zinc-500',
                      suggesting: 'text-amber-600 dark:text-amber-400',
                      recognizing: 'text-blue-600 dark:text-blue-400',
                      trusted: 'text-emerald-600 dark:text-emerald-400',
                      fullyTrusted: 'text-emerald-600 dark:text-emerald-400',
                    }
                    const barColors: Record<string, string> = {
                      learning: 'bg-zinc-400',
                      suggesting: 'bg-amber-500',
                      recognizing: 'bg-blue-500',
                      trusted: 'bg-emerald-500',
                      fullyTrusted: 'bg-emerald-500',
                    }
                    const prevThreshold = tier === 'learning' ? 0 : tier === 'suggesting' ? 3 : tier === 'recognizing' ? 6 : tier === 'trusted' ? 11 : 20
                    const progressPct = nextThreshold
                      ? Math.min(100, ((contact.confirmationCount - prevThreshold) / (nextThreshold - prevThreshold)) * 100)
                      : 100
                    const unconfirmedSamples = contact.enrollmentCount - contact.confirmationCount
                    const hasCorrections = contact.correctionCount > 0

                    return (
                      <div key={contact.contactId} className="space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-xs font-medium truncate">{contact.contactName}</span>
                            <span className={`text-[10px] font-medium shrink-0 ${tierColors[tier]}`}>
                              {tierLabel}
                            </span>
                            {hasCorrections && (
                              <span className="text-[9px] text-amber-600 dark:text-amber-400 shrink-0" title={`${contact.correctionCount} correction${contact.correctionCount !== 1 ? 's' : ''} — profile may be unreliable`}>
                                {contact.correctionCount} correction{contact.correctionCount !== 1 ? 's' : ''}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            <span className="text-[10px] text-muted-foreground tabular-nums">
                              {contact.enrollmentCount} sample{contact.enrollmentCount !== 1 ? 's' : ''}
                              {tier === 'learning' && unconfirmedSamples > 0 && (
                                <span className="text-zinc-400"> ({unconfirmedSamples} unconfirmed)</span>
                              )}
                            </span>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive"
                              title="Reset voice data"
                              disabled={isRecording}
                              onClick={() => setResetContactId(contact.contactId)}
                            >
                              <RotateCcw className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                        {/* Progress bar toward next tier */}
                        <div className="flex items-center gap-2">
                          <div className="h-1 flex-1 rounded-full bg-muted">
                            <div
                              className={`h-1 rounded-full transition-all ${barColors[tier]}`}
                              style={{ width: `${progressPct}%` }}
                            />
                          </div>
                          {nextThreshold ? (
                            <span className="text-[9px] text-muted-foreground/60 shrink-0 tabular-nums">
                              {Math.min(contact.confirmationCount, nextThreshold)}/{nextThreshold}
                            </span>
                          ) : (
                            <Check className="h-3 w-3 text-emerald-500 shrink-0" />
                          )}
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Recording Controls */}
            {!isRecording ? (
              <Button
                onClick={handleStartRecording}
                className="w-full gap-2"
              >
                <Play className="h-4 w-4" />
                Start Test Recording
              </Button>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="h-2 w-2 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-sm font-medium tabular-nums">
                      {formatTime(elapsed)}
                    </span>
                    <Badge variant="outline" className="text-[10px]">
                      Deepgram Nova-3
                    </Badge>
                  </div>
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleStopRecording}
                    className="gap-1"
                  >
                    <Square className="h-3 w-3" />
                    Stop
                  </Button>
                </div>

                {/* Audio Levels */}
                <div className="space-y-1">
                  <AudioLevelMeter level={levels.micLevel} label="Mic" />
                  <AudioLevelMeter level={levels.systemLevel} label="System" />
                </div>

                {/* Final segment count */}
                {finalSegmentCount > 0 && (
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-[10px]">
                      {finalSegmentCount} utterance{finalSegmentCount !== 1 ? 's' : ''}
                    </Badge>
                  </div>
                )}
              </div>
            )}

            {/* Error */}
            {recordingError && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/50 bg-destructive/10 px-3 py-2">
                <AlertCircle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
                <p className="text-xs text-destructive">{recordingError}</p>
              </div>
            )}

            {/* Recording Result (after stop) */}
            {recordingResult && (
              <div className="space-y-1 rounded-lg border border-border bg-muted/30 px-4 py-3">
                <p className="text-xs font-medium text-muted-foreground">Recording Result</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <span className="text-muted-foreground">Session</span>
                  <span className="font-mono truncate">{recordingResult.sessionId.slice(0, 8)}...</span>
                  <span className="text-muted-foreground">Duration</span>
                  <span>{recordingResult.durationSeconds.toFixed(1)}s</span>
                  <span className="text-muted-foreground">Utterances</span>
                  <span>{finalSegmentCount}</span>
                  {recordingResult.micFile && (
                    <>
                      <span className="text-muted-foreground">Mic file</span>
                      <span className="font-mono truncate text-[10px]">{recordingResult.micFile.split('/').pop()}</span>
                    </>
                  )}
                  {recordingResult.systemFile && (
                    <>
                      <span className="text-muted-foreground">System file</span>
                      <span className="font-mono truncate text-[10px]">{recordingResult.systemFile.split('/').pop()}</span>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Post-Session Review — auto-assigned speakers. Their embeddings
                are held in state; confirming saves them + a trust confirmation,
                reassigning penalizes the wrong contact and enrolls the right
                one. Closing the panel saves nothing. */}
            {postSessionReview && postSessionReview.autoAssigned.length > 0 && (
              <div className="rounded-lg border border-amber-400/50 bg-amber-50/50 px-4 py-3 dark:bg-amber-950/20 dark:border-amber-600/30">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs font-medium text-amber-700 dark:text-amber-300">
                    Auto-assigned speakers — review
                  </p>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-[10px] text-muted-foreground"
                    onClick={() => setPostSessionReview(null)}
                  >
                    Skip
                  </Button>
                </div>
                <div className="space-y-2">
                  {postSessionReview.autoAssigned.map((entry) => (
                    <div key={entry.speakerId} className="flex items-center justify-between gap-2 rounded border border-border bg-background/50 px-3 py-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs font-medium truncate">{entry.contactName}</span>
                          <Badge variant="outline" className="text-[9px] shrink-0">
                            {getTrustTierLabel(entry.trustTier)}
                          </Badge>
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          {(entry.confidence * 100).toFixed(0)}% confidence · {Math.round(entry.speakingDurationSec)}s speaking
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-[10px] border-emerald-500/30 text-emerald-600 hover:bg-emerald-50 hover:text-emerald-700 dark:hover:bg-emerald-950/30"
                          onClick={async () => {
                            // Confirm: NOW the held embeddings enroll + trust increments
                            if (entry.embeddings.length > 0) {
                              try {
                                const res = await fetch('/api/account/voice-enrollments', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({
                                    enrollments: entry.embeddings.map((embedding) => ({
                                      contact_id: entry.contactId,
                                      embedding,
                                      session_id: postSessionReview.sessionId,
                                    })),
                                    confirmations: [{ contact_id: entry.contactId }],
                                  }),
                                })
                                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                              } catch {
                                console.warn('[recording-test] Failed to save confirmed enrollment')
                                // Keep the entry (it holds the only copy of the embeddings) so it can be retried.
                                toast.error('Couldn’t save voice confirmation. Try again.')
                                return
                              }
                            }
                            setPostSessionReview((prev) => {
                              if (!prev) return null
                              const remaining = prev.autoAssigned.filter((a) => a.speakerId !== entry.speakerId)
                              return remaining.length > 0 ? { ...prev, autoAssigned: remaining } : null
                            })
                            refreshEnrolledContacts()
                          }}
                        >
                          Correct
                        </Button>
                        <SpeakerContactSearch
                          speakerId={entry.speakerId}
                          speakerDisplayName={entry.contactName}
                          onAssign={async (newContactId, newContactName) => {
                            // Apply trust penalty to the wrong contact
                            let saved = true
                            try {
                              const res = await fetch(`/api/account/voice-enrollments/${entry.contactId}/correct`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ session_id: postSessionReview.sessionId }),
                              })
                              if (!res.ok) throw new Error(`HTTP ${res.status}`)
                            } catch {
                              console.warn('[recording-test] Failed to apply trust penalty')
                              saved = false
                            }
                            // Teach the right contact with the held embeddings
                            if (entry.embeddings.length > 0) {
                              try {
                                const res = await fetch('/api/account/voice-enrollments', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({
                                    enrollments: entry.embeddings.map((embedding) => ({
                                      contact_id: newContactId,
                                      embedding,
                                      session_id: postSessionReview.sessionId,
                                    })),
                                    confirmations: [{ contact_id: newContactId }],
                                  }),
                                })
                                if (!res.ok) throw new Error(`HTTP ${res.status}`)
                              } catch {
                                console.warn('[recording-test] Failed to save corrected enrollment')
                                saved = false
                              }
                            }
                            if (!saved) {
                              // Keep the entry (it holds the only copy of the embeddings) so it can be retried.
                              toast.error('Couldn’t save voice correction. Try again.')
                              return
                            }
                            setSpeakerNames((prev) => ({ ...prev, [entry.speakerId]: newContactName }))
                            // Remove the corrected entry from the review panel
                            setPostSessionReview((prev) => {
                              if (!prev) return null
                              const remaining = prev.autoAssigned.filter((a) => a.speakerId !== entry.speakerId)
                              return remaining.length > 0 ? { ...prev, autoAssigned: remaining } : null
                            })
                            refreshEnrolledContacts()
                          }}
                        >
                          <Button variant="outline" size="sm" className="h-6 text-[10px] shrink-0">
                            Wrong person?
                          </Button>
                        </SpeakerContactSearch>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Speakers Panel — shows detected speakers with Voice ID status */}
            {detectedSpeakers.length > 0 && (
              <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
                <div className="flex items-center gap-2 mb-2">
                  <UserRound className="h-3.5 w-3.5 text-muted-foreground" />
                  <p className="text-xs font-medium text-muted-foreground">
                    Speakers ({detectedSpeakers.length})
                  </p>
                  {voiceIdReady && (
                    <span className="text-[9px] text-emerald-600 dark:text-emerald-400">Voice ID active</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {detectedSpeakers.map((speaker) => {
                    const colorIdx = speakerColorIndex(speaker)
                    const color = speakerColors[colorIdx]
                    const contact = speakerContacts[speaker]
                    const isIdentified = !!contact && !contact.isSuggestion
                    const isSuggestion = !!contact?.isSuggestion
                    const embeddingCount = voiceIdRef.current?.getEmbeddingCount(speaker) || 0

                    return (
                      <div key={speaker} className="inline-flex items-center gap-0.5">
                        {/* Suggestion badge — match awaiting user action */}
                        {isSuggestion ? (
                          <div className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 ${
                            contact.isLearningMatch
                              ? 'border border-zinc-300/50 bg-zinc-50 dark:bg-zinc-900/40 dark:border-zinc-600/40'
                              : 'border border-amber-400/50 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-600/40'
                          }`}>
                            <span className={`text-[11px] font-medium truncate max-w-[180px] ${
                              contact.isLearningMatch
                                ? 'text-zinc-600 dark:text-zinc-300'
                                : 'text-amber-700 dark:text-amber-300'
                            }`}>
                              {contact.isLearningMatch
                                ? `Possible match: ${contact.contactName}?`
                                : `Possible: ${contact.contactName} (${(contact.confidence * 100).toFixed(0)}%)`}
                            </span>
                            {contact.autoAcceptCountdown != null && contact.autoAcceptCountdown > 0 && (
                              <span className="inline-flex items-center gap-0.5 text-[9px] text-amber-600 dark:text-amber-400 tabular-nums">
                                <Timer className="h-2.5 w-2.5" />
                                {contact.autoAcceptCountdown}s
                              </span>
                            )}
                            <button
                              className="inline-flex items-center justify-center rounded-full w-4 h-4 bg-emerald-100 text-emerald-700 hover:bg-emerald-200 dark:bg-emerald-900 dark:text-emerald-300 dark:hover:bg-emerald-800 transition-colors"
                              title="Accept match"
                              onClick={() => {
                                // Cancel auto-accept timer if running
                                const timer = autoAcceptTimers.current.get(speaker)
                                if (timer) { clearInterval(timer); autoAcceptTimers.current.delete(speaker) }
                                voiceIdRef.current?.acceptSuggestion(speaker)
                                setSpeakerContacts((prev) => ({
                                  ...prev,
                                  [speaker]: { ...contact, isSuggestion: false, isAutoMatched: false },
                                }))
                                setSpeakerNames((prev) => ({ ...prev, [speaker]: contact.contactName }))
                              }}
                            >
                              <Check className="h-2.5 w-2.5" />
                            </button>
                            <button
                              className="inline-flex items-center justify-center rounded-full w-4 h-4 bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700 transition-colors"
                              title="Dismiss suggestion"
                              onClick={() => {
                                // Cancel auto-accept timer if running
                                const timer = autoAcceptTimers.current.get(speaker)
                                if (timer) { clearInterval(timer); autoAcceptTimers.current.delete(speaker) }
                                voiceIdRef.current?.dismissSuggestion(speaker)
                                setSpeakerContacts((prev) => {
                                  const next = { ...prev }
                                  delete next[speaker]
                                  return next
                                })
                              }}
                            >
                              <span className="text-[9px] font-bold leading-none">✕</span>
                            </button>
                          </div>
                        ) : (
                        <>
                        {/* Main speaker badge */}
                        <Popover>
                          <PopoverTrigger asChild>
                            <button
                              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-colors hover:opacity-80 ${color.bg} ${color.text}`}
                            >
                              {isIdentified && contact.isAutoMatched && (
                                <Check className="h-3 w-3" />
                              )}
                              {isIdentified && !contact.isAutoMatched && (
                                <Link2 className="h-3 w-3" />
                              )}
                              <span className="truncate max-w-[120px]">
                                {speakerDisplayName(speaker)}
                              </span>
                              <span className="text-[9px] opacity-60">
                                {speaker.startsWith('local') ? '(mic)' : '(system)'}
                              </span>
                            </button>
                          </PopoverTrigger>
                          <PopoverContent className="w-56 p-3" align="start">
                            <div className="space-y-2">
                              {isIdentified ? (
                                <>
                                  <div className="flex items-center gap-1.5">
                                    {contact.isAutoMatched ? (
                                      <Check className="h-3 w-3 text-emerald-600" />
                                    ) : (
                                      <Link2 className="h-3 w-3 text-blue-600" />
                                    )}
                                    <p className="text-xs font-medium">{contact.contactName}</p>
                                  </div>
                                  <p className="text-[10px] text-muted-foreground">
                                    {contact.isAutoMatched
                                      ? `Auto-matched (${(contact.confidence * 100).toFixed(0)}% confidence)`
                                      : 'Manually assigned'}
                                  </p>
                                  {embeddingCount > 0 && (
                                    <p className="text-[10px] text-muted-foreground">
                                      {embeddingCount} voice sample{embeddingCount !== 1 ? 's' : ''} collected
                                    </p>
                                  )}
                                  <div className="flex gap-1">
                                    <SpeakerContactSearch
                                      speakerId={speaker}
                                      speakerDisplayName={speakerDisplayName(speaker)}
                                      onAssign={(contactId, contactName) => {
                                        voiceIdRef.current?.assignContact(speaker, contactId, contactName)
                                        if (!voiceIdRef.current) {
                                          setSpeakerContacts((prev) => ({
                                            ...prev,
                                            [speaker]: { contactId, contactName, confidence: 1.0, isAutoMatched: false },
                                          }))
                                          setSpeakerNames((prev) => ({ ...prev, [speaker]: contactName }))
                                        }
                                      }}
                                    >
                                      <Button variant="ghost" size="sm" className="h-6 flex-1 text-[10px]">
                                        Change
                                      </Button>
                                    </SpeakerContactSearch>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="h-6 flex-1 text-[10px] text-destructive hover:text-destructive"
                                      onClick={() => {
                                        setSpeakerContacts((prev) => {
                                          const next = { ...prev }
                                          delete next[speaker]
                                          return next
                                        })
                                        setSpeakerNames((prev) => {
                                          const next = { ...prev }
                                          delete next[speaker]
                                          return next
                                        })
                                      }}
                                    >
                                      Unlink
                                    </Button>
                                  </div>
                                </>
                              ) : (
                                <>
                                  <p className="text-xs font-medium">Rename speaker</p>
                                  <p className="text-[10px] text-muted-foreground">ID: {speaker}</p>
                                  <Input
                                    placeholder={speakerDisplayName(speaker)}
                                    defaultValue={speakerNames[speaker] || ''}
                                    className="h-7 text-xs"
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter') {
                                        const value = (e.target as HTMLInputElement).value.trim()
                                        if (value) {
                                          setSpeakerNames((prev) => ({ ...prev, [speaker]: value }))
                                        } else {
                                          setSpeakerNames((prev) => {
                                            const next = { ...prev }
                                            delete next[speaker]
                                            return next
                                          })
                                        }
                                      }
                                    }}
                                    onBlur={(e) => {
                                      const value = e.target.value.trim()
                                      if (value) {
                                        setSpeakerNames((prev) => ({ ...prev, [speaker]: value }))
                                      } else {
                                        setSpeakerNames((prev) => {
                                          const next = { ...prev }
                                          delete next[speaker]
                                          return next
                                        })
                                      }
                                    }}
                                  />
                                  <p className="text-[10px] text-muted-foreground">
                                    Press Enter or click away to save
                                  </p>
                                  <Separator />
                                  <SpeakerContactSearch
                                    speakerId={speaker}
                                    speakerDisplayName={speakerDisplayName(speaker)}
                                    onAssign={(contactId, contactName) => {
                                      voiceIdRef.current?.assignContact(speaker, contactId, contactName)
                                      if (!voiceIdRef.current) {
                                        setSpeakerContacts((prev) => ({
                                          ...prev,
                                          [speaker]: { contactId, contactName, confidence: 1.0, isAutoMatched: false },
                                        }))
                                        setSpeakerNames((prev) => ({ ...prev, [speaker]: contactName }))
                                      }
                                    }}
                                  >
                                    <Button variant="outline" size="sm" className="h-6 w-full text-[10px]">
                                      <Link2 className="h-3 w-3 mr-1" />
                                      Link to CRM Contact
                                    </Button>
                                  </SpeakerContactSearch>
                                </>
                              )}
                            </div>
                          </PopoverContent>
                        </Popover>

                        {/* CRM link button — only show for unidentified speakers */}
                        {!isIdentified && (
                          <SpeakerContactSearch
                            speakerId={speaker}
                            speakerDisplayName={speakerDisplayName(speaker)}
                            onAssign={(contactId, contactName) => {
                              voiceIdRef.current?.assignContact(speaker, contactId, contactName)
                              // If Voice ID isn't ready, still update the UI
                              if (!voiceIdRef.current) {
                                setSpeakerContacts((prev) => ({
                                  ...prev,
                                  [speaker]: { contactId, contactName, confidence: 1.0, isAutoMatched: false },
                                }))
                                setSpeakerNames((prev) => ({ ...prev, [speaker]: contactName }))
                              }
                            }}
                          >
                            <button
                              className={`inline-flex items-center justify-center rounded-full w-5 h-5 text-[10px] transition-colors hover:opacity-80 ${color.bg} ${color.text}`}
                              title="Link to CRM contact"
                            >
                              <CircleHelp className="h-3 w-3" />
                            </button>
                          </SpeakerContactSearch>
                        )}
                        </>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {/* Live Transcript */}
            {(isRecording || transcriptSegments.length > 0) && (
              <div className="rounded-lg border border-border">
                <div className="border-b px-3 py-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    Live Transcript
                    {finalSegmentCount > 0 && (
                      <span className="ml-1 text-muted-foreground/60">
                        ({finalSegmentCount} final)
                      </span>
                    )}
                  </p>
                </div>
                <ScrollArea className="h-64">
                  {transcriptSegments.length === 0 ? (
                    <div className="flex items-center justify-center p-8 text-xs text-muted-foreground">
                      {isRecording ? 'Waiting for speech...' : 'No transcriptions received'}
                    </div>
                  ) : (
                    <div className="space-y-2 p-3">
                      {transcriptSegments.map((segment) => {
                        const colorIdx = speakerColorIndex(segment.speaker)
                        const color = speakerColors[colorIdx]
                        return (
                          <div
                            key={segment.id}
                            className={`flex gap-2 ${!segment.isFinal ? 'opacity-50' : ''}`}
                          >
                            <span
                              className={`mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${color.bg} ${color.text}`}
                            >
                              {speakerDisplayName(segment.speaker)}
                            </span>
                            <div className="min-w-0">
                              <p className="text-xs leading-relaxed">{segment.text}</p>
                              <p className="text-[10px] text-muted-foreground/60">
                                {segment.startTime.toFixed(1)}s
                                {!segment.isFinal && ' (interim)'}
                              </p>
                            </div>
                          </div>
                        )
                      })}
                      <div ref={transcriptEndRef} />
                    </div>
                  )}
                </ScrollArea>
              </div>
            )}
          </div>
        </div>
        )}

        {/* System Requirements — lower-environment only. */}
        {showTestingUI && (
        <div className="mt-10">
          <div className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
            <Monitor className="h-4 w-4" />
            System Requirements
          </div>
          <Separator className="mt-2 mb-4" />

          <div className="rounded-lg border border-border bg-muted/30 px-4 py-3">
            <p className="text-xs text-muted-foreground">
              System audio capture and meeting detection require macOS 14.4 or
              later. Microphone recording works on all supported platforms.
            </p>
          </div>
        </div>
        )}
      </div>

      {/* Reset voice data confirmation dialog */}
      <AlertDialog open={!!resetContactId} onOpenChange={(open) => { if (!open) setResetContactId(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset voice data</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove all voice enrollment samples and reset trust to zero for {resetContactName}. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                if (!resetContactId) return
                try {
                  const res = await fetch(`/api/account/voice-enrollments/${resetContactId}`, { method: 'DELETE' })
                  if (!res.ok) throw new Error(`HTTP ${res.status}`)
                  setEnrolledContacts((prev) => prev.filter((c) => c.contactId !== resetContactId))
                } catch {
                  console.warn('Failed to reset voice data')
                  toast.error('Couldn’t reset voice data. Try again.')
                }
                setResetContactId(null)
              }}
            >
              Reset
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

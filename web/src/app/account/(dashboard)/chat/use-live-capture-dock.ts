'use client'

/**
 * The live capture the main chat docks, read from the recording (the stable
 * subset: it changes on start, pause and stop, never per audio frame).
 */
import { useMemo } from 'react'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { activeLiveCapture, type ActiveLiveCapture } from './live-capture-dock-store'

/** The capture recording now (or paused, or starting), or null. It docks beside the main chat. */
export function useActiveLiveCapture(): ActiveLiveCapture | null {
  const rec = useOptionalRecordingStable()
  const captureId = rec?.captureId ?? null
  const isRecording = rec?.isRecording ?? false
  const isStarting = rec?.isStarting ?? false
  const isPaused = rec?.isPaused ?? false
  const active = activeLiveCapture({ captureId, isRecording, isStarting, isPaused })
  // A fresh object only when something the dock reads changed.
  const id = active?.captureId ?? null
  const paused = active?.paused ?? false
  return useMemo(() => (id ? { captureId: id, paused } : null), [id, paused])
}

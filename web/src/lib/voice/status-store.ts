/**
 * `voice_status`, shared by every composer and the settings page: one probe
 * per app, refreshed when a local module changes state (`module://status`:
 * local-stt / local-tts downloading → ready) and when the window regains
 * focus. A browser, or a desktop without `voice_status`, reads as
 * unavailable and never touches the bridge.
 */

import { useSyncExternalStore } from 'react'
import { isDesktopApp } from '@/lib/platform'
import { tauriBridge, type VoiceStatus } from '@/lib/tauri-bridge'
import { listenScoped } from '@/lib/tauri-unlisten'

/** Local, not the bridge's constant: suites that mock the bridge wholesale
 *  still get a well-formed "no voice". */
const VOICE_UNAVAILABLE: VoiceStatus = Object.freeze({
  available: false,
  dictation: false,
  conversation: false,
  stt: 'unsupported',
  tts: 'unsupported',
}) as VoiceStatus

let status: VoiceStatus = VOICE_UNAVAILABLE
let probeSeq = 0
const listeners = new Set<() => void>()
let teardown: (() => void) | null = null

function notify() {
  for (const listener of [...listeners]) listener()
}

function sameStatus(a: VoiceStatus, b: VoiceStatus) {
  return (
    a.available === b.available &&
    a.dictation === b.dictation &&
    a.conversation === b.conversation &&
    a.stt === b.stt &&
    a.tts === b.tts &&
    a.reason === b.reason &&
    a.readyFlag === b.readyFlag &&
    a.interactive === b.interactive &&
    a.speechAudio === b.speechAudio &&
    (a.noiseProfiles ?? []).join() === (b.noiseProfiles ?? []).join()
  )
}

/** Ask the desktop again. Resolves with the fresh status (never rejects). */
export async function refreshVoiceStatus(): Promise<VoiceStatus> {
  if (!isDesktopApp()) return VOICE_UNAVAILABLE
  const seq = ++probeSeq
  let next: VoiceStatus
  try {
    next = (await tauriBridge.voiceStatus()) ?? VOICE_UNAVAILABLE
  } catch {
    next = VOICE_UNAVAILABLE
  }
  // A newer probe owns the answer.
  if (seq === probeSeq && !sameStatus(status, next)) {
    status = next
    notify()
  }
  return status
}

function start() {
  void refreshVoiceStatus()
  // A build without module events rejects (or throws); listenScoped swallows it.
  const stopModules = listenScoped((gate) => tauriBridge.onModuleStatus(gate(() => void refreshVoiceStatus())))
  const onFocus = () => void refreshVoiceStatus()
  window.addEventListener('focus', onFocus)
  teardown = () => {
    stopModules()
    window.removeEventListener('focus', onFocus)
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  if (listeners.size === 1 && isDesktopApp()) start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && teardown) {
      teardown()
      teardown = null
    }
  }
}

export function getVoiceStatus(): VoiceStatus {
  return status
}

/** The desktop's current voice status (unavailable until the first probe). */
export function useVoiceStatus(): VoiceStatus {
  return useSyncExternalStore(subscribe, getVoiceStatus, () => VOICE_UNAVAILABLE)
}

/** Tests only: forget the cached status. */
export function __resetVoiceStatusForTests(): void {
  teardown?.()
  teardown = null
  listeners.clear()
  status = VOICE_UNAVAILABLE
  probeSeq = 0
}

/**
 * Speech output: the one seam everything that reads text aloud goes through.
 * That covers read-aloud on replies, the section buttons, Interactive's
 * briefs, the bubble's spoken lines, and voice previews.
 *
 * Today there is one engine: the desktop's on-device model (local-tts). It
 * downloads in the background on its own (local-modules-keeper.ts). Until it
 * is ready, speech output is unavailable, and every play button and
 * Interactive toggle stays hidden. There is no prompt and no system-voice
 * stand-in (docs/plans/local-modules.md, decision 2026-09-26).
 *
 * The seam is built so a cloud engine can join later, the way transcription
 * already works: while the local model downloads, speech goes to the cloud;
 * once the model is ready, the next utterance goes local. To add one:
 *   1. implement SpeechOutputEngine for it (speak / cancel / prepare /
 *      voices / onState, the same contract as the local engine below);
 *   2. return it from resolveSpeechOutput() when the local engine isn't
 *      usable, and from engineFor() for that id.
 * Every gate (useSpeechOutput) and every call site (speechOutput.*) then
 * picks it up. Voice mode and Interactive's talk-back are the exception: the
 * desktop runs those natively on the local models (voice_status
 * `conversation`), so a cloud fallback for them needs desktop work too.
 */

import { useLocalModule } from '@/hooks/use-local-module'
import { isLocalModuleUsable, LOCAL_TTS_MODULE_ID } from './local-modules'
import { tauriBridge, type LocalModuleInfo, type TtsStatePayload, type TtsVoice } from './tauri-bridge'

export type SpeechOutputEngineId = 'local'

export interface SpeechRequest {
  /** The utterance id that `onState` reports back under. */
  id: string
  text: string
  /** A voice from `voices()`; omitted → the engine's default. */
  voice?: string
}

export interface SpeechOutputEngine {
  id: SpeechOutputEngineId
  /** Queue one sentence. Resolves once queued. Rejects with a refusal
   *  (TtsRefusedError: recording / not_ready / unavailable / text_too_long). */
  speak: (request: SpeechRequest) => Promise<void>
  /** Stop the sound now and drop the queue. Never rejects. */
  cancel: () => Promise<void>
  /** Warm the engine up (a reply is about to be read). Never rejects. */
  prepare: () => Promise<void>
  /** The voices it can speak in; [] when it has none. */
  voices: () => Promise<TtsVoice[]>
  /** How fast it speaks (1 = normal); null when it has no speed setting. */
  rate: () => Promise<number | null>
  /** Sets the speed from the next sentence on; resolves to it as applied. */
  setRate: (rate: number) => Promise<number>
  /** Every utterance's progress (filter on `id`). Returns the unsubscribe. */
  onState: (cb: (payload: TtsStatePayload) => void) => () => void
}

/** The desktop's on-device model (local-tts), through the Tauri bridge. Each
 *  method reads the bridge when called, so a test that replaces the bridge
 *  still sees the calls. */
const LOCAL_ENGINE: SpeechOutputEngine = {
  id: 'local',
  speak: (request) =>
    tauriBridge.ttsSpeak(
      request.voice ? { id: request.id, text: request.text, voice: request.voice } : { id: request.id, text: request.text },
    ),
  cancel: () => tauriBridge.ttsCancel(),
  prepare: () => tauriBridge.ttsPrepare(),
  voices: () => tauriBridge.ttsVoices(),
  rate: async () => tauriBridge.ttsRate(),
  setRate: (rate) => tauriBridge.ttsSetRate(rate),
  onState: (cb) => tauriBridge.onTtsState(cb),
}

export interface SpeechOutputState {
  /** Something can speak right now: show play buttons, read-aloud, Interactive. */
  available: boolean
  /** Which engine will speak, or null when none can. */
  engine: SpeechOutputEngineId | null
}

const UNAVAILABLE: SpeechOutputState = Object.freeze({ available: false, engine: null })
const LOCAL: SpeechOutputState = Object.freeze({ available: true, engine: 'local' as const })

/** Which engine speaks, given what the device has. The local model wins once
 *  it is ready. A cloud engine goes in here as the fallback while it isn't. */
export function resolveSpeechOutput({ local }: { local: LocalModuleInfo | null | undefined }): SpeechOutputState {
  if (isLocalModuleUsable(local)) return LOCAL
  return UNAVAILABLE
}

/** Live speech-output availability for gating UI. */
export function useSpeechOutput(): SpeechOutputState {
  const local = useLocalModule(LOCAL_TTS_MODULE_ID)
  return resolveSpeechOutput({ local: local.info })
}

/** The engine that speaks now. One today. With a cloud engine, this picks by
 *  the latest resolveSpeechOutput() answer. */
function currentEngine(): SpeechOutputEngine {
  return LOCAL_ENGINE
}

/** The calls every reader makes. They go to the engine that speaks now. */
export const speechOutput = {
  speak: (request: SpeechRequest) => currentEngine().speak(request),
  cancel: () => currentEngine().cancel(),
  prepare: () => currentEngine().prepare(),
  voices: () => currentEngine().voices(),
  rate: () => currentEngine().rate(),
  setRate: (rate: number) => currentEngine().setRate(rate),
  onState: (cb: (payload: TtsStatePayload) => void) => currentEngine().onState(cb),
}

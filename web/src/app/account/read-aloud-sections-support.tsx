'use client'

import { useEffect, type ReactNode } from 'react'
import { useSpeechOutput } from '@/lib/speech-output'
import { useOptionalRecordingStable } from '@/hooks/recording-context'
import { useReadAloudHeld } from '@/lib/read-aloud/mic-guard'
import { setSectionPlayerSupported } from '@/lib/read-aloud/section-player'

/**
 * Whether the markdown section buttons (read-aloud: "play this section" on a
 * heading, @/lib/read-aloud/section-player) can play, for every /account page:
 * the gate the chat's useReadAloud uses — speech output available
 * (@/lib/speech-output: today the desktop's local-tts model, enabled and
 * Ready), no capture recording (or starting), and read-aloud not
 * held by dictation or a Voice ID enrollment. One probe for the whole app;
 * the buttons only read the result. Outside this provider (the /s/ share
 * pages) the section player stays unsupported.
 *
 * Renders its children unchanged.
 */
export function ReadAloudSectionsSupport({ children }: { children: ReactNode }) {
  const speech = useSpeechOutput()
  const held = useReadAloudHeld()
  const recording = useOptionalRecordingStable()
  const capturing = !!(recording?.isRecording || recording?.isStarting)
  const supported = speech.available && !capturing && !held

  useEffect(() => {
    setSectionPlayerSupported(supported)
  }, [supported])

  // Leaving /account: nothing may keep playing with no button to stop it.
  useEffect(() => () => setSectionPlayerSupported(false), [])

  return children
}

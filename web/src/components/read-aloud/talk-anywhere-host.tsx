'use client'

/**
 * Talk anywhere's host in the main window (docs/plans/talk-anywhere.md §3.3):
 * words someone spoke to the agent from the right ⌥ key, in any app, reach
 * their home thread the way Interactive mode's spoken asks do
 * (@/lib/voice/voice-ask-delivery: sent through the chat's normal path, the
 * reply read aloud even from a background tab), and the agent's progress goes
 * back to the panel through the desktop (talk_state → `dictate://agent`):
 * `thinking` once the chat took them, `speaking` when the reply is read aloud,
 * `done` when it's over (read, cut short, or nothing to read), `failed` when no
 * chat could take them.
 *
 * `talk://interrupt` (a new press, or Esc on the panel's circle) cuts that
 * reply: it stops being read and followed, even while still being written,
 * and what is already playing stops at once. (The reader's interrupt() alone
 * expects the desktop to have silenced it, as a spoken barge-in does; a key
 * press doesn't, so the sentences already synthesized would play out.)
 *
 * The desktop sends only to the `main` window, so this answers once however
 * many windows mount it. Renders nothing.
 *
 * PRIVACY: the text is what the person said to their own assistant, sent as
 * their chat message. Never log it.
 */
import { speechOutput } from '@/lib/speech-output'
import { tauriBridge } from '@/lib/tauri-bridge'
import { deliverVoiceAsk, type VoiceAskHandle } from '@/lib/voice/voice-ask-delivery'
import { useEffect } from 'react'

export function TalkAnywhereHost() {
  useEffect(() => {
    const replies = new Map<number, VoiceAskHandle>()
    const offAsk = tauriBridge.onTalkAsk(({ run, text }) => {
      const handle = deliverVoiceAsk(
        text,
        {},
        {
          onSpeaking: () => void tauriBridge.talkState(run, 'speaking'),
          onSettled: (outcome) => {
            replies.delete(run)
            void tauriBridge.talkState(run, outcome === 'failed' ? 'failed' : 'done')
          },
        },
      )
      if (!handle) {
        void tauriBridge.talkState(run, 'failed')
        return
      }
      replies.set(run, handle)
      void tauriBridge.talkState(run, 'thinking')
    })
    const offInterrupt = tauriBridge.onTalkInterrupt(({ run }) => {
      const reply = replies.get(run)
      if (!reply) return // already over: nothing of ours is playing
      replies.delete(run)
      reply.interrupt()
      void speechOutput.cancel()
    })
    return () => {
      offAsk()
      offInterrupt()
    }
  }, [])
  return null
}

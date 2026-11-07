/**
 * Where Interactive mode's spoken ask goes (the main chat host's window-event
 * routing, src/lib/voice/voice-ask-delivery.ts): during a call, to the call's
 * live agent (Liam, 10-15: one-chat plan, Slice 3, "Decided" 3); otherwise to
 * the main chat, which is the person's home thread (A3). Typed words in the
 * main chat always go to the main agent: only the spoken ask follows the call.
 */

import type { VoiceAskDelivery } from '@/lib/voice/voice-ask-delivery'
import { sendToLiveChat, type LiveChatTarget } from '@/components/live-chat/use-live-chat'

/** The part of a chat panel's handle the route uses. */
export interface VoiceAskPanel {
  askByVoice: (delivery: VoiceAskDelivery) => void
}

/** The call going on, as its live agent's chat talks to it. */
export interface LiveVoiceAskTarget extends LiveChatTarget {
  /** Pushes the transcript to the server before the send (capped by the chat). */
  beforeSend?: () => Promise<void>
  /**
   * Sends the words some other way than this window's live-chat store, and
   * resolves whether the reply came in: on desktop the HUD window's chat owns
   * the call's session, so the ask goes there (lib/live-agent/hud-ask-client.ts).
   * Absent: this window's store (the web HUD, in this page).
   */
  send?: (text: string) => Promise<boolean>
}

/**
 * A spoken ask during a call goes to the live agent's chat
 * (components/live-chat): sent there as the person's message, through the
 * store the HUD's chat shows (on desktop, the HUD window's, through the
 * target's `send`), so it shows in the HUD with its reply. The
 * reply is the HUD's to show, not read aloud: the ask settles `silent` once
 * the reply is in (`failed` when it didn't go).
 *
 * With no call (or its conversation not open yet), it goes to the home
 * thread: the one chat, put back on its home thread first when it isn't on
 * it (showHome). The reply is read aloud from there, and the delivery's
 * snapshot rides the turn as its context. When the home thread can't be
 * shown (it couldn't be read, or the chat moved on meanwhile) the chat as it
 * is answers, and with no chat at all it fails.
 *
 * Either way the ask is accepted at once.
 */
export function routeVoiceAskHome<P extends VoiceAskPanel>(
  delivery: VoiceAskDelivery,
  shell: {
    /** The chat's panel, when it is mounted. */
    panel: () => P | null
    /** The chat on its home thread, once it is; null when it can't be. */
    showHome: () => Promise<P | null>
    /** The call going on, or null. */
    liveCall?: () => LiveVoiceAskTarget | null
  },
): void {
  delivery.accept()
  const call = shell.liveCall?.() ?? null
  if (call) {
    const { beforeSend, send, ...target } = call
    void (send ? send(delivery.text) : sendToLiveChat(target, delivery.text, beforeSend)).then(
      (sent) => delivery.settle(sent ? 'silent' : 'failed'),
      () => delivery.settle('failed'),
    )
    return
  }
  void shell.showHome().then(
    (home) => {
      const target = home ?? shell.panel()
      if (target) target.askByVoice(delivery)
      else delivery.settle('failed')
    },
    () => delivery.settle('failed'),
  )
}

/**
 * Read anywhere in a chat or mail app on the Mac (Teams, Outlook, Slack,
 * Discord): a chat reads the way the in-app browser reads a highlight (Liam,
 * 2026-10-22: "smart enough to know not to read the full person's name ...
 * Emily said something, and then Jianmin said something"). The desktop
 * (desktop read_selection.rs) sends the selected text here and speaks
 * the sentences that come back; this is the browser's own chat reader,
 * ./browser-speech (chatSelectionToSentences), given the text alone, as for
 * any chat page it has no labels for. Text that isn't a chat (an email body,
 * one message) answers [], and the desktop reads it with its own splitter,
 * as it does in any app; so does a window that doesn't answer in time.
 *
 * Every desktop window answers (DesktopSetupMount); the desktop takes the
 * first. PRIVACY: the text is what the user selected; never log it.
 */

import { tauriBridge } from '@/lib/tauri-bridge'
import { chatSelectionToSentences } from './browser-speech'

/** Answers the desktop's requests until the returned function is called. */
export function answerReadAnywhereChats(): () => void {
  return tauriBridge.onReadSelectionConvert(({ run, text }) => {
    let sentences: string[] = []
    try {
      sentences = chatSelectionToSentences(text) ?? []
    } catch {
      sentences = []
    }
    void tauriBridge.readSelectionSentences(run, sentences)
  })
}

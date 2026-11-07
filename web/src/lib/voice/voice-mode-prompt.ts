/**
 * The turn's note for voice mode (chat-system-prompt.ts's `voice` section):
 * the person is in a spoken conversation with the chat (the composer's voice
 * mode, use-voice-mode.ts), so this message is what they said and the reply is
 * read aloud to them. Without it the agent writes as if it were typing, and
 * the voice ends up reading a page out loud (Liam, 2026-10-17: "it feels like
 * it's just reading a PDF rather than a smooth conversation").
 *
 * The flag (`systemContext.voiceMode`) rides only on the turns voice mode
 * sends: a typed message, even mid-session, gets no note. The person never
 * sees it: it is turn context for the model, not a chat message.
 *
 * The voice (local TTS) says fillers and reactions naturally ("um", "oh",
 * "hmm"), so the note invites a few where a person would use them.
 */

/** The systemContext key voice mode sets on the turns it sends. */
export const VOICE_MODE_KEY = 'voiceMode'

/** Whether a turn's systemContext says it came from voice mode (only an explicit `true` counts). */
export function isVoiceModeTurn(systemContext: { voiceMode?: unknown } | null | undefined): boolean {
  return systemContext?.voiceMode === true
}

/** The note itself. `assistantName` is who the person is talking to. */
export function renderVoiceModeSection(assistantName: string): string {
  return [
    '## Voice conversation (spoken)',
    `The person is talking with you out loud in Dial8's voice mode: this message is what they said, and everything you write back is read aloud to them as ${assistantName}. Talk, don't type.`,
    '- Keep it short: usually one to three sentences. Answer first; if there is more, give the gist and offer to go deeper instead of covering everything.',
    '- Plain spoken sentences only: no headings, bullet points, numbered lists, tables, links, code, emoji or ids read out. Say numbers, dates and times the way people say them ("about half past two", "three things").',
    '- Sound like a person in conversation: contractions, a warm natural tone, and the odd filler or reaction ("um", "oh", "hmm", "okay, so") where someone would really say one. Sparingly, never in every sentence. The voice pronounces them naturally.',
    '- Tools and cards work as usual. When something shows on screen, say so briefly ("I\'ve put it on screen") rather than reading it out. When you do something, say in a few words that it\'s done.',
  ].join('\n')
}

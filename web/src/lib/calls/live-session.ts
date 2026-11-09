/**
 * What GPT-Live is told when it answers the person's call (the spike): it is
 * the voice of their Native Intelligence agent, it hands every request about their world to
 * Native Intelligence (client delegation), and it says what comes back faithfully. Its
 * instructions are fixed once the call starts, so everything it needs is here.
 *
 * GPT-Live paraphrases what we hand it, so the instructions ask it to keep
 * names, numbers, dates and times exact, and never to state one Native Intelligence didn't
 * give it: it answers small talk itself, and a prompt is the only control we
 * have over what it says on its own.
 */
import { GPT_LIVE_MODEL, type LiveSessionConfig } from './live-api'

/** The voice a call speaks in (GPT-Live's default; fixed for the call). */
export const CALL_VOICE = 'marin'

/** The person's first name for the greeting, or null. */
export function firstName(displayName: string | null | undefined): string | null {
  const first = (displayName ?? '').trim().split(/\s+/)[0]
  return first ? first.slice(0, 40) : null
}

/** GPT-Live's standing instructions for the person's call. */
export function callInstructions(name: string | null): string {
  const who = name ?? 'the caller'
  return [
    `You are the voice of Native Intelligence, ${who}'s own AI agent, on a phone call with ${who}. You only talk. A backend agent called Native Intelligence knows ${who}'s work and life: their calendar, email, tasks, meetings, notes, contacts, projects and documents, and it can act for them.`,
    `Hand off to Native Intelligence for anything about ${who}'s information, anything they want done, and any question you can't answer from the conversation itself. Say a few natural words while you wait if it takes a moment.`,
    'Answer greetings, small talk and simple back-and-forth yourself, briefly.',
    `Never state anything about ${who}'s schedule, messages, tasks, people, numbers, prices, dates or times unless Native Intelligence gave it to you in this call. Never promise that something was done unless Native Intelligence said it was done.`,
    "When Native Intelligence's answer arrives, say it faithfully and keep every name, number, date and time exactly as given. If it says something is waiting in Native Intelligence for their OK, tell them that.",
    'Keep every turn short and natural: one or two sentences. Speak English unless they speak another language. If they say goodbye, say goodbye briefly.',
  ].join('\n\n')
}

/**
 * What GPT-Live says first. A developer message in the session's input isn't
 * enough to make it speak before the caller does; the docs pair it with a
 * `session.commentary.append` (no delegation) once the call is up, which the
 * bridge sends from this.
 */
export function callGreeting(name: string | null): string {
  return `Hi${name ? ` ${name}` : ''}, it's your Native Intelligence agent. What can I do for you?`
}

/** The session the person's call is accepted with. */
export function callSessionConfig(name: string | null): LiveSessionConfig {
  return {
    type: 'live',
    model: GPT_LIVE_MODEL,
    instructions: callInstructions(name),
    input: [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: `The call just connected. Greet ${name ?? 'them'} in a few words as their Native Intelligence agent and ask what they need.` }],
      },
    ],
    audio: { output: { voice: CALL_VOICE } },
    delegation: { type: 'client' },
    // No recording kept at OpenAI: the transcript lives in the home thread.
    store: false,
  }
}

// A local stand-in for the desktop while working on the floating control's prompter: at
// /hud/studio-recorder?session=dev&simulate=1 on the dev server, it hands the page a script and a checklist and plays
// the words of a made-up take (interim guesses, then finals; an ad-lib, a skipped line, a recognizer slip) through the
// same handlers the desktop's events reach. Development only: the page imports this file inside a
// `process.env.NODE_ENV !== 'production'` branch, which the production build removes with the file (pinned in
// __tests__/dev-harness.test.ts), and it refuses to run in production besides.
import type { PrompterHandoff } from '@/lib/studio/prompter/channel'
import type { LiveWordsEvent } from '@/lib/studio/prompter/live-words'

export const DEMO: PrompterHandoff = {
  sessionId: 'dev',
  following: 'on',
  lines: [
    'Hi, I’m Sam, and today I’ll show you how the new pipeline view works.',
    'First, open the deals board from the sidebar.',
    'Every column is a stage, and you can drag a deal between stages.',
    'When you drop a deal into Won, the forecast updates on its own.',
    'Next, let’s look at the filters at the top of the board.',
    'You can filter by owner, by stage, or by close date.',
    'Save a filter and it shows up in the sidebar for everyone on your team.',
    'That’s the new pipeline view. Thanks for watching.',
  ].map((text) => ({ text })),
  items: [
    { id: 'd1', text: 'Open the deals board' },
    { id: 'd2', text: 'Drag a deal between stages' },
    { id: 'd3', text: 'Explain how the forecast updates' },
    { id: 'd4', text: 'Filter by owner and close date' },
    { id: 'd5', text: 'Saved filters for the team' },
  ],
}

/** What the made-up speaker says, a few words per final, as a recognizer sends them. */
export const TAKE: string[] = [
  'hi I am Sam and today', 'I will show you how the new pipeline view works',
  'so first open the deals board', 'from the sidebar',
  'honestly this is my favourite part', // an ad-lib
  'every column is a stage', 'and you can drag a deel between stages', // a slip: "deel"
  'when you drop a deal into won', 'the forecast updates on its own',
  // line 4 skipped
  'you can filter by owner', 'by stage or by close date',
  'save a filter and it shows up in the sidebar', 'for everyone on your team',
  'that is the new pipeline view', 'thanks for watching',
]

export function devHarnessAllowed(env: string | undefined = process.env.NODE_ENV): boolean {
  return env !== 'production'
}

/** Play the take: each chunk's words as two interim guesses, then the final, about a word every 300 ms. */
export function playTake(onWords: (event: LiveWordsEvent) => void, onClock: (ms: number) => void, startMs = 1500): () => void {
  if (!devHarnessAllowed()) return () => {}
  const timers: ReturnType<typeof setTimeout>[] = []
  let at = startMs, seq = 0
  const started = Date.now()
  const clock = setInterval(() => onClock(Date.now() - started), 250)
  for (const chunk of TAKE) {
    const words = chunk.split(' ')
    const half = Math.ceil(words.length / 2)
    for (const [part, final] of [[words.slice(0, half), false], [words, false], [words, true]] as const) {
      const n = seq++, ms = at
      timers.push(setTimeout(() => onWords({ sessionId: 'dev', seq: n, final, words: part.map((text, i) => ({ text, startMs: ms + i * 300, endMs: ms + i * 300 + 250 })) }), at))
      at += final ? 500 : part.length * 150
    }
  }
  return () => { timers.forEach(clearTimeout); clearInterval(clock) }
}

import { describe, expect, it } from 'vitest'
import { currentLine, follow, indexScript, lineAt, linesOf, locate, placeBeforeLine, START, type FollowPlace, type ScriptIndex } from '../follow'
import { tokenize, type Token } from '../normalize'

const SCRIPT = `Hi, I'm Sam, and today I'll show you how the new pipeline view works.
First, open the deals board from the sidebar.
Every column is a stage, and you can drag a deal between stages.
When you drop a deal into Won, the forecast updates on its own.
Next, let's look at the filters at the top of the board.
You can filter by owner, by stage, or by close date.
Save a filter and it shows up in the sidebar for everyone on your team.
That's the new pipeline view. Thanks for watching.`

/** A take: the person says `chunks` one after another (each a final result), and we read the line after each. */
function take(index: ScriptIndex, chunks: string[], from: FollowPlace = START) {
  let place = from, finals: Token[] = []
  const lines: number[] = []
  for (const chunk of chunks) {
    finals = [...finals, ...tokenize(chunk)]
    place = follow(index, place, finals, [])
    lines.push(lineAt(index, place.confirmed))
  }
  return { place, lines, last: lines[lines.length - 1] }
}

const demo = indexScript(linesOf(SCRIPT))
/** The place at the end of `line` (as if it had just been read). */
const after = (index: ScriptIndex, line: number): FollowPlace => {
  const p = placeBeforeLine(index, line + 1)
  const at = line + 1 >= index.lines.length ? index.tokens.length - 1 : p
  return { confirmed: at, shown: at }
}

describe('following a script', () => {
  it('stays on the first line before anything is said', () => {
    expect(lineAt(demo, START.confirmed)).toBe(0)
  })

  it('follows a word-for-word reading line by line', () => {
    const lines = linesOf(SCRIPT).map((l) => l.text)
    // Each line heard in two halves, as a recognizer sends finals.
    const chunks = lines.flatMap((l) => { const w = l.split(' '); const h = Math.ceil(w.length / 2); return [w.slice(0, h).join(' '), w.slice(h).join(' ')] })
    const { lines: seen } = take(demo, chunks)
    // After the second half of each line, the place is on that line.
    lines.forEach((_, i) => expect(seen[i * 2 + 1]).toBe(i))
  })

  it('follows a paraphrase', () => {
    const { last } = take(demo, ['so first up you open the deals board over in the sidebar'], after(demo, 0))
    expect(last).toBe(1)
  })

  it('stays put through an ad-lib', () => {
    const { last, place } = take(demo, ['honestly this is my favourite part of the whole thing I love it'], after(demo, 1))
    expect(last).toBe(1)
    expect(place.confirmed).toBe(after(demo, 1).confirmed)
  })

  it('moves on when the speaker returns from an ad-lib', () => {
    const { last } = take(demo, ['honestly I love this part', 'every column is a stage and you can drag a deal'], after(demo, 1))
    expect(last).toBe(2)
  })

  it('jumps ahead past skipped lines', () => {
    const { last } = take(demo, ['you can filter by owner by stage or by close date'], after(demo, 1))
    expect(last).toBe(5)
  })

  it('tolerates recognizer errors', () => {
    // "deel" for deal, "steaks" for stages, heard as a recognizer sends finals: a few words at a time.
    const { last } = take(demo, ['every column is a stage', 'and you can drag a deel between steaks'], after(demo, 1))
    expect(last).toBe(2)
  })

  it('matches numbers said as words against digits in the script', () => {
    const index = indexScript(linesOf('Setup takes about 5 minutes.\nThen invite 3 teammates from the settings page.\nThat is all.'))
    expect(take(index, ['then you invite three teammates from settings'], after(index, 0)).last).toBe(1)
  })

  it('follows a line stopped and started again', () => {
    const { last } = take(demo, ['when you drop a deal into', 'sorry let me', 'when you drop a deal into won the forecast updates'], after(demo, 2))
    expect(last).toBe(3)
  })

  it('never moves on filler or stop words alone', () => {
    expect(take(demo, ['um uh so yeah okay so'], after(demo, 2)).last).toBe(2)
    expect(take(demo, ['and you can the of a to it'], after(demo, 2)).last).toBe(2)
  })

  it('needs three content words in order to move', () => {
    // Two content words of line 4 only.
    expect(take(demo, ['look at the filters'], after(demo, 2)).last).toBe(2)
  })

  it('goes back to a line read again, on a strong match', () => {
    const { last } = take(demo, ['every column is a stage and you can drag a deal between stages'], after(demo, 5))
    expect(last).toBe(2)
  })

  it('does not go back on a weak match', () => {
    // "stage" and "deal" are in earlier lines, but this is the speaker going on, not reading them again.
    const { last } = take(demo, ['so that deal stage thing'], after(demo, 5))
    expect(last).toBe(5)
  })

  it('stays on this copy of a phrase the script repeats', () => {
    const index = indexScript(linesOf([
      'Open the settings page.',
      'Change the team name to anything you like.',
      'Click save to keep your changes.',
      'Now open the billing page.',
      'Pick the plan your team needs.',
      'Click save to keep your changes.',
      'That is it.',
    ].join('\n')))
    expect(take(index, ['click save to keep your changes'], after(index, 1)).last).toBe(2)
    expect(take(index, ['click save to keep your changes'], after(index, 4)).last).toBe(5)
  })

  it('recovers after a skip beyond the look-ahead, when one place clearly fits', () => {
    const filler = Array.from({ length: 20 }, (_, i) => `Filler line ${i} about nothing in particular at all.`)
    const index = indexScript(linesOf([...filler.slice(0, 2), ...filler.slice(2), 'Finally the quarterly revenue chart shows growth across every region.'].join('\n')))
    const { last } = take(index, ['finally the quarterly revenue chart shows growth'], after(index, 0))
    expect(last).toBe(20)
  })

  it('does not jump far when the phrase fits two far places equally', () => {
    const filler = Array.from({ length: 20 }, (_, i) => `Filler number ${numberName(i)} has nothing to do with it.`)
    const index = indexScript(linesOf(['Start here.', ...filler.slice(0, 10), 'The quarterly revenue chart shows growth.', ...filler.slice(10), 'The quarterly revenue chart shows growth.'].join('\n')))
    // From line 0, both copies are beyond the look-ahead's reach? The first is 10 lines on: check the far rule only.
    const far = after(index, 0)
    const result = locate(index, tokenize('the quarterly revenue chart shows growth'), far.confirmed)
    // Either the near copy (within the look-ahead) or nothing: never the far copy.
    if (result !== null) expect(lineAt(index, result)).toBe(11)
  })

  it('is empty-safe', () => {
    const empty = indexScript([])
    expect(follow(empty, START, tokenize('anything at all said here'), [])).toEqual(START)
    expect(lineAt(empty, 5)).toBe(0)
  })
})

describe('interim and final words', () => {
  it('lets an interim move the highlight, and a final confirm it', () => {
    const start = after(demo, 1)
    const interim = tokenize('every column is a stage')
    const guess = follow(demo, start, [], interim)
    expect(guess.confirmed).toBe(start.confirmed)
    expect(lineAt(demo, guess.shown)).toBe(2)
    const confirmed = follow(demo, guess, tokenize('every column is a stage'), [])
    expect(lineAt(demo, confirmed.confirmed)).toBe(2)
    expect(confirmed.shown).toBe(confirmed.confirmed)
  })

  it('falls back to the confirmed place when the finals do not bear the interim out', () => {
    const start = after(demo, 1)
    const guess = follow(demo, start, [], tokenize('every column is a stage'))
    expect(lineAt(demo, guess.shown)).toBe(2)
    // The final turned out to be something else.
    const settled = follow(demo, guess, tokenize('every comment is a page'), [])
    expect(settled.shown).toBe(start.confirmed)
  })
})

describe('currentLine', () => {
  it('moves to the next line once a line’s last word is read, and stays on the last line at the end', () => {
    const lastOfFirst = demo.lineStart[1]! - 1
    expect(lineAt(demo, lastOfFirst)).toBe(0)
    expect(currentLine(demo, lastOfFirst)).toBe(1)
    expect(currentLine(demo, lastOfFirst - 1)).toBe(0)
    expect(currentLine(demo, -1)).toBe(0)
    expect(currentLine(demo, demo.tokens.length - 1)).toBe(demo.lines.length - 1)
    expect(currentLine(demo, placeBeforeLine(demo, 3))).toBe(3)
  })
})

describe('placeBeforeLine', () => {
  it('puts the place just before a line, so it reads as the current one', () => {
    expect(lineAt(demo, placeBeforeLine(demo, 4) + 1)).toBe(4)
    expect(placeBeforeLine(demo, 0)).toBe(-1)
  })
})

function numberName(i: number) {
  return ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango'][i]
}

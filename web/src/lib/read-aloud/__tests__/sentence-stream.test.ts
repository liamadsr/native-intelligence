import { describe, it, expect } from 'vitest'
import { SentenceStream } from '../sentence-stream'
import { markdownToSentences } from '../speech-text'

/**
 * SentenceStream — auto-read's splitter. It sees the reply's text grow (the AI
 * SDK hands over the whole text each ~50 ms) and must hand each sentence over
 * once it is finished, never from inside code or a table still being written,
 * and in total say exactly what the speaker button says for the final text.
 */

/** Grow `text` in chunks of the given sizes (cycled); record what each push returned. */
function stream(text: string, sizes: number[] = [7]) {
  const s = new SentenceStream()
  const pushes: { at: string; got: string[] }[] = []
  let end = 0
  let i = 0
  while (end < text.length) {
    end = Math.min(text.length, end + sizes[i++ % sizes.length])
    const at = text.slice(0, end)
    pushes.push({ at, got: s.push(at) })
  }
  const flushed = s.flush()
  const all = [...pushes.flatMap((p) => p.got), ...flushed]
  return { pushes, flushed, all }
}

const REPLY = [
  "## Here's the plan",
  '',
  'I checked the account for **Acme Inc.** and found 3 open deals. The biggest is worth $4.2M, e.g. the renewal. Dr. Smith owns it.',
  '',
  '| Deal | Value |',
  '|------|-------|',
  '| Renewal. Big. | $4.2M |',
  '',
  'Next steps:',
  '',
  '1. Email [Dr. Smith](https://acme.com/team/smith) by 3:30 pm.',
  '2. Update the CRM 📈',
  '3. 1.5 million users signed up.',
  '',
  '```python',
  'print("This is code. Never read it.")',
  '```',
  '',
  '> A quoted note. With two sentences.',
  '',
  'Let me know if you want me to draft the email… or not. Thanks!',
].join('\n')

describe('SentenceStream — says what the button says', () => {
  const chunkings: Array<[string, number[]]> = [
    ['1 char at a time', [1]],
    ['2 chars', [2]],
    ['token-ish', [3, 5, 4, 8, 2]],
    ['big bursts', [40, 90, 17]],
    ['everything at once', [100_000]],
  ]
  for (const [name, sizes] of chunkings) {
    it(`matches markdownToSentences for ${name}`, () => {
      expect(stream(REPLY, sizes).all).toEqual(markdownToSentences(REPLY))
    })
  }

  it('the expected sentences, for the record', () => {
    expect(markdownToSentences(REPLY)).toEqual([
      "Here's the plan.",
      'I checked the account for Acme Inc. and found 3 open deals.',
      'The biggest is worth $4.2M, e.g. the renewal.',
      'Dr. Smith owns it.',
      'Next steps:',
      'Email Dr. Smith by 3:30 pm.',
      'Update the CRM.',
      '1.5 million users signed up.',
      'A quoted note.',
      'With two sentences.',
      'Let me know if you want me to draft the email… or not.',
      'Thanks!',
    ])
  })
})

const SAMPLES = [
  REPLY,
  'Short answer: yes.',
  '# Title\nSetext\n---\nText after. More text!\n\n* a\n* b\n  lazy continuation. Really.\n\n    indented code. Skip.\n\nEnd.',
  'See https://docs.nativeintelligence.dev/api/v1?x=1. Then **bold. Still bold** and `code. span` done.\n\n~~~\nfence. text\n~~~\nTail sentence one. Tail two',
  '> Quote one. Quote two.\n>\n> - quoted item\n\n$$\nx. y.\n$$\n\nAfter math. 🎉 Party!',
]

describe('SentenceStream — random chunkings', () => {
  it('always matches markdownToSentences', () => {
    let seed = 42
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (const text of SAMPLES) {
      const expected = markdownToSentences(text)
      for (let run = 0; run < 25; run++) {
        const sizes = Array.from({ length: 8 }, () => 1 + Math.floor(rand() * 12))
        expect(stream(text, sizes).all).toEqual(expected)
      }
    }
  })
})

describe('SentenceStream — inline constructs split across chunks', () => {
  const INLINE = [
    'Read the guide. <https://docs.nativeintelligence.dev/guide> covers setup. Then restart.',
    'It worked. <em>really</em> well. Done.',
    'It worked. <br> new line. Done.',
    'It worked. <br/>New line. Done.',
    'It worked. ~~old~~ new plan. Done.',
    'It worked. ~~Old~~ New plan. Done.',
    'It worked. <!-- note --> fine. Done.',
    'Mail us. <mailto:help@dial8.ai> works too. Bye.',
    'Tom &amp; Jerry. &nbsp;next up. &lt;tag&gt; Done.',
    'See [the docs](https://docs.nativeintelligence.dev/a.b) now. Then *really* go. **Bold. Still** here. _Under_ it.',
    'Use `a<b` and `x ~ y`. Then `<em` ends. Next one.',
    '- Item one. <https://x.nativeintelligence.dev> two.\n- Item ~~three~~ four. Five.',
    '> Quote. <em>quoted</em> tail. End.',
    'Done. [^1] and more. Next [^a]. Ok.',
    'See [a](https://x.io/(b) "Hi. There") now. Next. Ok.',
    'If x<y then stop. Then go. Weird <b. Then> more. Done.',
  ]

  it('char by char, says what the button says', () => {
    for (const text of INLINE) expect(stream(text, [1]).all, text).toEqual(markdownToSentences(text))
  })

  it('in random chunks, says what the button says', () => {
    let seed = 7
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (const text of INLINE) {
      const expected = markdownToSentences(text)
      for (let run = 0; run < 40; run++) {
        const sizes = Array.from({ length: 8 }, () => 1 + Math.floor(rand() * 10))
        expect(stream(text, sizes).all, `${text} / ${sizes}`).toEqual(expected)
      }
    }
  })

  it('the autolink case from the review, in its three chunks', () => {
    const s = new SentenceStream()
    const got = [
      ...s.push('Read the guide. <'),
      ...s.push('Read the guide. <https://docs.nativeintelligence.dev/guide'),
      ...s.push('Read the guide. <https://docs.nativeintelligence.dev/guide> covers setup. Then restart.'),
      ...s.flush(),
    ]
    expect(got).toEqual(['Read the guide. docs.nativeintelligence.dev covers setup.', 'Then restart.'])
  })

  it('a "<" that starts no tag holds nothing back', () => {
    const s = new SentenceStream()
    expect(s.push('If a < b. Then c')).toEqual(['If a < b.'])
  })

  it('a "<" that could start a tag holds its paragraph, and is still read at the end', () => {
    const s = new SentenceStream()
    expect(s.push('Fine. If x<y then stop. Then go. And')).toEqual(['Fine.'])
    expect(s.flush()).toEqual(['If x<y then stop.', 'Then go.', 'And'])
    const t = new SentenceStream()
    expect([...t.push('a <b'), ...t.flush()]).toEqual(['a <b'])
  })
})

describe('SentenceStream — fences nested in lists and quotes', () => {
  const NESTED = [
    '- Setup:\n    ```bash\n    npm install. Now.\n    ```\n- Done. Really done.',
    '- ```js\n  code. X\n  ```\n- Next. Item.',
    '> > ```js\n> > const a = 1. B\n> > ```\n> > After quote. More.\n\nOut. Done.',
    '> ```js\n> const a = 1. B\n> ```\n\nAfter. And more.',
    '> ```\n> x. Y\n\nAfter the quote. Bye.',
  ]
  it('streams the same sentences as the finished text', () => {
    for (const text of NESTED) {
      for (const sizes of [[1], [3, 7], [100_000]]) expect(stream(text, sizes).all, text).toEqual(markdownToSentences(text))
    }
  })
})

describe('SentenceStream — timing', () => {
  it('hands a sentence over as soon as the next one starts, mid-line', () => {
    const s = new SentenceStream()
    expect(s.push('Hello there')).toEqual([])
    expect(s.push('Hello there.')).toEqual([])
    expect(s.push('Hello there. ')).toEqual([])
    expect(s.push('Hello there. H')).toEqual(['Hello there.'])
    expect(s.push('Hello there. How are you? I am')).toEqual(['How are you?'])
    expect(s.flush()).toEqual(['I am'])
  })

  it('waits on an abbreviation until the next word shows it is not a sentence end', () => {
    const s = new SentenceStream()
    expect(s.push('Ask Dr.')).toEqual([])
    expect(s.push('Ask Dr. Smith')).toEqual([])
    expect(s.push('Ask Dr. Smith. He')).toEqual(['Ask Dr. Smith.'])
  })

  it('waits on a decimal split across chunks', () => {
    const s = new SentenceStream()
    expect(s.push('It grew 4.')).toEqual([])
    expect(s.push('It grew 4.2')).toEqual([])
    expect(s.push('It grew 4.2 percent. Nice')).toEqual(['It grew 4.2 percent.'])
  })

  it('closes a block at the blank line after it, not at a bare newline', () => {
    const s = new SentenceStream()
    expect(s.push('First paragraph')).toEqual([])
    expect(s.push('First paragraph\n')).toEqual([])
    // A single newline may be a soft wrap: the paragraph could continue.
    expect(s.push('First paragraph\ncontinues')).toEqual([])
    expect(s.push('First paragraph\ncontinues\n\n')).toEqual(['First paragraph continues'])
    expect(s.push('First paragraph\ncontinues\n\nSecond. Third')).toEqual(['Second.'])
  })

  it('reads a list item once the next item begins', () => {
    const s = new SentenceStream()
    expect(s.push('- Alpha')).toEqual([])
    expect(s.push('- Alpha\n')).toEqual([])
    expect(s.push('- Alpha\n- Be')).toEqual([])
    expect(s.push('- Alpha\n- Beta\n')).toEqual(['Alpha.'])
    expect(s.flush()).toEqual(['Beta.'])
  })

  it('reads a heading once its line is done', () => {
    const s = new SentenceStream()
    expect(s.push('# Summary')).toEqual([])
    expect(s.push('# Summary\n')).toEqual(['Summary.'])
  })

  it('does not decide what a partial line is: "1" / "1." / "1.5 million"', () => {
    const s = new SentenceStream()
    expect(s.push('Intro line\n1')).toEqual([])
    expect(s.push('Intro line\n1.')).toEqual([])
    expect(s.push('Intro line\n1.5 million users')).toEqual([])
    expect(s.push('Intro line\n1.5 million users. Wow')).toEqual(['Intro line 1.5 million users.'])
    expect(s.flush()).toEqual(['Wow'])
  })
})

describe('SentenceStream — code and tables', () => {
  it('reads nothing from inside an unclosed fence, then carries on after it', () => {
    const s = new SentenceStream()
    expect(s.push('Try this.\n\n```js\nconsole.log("Hi. There.")\n')).toEqual(['Try this.'])
    expect(s.push('Try this.\n\n```js\nconsole.log("Hi. There.")\nfoo(). Bar()')).toEqual([])
    expect(s.push('Try this.\n\n```js\nconsole.log("Hi. There.")\nfoo(). Bar()\n```\n\nDone. Bye')).toEqual(['Done.'])
    expect(s.flush()).toEqual(['Bye'])
  })

  it('reads nothing of a fence that never closes, even at flush', () => {
    const { all } = stream('Look:\n\n```\nA. B. C. D.\nE. F.', [3])
    expect(all).toEqual(['Look:'])
  })

  it('reads nothing from a table while it is being written', () => {
    const text = 'Numbers:\n\n| A. B. | C. D. |\n|---|---|\n| E. F. | G. H. |\n\nAfter. End'
    const { pushes, all } = stream(text, [2])
    for (const p of pushes) {
      for (const sentence of p.got) expect(sentence).not.toMatch(/^[A-H]\.$/)
    }
    expect(all).toEqual(['Numbers:', 'After.', 'End'])
  })

  it('holds a pipe line that may still turn into a table header', () => {
    const s = new SentenceStream()
    expect(s.push('Name. | Seats. | Cost')).toEqual([])
    expect(s.push('Name. | Seats. | Cost\n--- | --- | ---\nTeam | 5 | 9\n\nOK. ')).toEqual([])
    expect(s.flush()).toEqual(['OK.'])
  })
})

describe('SentenceStream — lifecycle', () => {
  it('flush is final: later pushes and flushes return nothing', () => {
    const s = new SentenceStream()
    s.push('One. Two')
    expect(s.flush()).toEqual(['Two'])
    expect(s.push('One. Two. Three. Four')).toEqual([])
    expect(s.flush()).toEqual([])
  })

  it('repeated pushes of the same text return nothing new', () => {
    const s = new SentenceStream()
    expect(s.push('One. Two. Three')).toEqual(['One.', 'Two.'])
    expect(s.push('One. Two. Three')).toEqual([])
    expect(s.push('One. Two. Three')).toEqual([])
  })

  it('cuts a long sentence only once it is finished', () => {
    const words = Array.from({ length: 50 }, (_, i) => `w${i + 1}`)
    words[24] += ','
    const long = `${words.join(' ')}.`
    const { pushes, all } = stream(`${long} Next one.`, [4])
    // No piece of the long sentence is handed over before its period arrives.
    const firstEmit = pushes.findIndex((p) => p.got.length > 0)
    expect(pushes[firstEmit].at.length).toBeGreaterThan(long.length)
    expect(all).toEqual([`${words.slice(0, 25).join(' ')}`, `${words.slice(25).join(' ')}.`, 'Next one.'])
  })

  it('an empty or whitespace-only stream says nothing', () => {
    const s = new SentenceStream()
    expect(s.push('')).toEqual([])
    expect(s.push('   \n\n')).toEqual([])
    expect(s.flush()).toEqual([])
  })
})

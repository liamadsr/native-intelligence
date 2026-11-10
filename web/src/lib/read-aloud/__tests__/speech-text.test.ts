import { describe, it, expect } from 'vitest'
import {
  inlineToSpeech,
  markdownToSentences,
  markdownToSpeech,
  parseSpeechBlocks,
  plainTextToSentences,
  splitSentences,
} from '../speech-text'

/**
 * Read-aloud text pass (docs/plans/local-modules.md §3.5, web half): markdown
 * in, the sentences local-tts should say out. Numbers and symbols stay as they
 * are — the desktop expands those.
 */

describe('markdownToSpeech — what is skipped', () => {
  it('skips fenced code blocks (``` and ~~~), keeping the prose around them', () => {
    const md = [
      'Run this:',
      '',
      '```bash',
      'npm install acme',
      'echo "done."',
      '```',
      '',
      '~~~',
      'more code',
      '~~~',
      'Then restart.',
    ].join('\n')
    expect(markdownToSpeech(md)).toBe('Run this:\nThen restart.')
  })

  it('skips an unclosed fence to the end of the text', () => {
    expect(markdownToSpeech('Here it is.\n\n```ts\nconst a = 1\nconst b = 2')).toBe('Here it is.')
  })

  it('closes a fence opened in a blockquote at its quoted closer', () => {
    expect(markdownToSentences('> ```js\n> const a = 1\n> ```\n\nAfter.')).toEqual(['After.'])
    expect(markdownToSentences('> Look:\n> ```\n> x. y.\n> ```\n> Quoted after.\n\nAfter.')).toEqual([
      'Look:',
      'Quoted after.',
      'After.',
    ])
    expect(markdownToSentences('> $$\n> x. y.\n> $$\n\nAfter.')).toEqual(['After.'])
  })

  it('ends a quoted fence where the quote ends, and reads that line', () => {
    expect(markdownToSentences('> ```\n> x\n\nAfter.')).toEqual(['After.'])
    expect(markdownToSentences('> ```\n> x\nAfter the quote.')).toEqual(['After the quote.'])
    const blocks = parseSpeechBlocks('> ```js\n> x\n> ```')
    expect(blocks).toEqual([{ kind: 'code', lines: ['```js', 'x', '```'], open: false }])
  })

  it('skips a fence indented 4+ spaces inside a list', () => {
    expect(markdownToSentences('- Setup:\n    ```bash\n    npm install\n    npm run dev\n    ```\n- Done.')).toEqual([
      'Setup:',
      'Done.',
    ])
    expect(markdownToSentences('1. Parent\n   - Child:\n     ```ts\n     const x = await fetch(url)\n     ```')).toEqual([
      'Parent.',
      'Child:',
    ])
    expect(
      markdownToSentences('- Item\n\n    ```bash\n    # comment\n    - key: value\n    rm -rf node_modules\n    ```\n\nAfter.'),
    ).toEqual(['Item.', 'After.'])
    expect(markdownToSentences('- Math:\n      $$\n      x. y.\n      $$\n- Done.')).toEqual(['Math:', 'Done.'])
  })

  it('skips a fence opened on a list item\'s own line, and reads on after it', () => {
    expect(markdownToSentences('- ```js\n  code. X\n  ```\n- Next. Y')).toEqual(['Next.', 'Y.'])
    expect(markdownToSentences('1. ```bash\n   npm i. X\n   ```\n2. Next. Y')).toEqual(['Next.', 'Y.'])
    expect(markdownToSentences('> - ```\n>   code. X\n>   ```\n> - Next. Y')).toEqual(['Next.', 'Y.'])
  })

  it('reads a line that only starts with triple-backtick inline code (no fence)', () => {
    expect(markdownToSentences('```npm i``` installs it. Then run.')).toEqual(['npm i installs it.', 'Then run.'])
    expect(markdownToSentences('- ```npm i``` installs it.\n- Then run.')).toEqual(['npm i installs it.', 'Then run.'])
  })

  it('skips indented code after a blank line, but not an indented continuation', () => {
    const md = 'Example:\n\n    const x = 1\n    const y = 2\n\nDone.'
    expect(markdownToSpeech(md)).toBe('Example:\nDone.')
  })

  it('does not treat nested (indented) list items as code', () => {
    const md = '- First\n    - Nested one\n    - Nested two'
    expect(markdownToSentences(md)).toEqual(['First.', 'Nested one.', 'Nested two.'])
  })

  it('skips tables, with or without leading pipes', () => {
    const md = [
      'Here are the numbers.',
      '',
      '| Plan | Price |',
      '| --- | ---: |',
      '| Pro | $99 |',
      '',
      'Name | Seats',
      '--- | ---',
      'Team | 5',
      '',
      'That is all.',
    ].join('\n')
    expect(markdownToSpeech(md)).toBe('Here are the numbers.\nThat is all.')
  })

  it('drops images, HTML tags, comments and footnote markers', () => {
    expect(
      inlineToSpeech('See ![the chart](https://x.io/c.png "Chart") below<sup>[^1]</sup>.<br/>It <b>grew</b> fast<!-- note -->.'),
    ).toBe('See below. It grew fast.')
    expect(inlineToSpeech('Revenue doubled[^note] this year.')).toBe('Revenue doubled this year.')
  })

  it('drops footnote definitions, link reference definitions and thematic breaks', () => {
    const md = 'Intro.\n\n---\n\nBody.\n\n[^1]: A footnote.\n[docs]: https://nativeintelligence.dev/docs'
    expect(markdownToSpeech(md)).toBe('Intro.\nBody.')
  })

  it('drops stage directions, which local-tts would read as words', () => {
    expect(inlineToSpeech('[laughs] That is great.')).toBe('That is great.')
    expect(inlineToSpeech('Oh, nice (chuckles softly). Let me check.')).toBe('Oh, nice. Let me check.')
    expect(inlineToSpeech('*sighs* Okay, *long pause* here goes.')).toBe('Okay, here goes.')
    expect(inlineToSpeech('**Laughs** Fair point. _clears throat_ So.')).toBe('Fair point. So.')
    expect(inlineToSpeech('Haha, [laughter], fair point.')).toBe('Haha, fair point.')
    // Prose in brackets stays, and so does emphasis that isn't a cue.
    expect(inlineToSpeech('Press it (the pause button) twice.')).toBe('Press it (the pause button) twice.')
    expect(inlineToSpeech('I *really* laugh at that (smiles are free).')).toBe('I really laugh at that (smiles are free).')
    expect(inlineToSpeech('Use `[laughs]` as the tag.')).toBe('Use [laughs] as the tag.')
  })

  it('drops emoji, including joined and flag sequences', () => {
    expect(inlineToSpeech('Shipped 🚀 today 👩🏽‍💻 🇺🇸!')).toBe('Shipped today!')
    expect(inlineToSpeech('✅ Done')).toBe('Done')
    expect(markdownToSpeech('🎉🎉')).toBe('')
  })
})

describe('markdownToSpeech — what is kept', () => {
  it('keeps link text and drops the URL', () => {
    expect(inlineToSpeech('Read [the docs](https://docs.nativeintelligence.dev/api "API") first.')).toBe('Read the docs first.')
    expect(inlineToSpeech('A [wiki link](https://en.wikipedia.org/wiki/Foo_(bar)) here.')).toBe('A wiki link here.')
    expect(inlineToSpeech('See [the guide][guide].')).toBe('See the guide.')
  })

  it('reads bare URLs as their host, keeping the sentence period', () => {
    expect(inlineToSpeech('Go to https://www.nativeintelligence.dev/pricing?plan=pro.')).toBe('Go to nativeintelligence.dev.')
    expect(inlineToSpeech('Open <https://docs.nativeintelligence.dev/api> now')).toBe('Open docs.nativeintelligence.dev now')
  })

  it('strips emphasis, strikethrough and inline-code backticks, keeping the words', () => {
    expect(inlineToSpeech('This is **very** _really_ *quite* __bold__ ~~old~~ news.')).toBe(
      'This is very really quite bold old news.',
    )
    expect(inlineToSpeech('Run `npm test` and `a*b*c`.')).toBe('Run npm test and a*b*c.')
    expect(inlineToSpeech('Keep my_snake_case and 2*3 intact.')).toBe('Keep my_snake_case and 2*3 intact.')
  })

  it('strips blockquote markers', () => {
    expect(markdownToSpeech('> Quoted line.\n> > Nested quote.')).toBe('Quoted line. Nested quote.')
  })

  it('decodes common HTML entities', () => {
    expect(inlineToSpeech('Tom &amp; Jerry&nbsp;&mdash; classic.')).toBe('Tom & Jerry — classic.')
  })

  it('turns headings and list items into sentences, adding a period only when missing', () => {
    const md = [
      '# Summary',
      '## What changed? ##',
      'Setext heading',
      '===',
      '- **Speed**: 5x faster',
      '* Done already.',
      '1. First step',
      '2) Second step!',
      '- [x] Task done',
      '- [ ] Task open',
    ].join('\n')
    expect(markdownToSentences(md)).toEqual([
      'Summary.',
      'What changed?',
      'Setext heading.',
      'Speed: 5x faster.',
      'Done already.',
      'First step.',
      'Second step!',
      'Task done.',
      'Task open.',
    ])
  })

  it('joins soft-wrapped paragraph lines and collapses whitespace', () => {
    expect(markdownToSpeech('One   line\ncontinues\there.\n\n\nNext   paragraph.')).toBe(
      'One line continues here.\nNext paragraph.',
    )
  })

  it('puts one block per line so block ends are sentence ends', () => {
    expect(splitSentences(markdownToSpeech('Here is what I found:\n\n- Alpha\n- Beta'))).toEqual([
      'Here is what I found:',
      'Alpha.',
      'Beta.',
    ])
  })

  it('reads a realistic chat reply', () => {
    const md = [
      "## Here's the plan",
      '',
      "I checked the account for **Acme Inc.** and found 3 open deals. The biggest is worth $4.2M, e.g. the renewal.",
      '',
      '| Deal | Value |',
      '|------|-------|',
      '| Renewal | $4.2M |',
      '',
      'Next steps:',
      '',
      '1. Email [Dr. Smith](mailto:smith@acme.com) by 3:30 pm.',
      '2. Update the CRM 📈',
      '',
      '```sql',
      'select * from deals;',
      '```',
      '',
      'Let me know if you want me to draft the email.',
    ].join('\n')
    expect(markdownToSentences(md)).toEqual([
      "Here's the plan.",
      'I checked the account for Acme Inc. and found 3 open deals.',
      'The biggest is worth $4.2M, e.g. the renewal.',
      'Next steps:',
      'Email Dr. Smith by 3:30 pm.',
      'Update the CRM.',
      'Let me know if you want me to draft the email.',
    ])
  })

  it('returns nothing for empty or code-only input', () => {
    expect(markdownToSpeech('')).toBe('')
    expect(markdownToSentences('```\ncode\n```')).toEqual([])
    expect(markdownToSentences('   \n\n  ')).toEqual([])
  })
})

describe('parseSpeechBlocks', () => {
  it('classifies blocks', () => {
    const kinds = parseSpeechBlocks('# H\n\nPara\n\n- item\n\n```\nx\n```\n\n| a |\n|---|').map((b) => b.kind)
    expect(kinds).toEqual(['heading', 'text', 'list', 'code', 'table'])
  })

  it('treats $$ math blocks as code', () => {
    expect(markdownToSpeech('Formula:\n\n$$\nE = mc^2\n$$\n\nDone.')).toBe('Formula:\nDone.')
    expect(markdownToSpeech('$$ a + b $$')).toBe('')
  })
})

describe('splitSentences', () => {
  it('splits on . ! ? followed by a new sentence', () => {
    expect(splitSentences('Hello there. How are you? Great! Thanks.')).toEqual([
      'Hello there.',
      'How are you?',
      'Great!',
      'Thanks.',
    ])
  })

  it('keeps closing quotes and brackets with their sentence', () => {
    expect(splitSentences('He said "done." Then he left. (It was late.) We slept.')).toEqual([
      'He said "done."',
      'Then he left.',
      '(It was late.)',
      'We slept.',
    ])
  })

  it('does not split on abbreviations', () => {
    expect(splitSentences('Dr. Smith met Mr. Jones and Mrs. Lee. They agreed.')).toEqual([
      'Dr. Smith met Mr. Jones and Mrs. Lee.',
      'They agreed.',
    ])
    expect(splitSentences('Some fruit, e.g. Apples, and i.e. Pears. Next.')).toEqual([
      'Some fruit, e.g. Apples, and i.e. Pears.',
      'Next.',
    ])
    expect(splitSentences('Acme Inc. Reported growth in the U.S. Army contract. Good news.')).toEqual([
      'Acme Inc. Reported growth in the U.S. Army contract.',
      'Good news.',
    ])
    expect(splitSentences('She has a Ph.D. In physics.')).toEqual(['She has a Ph.D. In physics.'])
  })

  it('does not split on decimals, times, domains or versions', () => {
    expect(splitSentences('Revenue hit 4.2 million at 3:30 today. Visit nativeintelligence.dev or docs.nativeintelligence.dev/api for v2.1.3 notes. Done.')).toEqual([
      'Revenue hit 4.2 million at 3:30 today.',
      'Visit nativeintelligence.dev or docs.nativeintelligence.dev/api for v2.1.3 notes.',
      'Done.',
    ])
  })

  it('still splits after a domain that ends a sentence', () => {
    expect(splitSentences('Go to nativeintelligence.dev. Then sign in.')).toEqual(['Go to nativeintelligence.dev.', 'Then sign in.'])
  })

  it('does not split on initials, but does after a sentence-final "I"', () => {
    expect(splitSentences('J. R. R. Tolkien wrote it. John F. Kennedy read it.')).toEqual([
      'J. R. R. Tolkien wrote it.',
      'John F. Kennedy read it.',
    ])
    expect(splitSentences('So did I. Then we left.')).toEqual(['So did I.', 'Then we left.'])
  })

  it('does not split on ellipses', () => {
    expect(splitSentences('Well... Maybe later… We will see.')).toEqual(['Well... Maybe later… We will see.'])
  })

  it('does not split before a lowercase word', () => {
    expect(splitSentences('It costs approx. two dollars. OK.')).toEqual(['It costs approx. two dollars.', 'OK.'])
  })

  it('splits after etc. / a.m. only before a capital, and after No. only before a non-digit', () => {
    expect(splitSentences('Apples, pears, etc. Then more.')).toEqual(['Apples, pears, etc.', 'Then more.'])
    expect(splitSentences('Meet at 9 a.m. tomorrow. Or at 5 p.m. Then leave.')).toEqual([
      'Meet at 9 a.m. tomorrow.',
      'Or at 5 p.m.',
      'Then leave.',
    ])
    expect(splitSentences('See No. 5 below. The answer is no. Then stop.')).toEqual([
      'See No. 5 below.',
      'The answer is no.',
      'Then stop.',
    ])
  })

  it('keeps a leading number label with its sentence', () => {
    expect(splitSentences('1. Setup is easy. 2. Run it.')).toEqual(['1. Setup is easy.', '2. Run it.'])
  })

  it('treats line breaks as sentence ends', () => {
    expect(splitSentences('No period here\nNext line.')).toEqual(['No period here', 'Next line.'])
  })

  it('cuts a sentence over ~40 words at a comma or semicolon near the middle', () => {
    const left = 'This first clause keeps going with plenty of words to describe the situation in detail'
    const right =
      'and this second clause continues just as long with even more words so that the total count of words in the whole sentence goes well past the limit of forty words.'
    const sentence = `${left}, ${right}`
    expect(sentence.split(' ').length).toBeGreaterThan(40)
    expect(splitSentences(sentence)).toEqual([`${left},`, right])
  })

  it('prefers a semicolon to a comma for the cut', () => {
    const words = Array.from({ length: 50 }, (_, i) => `w${i + 1}`)
    words[14] += ';' // after word 15
    words[24] += ',' // after word 25, the exact middle
    words[49] += '.'
    const parts = splitSentences(words.join(' '))
    expect(parts).toHaveLength(2)
    expect(parts[0].endsWith('w15;')).toBe(true)
    expect(parts.join(' ')).toBe(words.join(' '))
  })

  it('leaves a long sentence alone when it has no comma or semicolon', () => {
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`).join(' ') + '.'
    expect(splitSentences(words)).toEqual([words])
  })

  it('returns [] for blank text', () => {
    expect(splitSentences('')).toEqual([])
    expect(splitSentences('  \n ')).toEqual([])
  })
})

describe('plainTextToSentences (a highlight in the in-app browser)', () => {
  it('reads each line as its own sentences, a heading ending like one', () => {
    expect(
      plainTextToSentences('Getting started\nInstall the app. Then sign in!\n\nIt takes a minute'),
    ).toEqual(['Getting started.', 'Install the app.', 'Then sign in!', 'It takes a minute.'])
  })

  it('reads plain text as it is: no markdown, URLs as their host, no emoji', () => {
    expect(plainTextToSentences('Use *bold* at https://docs.nativeintelligence.dev/api?x=1 🎉')).toEqual([
      'Use *bold* at docs.nativeintelligence.dev.',
    ])
  })

  it('a partial phrase is still said', () => {
    expect(plainTextToSentences('  the quick brown fox  ')).toEqual(['the quick brown fox.'])
  })

  it('returns [] when nothing in it can be said', () => {
    expect(plainTextToSentences('')).toEqual([])
    expect(plainTextToSentences(' \n\t\n ')).toEqual([])
    expect(plainTextToSentences('🎉 — …')).toEqual([])
  })
})

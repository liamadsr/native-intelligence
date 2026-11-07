// @vitest-environment jsdom
/**
 * An email thread → what listen mode reads (../email-thread-speech). The
 * contract (Liam, 2026-10-02: read the whole conversation, "this person sent
 * an email first … and then this person responded", attachments counted, no
 * signatures, no model):
 *  - one message (drafts left out) reads exactly as a single email always
 *    has, plus "It has two attachments." after the preface when it has files;
 *  - several: "<subject>: a thread of three emails.", then oldest to newest
 *    "Sarah wrote first, on Monday." / "Bob replied the next day." / "Then you
 *    replied." / "Sarah followed up.", each before that message's own words;
 *  - a day only when it changes: today, yesterday, the next day, on Monday,
 *    last Thursday, on September 3;
 *  - files folded into the intro, never named; a reply with nothing of its own
 *    left out, or just its intro when it carries files; drafts never read;
 *  - a reply's quoted history isn't read again;
 *  - given names, full names when two share one, "you" for the user's own,
 *    a name from the address with no "@…", never he or she.
 */
import { describe, it, expect } from 'vitest'
import { emailThreadToSentences, type ThreadSpeechMessage } from '../email-thread-speech'
import { emailToSentences } from '../email-speech'

/** Friday 2 October 2026, 3 PM UTC. */
const NOW = new Date('2026-10-02T15:00:00Z')
const CLOCK = { now: NOW, timeZone: 'UTC' }

const SARAH = { name: 'Sarah Chen', email: 'sarah@acme.com' }
const BOB = { name: 'Bob Lee', email: 'bob@acme.com' }
const LIAM = { name: 'Liam', email: 'liam@dial8.ai' }

const MON = '2026-09-28T09:00:00Z'
const TUE = '2026-09-29T10:30:00Z'
const WED = '2026-09-30T16:00:00Z'
const THU = '2026-10-01T18:00:00Z' // yesterday
const FRI = '2026-10-02T08:00:00Z' // today

function msg(from: ThreadSpeechMessage['from'], date: string | null, bodyText: string, extra: Partial<ThreadSpeechMessage> = {}): ThreadSpeechMessage {
  return { from, date, subject: 'Re: Q3 review', bodyText, ...extra }
}

function read(messages: ThreadSpeechMessage[], subject: string | null = 'Q3 review'): string[] {
  return emailThreadToSentences({ subject, messages }, CLOCK)
}

/** The sentences that are ours (the opener and the intros), not the messages'. */
const INTRO_RE = /^(?:.*: a thread of|A thread of|.* wrote first|.* replied|Then .* replied|.* wrote back|.* followed up|.* wrote again|It has )/

describe('one message: as a single email reads', () => {
  it('is exactly the email reader’s reading', () => {
    const message = msg(SARAH, MON, 'Can we move the review to Thursday? The deck is late.')
    expect(read([message])).toEqual(emailToSentences({ from: SARAH, subject: 'Re: Q3 review', bodyText: message.bodyText }))
    expect(read([message])).toEqual([
      'From Sarah Chen, about Q3 review.',
      'Can we move the review to Thursday?',
      'The deck is late.',
    ])
  })

  it('drafts around it leave it a single email', () => {
    const draft = msg(LIAM, TUE, 'Sure, Thursday it is.', { mine: true, isDraft: true })
    expect(read([msg(SARAH, MON, 'Can we meet Thursday?'), draft])).toEqual([
      'From Sarah Chen, about Q3 review.',
      'Can we meet Thursday?',
    ])
  })

  it('says how many files it carries after the preface, never their names', () => {
    expect(read([msg(SARAH, MON, 'Numbers attached.', { attachmentCount: 1 })])).toEqual([
      'From Sarah Chen, about Q3 review.',
      'It has an attachment.',
      'Numbers attached.',
    ])
    expect(read([msg(SARAH, MON, 'Numbers attached.', { attachmentCount: 2 })])).toEqual([
      'From Sarah Chen, about Q3 review.',
      'It has two attachments.',
      'Numbers attached.',
    ])
  })

  it('its subject is its own, else the thread’s', () => {
    expect(read([{ from: SARAH, date: MON, bodyText: 'Hello.' }], 'Fwd: Launch')).toEqual(['From Sarah Chen, about Launch.', 'Hello.'])
  })

  it('nothing but drafts reads nothing', () => {
    expect(read([msg(LIAM, MON, 'Draft.', { mine: true, isDraft: true })])).toEqual([])
    expect(read([])).toEqual([])
  })
})

describe('several messages: who wrote what, when', () => {
  it('opens with the subject and the count, then reads oldest to newest with who and when', () => {
    expect(
      read([
        msg(SARAH, MON, "Can we move the Q3 review to Thursday? The deck isn't ready.", { subject: 'Q3 review' }),
        msg(BOB, TUE, 'Thursday works. The latest numbers are attached.', { attachmentCount: 2 }),
        msg(LIAM, THU, 'Great, see you both Thursday.', { mine: true }),
      ]),
    ).toEqual([
      'Q3 review: a thread of three emails.',
      'Sarah wrote first, on Monday.',
      'Can we move the Q3 review to Thursday?',
      "The deck isn't ready.",
      'Bob replied the next day, with two attachments.',
      'Thursday works.',
      'The latest numbers are attached.',
      'Then you replied yesterday.',
      'Great, see you both Thursday.',
    ])
  })

  it('sorts by date when every message has one; else keeps the order given', () => {
    const late = msg(BOB, TUE, 'Second.')
    const early = msg(SARAH, MON, 'First.')
    expect(read([late, early])).toEqual([
      'Q3 review: a thread of two emails.',
      'Sarah wrote first, on Monday.',
      'First.',
      'Bob replied the next day.',
      'Second.',
    ])
    expect(read([{ ...late, date: null }, early])).toEqual([
      'Q3 review: a thread of two emails.',
      'Bob wrote first.',
      'Second.',
      'Sarah replied on Monday.',
      'First.',
    ])
  })

  it('the user’s own messages are "you"', () => {
    expect(read([msg(LIAM, THU, 'Can we meet?', { mine: true }), msg(SARAH, FRI, 'Yes, at noon.')])).toEqual([
      'Q3 review: a thread of two emails.',
      'You wrote first, yesterday.',
      'Can we meet?',
      'Sarah replied today.',
      'Yes, at noon.',
    ])
  })

  it('the same sender again follows up; replies vary their wording, in a fixed turn', () => {
    expect(
      read([
        msg(SARAH, MON, 'One.'),
        msg(SARAH, MON, 'Two.'),
        msg(BOB, MON, 'Three.'),
        msg(SARAH, MON, 'Four.'),
        msg(BOB, MON, 'Five.'),
        msg(BOB, MON, 'Six.'),
        msg(LIAM, MON, 'Seven.', { mine: true }),
        msg(LIAM, MON, 'Eight.', { mine: true }),
      ]).filter((s) => INTRO_RE.test(s)),
    ).toEqual([
      'Q3 review: a thread of eight emails.',
      'Sarah wrote first, on Monday.',
      'Sarah followed up.',
      'Bob replied.',
      'Then Sarah replied.',
      'Bob wrote back.',
      'Bob wrote again.',
      'You replied.',
      'You followed up.',
    ])
  })

  it('says a day only when it changes: today, yesterday, the next day, on Monday, last Saturday, on September 3', () => {
    const intros = (dates: string[]) =>
      read(dates.map((date, i) => msg(i % 2 ? BOB : SARAH, date, `Message ${i + 1}.`))).filter((s) => INTRO_RE.test(s)).slice(1)

    expect(intros(['2026-09-03T10:00:00Z', '2026-09-04T10:00:00Z', '2026-09-26T10:00:00Z', MON, MON, WED, THU, FRI, FRI])).toEqual([
      'Sarah wrote first, on September 3.',
      'Bob replied the next day.',
      // Within the week before, by its weekday.
      'Then Sarah replied last Saturday.',
      'Bob wrote back on Monday.',
      'Sarah replied.',
      'Then Bob replied on Wednesday.',
      // Yesterday and today, rather than "the next day": said from now.
      'Sarah wrote back yesterday.',
      'Bob replied today.',
      'Then Sarah replied.',
    ])
    // Another year says its year.
    expect(intros(['2025-12-03T10:00:00Z', MON])[0]).toBe('Sarah wrote first, on December 3, 2025.')
  })

  it('days are the user’s: counted in their zone', () => {
    // 01:00 UTC on Tuesday is still Monday evening in Los Angeles.
    const out = emailThreadToSentences(
      { subject: 'Q3 review', messages: [msg(SARAH, MON, 'One.'), msg(BOB, '2026-09-29T01:00:00Z', 'Two.')] },
      { now: NOW, timeZone: 'America/Los_Angeles' },
    )
    expect(out).toContain('Bob replied.')
  })

  it('files fold into the intro, counted, never named', () => {
    expect(
      read([
        msg(SARAH, MON, 'Draft deck attached.', { attachmentCount: 1 }),
        msg(BOB, TUE, 'Looks good.', { attachmentCount: 3 }),
      ]).filter((s) => INTRO_RE.test(s)),
    ).toEqual(['Q3 review: a thread of two emails.', 'Sarah wrote first, on Monday, with an attachment.', 'Bob replied the next day, with three attachments.'])
  })

  it('a reply with nothing of its own is left out; one that only carries files is just its intro', () => {
    const quotedOnly = `<div class="gmail_quote"><div class="gmail_attr">On Mon, Sep 28, 2026 at 9:00 AM Sarah Chen &lt;sarah@acme.com&gt; wrote:<br></div><blockquote class="gmail_quote">Can we meet Thursday?</blockquote></div>`
    expect(
      read([
        msg(SARAH, MON, 'Can we meet Thursday?'),
        { from: BOB, date: MON, subject: 'Re: Q3 review', bodyHtml: quotedOnly },
        { from: BOB, date: MON, subject: 'Re: Q3 review', bodyHtml: quotedOnly, attachmentCount: 2 },
        msg(LIAM, MON, 'Thursday it is.', { mine: true }),
      ]),
    ).toEqual([
      'Q3 review: a thread of four emails.',
      'Sarah wrote first, on Monday.',
      'Can we meet Thursday?',
      'Bob replied with two attachments.',
      'Then you replied.',
      'Thursday it is.',
    ])
  })

  it('drafts are never read, nor counted', () => {
    expect(
      read([
        msg(SARAH, MON, 'Can we meet Thursday?'),
        msg(BOB, TUE, 'Yes.'),
        msg(LIAM, WED, 'Sure, Thursday.', { mine: true, isDraft: true }),
      ]),
    ).toEqual(['Q3 review: a thread of two emails.', 'Sarah wrote first, on Monday.', 'Can we meet Thursday?', 'Bob replied the next day.', 'Yes.'])
  })

  it('a reply reads only its own words: the email it quotes is not read twice (Gmail, Outlook, plain text)', () => {
    const first = 'Can we move the Q3 review to Thursday? The deck is not ready.'
    const gmail = `<div dir="ltr">Thursday works for me.<div><br></div><div>Best,</div><div>Bob</div></div><div class="gmail_quote"><div class="gmail_attr">On Mon, Sep 28, 2026 at 9:00 AM Sarah Chen &lt;sarah@acme.com&gt; wrote:<br></div><blockquote class="gmail_quote">${first}</blockquote></div>`
    const outlook = `<div>Thursday at 10 then.</div><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> Bob Lee<br><b>Sent:</b> Tuesday, September 29, 2026<br><b>Subject:</b> Re: Q3 review</div><div>Thursday works for me.</div><blockquote>${first}</blockquote>`
    const plain = `Perfect, see you then.\n\nOn Tue, Sep 29, 2026 at 4:00 PM Sarah Chen <sarah@acme.com> wrote:\n> Thursday at 10 then.\n>\n> On Tue, Bob Lee wrote:\n>> Thursday works for me.`
    const out = read([
      msg(SARAH, MON, first, { subject: 'Q3 review' }),
      { from: BOB, date: TUE, subject: 'Re: Q3 review', bodyHtml: gmail },
      { from: SARAH, date: TUE, subject: 'Re: Q3 review', bodyHtml: outlook },
      msg(LIAM, WED, plain, { mine: true }),
    ])
    expect(out).toEqual([
      'Q3 review: a thread of four emails.',
      'Sarah wrote first, on Monday.',
      'Can we move the Q3 review to Thursday?',
      'The deck is not ready.',
      'Bob replied the next day.',
      'Thursday works for me.',
      'Then Sarah replied.',
      'Thursday at 10 then.',
      'You wrote back the next day.',
      'Perfect, see you then.',
    ])
    expect(out.filter((s) => s === 'Thursday works for me.')).toHaveLength(1)
    expect(out.filter((s) => s.startsWith('Can we move'))).toHaveLength(1)
  })

  it('a message in a thread drops its closing sign-off (the intro said who), but a reply that is only "Thanks!" keeps it', () => {
    expect(
      read([
        msg(SARAH, MON, 'Can we meet Thursday?\n\nBest,\nSarah'),
        msg(BOB, TUE, 'Thanks!'),
        msg(SARAH, TUE, 'Great, booked.\n\nThanks, Sarah'),
      ]),
    ).toEqual([
      'Q3 review: a thread of three emails.',
      'Sarah wrote first, on Monday.',
      'Can we meet Thursday?',
      'Bob replied the next day.',
      'Thanks!',
      'Then Sarah replied.',
      'Great, booked.',
    ])
  })

  it('the first message loses an opening line that repeats the subject; the opener says the subject without Re: or end punctuation', () => {
    expect(read([msg(SARAH, MON, 'Q3 review\n\nCan we meet?'), msg(BOB, TUE, 'Yes.')], 'RE: [EXT] Q3 review?')).toEqual([
      'Q3 review: a thread of two emails.',
      'Sarah wrote first, on Monday.',
      'Can we meet?',
      'Bob replied the next day.',
      'Yes.',
    ])
    expect(read([msg(SARAH, MON, 'Hi.', { subject: '' }), msg(BOB, TUE, 'Hey.', { subject: '' })], null)[0]).toBe('A thread of two emails.')
  })
})

describe('names', () => {
  const intros = (...froms: Array<ThreadSpeechMessage['from'] | 'you'>) =>
    read(froms.map((from, i) => (from === 'you' ? msg(LIAM, MON, `M${i}.`, { mine: true }) : msg(from, MON, `M${i}.`))))
      .filter((s) => INTRO_RE.test(s))
      .slice(1)

  it('given names; the full name when two people in the thread share a given name', () => {
    expect(intros(SARAH, { name: 'Sarah Park', email: 'park@globex.com' }, BOB)).toEqual([
      'Sarah Chen wrote first, on Monday.',
      'Sarah Park replied.',
      'Then Bob replied.',
    ])
  })

  it('tags off, "Last, First" turned round, a surname in capitals softened', () => {
    expect(
      intros(
        { name: 'Ann LEE (EXT)', email: 'ann@globex.com' },
        { name: 'Lee, Bob', email: 'bob@globex.com' },
        { name: '"Jian Min LIM" [External]', email: 'jm@globex.com' },
      ),
    ).toEqual(['Ann wrote first, on Monday.', 'Bob replied.', 'Then Jian Min replied.'])
    expect(intros({ name: 'Ann LEE (EXT)', email: 'ann@globex.com' }, { name: 'Ann Smith', email: 'smith@x.com' })).toEqual([
      'Ann Lee wrote first, on Monday.',
      'Ann Smith replied.',
    ])
  })

  it('no name: the address’s own part as a name, never "@…"; a team or service whole', () => {
    const out = intros({ name: null, email: 'jordan.lee+news@acme.com' }, { name: 'Acme Support', email: 'help@acme.com' }, { name: 'sarah@acme.com', email: 'sarah@acme.com' })
    expect(out).toEqual(['Jordan Lee wrote first, on Monday.', 'Acme Support replied.', 'Then Sarah replied.'])
    expect(out.join(' ')).not.toMatch(/@|acme\.com|\bat acme\b/i)
  })

  it('one person under one name from two addresses is one sender: they follow up', () => {
    expect(intros(SARAH, { name: 'Sarah Chen', email: 'sarah.chen@gmail.com' })).toEqual([
      'Sarah wrote first, on Monday.',
      'Sarah followed up.',
    ])
  })

  it('never he or she: the name again, or "you"', () => {
    const threads: ThreadSpeechMessage[][] = [
      [msg(SARAH, MON, 'One.'), msg(SARAH, TUE, 'Two.'), msg(BOB, WED, 'Three.', { attachmentCount: 1 }), msg(LIAM, THU, 'Four.', { mine: true })],
      [msg(LIAM, MON, 'One.', { mine: true }), msg(LIAM, FRI, 'Two.', { mine: true }), msg({ name: 'Ann LEE', email: 'a@x.com' }, FRI, 'Three.', { attachmentCount: 4 })],
    ]
    for (const thread of threads) {
      const ours = read(thread).filter((s) => INTRO_RE.test(s))
      expect(ours.length).toBeGreaterThan(thread.length - 1)
      for (const sentence of ours) expect(sentence).not.toMatch(/\b(?:he|she|him|her|his|hers|himself|herself)\b/i)
    }
  })
})

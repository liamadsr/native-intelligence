// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { browserSelectionToSentences as read, type HighlightedMail, type HighlightedMessage } from '../browser-speech'
import { plainTextToSentences } from '../speech-text'

/**
 * A highlight in the in-app browser → what listen mode says (../browser-speech).
 * Texts are the page's as WebKit's Selection.toString gives it: a line per
 * block (flex and grid items too), table cells split by tabs. Names and
 * messages here are made up.
 */

const readMessages = (messages: HighlightedMessage[], text = '') => read(text, { messages })
const readMail = (mail: HighlightedMail, text = '') => read(text, { mail })

describe('browserSelectionToSentences — Teams (the desktop says who wrote what)', () => {
  /** What desktop selection_watch.js posts for a drag over a Teams chat
   *  (checked in WebKit against a page built like Teams' message list). */
  const TEAMS_MESSAGES = [
    {
      author: 'Maya REYES',
      text: 'Sorry all, need to drop - thank you Luis! Liam, will follow up with you on anything I can support on',
    },
    { event: true, text: '12:36 PM Meeting ended: 34m 44s' },
    { author: 'Tom BAKER (EXT)', text: 'Luis ORTEGA (EXT) here is our list of users\nTeam User List.loop' },
    { author: 'Luis ORTEGA (EXT)', text: '100% good for client search 😜' },
    { author: 'Luis ORTEGA (EXT)', text: 'examples are in the data dictionary + you will find url for int & uat' },
    { author: 'Liam Alizadeh', mine: true, text: 'Thanks, will do. Talk soon.' },
  ]

  it('reads who said what: given names, "you", an event under no name, one sender’s run named once', () => {
    expect(readMessages(TEAMS_MESSAGES, '(the page text, not read when the messages are given)')).toEqual([
      'Maya said: Sorry all, need to drop - thank you Luis!',
      'Liam, will follow up with you on anything I can support on.',
      'Meeting ended: 34 minutes 44 seconds.',
      'Tom then said: Luis Ortega here is our list of users.',
      'Team User List.',
      'Luis then said: 100% good for client search.',
      'examples are in the data dictionary + you will find url for int & uat.',
      'You then said: Thanks, will do.',
      'Talk soon.',
    ])
  })

  it('names senders as people say them', () => {
    expect(readMessages([{ author: 'Jian Min LIM', text: 'Hello.' }])).toEqual(['Jian Min said: Hello.'])
    expect(readMessages([{ author: 'LEE, Ann', text: 'Hello.' }])).toEqual(['Ann said: Hello.'])
    expect(readMessages([{ author: 'Priya Nair (Contractor)', text: 'Hello.' }])).toEqual(['Priya said: Hello.'])
    // Two senders sharing a given name: their full names.
    expect(
      readMessages([
        { author: 'Ann LEE', text: 'One.' },
        { author: 'Ann KIM', text: 'Two.' },
      ]),
    ).toEqual(['Ann Lee said: One.', 'Ann Kim then said: Two.'])
    // A name no header would look like is still said, as written.
    expect(readMessages([{ author: 'build-bot 2', text: 'Deployed.' }])).toEqual(['build-bot said: Deployed.'])
  })

  it('a message with no sender is read without one; nothing in it, nothing read', () => {
    expect(readMessages([{ author: 'Ann LEE', text: 'Hi.' }, { text: 'Hello.' }])).toEqual(['Ann said: Hi.', 'Hello.'])
    expect(readMessages([{ author: 'Ann LEE', text: '🎉' }])).toEqual([])
  })

  it('no messages given: reads the text', () => {
    expect(readMessages([], 'Plain words here')).toEqual(['Plain words here.'])
  })
})

describe('browserSelectionToSentences — Outlook (the desktop gives the highlighted mail)', () => {
  /** What desktop selection_watch.js posts for a drag over an Outlook thread
   *  from its subject down (checked in WebKit against a page built like
   *  Outlook's reading pane): Outlook's "x_"-prefixed markup, a signature, a
   *  reply header over the old message, a collapsed message's preview. */
  const THREAD: HighlightedMail = {
    subject: 'RE: Q3 renewal',
    messages: [
      {
        from: 'LEE, Ann',
        html:
          '<div><p>Hi all, the renewal is signed. Thanks for pushing it over the line.</p>' +
          '<div id="x_Signature"><p>Ann Lee</p><p>VP Sales | +1 555 0100</p></div></div>',
      },
      {
        from: 'Bob King',
        html:
          '<div class="x_elementToProof"><p>Great news. I will tell the team tomorrow.</p></div>' +
          '<div id="x_x_Signature"><p>Bob</p></div>' +
          '<div id="x_divRplyFwdMsg"><b>From:</b> Ann Lee<br><b>Sent:</b> Tuesday<br><b>Subject:</b> Q3 renewal</div>' +
          '<div><p>Earlier message that should not be read.</p></div>',
      },
      { from: 'Cho, Dana', text: 'Congrats both, drinks are on me this Friday', preview: true },
    ],
  }

  it('reads the thread like Dial8 Mail: from and about, the messages without signatures or history, who wrote each', () => {
    expect(readMail(THREAD, '(the page text, not read when the mail is given)')).toEqual([
      'From Ann, about Q3 renewal.',
      'Hi all, the renewal is signed.',
      'Thanks for pushing it over the line.',
      'Bob then wrote: Great news.',
      'I will tell the team tomorrow.',
      'Dana then wrote: Congrats both, drinks are on me this Friday.',
    ])
  })

  it('without the subject highlighted: "Ann wrote: …"', () => {
    expect(readMail({ messages: [{ from: 'LEE, Ann', html: '<p>the renewal is signed</p>' }] })).toEqual([
      // As Dial8 Mail reads a body: its words as written.
      'Ann wrote: the renewal is signed',
    ])
    expect(
      readMail({
        messages: [
          { from: 'LEE, Ann', html: '<p>One.</p>' },
          { from: 'LEE, Ann', html: '<p>Two.</p>' },
          { html: '<p>Three.</p>' },
        ],
      }),
    ).toEqual(['Ann wrote: One.', 'Two.', 'Three.'])
  })

  it('a message with nothing left to read (only its signature highlighted) is skipped', () => {
    expect(
      readMail({
        messages: [
          { from: 'LEE, Ann', html: '<div id="x_Signature"><p>Ann Lee</p></div>' },
          { from: 'Bob King', html: '<p>Sounds good.</p>' },
        ],
      }),
    ).toEqual(['Bob wrote: Sounds good.'])
  })

  it('no messages: reads the page text', () => {
    expect(readMail({ subject: 'Hi', messages: [] }, 'Plain words here')).toEqual(['Plain words here.'])
  })
})

describe('browserSelectionToSentences — a chat, from the page text', () => {
  /** A drag over a chat laid out like Teams, as WebKit gives its text: an
   *  avatar's initials, a control message, the "Last read" divider, a shared
   *  list, follow-ups and one of your own. */
  const CHAT_DRAG = [
    '',
    'Maya REYES',
    '12:33 PM',
    'Sorry all, need to drop - thank you Luis! Liam, will follow up with you on anything I can support on',
    '',
    '12:36 PM',
    'Meeting ended: 34m 44s',
    'Last read',
    'TB',
    'Tom BAKER (EXT)',
    '12:38 PM',
    'Luis ORTEGA (EXT) here is our list of users',
    'Team User List.loop',
    'Name\tEmail\tAccount Name (AD Id)',
    '12\tPriya Nair\tpriya.nair@example.com\tpnair',
    'Luis ORTEGA (EXT)',
    '1:04 PM',
    '100% good for client search 😜',
    'examples are in the data dictionary + you will find url for int & uat',
    '1:10 PM',
    'Thanks, will do.',
  ].join('\n')

  it('reads who said what, without the furniture', () => {
    expect(read(CHAT_DRAG)).toEqual([
      'Maya said: Sorry all, need to drop - thank you Luis!',
      'Liam, will follow up with you on anything I can support on.',
      'Meeting ended: 34 minutes 44 seconds.',
      'Tom then said: Luis Ortega here is our list of users.',
      'Team User List.',
      'Luis then said: 100% good for client search.',
      'examples are in the data dictionary + you will find url for int & uat.',
      'Thanks, will do.',
    ])
  })

  it('reads a header on one line, and Discord’s', () => {
    expect(read('Ann LEE 12:33 PM\nShipping today.\nBob KING, 12:40 PM\nNice work!')).toEqual([
      'Ann said: Shipping today.',
      'Bob then said: Nice work!',
    ])
    expect(read('ann — Today at 9:02 AM\nhi\nBea — Today at 9:03 AM\nMorning all')).toEqual([
      'hi.',
      'Bea said: Morning all.',
    ])
  })

  it('reads older stamps: a day or a date before the time', () => {
    expect(read('Ann LEE\nYesterday 4:02 PM\nDone.\nBob KING\n9/29 3:12 PM\nGreat.')).toEqual([
      'Ann said: Done.',
      'Bob then said: Great.',
    ])
  })

  it('a name needs a sign that it is a person’s: a tag, a surname in capitals, its avatar, "You"', () => {
    expect(read('Zed (EXT)\n12:33 PM\nOn it.')).toEqual(['Zed said: On it.'])
    expect(read('MG\nMaria Garcia\n12:35 PM\nOn it.')).toEqual(['Maria said: On it.'])
    expect(read('You\n12:33 PM\nOn my way.\nAnn LEE\n12:34 PM\nGreat.')).toEqual([
      'You said: On my way.',
      'Ann then said: Great.',
    ])
    // Without one, a Title Case line above a time is the message before it.
    expect(read('Ann LEE\n12:30 PM\nWho owns the renewal?\nMaria Garcia\n12:35 PM\nGreat, I will ping her.')).toEqual([
      'Ann said: Who owns the renewal?',
      'Maria Garcia.',
      'Great, I will ping her.',
    ])
    expect(read('Ann LEE\n12:30 PM\nThanks Bob\nBest Regards\n12:34 PM\nWill do.')).toEqual([
      'Ann said: Thanks Bob.',
      'Best Regards.',
      'Will do.',
    ])
  })

  it('names senders as people say them, one sender’s run once', () => {
    expect(read('Jian Min LIM\n12:33 PM\nHello.')).toEqual(['Jian Min said: Hello.'])
    expect(read('LEE, Ann\n12:33 PM\nHello.')).toEqual(['Ann said: Hello.'])
    expect(read('Ann LEE\n12:33 PM\nOne.\nAnn KIM\n12:34 PM\nTwo.')).toEqual([
      'Ann Lee said: One.',
      'Ann Kim then said: Two.',
    ])
    expect(read('Ann LEE\n12:33 PM\nFirst.\nAnn LEE\n12:50 PM\nSecond.')).toEqual(['Ann said: First.', 'Second.'])
  })

  it('a message with no name (your own) is read without one, never under the last sender', () => {
    expect(read('Ann LEE\n12:33 PM\nCan you send it?\n12:34 PM\nSending now.')).toEqual([
      'Ann said: Can you send it?',
      'Sending now.',
    ])
  })

  it('drops dividers, controls, reaction counts and avatars, but never a message’s first line', () => {
    expect(
      read('Today\nAB\nAnn BELL\n12:33 PM\nShip it.\n👍 3\n2\nReply\n2 Like reactions.2\nNew messages\nBo CHEN\n12:40 PM\nDone (edited)'),
    ).toEqual(['Ann said: Ship it.', 'Bo then said: Done.'])
    expect(read('Ann LEE\n12:33 PM\nWhen?\n12:34 PM\nMonday.\n12:35 PM\n12\n12:36 PM\nOK\nOlivia KIM\n12:37 PM\nSent.')).toEqual([
      'Ann said: When?',
      'Monday.',
      '12.',
      'OK.',
      'Olivia then said: Sent.',
    ])
  })

  it('reads a chat event under no one’s name, and a member event only when its actor is a name', () => {
    expect(read('Ann LEE\n12:33 PM\nWelcome!\nAnn Lee added Bob King to the chat.\nHi all.')).toEqual([
      'Ann said: Welcome!',
      'Ann Lee added Bob King to the chat.',
      'Hi all.',
    ])
    expect(read('Ann LEE\n12:33 PM\nI think Bob left the meeting early.\nMore later.')).toEqual([
      'Ann said: I think Bob left the meeting early.',
      'More later.',
    ])
  })

  it('reads a partial first message (the drag began mid-message) without a name', () => {
    expect(read('the end of a message.\nAnn LEE\n12:33 PM\nNext one.')).toEqual([
      'the end of a message.',
      'Ann said: Next one.',
    ])
  })
})

describe('browserSelectionToSentences — pages that only look like a chat', () => {
  it('a calendar, a schedule, a byline: read as a page', () => {
    const calendar = 'Design Review\n10:00 AM\nRoom 4\nBudget Sync\n2:00 PM\nZoom'
    expect(read(calendar)).toEqual(plainTextToSentences(calendar))
    expect(read('Standup - 9:30 AM')).toEqual(['Standup - 9:30 AM.'])
    const schedule = 'Break\n10:30 AM\nTalks\nBreak\n3:00 PM'
    expect(read(schedule)).toEqual(plainTextToSentences(schedule))
    expect(read('Jane Smith | September 29, 2026 at 4:02 PM\nThe river rose.')).toEqual([
      'Jane Smith | September 29, 2026 at 4:02 PM.',
      'The river rose.',
    ])
    expect(read('OPENING REMARKS\n9:00 AM\nWelcome.')).toEqual(['OPENING REMARKS.', '9:00 AM.', 'Welcome.'])
  })
})

describe('browserSelectionToSentences — any page', () => {
  it('reads plain text exactly as plainTextToSentences does', () => {
    const text = 'Getting started\nInstall the app. Then sign in!\n\nIt takes a minute'
    expect(read(text)).toEqual(plainTextToSentences(text))
    expect(read('Use *bold* at https://docs.dial8.ai/api?x=1 🎉')).toEqual(['Use *bold* at docs.dial8.ai.'])
  })

  it('drops footnote markers and lines that are only a page control, nothing more', () => {
    expect(
      read('Advertisement\nThe river is long.[1][2] It floods in spring.[citation needed]\nShare\nRead more'),
    ).toEqual(['The river is long.', 'It floods in spring.'])
    expect(read('Read by over two million people each month, the newsletter grew.')).toEqual([
      'Read by over two million people each month, the newsletter grew.',
    ])
    expect(read('Set x[i] to y[j].\nReply\nSeen')).toEqual(['Set x[i] to y[j].', 'Reply.', 'Seen.'])
  })

  it('reads a table row by row, its cells as a list', () => {
    expect(read('Name\tRole\nAnn Lee\tDesign')).toEqual(['Name, Role.', 'Ann Lee, Design.'])
  })

  it('reads files without their extension and compact durations in words, and nothing else like them', () => {
    expect(read('See Q3 plan.docx and Team List.loop')).toEqual(['See Q3 plan and Team List.'])
    expect(read('The call ran 1h 5m and the demo 34m 44s.')).toEqual([
      'The call ran 1 hour 5 minutes and the demo 34 minutes 44 seconds.',
    ])
    expect(read('Music of the 60s 70s and 80s, over 100m 200m.')).toEqual([
      'Music of the 60s 70s and 80s, over 100m 200m.',
    ])
    expect(read('Visit acme.md or grab notes.zip')).toEqual(['Visit acme.md or grab notes.zip.'])
  })

  it('a time on a page that is no chat stays', () => {
    expect(read('9:00 AM\nKeynote\n10:30 AM\nPanel')).toEqual(['9:00 AM.', 'Keynote.', '10:30 AM.', 'Panel.'])
  })

  it('stays fast on a long hostile line (the page writes the text)', () => {
    const started = performance.now()
    read(`a${'\t'.repeat(50_000)}`)
    read(`${'Ann '.repeat(12_000)}12:33 PM`)
    read(`Ann LEE\n12:33 PM\n${'x '.repeat(25_000)}`)
    read(`${'- '.repeat(25_000)}Today at 9:02 AM`)
    expect(performance.now() - started).toBeLessThan(1_000)
  })

  it('returns [] when nothing in it can be said', () => {
    expect(read('')).toEqual([])
    expect(read(`${String.fromCharCode(0x200b)}\n🎉\nShare`)).toEqual([])
  })
})

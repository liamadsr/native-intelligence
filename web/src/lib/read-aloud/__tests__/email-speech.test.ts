// @vitest-environment jsdom
/**
 * An email → what its "Listen" button reads (../email-speech). The contract,
 * pinned on realistic Gmail, Outlook (web and desktop), Apple Mail, Yahoo,
 * Thunderbird, plain-text, newsletter and transactional emails:
 *  - a preface: "From {name or address}, about {subject}." — Re:/Fwd:/[EXT]
 *    stripped, "From {sender}." with no subject;
 *  - then ONLY the message: no quoted history (quote containers,
 *    attributions, Outlook reply headers, "> " lines), no signature,
 *    tagline, footer or hidden text; the sender's own words after or between
 *    quoted parts (bottom-posted and inline replies) are read;
 *  - the sign-off is read with the name under it, not what follows (a P.S.
 *    is); a pure forward reads the forwarded message; a reply with nothing
 *    of its own reads only the preface;
 *  - every heuristic fails safe: when a sign-off, a footer word or an
 *    attribution could be the message, it is read.
 */
import { describe, it, expect } from 'vitest'
import { cleanSubject, emailBodyLines, emailPreface, emailToSentences, type EmailSpeechMessage } from '../email-speech'

const SARAH = { name: 'Sarah Chen', email: 'sarah@acme.com' }
const PREFACE = 'From Sarah Chen, about Q3 planning.'

/** What Listen reads for a message from Sarah, "Re: Q3 planning" unless given. */
function read(message: Partial<EmailSpeechMessage>): string[] {
  return emailToSentences({ from: SARAH, subject: 'Re: Q3 planning', bodyHtml: null, bodyText: null, ...message })
}

/** The body's sentences only, without the preface. */
function body(message: Partial<EmailSpeechMessage>): string[] {
  return read(message).slice(1)
}

describe('the preface', () => {
  it('names the sender and the subject without its prefixes and tags', () => {
    expect(read({ subject: 'RE: Fw: [EXT] Re: Q3 planning', bodyText: 'Tuesday works.' })).toEqual([
      PREFACE,
      'Tuesday works.',
    ])
    expect(cleanSubject('Re: Re: Fwd: Q3 planning')).toBe('Q3 planning')
    expect(cleanSubject('RE[2]: FW: Q3 planning')).toBe('Q3 planning')
    expect(cleanSubject('[EXTERNAL] RE: Q3 planning')).toBe('Q3 planning')
    expect(cleanSubject('EXTERNAL: Fwd: Q3 planning')).toBe('Q3 planning')
    // Only prefixes: words that start the same way stay.
    expect(cleanSubject('Regarding the budget')).toBe('Regarding the budget')
    expect(cleanSubject('External audit results')).toBe('External audit results')
  })

  it('a sender without a name reads as the address', () => {
    expect(read({ from: { name: null, email: 'sarah@acme.com' }, bodyText: 'Tuesday works.' })).toEqual([
      'From sarah@acme.com, about Q3 planning.',
      'Tuesday works.',
    ])
    // A name that says nothing (only an emoji) falls back to the address too.
    expect(emailPreface({ from: { name: '🚀', email: 'sarah@acme.com' }, subject: 'Q3' })).toBe('From sarah@acme.com, about Q3.')
    expect(emailPreface({ from: { name: '"Sarah Chen"', email: 'sarah@acme.com' }, subject: 'Q3' })).toBe('From Sarah Chen, about Q3.')
  })

  it('no subject: "From {sender}."; a subject ending in punctuation keeps it', () => {
    expect(read({ subject: 'Re:', bodyText: 'Tuesday works.' })).toEqual(['From Sarah Chen.', 'Tuesday works.'])
    expect(emailPreface({ from: SARAH, subject: '' })).toBe('From Sarah Chen.')
    expect(emailPreface({ from: SARAH, subject: 'Can we meet Tuesday?' })).toBe('From Sarah Chen, about Can we meet Tuesday?')
  })

  it('nothing in the body: only the preface', () => {
    expect(read({ bodyHtml: '<div><br></div>', bodyText: '' })).toEqual([PREFACE])
    expect(read({})).toEqual([PREFACE])
  })
})

// ── Replies: only the new message ──────────────────────────────────────────

const GMAIL_REPLY = `<div dir="ltr">Hi Liam,<div><br></div><div>Tuesday at 10 works for me. I'll bring the Q3 numbers and the hiring plan.</div><div><br></div><div>Best,</div><div>Sarah</div><br clear="all"><div><br></div><span class="gmail_signature_prefix">-- </span><br><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><div dir="ltr">Sarah Chen<div>VP Marketing | Acme</div><div>+1 (555) 010-0100</div></div></div></div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Fri, Sep 26, 2026 at 4:12 PM Liam Alizadeh &lt;<a href="mailto:liam@dial8.ai">liam@dial8.ai</a>&gt; wrote:<br></div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex"><div dir="ltr">Hi Sarah,<div><br></div><div>Can we meet Tuesday to go over Q3?</div><div><br></div><div>Liam</div></div></blockquote></div>`

const OUTLOOK_WEB_REPLY = `<html><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8"><style type="text/css" style="display:none;"> P {margin-top:0;margin-bottom:0;} </style></head><body dir="ltr"><div class="elementToProof" style="font-family: Aptos, sans-serif; font-size: 12pt;">Tuesday works for me.</div><div class="elementToProof" style="font-size: 12pt;">I'll send the agenda tonight.</div><div id="Signature"><div>Sarah Chen</div><div>VP Marketing, Acme</div></div><div id="appendonsend"></div><hr style="display:inline-block;width:98%" tabindex="-1"><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri, sans-serif" style="font-size:11pt" color="#000000"><b>From:</b> Liam &lt;liam@dial8.ai&gt;<br><b>Sent:</b> Friday, September 26, 2026 4:12 PM<br><b>To:</b> Sarah Chen &lt;sarah@acme.com&gt;<br><b>Subject:</b> Q3 planning</font><div>&nbsp;</div></div><div><div dir="ltr">Can we meet Tuesday?</div><div dir="ltr">Liam</div></div></body></html>`

/** Word-generated HTML: MsoNormal paragraphs, a signature with nothing to mark
 *  it, and the old message under a bordered "From: / Sent: / Subject:" block. */
const OUTLOOK_DESKTOP_REPLY = `<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta name="Generator" content="Microsoft Word 15 (filtered medium)"><style><!--
@font-face {font-family:Calibri; panose-1:2 15 5 2 2 2 4 3 2 4;}
p.MsoNormal, li.MsoNormal, div.MsoNormal {margin:0in; font-size:11.0pt; font-family:"Calibri",sans-serif;}
span.EmailStyle19 {mso-style-type:personal-reply; color:windowtext;}
@page WordSection1 {size:8.5in 11.0in;}
div.WordSection1 {page:WordSection1;}
--></style></head><body lang="EN-US" link="#0563C1"><div class="WordSection1"><p class="MsoNormal">Hi Liam,<o:p></o:p></p><p class="MsoNormal"><o:p>&nbsp;</o:p></p><p class="MsoNormal">Tuesday works. I&#8217;ll bring the numbers.<o:p></o:p></p><p class="MsoNormal"><o:p>&nbsp;</o:p></p><p class="MsoNormal">Kind regards,<o:p></o:p></p><p class="MsoNormal">Sarah<o:p></o:p></p><p class="MsoNormal"><o:p>&nbsp;</o:p></p><p class="MsoNormal"><b>Sarah Chen</b> | VP Marketing<o:p></o:p></p><p class="MsoNormal">T: +1 555 010 0100<o:p></o:p></p><p class="MsoNormal"><a href="https://acme.com">acme.com</a><o:p></o:p></p><p class="MsoNormal"><o:p>&nbsp;</o:p></p><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0in 0in 0in"><p class="MsoNormal"><b>From:</b> Liam &lt;liam@dial8.ai&gt; <br><b>Sent:</b> Friday, September 26, 2026 4:12 PM<br><b>To:</b> Sarah Chen &lt;sarah@acme.com&gt;<br><b>Subject:</b> Q3 planning<o:p></o:p></p></div><p class="MsoNormal"><o:p>&nbsp;</o:p></p><p class="MsoNormal">Can we meet Tuesday to go over the plan?<o:p></o:p></p></div></body></html>`

/** iOS Mail: the tagline, then the attribution in its own cite blockquote. */
const APPLE_MAIL_REPLY = `<html aria-label="message body"><head><meta http-equiv="content-type" content="text/html; charset=utf-8"></head><body dir="auto"><div dir="ltr">Sounds great, see you Tuesday.</div><div dir="ltr"><br id="lineBreakAtBeginningOfSignature"><div dir="ltr">Sent from my iPhone</div><div dir="ltr"><br><blockquote type="cite">On Sep 26, 2026, at 4:12 PM, Liam &lt;liam@dial8.ai&gt; wrote:<br><br></blockquote></div><blockquote type="cite"><div dir="ltr">Can we meet Tuesday?</div></blockquote></div></body></html>`

describe('the subject is not read twice', () => {
  it('a newsletter headline that repeats the subject is skipped', () => {
    expect(
      read({
        from: { name: 'Dial8', email: 'news@dial8.ai' },
        subject: 'Product updates',
        bodyHtml: '<h1>Product updates</h1><p>Listen mode is here, and every reply can pause.</p>',
      }),
    ).toEqual(['From Dial8, about Product updates.', 'Listen mode is here, and every reply can pause.'])
  })

  it('a headline that is most of the subject, or the subject plus a date, is skipped', () => {
    const news = { from: { name: 'Dial8', email: 'news@dial8.ai' }, subject: 'Dial8 product updates: September' }
    expect(read({ ...news, bodyHtml: '<h2>Product updates</h2><p>Listen mode is here.</p>' }).slice(1)).toEqual([
      'Listen mode is here.',
    ])
    expect(
      read({ ...news, subject: 'Product updates', bodyHtml: '<p>Product updates — September 2026</p><p>Listen mode is here.</p>' }).slice(1),
    ).toEqual(['Listen mode is here.'])
  })

  it('a plain-text title line is skipped; a greeting or a sentence that shares its words is read', () => {
    expect(body({ subject: 'Q3 planning', bodyText: 'Q3 planning\n\nTuesday works for me.' })).toEqual(['Tuesday works for me.'])
    expect(body({ subject: 'Hi Liam, quick question', bodyText: 'Hi Liam,\n\nDoes Tuesday work?' })).toEqual([
      'Hi Liam,',
      'Does Tuesday work?',
    ])
    expect(body({ subject: 'Q3 planning', bodyText: 'Q3 planning is on track, and the budget review moved to Friday.' })).toEqual([
      'Q3 planning is on track, and the budget review moved to Friday.',
    ])
  })

  it('a button further down that repeats the subject is read (the opening ends at the first real sentence)', () => {
    expect(
      body({
        subject: 'Reset your password',
        bodyText: 'Hi Liam,\n\nYou asked to reset the password for your Acme account just now.\n\nReset your password\n\nThanks',
      }),
    ).toEqual(['Hi Liam,', 'You asked to reset the password for your Acme account just now.', 'Reset your password', 'Thanks'])
  })

  it('only near the top, and only once', () => {
    expect(
      body({
        subject: 'Q3 planning',
        bodyText: 'Hi Liam,\n\nSome notes.\n\nMore notes.\n\nQ3 planning\n\nThe end.',
      }),
    ).toEqual(['Hi Liam,', 'Some notes.', 'More notes.', 'Q3 planning', 'The end.'])
  })
})

describe('replies: only the new message', () => {
  it('Gmail: the gmail_quote and the gmail_signature go; the sign-off keeps its name', () => {
    expect(read({ bodyHtml: GMAIL_REPLY })).toEqual([
      PREFACE,
      'Hi Liam,',
      'Tuesday at 10 works for me.',
      "I'll bring the Q3 numbers and the hiring plan.",
      'Best, Sarah',
    ])
  })

  it('Outlook on the web: #Signature, and everything from appendonsend / divRplyFwdMsg on, go', () => {
    expect(read({ bodyHtml: OUTLOOK_WEB_REPLY })).toEqual([PREFACE, 'Tuesday works for me.', "I'll send the agenda tonight."])
  })

  it('Outlook desktop: the bordered From/Sent/Subject block ends it; the unmarked signature goes after the sign-off', () => {
    expect(read({ bodyHtml: OUTLOOK_DESKTOP_REPLY })).toEqual([
      PREFACE,
      'Hi Liam,',
      'Tuesday works.',
      'I’ll bring the numbers.',
      'Kind regards, Sarah',
    ])
  })

  it('Apple Mail: blockquote type=cite and "Sent from my iPhone" go', () => {
    expect(read({ bodyHtml: APPLE_MAIL_REPLY })).toEqual([PREFACE, 'Sounds great, see you Tuesday.'])
  })

  it('Yahoo: the yahoo_quoted container goes, attribution and all', () => {
    const html = `<div dir="ltr">Tuesday it is.</div><div><br></div><div class="yahoo_quoted" id="yahoo_quoted_123"><div><div>On Friday, September 26, 2026, 04:12:00 PM EDT, Liam &lt;liam@dial8.ai&gt; wrote:</div><div><br></div><div>Can we meet Tuesday?</div></div></div>`
    expect(body({ bodyHtml: html })).toEqual(['Tuesday it is.'])
  })

  it('a bottom-posted reply (Thunderbird): the words under the quote are the message', () => {
    const html = `<html><body><div class="moz-cite-prefix">On 9/26/26 4:12 PM, Liam wrote:<br></div><blockquote type="cite" cite="mid:abc@dial8.ai">Can we meet Tuesday?</blockquote><p>Yes, Tuesday at 10 works.</p><div class="moz-signature">-- <br>Sarah Chen<br>Acme</div></body></html>`
    expect(body({ bodyHtml: html })).toEqual(['Yes, Tuesday at 10 works.'])
  })

  it('an inline reply in Gmail: the answers between the quoted parts are read, the quoted parts are not', () => {
    const html = `<div dir="ltr">See my answers inline.</div><div class="gmail_quote"><div class="gmail_attr">On Fri, Sep 26, 2026 at 4:12 PM Liam &lt;liam@dial8.ai&gt; wrote:</div><blockquote class="gmail_quote">Can we meet Tuesday?</blockquote><div>Yes, Tuesday works.</div><blockquote class="gmail_quote">Can you bring the numbers?</blockquote><div>Will do.</div></div>`
    expect(body({ bodyHtml: html })).toEqual(['See my answers inline.', 'Yes, Tuesday works.', 'Will do.'])
  })

  it('plain text: "> " lines and an "On … wrote:" wrapped onto two lines go', () => {
    const text = [
      'Sounds good, Tuesday it is.',
      '',
      'Best,',
      'Sarah',
      '',
      'On Fri, Sep 26, 2026 at 4:12 PM Liam Alizadeh <liam@dial8.ai>',
      'wrote:',
      '',
      '> Hi Sarah,',
      '>',
      '> Can we meet Tuesday?',
      '>',
      '> Liam',
    ].join('\n')
    expect(read({ bodyText: text })).toEqual([PREFACE, 'Sounds good, Tuesday it is.', 'Best, Sarah'])
  })

  it('plain text, answered inline: every answer is read, no quoted line', () => {
    const text = [
      'Answers inline.',
      '',
      'On Fri, Sep 26, 2026 at 4:12 PM Liam <liam@dial8.ai> wrote:',
      '> Can we meet Tuesday?',
      '',
      'Yes, Tuesday works.',
      '',
      '> And can you bring the numbers?',
      '',
      'Will do.',
      '',
      '-- ',
      'Sarah',
    ].join('\n')
    expect(body({ bodyText: text })).toEqual(['Answers inline.', 'Yes, Tuesday works.', 'Will do.'])
  })

  it('Outlook plain text: the rule of underscores and the header block under it go', () => {
    const text = 'Works for me.\n\n________________________________\nFrom: Liam <liam@dial8.ai>\nSent: Friday, September 26, 2026 4:12 PM\nTo: Sarah Chen <sarah@acme.com>\nSubject: Q3 planning\n\nCan we meet Tuesday?\n'
    expect(body({ bodyText: text })).toEqual(['Works for me.'])
    expect(body({ bodyText: 'Works for me.\n\n-----Original Message-----\nFrom: Liam\nSent: Friday\nSubject: Q3\n\nCan we meet Tuesday?' })).toEqual([
      'Works for me.',
    ])
  })

  it('a reply with nothing of its own (only a tagline) reads only the preface, never the quoted mail as if it were new', () => {
    const html = `<div dir="ltr">Sent from my iPhone</div><div><br><blockquote type="cite">On Sep 26, 2026, at 4:12 PM, Liam &lt;liam@dial8.ai&gt; wrote:<br><br></blockquote></div><blockquote type="cite"><div>Can you send me the photo?</div></blockquote>`
    expect(read({ bodyHtml: html })).toEqual([PREFACE])
  })
})

// ── Forwards ───────────────────────────────────────────────────────────────

const LIAM = { name: 'Liam', email: 'liam@dial8.ai' }
const FORWARDED = ['Hi Liam,', 'The Q3 plan is attached.', 'Budget review is on Tuesday.', 'Best, Sarah']

const GMAIL_FORWARD = (own: string) =>
  `<div dir="ltr">${own}<br><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">---------- Forwarded message ---------<br>From: <strong class="gmail_sendername" dir="auto">Sarah Chen</strong> <span dir="auto">&lt;<a href="mailto:sarah@acme.com">sarah@acme.com</a>&gt;</span><br>Date: Fri, Sep 26, 2026 at 4:12 PM<br>Subject: Q3 planning<br>To: Liam &lt;<a href="mailto:liam@dial8.ai">liam@dial8.ai</a>&gt;<br></div><br><br><div dir="ltr">Hi Liam,<div><br></div><div>The Q3 plan is attached. Budget review is on Tuesday.</div><div><br></div><div>Best,</div><div>Sarah</div><div><br></div><div>Sarah Chen</div><div>VP Marketing, Acme</div></div></div></div>`

describe('forwards', () => {
  it('a pure Gmail forward reads the forwarded message, without its From / Date / Subject / To lines', () => {
    expect(read({ from: LIAM, subject: 'Fwd: Q3 planning', bodyHtml: GMAIL_FORWARD('') })).toEqual([
      'From Liam, about Q3 planning.',
      ...FORWARDED,
    ])
  })

  it('a forward with words of its own reads only those', () => {
    expect(read({ from: LIAM, subject: 'Fwd: Q3 planning', bodyHtml: GMAIL_FORWARD('FYI, see the plan below.') })).toEqual([
      'From Liam, about Q3 planning.',
      'FYI, see the plan below.',
    ])
  })

  it('a pure plain-text forward', () => {
    const text = '\n\n---------- Forwarded message ---------\nFrom: Sarah Chen <sarah@acme.com>\nDate: Fri, Sep 26, 2026 at 4:12 PM\nSubject: Q3 planning\nTo: Liam <liam@dial8.ai>\n\n\nHi Liam,\n\nThe Q3 plan is attached. Budget review is on Tuesday.\n\nBest,\nSarah\n'
    expect(body({ from: LIAM, subject: 'Fwd: Q3 planning', bodyText: text })).toEqual(FORWARDED)
  })

  it('Apple Mail from an iPhone: past the tagline and "Begin forwarded message:"', () => {
    const html = `<html><body dir="auto"><div dir="ltr"><br></div><div dir="ltr">Sent from my iPhone</div><div dir="ltr"><br>Begin forwarded message:<br><br></div><blockquote type="cite"><div dir="ltr"><b>From:</b> Sarah Chen &lt;sarah@acme.com&gt;<br><b>Date:</b> September 26, 2026 at 4:12:00 PM EDT<br><b>To:</b> Liam &lt;liam@dial8.ai&gt;<br><b>Subject:</b> <b>Q3 planning</b><br><br></div></blockquote><blockquote type="cite"><div dir="ltr">The plan is attached. Budget review is Tuesday.</div></blockquote></body></html>`
    expect(body({ from: LIAM, subject: 'Fwd: Q3 planning', bodyHtml: html })).toEqual(['The plan is attached.', 'Budget review is Tuesday.'])
  })

  it('Thunderbird: past its header table, label and value in separate cells', () => {
    const html = `<html><body><p><br></p><div class="moz-forward-container"><br><br>-------- Forwarded Message --------<table class="moz-email-headers-table"><tbody><tr><th align="RIGHT">Subject: </th><td>Q3 planning</td></tr><tr><th align="RIGHT">Date: </th><td>Fri, 26 Sep 2026 16:12:00 -0400</td></tr><tr><th align="RIGHT">From: </th><td>Sarah Chen <a href="mailto:sarah@acme.com">&lt;sarah@acme.com&gt;</a></td></tr></tbody></table><br><p>The plan is attached. Budget review is Tuesday.</p></div></body></html>`
    expect(body({ from: LIAM, subject: 'Fwd: Q3 planning', bodyHtml: html })).toEqual(['The plan is attached.', 'Budget review is Tuesday.'])
  })

  it('Outlook marks a forward like a reply: an FW: subject reads the forwarded message, an RE: one does not', () => {
    const html = `<html><body><div id="appendonsend"></div><hr><div id="divRplyFwdMsg" dir="ltr"><font face="Calibri"><b>From:</b> Sarah Chen &lt;sarah@acme.com&gt;<br><b>Sent:</b> Friday, September 26, 2026 4:12 PM<br><b>To:</b> Liam &lt;liam@dial8.ai&gt;<br><b>Subject:</b> Q3 planning</font><div>&nbsp;</div></div><div>The plan is attached.</div><div>Budget review is Tuesday.</div></body></html>`
    expect(body({ from: LIAM, subject: 'FW: Q3 planning', bodyHtml: html })).toEqual(['The plan is attached.', 'Budget review is Tuesday.'])
    expect(body({ from: LIAM, subject: 'RE: Q3 planning', bodyHtml: html })).toEqual([])
  })
})

// ── Signatures and the sign-off ────────────────────────────────────────────

describe('signatures and the sign-off', () => {
  it('after "Best,\\nSarah": keeps "Best, Sarah", drops the title, phone, links and address', () => {
    const text = 'Hi Liam,\n\nThe numbers are in the deck.\n\nBest,\nSarah\n\nSarah Chen\nVP Marketing | Acme Corp\n+1 (555) 010-0100\nacme.com | linkedin.com/in/sarahchen\n548 Market St, San Francisco, CA 94104\n'
    expect(body({ bodyText: text })).toEqual(['Hi Liam,', 'The numbers are in the deck.', 'Best, Sarah'])

    const html = `<div>The numbers are in the deck.</div><div><br></div><div>Best,</div><div>Sarah</div><div><br></div><div><b>Sarah Chen</b></div><div>VP Marketing | Acme</div><div>+1 (555) 010-0100</div><div><a href="https://acme.com">acme.com</a> | <a href="https://linkedin.com/in/sarahchen">LinkedIn</a></div>`
    expect(body({ bodyHtml: html })).toEqual(['The numbers are in the deck.', 'Best, Sarah'])
  })

  it('a name on the sign-off line: "Thanks, Sarah" stays, the block under it goes', () => {
    expect(body({ bodyText: 'Works for me.\n\nThanks, Sarah\nSarah Chen | CEO | Acme\n+1 555 010 0100' })).toEqual([
      'Works for me.',
      'Thanks, Sarah',
    ])
  })

  it('a "-- " line and the signature under it go', () => {
    expect(body({ bodyText: 'Ship it.\n\n-- \nSarah Chen\nCEO, Acme\n+1 555 010 0100\n' })).toEqual(['Ship it.'])
  })

  it('a P.S. after the signature is read; the signature before it is not', () => {
    const text = 'Looks good.\n\nBest,\nSarah\nSarah Chen | CEO\n\nP.S. Can you send the deck by Friday?'
    expect(body({ bodyText: text })).toEqual(['Looks good.', 'Best, Sarah', 'P.S. Can you send the deck by Friday?'])
  })

  it('a legal notice after the signature goes with it', () => {
    const text = 'Please see the attached contract.\n\nRegards,\nSarah\n\nSarah Chen\nGeneral Counsel\n\nCONFIDENTIALITY NOTICE: This email and any attachments are confidential and\nintended solely for the use of the individual to whom they are addressed.\nIf you have received this email in error please notify the sender.'
    expect(body({ bodyText: text })).toEqual(['Please see the attached contract.', 'Regards, Sarah'])
  })

  it('fails safe: a "Thanks!" opening a short email cuts nothing after it', () => {
    expect(body({ bodyText: "Thanks!\n\nI'll review the doc tonight and get back to you tomorrow.\n\nSarah" })).toEqual([
      'Thanks!',
      "I'll review the doc tonight and get back to you tomorrow.",
      'Sarah',
    ])
    // No name under it: data lines are the message, not a signature.
    expect(body({ bodyText: 'Thanks!\nRevenue: $1.2M\nChurn: 2%' })).toEqual(['Thanks!', 'Revenue: $1.2M', 'Churn: 2%'])
    // A list after the sign-off is more message.
    expect(body({ bodyText: 'Thanks,\nSarah\n\n- Book the room\n- Send the deck' })).toEqual([
      'Thanks,',
      'Sarah',
      'Book the room.',
      'Send the deck.',
    ])
  })

  it('mobile taglines go wherever they are; a sentence that starts the same way stays', () => {
    const html = `<div>Sounds good.</div><div>Get <a href="https://aka.ms/o0ukef">Outlook for iOS</a></div><div>Sent from Yahoo Mail for Android</div><div>Sent from the office, back at 3.</div>`
    expect(body({ bodyHtml: html })).toEqual(['Sounds good.', 'Sent from the office, back at 3.'])
  })
})

// ── Hidden text and what isn't text ────────────────────────────────────────

describe('hidden text and what is not text', () => {
  it('preheaders hidden inline or by a <style> rule; a rule inside @media decides nothing', () => {
    const html = `<html><head><style>.preheader { display: none !important; } @media only screen and (max-width: 600px) { .desktop { display: none !important; } }</style></head><body><span class="preheader">Preheader from the stylesheet</span><div style="display:none;font-size:1px;max-height:0;overflow:hidden;mso-hide:all">Preheader inline &zwnj;&nbsp;&zwnj;&nbsp;</div><div style="max-height:0px;overflow:hidden">Collapsed preheader</div><p class="desktop">Shown on desktop.</p><p>The message.</p></body></html>`
    expect(body({ bodyHtml: html })).toEqual(['Shown on desktop.', 'The message.'])
  })

  it('hidden, aria-hidden, opacity 0, visibility hidden (a visible child still reads)', () => {
    const html = `<div hidden>gone</div><div aria-hidden="true">also gone</div><div style="opacity:0">faded</div><div style="visibility:hidden">hidden words <span style="visibility:visible">shown words</span></div><p>The message.</p>`
    expect(body({ bodyHtml: html })).toEqual(['shown words', 'The message.'])
  })

  it('font-size 0 hides only text that is itself at size 0 (MJML sets 0 on the wrapper and a size on the text)', () => {
    const html = `<table role="presentation"><tr><td style="font-size:0px;padding:20px 0;"><div style="font-size:0px;display:inline-block;width:100%;"><table role="presentation"><tr><td align="left" style="font-size:0px;padding:10px 25px;">zero-size spacer<div style="font-family:Ubuntu, Helvetica, Arial, sans-serif;font-size:13px;line-height:1;">Welcome to Dial8! Your workspace is ready.</div></td></tr></table></div></td></tr></table>`
    expect(body({ bodyHtml: html })).toEqual(['Welcome to Dial8!', 'Your workspace is ready.'])
  })

  it('scripts, styles, images, media and form controls are never read', () => {
    const html = `<script>alert("x")</script><style>p { color: red }</style><img src="https://dial8.ai/logo.png" alt="Dial8 logo"><svg><text>chart label</text></svg><video>video fallback</video><button>Click me</button><input value="typed"><select><option>Choice</option></select><p>The message.</p>`
    expect(body({ bodyHtml: html })).toEqual(['The message.'])
  })

  it('links read as their text, a URL as its host; emoji and invisible padding go', () => {
    const html = `<p>We launched 🎉 read the notes at <a href="https://dial8.ai/changelog">https://dial8.ai/changelog?utm=x</a> or on <a href="https://dial8.ai/blog">our blog</a>&zwnj; today.</p>`
    expect(body({ bodyHtml: html })).toEqual(['We launched read the notes at dial8.ai or on our blog today.'])
  })
})

// ── Newsletters and footers ────────────────────────────────────────────────

const NEWSLETTER = `<!DOCTYPE html><html><head><style>.preheader{display:none!important;visibility:hidden}@media only screen and (max-width:600px){.col{width:100%!important}.hide-mobile{display:none!important}}</style></head><body><span class="preheader">Three launches and a hiring update</span><div style="display:none;max-height:0;overflow:hidden;mso-hide:all">Preview text &zwnj;&nbsp;&zwnj;&nbsp;</div><table role="presentation" width="100%"><tr><td align="center" style="font-size:12px"><a href="https://dial8.ai/n/42">View this email in your browser</a></td></tr><tr><td><img src="https://dial8.ai/logo.png" alt="Dial8 logo" width="120"></td></tr><tr><td><h1>This week at Dial8</h1></td></tr><tr><td style="font-size:0px"><div class="col hide-mobile" style="display:inline-block;font-size:16px"><p>We shipped read-aloud for documents.</p></div><div class="col" style="display:inline-block;font-size:16px"><ul><li>Listen reads only the message</li><li>Sections play on hover</li></ul></div></td></tr><tr><td><a href="https://dial8.ai/blog/listen" style="background:#000;color:#fff;padding:8px">Read the post</a></td></tr><tr><td><p>Thanks for reading!</p><p>The Dial8 team</p></td></tr><tr><td style="font-size:12px;color:#999"><p>You are receiving this email because you signed up at dial8.ai.</p><p><a href="https://dial8.ai/unsub">Unsubscribe</a> | <a href="https://dial8.ai/prefs">Manage preferences</a></p><p>Dial8 Inc., 548 Market St, San Francisco, CA 94104</p><p>&copy; 2026 Dial8. All rights reserved.</p></td></tr></table><img src="https://t.dial8.ai/open.gif" width="1" height="1"></body></html>`

describe('newsletters and footers', () => {
  it('a newsletter: no preheader or "view in browser", layout tables cell by cell, no unsubscribe / address / © footer', () => {
    expect(read({ from: { name: 'Dial8', email: 'news@dial8.ai' }, subject: 'This week at Dial8', bodyHtml: NEWSLETTER })).toEqual([
      'From Dial8, about This week at Dial8.',
      'We shipped read-aloud for documents.',
      'Listen reads only the message.',
      'Sections play on hover.',
      'Read the post',
      'Thanks for reading!',
      'The Dial8 team',
    ])
    expect(emailBodyLines({ bodyHtml: NEWSLETTER }).map((line) => line.kind)).toEqual([
      'heading', 'text', 'item', 'item', 'text', 'text', 'text',
    ])
  })

  it('footer words in the middle of a message stay, and at its end too unless they are a link or beside a URL', () => {
    expect(body({ bodyText: "Hi Sam,\n\nPlease don't unsubscribe me from the Q3 updates, I still need them.\n\nThanks,\nSarah\n" })).toEqual([
      'Hi Sam,',
      "Please don't unsubscribe me from the Q3 updates, I still need them.",
      'Thanks, Sarah',
    ])
    expect(body({ bodyText: "Hi Sam,\n\nPlease don't unsubscribe me from the Q3 updates." })).toEqual([
      'Hi Sam,',
      "Please don't unsubscribe me from the Q3 updates.",
    ])
    expect(body({ bodyHtml: '<div>Hi Sam,</div><div><a href="https://lists.acme.com/unsub">Unsubscribe</a> me from this list please.</div>' })).toEqual([
      'Hi Sam,',
      'Unsubscribe me from this list please.',
    ])
  })

  it('never drops the whole message, and keeps what a line ending in ":" introduces', () => {
    expect(body({ bodyHtml: '<div><a href="https://lists.acme.com/unsub">Unsubscribe</a></div>' })).toEqual(['Unsubscribe'])
    const html = `<div>Here's the doc:</div><div><a href="https://docs.google.com/document/d/abc">https://docs.google.com/document/d/abc</a></div><div><br></div><div>CONFIDENTIALITY NOTICE: This email and any attachments are confidential and intended solely for the addressee.</div>`
    expect(body({ bodyHtml: html })).toEqual(["Here's the doc:", 'docs.google.com'])
  })

  it('a GitHub notification: the comment, not the quoted code or the reply / unsubscribe footer', () => {
    const html = `<p><b>@sarahchen</b> commented on this pull request.</p><blockquote><p>const x = 1</p></blockquote><p>Why not 2?</p><p style="font-size:small;color:#666;">—<br>Reply to this email directly, <a href="https://github.com/x">view it on GitHub</a>, or <a href="https://github.com/unsub">unsubscribe</a>.<br>You are receiving this because you were mentioned.<img src="https://github.com/p.gif" height="1" width="1"></p>`
    expect(body({ bodyHtml: html })).toEqual(['@sarahchen commented on this pull request.', 'Why not 2?'])
  })

  it('a transactional email (Postmark template): no stylesheet preheader, broken-button help or company footer', () => {
    const html = `<html><head><style type="text/css" rel="stylesheet" media="all">.preheader { display: none !important; visibility: hidden; mso-hide: all; font-size: 1px; max-height: 0; opacity: 0; overflow: hidden; } @media only screen and (max-width: 500px) { .button { width: 100% !important; } }</style></head><body><span class="preheader">Use this link to reset your password. The link is only valid for 24 hours.</span><table class="email-wrapper"><tr><td><table class="email-content"><tr><td class="email-body"><h1>Hi Liam,</h1><p>You recently requested to reset your password for your Acme account. <strong>This reset is only valid for the next 24 hours.</strong></p><table class="body-action"><tr><td><a href="https://acme.com/reset" class="button">Reset your password</a></td></tr></table><p>Thanks,<br>The Acme team</p><table class="body-sub"><tr><td><p class="sub">If you're having trouble with the button above, copy and paste the URL below into your web browser.</p><p class="sub">https://acme.com/reset?token=abc</p></td></tr></table></td></tr></table></td></tr><tr><td><table class="email-footer"><tr><td><p class="sub">Acme, Inc.<br>1234 Street Rd.<br>Suite 1234</p></td></tr></table></td></tr></table></body></html>`
    expect(read({ from: { name: 'Acme', email: 'support@acme.com' }, subject: 'Reset your password', bodyHtml: html })).toEqual([
      'From Acme, about Reset your password.',
      'Hi Liam,',
      'You recently requested to reset your password for your Acme account.',
      'This reset is only valid for the next 24 hours.',
      'Reset your password',
      'Thanks, The Acme team',
    ])
  })
})

// ── Plain text ─────────────────────────────────────────────────────────────

describe('plain text', () => {
  it('hard-wrapped paragraphs read as one line each; list lines stay items', () => {
    const text = [
      'Hi team,',
      '',
      'Here is the plan for the launch next week. We will ship the beta on',
      'Friday after the last round of fixes lands, and support will read the',
      'release notes first.',
      '',
      'Before then:',
      '- Book the room for the demo',
      '- Send the deck to the board, and ask them for',
      '  comments by Thursday',
      '1. Finalize pricing',
      '2) Update the docs',
      '',
      'Thanks,',
      'Sarah',
    ].join('\n')
    expect(read({ subject: 'Launch plan', bodyText: text })).toEqual([
      'From Sarah Chen, about Launch plan.',
      'Hi team,',
      'Here is the plan for the launch next week.',
      'We will ship the beta on Friday after the last round of fixes lands, and support will read the release notes first.',
      'Before then:',
      'Book the room for the demo.',
      'Send the deck to the board, and ask them for comments by Thursday.',
      'Finalize pricing.',
      'Update the docs.',
      'Thanks, Sarah',
    ])
  })

  it('short lines are not wrapped lines: each reads on its own', () => {
    expect(body({ bodyText: 'Q3 numbers:\nRevenue: $1.2M\nChurn: 2%\nNew logos: 14' })).toEqual([
      'Q3 numbers:',
      'Revenue: $1.2M',
      'Churn: 2%',
      'New logos: 14',
    ])
  })

  it('<pre> and an HTML part that is plain text read as plain text', () => {
    const pre = '<pre>Build 42 passed. All 318 tests are green, and the release candidate is\nready for review.\n\n- web: ok\n- desktop: ok</pre>'
    expect(body({ subject: 'Build', bodyHtml: pre })).toEqual([
      'Build 42 passed.',
      'All 318 tests are green, and the release candidate is ready for review.',
      'web: ok.',
      'desktop: ok.',
    ])
    expect(body({ bodyHtml: 'Hi Liam,\n\nPlain text in the HTML part.\n\nSarah' })).toEqual([
      'Hi Liam,',
      'Plain text in the HTML part.',
      'Sarah',
    ])
  })

  it('HTML that says nothing (an image-only email) falls back to the plain text', () => {
    const html = '<table><tr><td><a href="https://shop.com"><img src="https://shop.com/sale.png" alt="50% off everything"></a></td></tr></table>'
    expect(body({ bodyHtml: html, bodyText: 'Our fall sale is on: 50% off everything this weekend.' })).toEqual([
      'Our fall sale is on: 50% off everything this weekend.',
    ])
  })
})

// ── Fails safe ─────────────────────────────────────────────────────────────

describe('fails safe', () => {
  it('"On page 3, the author wrote:" is not an attribution: nothing after it is dropped', () => {
    expect(body({ bodyHtml: '<p>On page 3, the author wrote:</p><p>"Ship small."</p><p>We agree.</p>' })).toEqual([
      'On page 3, the author wrote:',
      '"Ship small."',
      'We agree.',
    ])
  })

  it('a quote inside a newsletter drops only the quote, never the rest', () => {
    const html = '<p>Our CEO said it best this week:</p><blockquote><p>Ship the smallest thing that works.</p></blockquote><p>That is how we built Listen.</p><p>More next week.</p>'
    expect(body({ subject: 'Weekly digest', bodyHtml: html })).toEqual([
      'Our CEO said it best this week:',
      'That is how we built Listen.',
      'More next week.',
    ])
  })

  it('an email that is all one quote with no attribution is read, not dropped', () => {
    expect(body({ bodyHtml: '<blockquote><p>Ship the smallest thing that works.</p><p>Then listen.</p></blockquote>' })).toEqual([
      'Ship the smallest thing that works.',
      'Then listen.',
    ])
  })

  it('the same line twice in a row reads once', () => {
    expect(body({ bodyHtml: '<p>Hello there.</p><p>Hello there.</p><p>Bye now.</p>' })).toEqual(['Hello there.', 'Bye now.'])
  })
})

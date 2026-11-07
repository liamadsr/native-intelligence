/**
 * What a bot says (bots v2 phase 3): one templated line per row or card,
 * never a model. Locked in: a sentence for every deliverable type, row status
 * and card kind the ledger produces, a fallback for anything else; counts in
 * words and pluralised; first person by default, the teammate named in the
 * third; never an email address, a raw id or markdown; and what "Read it"
 * says, trimmed.
 */
import { describe, it, expect } from 'vitest'
import type { AttentionItem } from '@/hooks/use-attention-items'
import type { LightWorkRow } from '@/lib/work/queries'
import type { WorkDeliverable, WorkItem } from '@/lib/work/types'
import {
  MAX_READ_CHARS,
  READ_MORE_LINE,
  batchLine,
  batchTitle,
  cardReading,
  documentReading,
  draftReading,
  narrateItem,
  narrateSummary,
  noticeInWorkspace,
  questionReading,
  skippedNoticeLine,
  verdictNoticeLine,
  workNoticeLine,
  questionsOf,
  readableDeliverable,
  textReading,
  type NarratedCard,
  type NarratedWorkItem,
  type NarrationEnrichment,
} from '../narration'

const DOC_ID = 'd0c00000-0000-4000-8000-000000000001'
const DRAFT_ID = 'd1000000-0000-4000-8000-000000000001'

function row(over: Partial<NarratedWorkItem> = {}): NarratedWorkItem {
  return { kind: 'work_run', status: 'needs_review', title: 'Write the kickoff notes', teammate: { name: 'Writer' }, ...over }
}
const deliv = (type: WorkDeliverable['type'], label: string, over: Partial<WorkDeliverable> = {}): WorkDeliverable => ({
  type,
  id: `${type}-${label}`.replace(/\s+/g, '-'),
  label,
  ...over,
})
const say = (item: NarratedWorkItem, enrichment?: NarrationEnrichment) => narrateItem({ item, enrichment })
const sayCard = (card: NarratedCard) => narrateItem({ card })

describe('a work item waiting on review: what it made', () => {
  it('an email draft, with the email it answers: who wrote and what about, then the draft', () => {
    const n = say(row({ kind: 'email_drafts', deliverables: [{ type: 'email_draft', id: DRAFT_ID, label: 'Re: Q3 planning' }] }), {
      senders: ['Alex Rivera'],
      subject: 'Re: Q3 planning',
    })
    expect(n).toEqual({
      line: 'You got an email from Alex Rivera about Q3 planning. I drafted a reply.',
      canRead: true,
      readKind: 'email_draft',
    })
  })

  it('a draft alone: its subject, without the reply prefix; to whom when known', () => {
    expect(say(row({ deliverables: [deliv('email_draft', 'Re: Pricing')] })).line).toBe('I wrote a draft about Pricing.')
    expect(say(row({ deliverables: [deliv('email_draft', 'Re: Pricing')] }), { recipients: ['Dana Reed'] }).line).toBe(
      'I wrote a draft to Dana Reed about Pricing.',
    )
  })

  it('several drafts: emails from several people, counted', () => {
    const n = say(row({ deliverables: [deliv('email_draft', 'Re: A'), deliv('email_draft', 'Re: B')] }), {
      senders: ['Alex Rivera', 'Dana Lee'],
    })
    expect(n.line).toBe('You got emails from Alex Rivera and Dana Lee. I wrote two drafts.')
    expect(say(row({ deliverables: [deliv('email_draft', 'Re: A'), deliv('email_draft', 'Re: B'), deliv('email_draft', 'C')] })).line).toBe(
      'I wrote three drafts.',
    )
  })

  it('a document: its current title, never a generic label', () => {
    const doc = { type: 'document' as const, id: DOC_ID, label: 'Output document' }
    expect(say(row({ deliverables: [doc] }), { labels: { [`document:${DOC_ID}`]: 'Q3 kickoff notes' } })).toEqual({
      line: 'I finished a document: Q3 kickoff notes.',
      canRead: true,
      readKind: 'document',
    })
    expect(say(row({ deliverables: [doc] })).line).toBe('I finished a document.')
    expect(say(row({ deliverables: [deliv('document', 'Launch plan'), deliv('document', 'Pricing memo')] })).line).toBe(
      'I finished two documents: Launch plan and Pricing memo.',
    )
  })

  it('actions and cards from a meeting: "from" the meeting, the teammate named in the third person', () => {
    const triage = row({
      kind: 'flow_run',
      status: 'done',
      teammate: { name: 'Triage' },
      deliverables: [deliv('action', 'Filed action', { id: 'a1' }), deliv('action', 'Filed action', { id: 'a2' })],
    })
    expect(narrateItem({ item: triage, enrichment: { sourceTitle: 'Sync w/ Dana' }, person: 'third' }).line).toBe(
      "Triage filed two actions from 'Sync w/ Dana'.",
    )
    expect(say(triage, { sourceTitle: 'Sync w/ Dana' }).line).toBe("I filed two actions from 'Sync w/ Dana'.")
    const cards = row({ status: 'done', deliverables: [deliv('attention_cards', '2 cards for you', { count: 2 })] })
    expect(say(cards, { sourceTitle: 'Sync w/ Dana' }).line).toBe("I have two cards for you from 'Sync w/ Dana'.")
    expect(narrateItem({ item: cards, person: 'third', speaker: 'Triage' }).line).toBe('Triage has two cards for you.')
  })

  it('several kinds at once: one list, the meeting with the first actions said', () => {
    const n = say(
      row({ deliverables: [deliv('email_draft', 'Re: A'), deliv('document', 'Plan'), deliv('action', 'Filed action'), deliv('attention_cards', '1 card for you', { count: 1 })] }),
      { sourceTitle: 'Sync w/ Dana' },
    )
    expect(n.line).toBe("I wrote a draft, finished a document, filed an action from 'Sync w/ Dana' and have a card for you.")
    expect(n).toMatchObject({ canRead: true, readKind: 'email_draft' })
  })

  it('every other deliverable type has its own words', () => {
    const one = (d: WorkDeliverable) => say(row({ deliverables: [d] })).line
    expect(one(deliv('contact', 'Dana Reed'))).toBe('I added a contact: Dana Reed.')
    expect(one(deliv('company', 'Acme'))).toBe('I added a company: Acme.')
    expect(one(deliv('prospect_list', 'Fintech CFOs'))).toBe('I built a prospect list: Fintech CFOs.')
    expect(one(deliv('pr', 'Pull request', { id: 'https://github.com/acme/app/pull/12' }))).toBe('I opened a pull request.')
    expect(one(deliv('capture', 'Archived capture'))).toBe('I archived a capture.')
    expect(one(deliv('capture', 'Board review'))).toBe('I saved a capture: Board review.')
    expect(one(deliv('flow_run', 'Weekly digest'))).toBe('I finished a run: Weekly digest.')
    expect(one(deliv('url', 'https://docs.acme.com/pricing?x=1', { id: 'https://docs.acme.com/pricing?x=1' }))).toBe(
      'I found a link: docs.acme.com.',
    )
    expect(say(row({ deliverables: [deliv('contact', 'A'), deliv('contact', 'B'), deliv('contact', 'C'), deliv('contact', 'D')] })).line).toBe(
      'I added four contacts.',
    )
  })

  it('reads only what is still waiting: a resolved deliverable is not said', () => {
    const n = say(row({ deliverables: [deliv('email_draft', 'Re: A', { resolved_at: '2026-10-01T00:00:00Z' }), deliv('document', 'Plan')] }))
    expect(n).toEqual({ line: 'I finished a document: Plan.', canRead: true, readKind: 'document' })
  })

  it('an attempt never reads as work you asked for', () => {
    expect(say(row({ origin: 'attempt', deliverables: [deliv('email_draft', 'Re: Pricing')] })).line).toBe(
      'I went ahead and wrote a draft about Pricing.',
    )
  })

  it('nothing to hand over: what it finished, and its summary to read', () => {
    expect(say(row({ result_summary: 'Acme pays **$40k** a year.' }))).toEqual({
      line: "I finished 'Write the kickoff notes'.",
      canRead: true,
      readKind: 'text',
    })
    expect(say(row({ status: 'done', title: null }))).toEqual({ line: 'I have something for you.', canRead: false })
  })

  it('an extraction pass: the capture it went through and what it filed', () => {
    const n = say(
      row({ kind: 'extraction', status: 'done', teammate: { name: 'Extraction' }, result_summary: 'Filed 3, staged 2 for review', deliverables: [deliv('capture', 'Sync w/ Dana')] }),
    )
    expect(n).toEqual({ line: "I went through 'Sync w/ Dana': filed 3, staged 2 for review.", canRead: false })
  })
})

describe('a work item asking a question', () => {
  const asking = (questions: unknown[]) => row({ status: 'needs_input', needs: { kind: 'input', questions } })

  it('says the question, lowercased after the colon when it starts with a question word', () => {
    const q = { question: 'Which Acme contact should get this?', header: 'Contact', options: [{ label: 'Dana Lee' }, { label: 'Sam Ortiz' }], multiSelect: false }
    expect(say(asking([q]))).toEqual({ line: 'I have a question: which Acme contact should get this?', canRead: true, readKind: 'text' })
    expect(say(asking(['Dana or Sam?'])).line).toBe('I have a question: Dana or Sam?')
    expect(narrateItem({ item: asking(['Send it today?']), person: 'third' }).line).toBe('Writer has a question: Send it today?')
  })

  it('several questions: how many, then the first', () => {
    expect(say(asking(['Which list?', 'Which day?'])).line).toBe(
      "I have two questions about 'Write the kickoff notes'. The first: which list?",
    )
  })

  it('a question too long for a line, or none: what it is about', () => {
    expect(say(asking([`Which of these ${'very '.repeat(60)}long options?`])).line).toBe(
      "I have a question about 'Write the kickoff notes'.",
    )
    expect(say(asking([]))).toEqual({ line: "I have a question about 'Write the kickoff notes'.", canRead: false })
    expect(say(row({ status: 'needs_input', title: null, needs: null })).line).toBe('I have a question for you.')
  })

  it('reads every shape a question comes in', () => {
    expect(questionsOf({ kind: 'input', questions: ['  A?  ', { prompt: 'B?' }, { title: 'C?', options: ['x', { label: 'y' }, 3] }, 7, null, { other: 1 }] })).toEqual([
      { text: 'A?', options: [], multiSelect: false },
      { text: 'B?', options: [], multiSelect: false },
      { text: 'C?', options: ['x', 'y'], multiSelect: false },
    ])
    expect(questionsOf({ kind: 'review', verb: 'review' })).toEqual([])
    expect(questionsOf(null)).toEqual([])
  })
})

describe('a work item in any other state', () => {
  it('running, queued, waiting on a teammate, failed, paused, skipped, canceled', () => {
    expect(say(row({ status: 'running' })).line).toBe("I'm working on 'Write the kickoff notes'.")
    expect(say(row({ status: 'running', title: null })).line).toBe("I'm working on something.")
    expect(say(row({ status: 'queued' })).line).toBe("I'll start on 'Write the kickoff notes' soon.")
    expect(say(row({ status: 'waiting_on_child', needs: { kind: 'child', work_item_id: 'c', role: 'researcher' } })).line).toBe(
      "I'm waiting on the Researcher for 'Write the kickoff notes'.",
    )
    expect(say(row({ status: 'waiting_on_child', needs: { kind: 'child', work_item_id: 'c', count: 3 } })).line).toBe(
      "I'm waiting on three teammates for 'Write the kickoff notes'.",
    )
    expect(say(row({ status: 'waiting_on_child', title: null, needs: null })).line).toBe("I'm waiting on a teammate.")
    expect(say(row({ status: 'failed', error_message: 'boom' }))).toEqual({ line: "I couldn't finish 'Write the kickoff notes'.", canRead: false })
    expect(say(row({ status: 'failed', error_message: 'AI usage limit reached' })).line).toBe("I'm paused: the AI usage limit was reached.")
    expect(say(row({ status: 'skipped' })).line).toBe("I skipped 'Write the kickoff notes'.")
    expect(say(row({ status: 'canceled' })).line).toBe("I stopped working on 'Write the kickoff notes'.")
    expect(narrateItem({ item: row({ status: 'running' }), person: 'third' }).line).toBe("Writer is working on 'Write the kickoff notes'.")
  })

  it('an unknown status: the fallback, first or third person', () => {
    expect(say(row({ status: 'mystery', title: 'Launch plan' }))).toEqual({ line: 'I have something for you: Launch plan.', canRead: false })
    expect(narrateItem({ item: row({ status: 'mystery', title: 'Launch plan' }), person: 'third' }).line).toBe(
      'Writer has something for you: Launch plan.',
    )
    // Third person with no one to name stays first person.
    expect(narrateItem({ item: row({ status: 'mystery', teammate: null }), person: 'third' }).line).toBe(
      'I have something for you: Write the kickoff notes.',
    )
  })

  it('a light row (no title, no deliverables) still reads', () => {
    const light: LightWorkRow = {
      id: 'r1',
      workspace_id: 'w1',
      member_id: 'm1',
      kind: 'work_run',
      status: 'needs_review',
      origin: 'user',
      ai_team_member_id: 't1',
      parent_id: null,
      root_id: null,
      flow_run_id: null,
      source: {},
      created_at: '2026-10-01T00:00:00Z',
      needs: { kind: 'review', verb: 'review' },
      opened_at: null,
      teammate: { id: 't1', name: 'Writer', is_system: false, system_key: null },
    }
    expect(narrateItem({ item: light })).toEqual({ line: 'I have something for you.', canRead: false })
  })

  it('a full feed row is accepted as it is', () => {
    const full = { kind: 'work_run', status: 'running', title: 'Plan', teammate: null } as unknown as WorkItem
    expect(narrateItem({ item: full }).line).toBe("I'm working on 'Plan'.")
  })
})

describe('a card', () => {
  it('a question card', () => {
    expect(sayCard({ kind: 'question', title: 'Should Dana own the renewal?', why: 'Nobody took it' })).toEqual({
      line: 'I have a question: should Dana own the renewal?',
      canRead: true,
      readKind: 'text',
    })
  })

  it('an email to draft: to whom (a name, never the address) and what about', () => {
    expect(sayCard({ kind: 'draft_email', title: 'Draft the pricing recap', payload: { email_to_name: 'Dana Reed', email_subject: 'Re: Pricing recap' } }).line).toBe(
      'I could draft an email to Dana Reed about Pricing recap.',
    )
    expect(sayCard({ kind: 'draft_email', title: 'Draft the pricing recap', payload: { email_to_address: 'dana.reed@acme.com' } }).line).toBe(
      'I could draft an email to Dana Reed: Draft the pricing recap.',
    )
    expect(sayCard({ kind: 'draft_email', title: 'Draft the pricing recap' })).toEqual({
      line: 'I could draft an email: Draft the pricing recap.',
      canRead: false,
    })
  })

  it('a work proposal, by what it would hand back', () => {
    const wp = (hint?: string) => sayCard({ kind: 'work_proposal', title: 'Acme pricing brief', payload: { task: 'Research Acme', ...(hint ? { deliverable_hint: hint } : {}) } })
    expect(wp('document')).toEqual({ line: 'I could write a document: Acme pricing brief.', canRead: true, readKind: 'text' })
    expect(wp('email_draft').line).toBe('I could draft an email: Acme pricing brief.')
    expect(wp('board_update').line).toBe('I could update the board: Acme pricing brief.')
    expect(wp().line).toBe('I could take this on: Acme pricing brief.')
  })

  it('an action card: what it found and where, or the change it would make', () => {
    const ac = (payload: Record<string, unknown>) => sayCard({ kind: 'action_card', title: 'Send the security questionnaire', payload })
    expect(ac({ change_type: 'create', entity_type: 'action', capture_title: 'Sync w/ Dana' }).line).toBe(
      "I found an action in 'Sync w/ Dana': Send the security questionnaire.",
    )
    expect(ac({ change_type: 'create', entity_type: 'decision' }).line).toBe('I found a decision for you: Send the security questionnaire.')
    expect(ac({}).line).toBe('I found an action for you: Send the security questionnaire.')
    expect(ac({ change_type: 'update' }).line).toBe("I'd update an action: Send the security questionnaire.")
    expect(ac({ change_type: 'assign' }).line).toBe("I'd assign an action: Send the security questionnaire.")
    expect(ac({ change_type: 'delete' }).line).toBe("I'd remove an action: Send the security questionnaire.")
    expect(ac({ change_type: 'mcp_call' }).line).toBe('I have something for you: Send the security questionnaire.')
  })

  it('an unknown kind: the fallback', () => {
    expect(sayCard({ kind: 'mystery', title: 'Launch plan' })).toEqual({ line: 'I have something for you: Launch plan.', canRead: false })
    expect(narrateItem({ card: { kind: 'mystery', title: 'Launch plan' }, person: 'third', speaker: 'Writer' }).line).toBe(
      'Writer has something for you: Launch plan.',
    )
  })

  it('an AttentionItem from the deck is accepted as it is', () => {
    const item: AttentionItem = {
      id: 'c1',
      workspace_id: 'w1',
      member_id: 'm1',
      kind: 'question',
      title: 'Who owns the renewal?',
      why: null,
      payload: {},
      proposal_id: null,
      source_flow_run_id: null,
      status: 'pending',
      expires_at: null,
      created_at: '2026-10-01T00:00:00Z',
    }
    expect(narrateItem({ card: item })).toEqual({ line: 'I have a question: who owns the renewal?', canRead: false })
  })
})

describe('the rules every line keeps', () => {
  const ADDRESS = /[\w.+-]+@[\w-]+\.[\w.]+/

  it('never says an email address, wherever one is', () => {
    const lines = [
      say(row({ title: 'Reply to jessa@acme.com', status: 'running' })).line,
      say(row({ title: 'jessa.lin@acme.com', status: 'running' })).line,
      say(row({ deliverables: [deliv('email_draft', 'Re: Pricing')] }), { senders: ['jordan.lee@acme.com'], subject: 'Hi from jordan@acme.com' }).line,
      say(row({ deliverables: [deliv('email_draft', 'Re: Pricing')] }), { recipients: ['dana.reed@acme.com', 'Sam <sam@acme.com>'] }).line,
      say(row({ deliverables: [deliv('document', 'Notes for ops@acme.com')] })).line,
      say(row({ status: 'needs_input', needs: { kind: 'input', questions: ['Should I cc legal@acme.com?'] } })).line,
      sayCard({ kind: 'draft_email', title: 'Email ada@acme.com', payload: { email_to_address: 'ada.lovelace@acme.com', email_subject: 'mailto:ada@acme.com' } }).line,
      sayCard({ kind: 'question', title: 'Is bo@acme.com right?' }).line,
      narrateItem({ item: row({ status: 'mystery' }), person: 'third', speaker: 'writer@acme.com' }).line,
    ]
    for (const line of lines) expect(line).not.toMatch(ADDRESS)
    expect(lines[2]).toBe('You got an email from Jordan Lee about Hi from Jordan. I wrote a draft.')
    expect(lines[3]).toBe('I wrote a draft to Dana Reed and Sam about Pricing.')
  })

  it('never says a raw id: deliverable ids, uuids in a title', () => {
    const n = say(row({ title: `Fix ${DOC_ID}`, status: 'running' }))
    expect(n.line).toBe("I'm working on 'Fix'.")
    const ids = say(row({ deliverables: [{ type: 'document', id: DOC_ID, label: 'Output document' }, { type: 'action', id: 'act-9', label: 'Filed action' }] }))
    expect(ids.line).not.toContain(DOC_ID)
    expect(ids.line).not.toContain('act-9')
  })

  it('never says markdown, and cuts a long title', () => {
    expect(say(row({ deliverables: [deliv('document', '**Q3** _kickoff_ [notes](https://x.com/a)')] })).line).toBe('I finished a document: Q3 kickoff notes.')
    const long = say(row({ status: 'running', title: `Plan ${'the launch '.repeat(20)}` })).line
    expect(long.length).toBeLessThan(140)
    // The cut's ellipsis ends the sentence: no period after it.
    expect(long).toMatch(/the…'$/)
  })

  it('pluralises: one, two, ten in words, then digits', () => {
    const cards = (n: number) => say(row({ status: 'done', deliverables: [deliv('attention_cards', `${n} cards for you`, { count: n })] })).line
    expect(cards(1)).toBe('I have a card for you.')
    expect(cards(2)).toBe('I have two cards for you.')
    expect(cards(12)).toBe('I have 12 cards for you.')
    const companies = say(row({ deliverables: [deliv('company', 'A'), deliv('company', 'B')] })).line
    expect(companies).toBe('I added two companies: A and B.')
  })
})

describe('narrateSummary', () => {
  const draft = { item: row({ deliverables: [deliv('email_draft', 'Re: A')] }) }
  const question = { item: row({ status: 'needs_input', needs: { kind: 'input', questions: ['Which?'] } }) }
  const card = { card: { kind: 'action_card', title: 'Send the deck' } }

  it('counts what it has by kind, in order', () => {
    expect(narrateSummary([draft, question, card])).toBe('I have three things for you: a draft, a question and a card.')
    expect(narrateSummary([draft, draft, question])).toBe('I have three things for you: two drafts and a question.')
    expect(narrateSummary([{ card: { kind: 'question', title: 'Who?' } }, card])).toBe('I have two things for you: a question and a card.')
  })

  it('one kind: just that; nothing: says so', () => {
    expect(narrateSummary([draft])).toBe('I have a draft for you.')
    expect(narrateSummary([draft, draft])).toBe('I have two drafts for you.')
    expect(narrateSummary([])).toBe('I have nothing new for you.')
  })

  it('counts cards a run surfaced, results, problems and updates', () => {
    expect(
      narrateSummary([
        { item: row({ status: 'done', deliverables: [deliv('attention_cards', '3 cards for you', { count: 3 })] }) },
        { item: row({ status: 'needs_review' }) },
        { item: row({ status: 'failed' }) },
        { item: row({ status: 'running' }) },
      ]),
    ).toBe('I have six things for you: three cards, a result, a problem and an update.')
  })

  it('in the third person, names the teammate', () => {
    expect(narrateSummary([draft, question], { person: 'third' })).toBe('Writer has two things for you: a draft and a question.')
    expect(narrateSummary([card], { person: 'third', speaker: 'Triage' })).toBe('Triage has a card for you.')
  })
})

describe('readings: what "Read it" says', () => {
  it('an email draft: who to and what about, then the body without its quoted history', () => {
    const r = draftReading({
      subject: 'Re: Q3 planning',
      recipients: ['alex.rivera@acme.com'],
      bodyText: 'Hi Alex,\n\nThursday works. I will send the deck to dana@acme.com first.\n\nBest,\nLiam\n\nOn Tue, Alex Rivera <alex@acme.com> wrote:\n> Can we meet Thursday?',
    })
    expect(r).not.toBeNull()
    expect(r!.title).toBe('Q3 planning')
    expect(r!.sentences[0]).toBe('The draft to Alex Rivera, about Q3 planning.')
    expect(r!.sentences.join(' ')).toContain('Thursday works.')
    expect(r!.sentences.join(' ')).not.toContain('Can we meet')
    expect(r!.text).toContain('Thursday works.')
    expect(r!.text).not.toMatch(/@/)
    expect(r!.sentences.join(' ')).not.toMatch(/@/)
    expect(draftReading({ subject: 'Hi', bodyText: '' })).toBeNull()
  })

  it('a document: the title said first, its markdown read as text', () => {
    const r = documentReading({ title: 'Q3 kickoff notes', content: '# Goals\n\n- Ship **v2**\n- Hire\n\nSee [the plan](https://x.com/p).' })
    expect(r).toEqual({
      title: 'Q3 kickoff notes',
      text: 'Goals.\n\nShip v2.\n\nHire.\n\nSee the plan.',
      sentences: ['Q3 kickoff notes.', 'Goals.', 'Ship v2.', 'Hire.', 'See the plan.'],
    })
    expect(documentReading({ title: 'Empty', content: '' })).toBeNull()
  })

  it('a question with its options', () => {
    const r = questionReading('Pick a contact', [
      { text: 'Which Acme contact should get this?', options: ['Dana Lee', 'Sam Ortiz', 'Jordan Kim'], multiSelect: false },
      { text: 'Which days', options: ['Mon', 'Tue'], multiSelect: true },
    ])
    expect(r!.sentences).toEqual([
      'Which Acme contact should get this?',
      'The options are: Dana Lee, Sam Ortiz and Jordan Kim.',
      'Which days.',
      'You can pick more than one: Mon and Tue.',
    ])
  })

  it('a card: why, then what it proposes', () => {
    const r = cardReading({ kind: 'work_proposal', title: 'Acme brief', why: 'Dana asked twice', payload: { task: 'Research **Acme** pricing' } })
    expect(r!.sentences).toEqual(['Dana asked twice', 'Research Acme pricing'])
    expect(cardReading({ kind: 'question', title: 'Who?' })).toBeNull()
    expect(textReading('Result', ['Acme pays $40k.'])!.text).toBe('Acme pays $40k.')
  })

  it('stops at the cap, sentence by sentence, and says there is more', () => {
    const para = 'This sentence is about fifty characters long, roughly. '
    const r = documentReading({ title: 'Long', content: Array.from({ length: 30 }, () => para.repeat(10)).join('\n\n') })!
    expect(r.sentences.at(-1)).toBe(READ_MORE_LINE)
    expect(r.sentences.slice(1, -1).join(' ').length).toBeLessThanOrEqual(MAX_READ_CHARS + 60)
    expect(r.text.endsWith('…')).toBe(true)
  })
})

describe('plumbing', () => {
  it('reads the first pending draft or document', () => {
    const d = deliv('document', 'Plan')
    expect(readableDeliverable({ deliverables: [deliv('action', 'A'), d] })).toBe(d)
    expect(readableDeliverable({ deliverables: [{ ...d, resolved_at: 'x' }] })).toBeNull()
    expect(readableDeliverable({})).toBeNull()
  })
})

// Bots v3 1a: the sentence a bot's notice carries, written by the server
// (bot-notice.ts) from the same templates the bubble narrates with.
describe('notice lines', () => {
  it('says what a triage left for you, in the first person, counts in words', () => {
    expect(verdictNoticeLine({ cardCount: 3, captureTitle: 'Call with Acme' })).toBe(
      "I triaged 'Call with Acme': three proposals need you.",
    )
    expect(verdictNoticeLine({ cardCount: 1, captureTitle: 'Call with Acme' })).toBe(
      "I triaged 'Call with Acme': one proposal needs you.",
    )
    expect(verdictNoticeLine({ cardCount: 12 })).toBe('I finished triage: 12 proposals need you.')
  })

  it('adds the overflow and the take-backs, and says a take-back on its own', () => {
    expect(verdictNoticeLine({ cardCount: 3, overflowCount: 2, revokedCount: 1, captureTitle: 'Sync' })).toBe(
      "I triaged 'Sync': three proposals need you. Two more are waiting in the capture. I also took back an auto-accepted change.",
    )
    expect(verdictNoticeLine({ cardCount: 1, overflowCount: 1 })).toBe(
      'I finished triage: one proposal needs you. One more is waiting in the queue.',
    )
    expect(verdictNoticeLine({ cardCount: 0, revokedCount: 2, captureTitle: 'Sync' })).toBe(
      "I took back two auto-accepted changes from 'Sync'.",
    )
    expect(verdictNoticeLine({ cardCount: 0, captureTitle: 'Sync' })).toBe("I triaged 'Sync': nothing needs you.")
  })

  it('never reads out markdown, an email address or a raw id in a capture title', () => {
    const line = verdictNoticeLine({
      cardCount: 2,
      captureTitle: '**Call** with dana@acme.com 3f2a9c1e-1111-2222-3333-444455556666',
    })
    expect(line).not.toMatch(/\*|@|3f2a9c1e/)
    expect(line).toMatch(/^I triaged 'Call with/)
  })

  it('says a skip with its reason', () => {
    expect(skippedNoticeLine({ skillName: 'Weekly brief', reason: 'Connect a calendar first.' })).toBe(
      "I skipped 'Weekly brief' this time. Connect a calendar first.",
    )
    expect(skippedNoticeLine({ skillName: null, reason: '' })).toBe('I skipped a loop this time.')
  })

  it('says a waiting or failed row the way the bubble does', () => {
    const asking: NarratedWorkItem = {
      kind: 'work_run',
      status: 'needs_input',
      title: 'Follow up with Acme',
      needs: { kind: 'input', questions: ['Which Acme contact should get this?'] },
    }
    expect(workNoticeLine(asking)).toBe(narrateItem({ item: asking }).line)
    expect(workNoticeLine(asking)).toBe('I have a question: which Acme contact should get this?')
    expect(workNoticeLine({ kind: 'work_run', status: 'failed', title: 'Q3 plan', error_message: 'boom' })).toBe(
      "I couldn't finish 'Q3 plan'.",
    )
  })

  it('names another workspace up front', () => {
    expect(noticeInWorkspace("I triaged 'Sync': one proposal needs you.", 'Acme')).toBe(
      "In Acme, I triaged 'Sync': one proposal needs you.",
    )
    expect(noticeInWorkspace('Two more are waiting.', 'Acme')).toBe('In Acme, two more are waiting.')
    expect(noticeInWorkspace('I did it.', null)).toBe('I did it.')
  })
})

describe('a run’s cards as one batch (bots v3 1b)', () => {
  const card = (payload: Record<string, unknown>) => ({ payload })

  it('says the digest’s own sentence: the count and the capture the cards came from', () => {
    const three = [card({ capture_title: 'Call with Acme' }), card({}), card({ capture_title: 'Call with Acme' })]
    expect(batchLine(three)).toBe("I triaged 'Call with Acme': three proposals need you.")
    expect(batchLine(three)).toBe(verdictNoticeLine({ cardCount: 3, captureTitle: 'Call with Acme' }))
    expect(batchLine([card({}), card({})])).toBe('I finished triage: two proposals need you.')
  })

  it('is titled by its capture, else its loop, else plainly', () => {
    expect(batchTitle([card({ skill_name: 'Proposal Triage' }), card({ capture_title: 'Call with Acme' })])).toBe('Call with Acme')
    expect(batchTitle([card({ skill_name: 'Proposal Triage' })])).toBe('Proposal Triage')
    expect(batchTitle([card({})])).toBe('Proposals for you')
  })
})

describe('work that came to a bot with no teammate says which work it was (bots-v4 Phase 5)', () => {
  // The Assistant stands for unrelated work at once, so every line names it.
  const done = (over: Partial<NarratedWorkItem>) => say({ status: 'done', teammate: { name: 'Assistant' }, ...over } as NarratedWorkItem)

  it('prospecting: what it found, for which list', () => {
    expect(
      done({ kind: 'prospecting', title: 'Finding companies for Fintech CFOs', result_summary: 'Found 12 new companies', deliverables: [deliv('prospect_list', 'Fintech CFOs')] }),
    ).toEqual({ line: "I found 12 new companies for 'Fintech CFOs'.", canRead: false })
    // People and accounts, and a row whose list deliverable is gone: the title names the list.
    expect(done({ kind: 'prospecting', title: 'Finding people in Q3 ICP', result_summary: 'Found 3 people' }).line).toBe("I found 3 people for 'Q3 ICP'.")
    expect(done({ kind: 'prospecting', title: 'Researching accounts in Q3 ICP', result_summary: 'Researched 4 companies' }).line).toBe(
      "I researched 4 companies for 'Q3 ICP'.",
    )
  })

  it('evals: which suite, and how it went, waiting on review too', () => {
    expect(done({ kind: 'eval', title: 'Evaluating Discovery calls (batch)', result_summary: '12 trials, all passed' }).line).toBe(
      "I ran the evals for 'Discovery calls': 12 trials, all passed.",
    )
    expect(
      say({ kind: 'eval', status: 'needs_review', title: 'Evaluating Discovery calls (live)', result_summary: '3 of 12 trials failed', teammate: { name: 'Developer' } }).line,
    ).toBe("I ran the evals for 'Discovery calls': 3 of 12 trials failed.")
  })

  it('a run that stopped at its budget says what it found first, and an eval that failed says after how much', () => {
    expect(
      done({ kind: 'prospecting', title: 'Finding companies for Fintech CFOs', result_summary: 'Stopped at the run budget — Found 7 new companies' }).line,
    ).toBe("I found 7 new companies for 'Fintech CFOs', then stopped at the run budget.")
    expect(done({ kind: 'eval', title: 'Evaluating Discovery calls (batch)', result_summary: 'Stopped at the eval budget — 5 trials, all passed' }).line).toBe(
      "I ran the evals for 'Discovery calls' and stopped at the eval budget: 5 trials, all passed.",
    )
    expect(
      say({ kind: 'eval', status: 'needs_review', title: 'Evaluating Discovery calls (batch)', result_summary: 'Failed — 12 trials', teammate: { name: 'Developer' } }).line,
    ).toBe("I ran the evals for 'Discovery calls', and the run failed after 12 trials.")
  })

  it('onboarding research and enrichment', () => {
    expect(done({ kind: 'onboarding_research', title: 'Researching your company', result_summary: 'Found your company; set up Launch plan with 4 actions' }).line).toBe(
      'I finished researching your company. Found your company; set up Launch plan with 4 actions.',
    )
    expect(done({ kind: 'crm_enrichment', title: 'Enriching 12 contacts and 3 companies', result_summary: 'Enriched 9 of 15 · 2 failed' }).line).toBe(
      'I looked up 12 contacts and 3 companies on the web. Enriched 9 of 15, 2 failed.',
    )
    expect(done({ kind: 'crm_enrichment', title: 'Enriching Dana Lee', result_summary: 'Filled 3 fields' }).line).toBe('I looked up Dana Lee on the web. Filled 3 fields.')
  })

  it('names the bot in the third person, and falls back to the general line without a summary (a light row)', () => {
    expect(
      narrateItem({
        item: { kind: 'prospecting', status: 'done', title: 'Finding companies for Fintech CFOs', result_summary: 'Found 12 new companies', teammate: { name: 'Assistant' } },
        person: 'third',
      }).line,
    ).toBe("Assistant found 12 new companies for 'Fintech CFOs'.")
    expect(done({ kind: 'prospecting', title: null, result_summary: null, deliverables: [deliv('prospect_list', 'Fintech CFOs')] }).line).toBe(
      'I built a prospect list: Fintech CFOs.',
    )
  })

  it('a failure, and running work, say which work by its title, as every row does', () => {
    expect(say({ kind: 'prospecting', status: 'failed', title: 'Finding companies for Fintech CFOs', error_message: 'Exa is down' }).line).toBe(
      "I couldn't finish 'Finding companies for Fintech CFOs'.",
    )
    expect(say({ kind: 'eval', status: 'running', title: 'Evaluating Discovery calls (batch)' }).line).toBe("I'm working on 'Evaluating Discovery calls (batch)'.")
  })

  it('its notice says the same line', () => {
    expect(workNoticeLine({ kind: 'eval', status: 'needs_review', title: 'Evaluating Discovery calls (batch)', result_summary: '3 of 12 trials failed' })).toBe(
      "I ran the evals for 'Discovery calls': 3 of 12 trials failed.",
    )
  })
})

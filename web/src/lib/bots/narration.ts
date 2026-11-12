/**
 * What a bot says about one thing its teammate has for you (bots v2 phase 3,
 * docs/plans/bots-v2.md decision 7): a templated sentence per waiting work
 * item or pending card, and what it reads when you say "read it". Plain code
 * over the row, never a model (Liam's rule for listen briefs, kept here):
 *
 *   "You got an email from Alex Rivera about Q3 planning. I wrote a draft."
 *   "I finished a document: Q3 kickoff notes."
 *   "I have a question: which Acme contact should get this?"
 *   "Triage filed two actions from 'Sync w/ Dana'."
 *   "I found 12 new companies for 'Fintech CFOs'."
 *   "I have three things for you: a draft, a question and a card."
 *
 * The teammate speaks in the first person by default (its own bubble); in the
 * third person (`person: 'third'`) it is named, for a surface that is not its
 * own ("Writer has something for you: Launch plan.").
 *
 * `narrateItem` takes what the client already holds (a ledger row, full or
 * light, or an attention card) plus optional enrichment the narration reads
 * (narration-server.ts) fill server-side (the email a draft replies to, current titles). The
 * listen-brief helpers keep it sounding like the briefs: small counts in
 * words, lists the way people say them, titles without their markdown, and
 * never an email address (`Speech` drops them) or a raw id read out.
 *
 * The readings (`draftReading`, `documentReading`, …) turn the item's own
 * words into what "Read it" says and shows, with the read-aloud converters,
 * trimmed to `MAX_READ_CHARS`. Pure and client-safe: narration-server.ts
 * does the reads.
 */
import { Speech, clause, count, listOf, nameFromEmail, numberWord, withoutEmails } from '@/lib/listen-briefs/speech'
import { cleanSubject, dropSubjectEcho, emailBodyLines } from '@/lib/read-aloud/email-speech'
import { linesToSentences } from '@/lib/read-aloud/sections'
import {
  blockToSpeech,
  inlineToSpeech,
  parseSpeechBlocks,
  plainTextToSpeech,
  splitSentences,
  withTerminalPunctuation,
} from '@/lib/read-aloud/speech-text'
import { labelKey } from '@/lib/work/output'
import { postDraftFromPayload } from '@/lib/content/post-draft'
import { deliverableNoun, isPausedFailure } from '@/lib/work/presentation'
import { WORK_ROLE_LABELS, isWorkRole } from '@/lib/work/roles'
import type { WorkDeliverable, WorkDeliverableType, WorkNeeds } from '@/lib/work/types'

// ── Shapes ───────────────────────────────────────────────────────────────────

export type NarrationPerson = 'first' | 'third'

/** What "Read it" reads: an email draft's body, a document's text, or other
 *  text (a question with its options, a result, a card's reasoning). */
export type NarrationReadKind = 'email_draft' | 'document' | 'text'

export interface Narration {
  /** The sentence (or two) the bot says. */
  line: string
  /** Whether there is something behind it to read out. */
  canRead: boolean
  readKind?: NarrationReadKind
}

/** A ledger row as the client holds it: a full feed row (`WorkItem`) or a
 *  light one (`LightWorkRow`: no title, no deliverables). */
export interface NarratedWorkItem {
  kind: string
  status: string
  title?: string | null
  result_summary?: string | null
  error_message?: string | null
  deliverables?: readonly WorkDeliverable[] | null
  needs?: WorkNeeds | null
  origin?: string | null
  teammate?: { name?: string | null } | null
}

/** An attention card (`AttentionItem`), or as much of one as is held. */
export interface NarratedCard {
  kind: string
  title: string
  why?: string | null
  payload?: Record<string, unknown> | null
}

/** Facts the client may not hold; the narration reads (narration-server.ts) fill them. */
export interface NarrationEnrichment {
  /** Who wrote the emails the drafts reply to: display names, one per thread. */
  senders?: readonly string[]
  /** The subject of the (first) email a draft replies to. */
  subject?: string | null
  /** Who the drafts go to (display names), for a draft that answers no one. */
  recipients?: readonly string[]
  /** Deliverables' current titles, keyed `type:id` (the activity route's
   *  `output.labels`); a deliverable's stored label is often generic. */
  labels?: Readonly<Record<string, string>>
  /** The meeting the work came from: "filed two actions from 'Sync w/ Dana'". */
  sourceTitle?: string | null
}

export interface NarrationOptions {
  person?: NarrationPerson
  /** Who speaks, for the third person: defaults to the row's teammate. */
  speaker?: string | null
}

/** One thing a bot has for you. */
export type NarrationSubject = { item: NarratedWorkItem; card?: undefined } | { card: NarratedCard; item?: undefined }

export type NarrationInput = NarrationSubject & NarrationOptions & { enrichment?: NarrationEnrichment }

/** What the narration reads answer (narration-server.ts). */
export interface NarrationReply {
  line: string
  readKind?: NarrationReadKind
  /** What is being read: the document's title, the draft's subject. */
  readTitle?: string
  /** The text "Read it" shows, paragraphs split by blank lines. */
  readText?: string
  /** What "Read it" says, sentence by sentence (a preface, then the text). */
  readSentences?: string[]
}

// ── Who speaks ───────────────────────────────────────────────────────────────

interface Voice {
  /** "I" / "Writer" */
  I: string
  /** "I have" / "Writer has" */
  have: string
  /** "I'm" / "Writer is" */
  am: string
  /** "I'd" / "Writer would" */
  would: string
  /** "I'll" / "Writer will" */
  will: string
  /** "have" alone, inside a list: "filed an action and have a card for you". */
  haveBare: string
}

const FIRST: Voice = { I: 'I', have: 'I have', am: "I'm", would: "I'd", will: "I'll", haveBare: 'have' }

function voiceOf(person: NarrationPerson | undefined, name: string | null | undefined): Voice {
  const who = person === 'third' ? short(clause(withoutEmails(name ?? '')), 40) : null
  if (!who) return FIRST
  return { I: who, have: `${who} has`, am: `${who} is`, would: `${who} would`, will: `${who} will`, haveBare: 'has' }
}

// ── Words ────────────────────────────────────────────────────────────────────

/** Titles past this many characters are cut at a word ("…"). */
const TITLE_MAX = 100
/** A question longer than this is not said in the line; "Read it" reads it. */
const QUESTION_IN_LINE_MAX = 200

/** A uuid-shaped id in running text: never read out. */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

function short(text: string | null | undefined, max = TITLE_MAX): string | null {
  const t = text?.replace(UUID_RE, '').replace(/\s+/g, ' ').trim()
  if (!t) return null
  if (t.length <= max) return t
  const cut = t.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.-]+$/, '')}…`
}

/** A title as a clause: markdown off, its own end punctuation off, cut short. */
function titled(text: string | null | undefined): string | null {
  return short(clause(withoutEmails(text ?? '')))
}

/** A title mid-sentence, set off in quotes: 'Sync w/ Dana'. */
function quoted(text: string | null | undefined): string | null {
  const t = titled(text)
  return t ? `'${t}'` : null
}

/** A person's name for speech: their name, else the name in their address,
 *  never the address. */
function personName(name: string | null | undefined): string | null {
  const t = name?.trim()
  if (!t) return null
  if (/^\S+@\S+$/.test(t)) return short(nameFromEmail(t.replace(/^mailto:/i, '')), 60)
  return short(clause(withoutEmails(t)), 60)
}

function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? 'an' : 'a'
}

/** "a draft", "an action", "two drafts", "12 actions". */
function some(n: number, singular: string, plural: string): string {
  return n === 1 ? `${article(singular)} ${singular}` : `${numberWord(n)} ${plural}`
}

function deliverables(type: WorkDeliverableType, n: number): string {
  return some(n, deliverableNoun(type, 1), deliverableNoun(type, 2))
}

/** Every item listed, the last after "and" (never "and N others"). */
function listAll(items: readonly string[]): string {
  return listOf(items, Math.max(items.length, 1)) ?? ''
}

/** Labels the producers write when they have nothing better (flow-results.ts,
 *  agent-run-mirror.ts): never read as a title. */
const GENERIC_LABELS = new Set(['output document', 'filed action', 'archived capture', 'pull request', 'deliverable'])
const CARDS_LABEL_RE = /^\d+ cards? for you$/i

function deliverableTitle(d: WorkDeliverable, labels: Readonly<Record<string, string>> | undefined): string | null {
  const known = labels?.[labelKey(d)]
  if (known?.trim()) return titled(known)
  const label = d.label?.trim()
  if (!label || GENERIC_LABELS.has(label.toLowerCase()) || CARDS_LABEL_RE.test(label)) return null
  return titled(label)
}

/** The sentences as one line: ids scrubbed (`Speech` already dropped the
 *  email addresses). */
function sentencesToLine(speech: Speech): string {
  return speech
    .toArray()
    .map((s) => s.replace(UUID_RE, '').replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim())
    .filter(Boolean)
    .join(' ')
}

// ── Questions ────────────────────────────────────────────────────────────────

export interface NarrationQuestion {
  text: string
  options: string[]
  multiSelect: boolean
}

/** The questions a parked row asks, whatever shape the asker used (a work
 *  run's `{ question, options }`, a bare string), read as notify.ts
 *  `questionText` reads the first one. */
export function questionsOf(needs: WorkNeeds | null | undefined): NarrationQuestion[] {
  if (needs?.kind !== 'input' || !Array.isArray(needs.questions)) return []
  return needs.questions.flatMap((q): NarrationQuestion[] => {
    if (typeof q === 'string') return q.trim() ? [{ text: q.trim(), options: [], multiSelect: false }] : []
    if (!q || typeof q !== 'object') return []
    const o = q as Record<string, unknown>
    const text = ['question', 'prompt', 'text', 'title']
      .map((k) => o[k])
      .find((v): v is string => typeof v === 'string' && !!v.trim())
    if (!text) return []
    const options = (Array.isArray(o.options) ? o.options : []).flatMap((opt: unknown) => {
      const label = typeof opt === 'string' ? opt : opt && typeof opt === 'object' ? (opt as { label?: unknown }).label : null
      return typeof label === 'string' && label.trim() ? [label.trim()] : []
    })
    return [{ text: text.trim(), options, multiSelect: o.multiSelect === true }]
  })
}

/** Words a question starts with that read lowercase after a colon ("I have a
 *  question: which…"); anything else (a name, an acronym) keeps its capital. */
const QUESTION_WORD_RE =
  /^(Which|What|Who|Whom|Whose|When|Where|Why|How|Should|Shall|Can|Could|Would|Will|Do|Does|Did|Is|Are|Was|Were|Has|Have|May|Want|Any)\b/

/** A question as it is said in a line: plain, its own "?" kept, lowercased
 *  after a colon when it starts with a question word. Null past the cap. */
function questionClause(text: string): string | null {
  const plain = inlineToSpeech(withoutEmails(text)).replace(UUID_RE, '').replace(/\s+/g, ' ').trim()
  if (!/[\p{L}\p{N}]/u.test(plain) || plain.length > QUESTION_IN_LINE_MAX) return null
  return QUESTION_WORD_RE.test(plain) ? plain[0].toLowerCase() + plain.slice(1) : plain
}

// ── A work item ──────────────────────────────────────────────────────────────

/** The unresolved deliverables, in the row's order. */
function pending(item: NarratedWorkItem): WorkDeliverable[] {
  return (item.deliverables ?? []).filter((d) => !d.resolved_at)
}

/** What "Read it" reads for a row: its first pending draft or document. */
export function readableDeliverable(item: Pick<NarratedWorkItem, 'deliverables'>): WorkDeliverable | null {
  return (item.deliverables ?? []).find((d) => !d.resolved_at && (d.type === 'email_draft' || d.type === 'document')) ?? null
}

/** The verb a kind of deliverable takes in a line. */
function verbFor(type: WorkDeliverableType, group: readonly WorkDeliverable[], v: Voice): string {
  switch (type) {
    case 'email_draft':
      return 'wrote'
    case 'document':
    case 'flow_run':
      return 'finished'
    case 'action':
      return 'filed'
    case 'capture':
      return group.every((d) => d.label?.trim().toLowerCase() === 'archived capture') ? 'archived' : 'saved'
    case 'contact':
    case 'company':
      return 'added'
    case 'prospect_list':
      return 'built'
    case 'pr':
      return 'opened'
    case 'attention_cards':
      return v.haveBare
    case 'url':
      return 'found'
    case 'studio_video':
      return 'exported'
    default:
      return 'finished'
  }
}

interface DeliverableGroup {
  type: WorkDeliverableType
  items: WorkDeliverable[]
  n: number
}

function groupDeliverables(list: readonly WorkDeliverable[]): DeliverableGroup[] {
  const groups: DeliverableGroup[] = []
  for (const d of list) {
    let g = groups.find((x) => x.type === d.type)
    if (!g) {
      g = { type: d.type, items: [], n: 0 }
      groups.push(g)
    }
    g.items.push(d)
    g.n += d.type === 'attention_cards' ? Math.max(1, d.count ?? 1) : 1
  }
  return groups
}

/** "wrote a draft about Pricing", "finished a document: Q3 kickoff notes",
 *  "filed two actions from 'Sync w/ Dana'", "have two cards for you", and an
 *  email drafting pass's "drafted three replies" (bots-v4.md Phase 3). */
function groupPhrase(
  g: DeliverableGroup,
  ctx: { v: Voice; alone: boolean; saidSenders: boolean; enrichment: NarrationEnrichment; from: string | null; replies: boolean },
): string {
  const { v, alone, saidSenders, enrichment, from, replies } = ctx
  const what =
    replies && g.type === 'email_draft'
      ? `drafted ${some(g.n, 'reply', 'replies')}`
      : `${verbFor(g.type, g.items, v)} ${deliverables(g.type, g.n)}${g.type === 'attention_cards' ? ' for you' : ''}`
  if (g.type === 'email_draft') {
    if (saidSenders || !alone) return what
    const to = listOf((enrichment.recipients ?? []).map(personName), 3)
    const about = g.n === 1 ? titled(cleanSubject(enrichment.subject?.trim() || g.items[0].label || '')) : null
    return [what, to && `to ${to}`, about && `about ${about}`].filter(Boolean).join(' ')
  }
  if (from) return `${what} from ${from}`
  if (!alone) return what
  const titles = g.items.map((d) => deliverableTitle(d, enrichment.labels))
  if (g.type === 'attention_cards' || titles.some((t) => !t) || titles.length > 3) return what
  return `${what}: ${listAll(titles as string[])}`
}

/** Says what a row produced (needs_review, done); false when it has no
 *  pending deliverables. */
function sayProduced(item: NarratedWorkItem, v: Voice, enrichment: NarrationEnrichment, speech: Speech): boolean {
  const groups = groupDeliverables(pending(item))
  if (groups.length === 0) return false

  const drafts = groups.find((g) => g.type === 'email_draft')
  const senders = (enrichment.senders ?? []).map(personName).filter((s): s is string => !!s)
  const saidSenders = !!drafts && senders.length > 0
  if (drafts && saidSenders) {
    const one = senders.length === 1 && drafts.n === 1
    const subject = one ? titled(cleanSubject(enrichment.subject ?? '')) : null
    speech.say(one ? `You got an email from ${senders[0]}` : `You got emails from ${listOf(senders, 3)}`, subject && `about ${subject}`)
  }

  // The meeting it came from goes with the first actions or cards said.
  const source = quoted(enrichment.sourceTitle)
  const fromAt = source ? groups.findIndex((g) => g.type === 'action' || g.type === 'attention_cards') : -1
  // An email drafting pass's drafts are replies (the pass drafts replies to threads).
  const replies = item.kind === 'email_drafts'
  const phrases = groups.map((g, i) =>
    groupPhrase(g, { v, alone: groups.length === 1, saidSenders, enrichment, from: i === fromAt ? source : null, replies }),
  )
  // An attempt is work nobody asked for yet: it never reads as if they had.
  const lead = item.origin === 'attempt' ? `${v.I} went ahead and` : v.I
  speech.say(lead, listAll(phrases))
  return true
}

function workItemNarration(item: NarratedWorkItem, opts: NarrationOptions, enrichment: NarrationEnrichment): Narration {
  const v = voiceOf(opts.person, opts.speaker ?? item.teammate?.name)
  const speech = new Speech()
  const title = quoted(item.title)

  switch (item.status) {
    case 'needs_input': {
      const questions = questionsOf(item.needs)
      const first = questions[0] ? questionClause(questions[0].text) : null
      if (questions.length > 1) {
        speech.say(`${v.have} ${count(questions.length, 'question')}`, title && `about ${title}`)
        if (first) speech.say(`The first: ${first}`)
      } else if (first) speech.say(`${v.have} a question: ${first}`)
      else speech.say(`${v.have} a question`, title ? `about ${title}` : 'for you')
      return { line: sentencesToLine(speech), canRead: questions.length > 0, ...(questions.length > 0 ? { readKind: 'text' as const } : {}) }
    }
    case 'needs_review':
    case 'done': {
      if (item.kind === 'extraction') return extractionNarration(item, v, enrichment)
      const routed = routedWorkNarration(item, v, enrichment)
      if (routed) return routed
      if (sayProduced(item, v, enrichment, speech)) {
        const readable = readableDeliverable(item)
        return {
          line: sentencesToLine(speech),
          canRead: !!readable,
          ...(readable ? { readKind: readable.type as NarrationReadKind } : {}),
        }
      }
      const summary = !!item.result_summary?.trim()
      if (title) speech.say(`${v.I} finished ${title}`)
      else speech.say(`${v.have} something for you`)
      return { line: sentencesToLine(speech), canRead: summary, ...(summary ? { readKind: 'text' as const } : {}) }
    }
    case 'running':
      speech.say(`${v.am} working on`, title ?? 'something')
      break
    case 'queued':
      speech.say(`${v.will} start on`, title ?? 'something', 'soon')
      break
    case 'waiting_on_child': {
      const needs = item.needs?.kind === 'child' ? item.needs : null
      const on =
        needs?.count && needs.count > 1
          ? count(needs.count, 'teammate')
          : needs?.role
            ? `the ${isWorkRole(needs.role) ? WORK_ROLE_LABELS[needs.role] : clause(needs.role)}`
            : 'a teammate'
      speech.say(`${v.am} waiting on ${on}`, title && `for ${title}`)
      break
    }
    case 'failed':
      if (isPausedFailure({ status: 'failed', error_message: item.error_message ?? null })) {
        speech.say(`${v.am} paused: the AI usage limit was reached`)
      } else {
        speech.say(`${v.I} couldn't finish`, title ?? 'something')
      }
      break
    case 'skipped':
      speech.say(`${v.I} skipped`, title ?? 'something')
      break
    case 'canceled':
      speech.say(`${v.I} stopped working on`, title ?? 'something')
      break
    default:
      return fallback(v, item.title)
  }
  return { line: sentencesToLine(speech), canRead: false }
}

// ── Work that came to a bot with no teammate of its own ──────────────────────
//
// Prospecting, evals, onboarding research and enrichment come from a bot since
// bots-v4 Phase 5: a Researcher or Developer, or the Assistant, which stands
// for all of them at once. So each line names its work ("I found 12 new
// companies for 'Fintech CFOs'.", "I ran the evals for 'Discovery calls': all
// 12 trials passed."), from the row's own title and summary. A row without
// them (a light row) says what any row says.

/** A run that stopped at its own budget keeps what it found: "Stopped at the run budget — Found 12 new companies". */
const BUDGET_STOP_RE = /^Stopped at the (run|eval) budget\s+[—-]+\s+(.+)$/i

/** A sentence's first letter lower-cased, to run on after "I". */
function runOn(text: string): string {
  return text ? `${text[0].toLowerCase()}${text.slice(1)}` : text
}

/** The row's summary as a clause: markdown off, ids and emails out, the producers' "·" read as commas. */
function summaryClause(item: NarratedWorkItem): string | null {
  return short(clause(withoutEmails((item.result_summary ?? '').replace(/\s+·\s+/g, ', '))), 160)
}

/** What the row's title names after a known lead ("Finding companies for Q3 ICP" → "Q3 ICP"). */
function titleAfter(title: string | null | undefined, lead: RegExp): string | null {
  const m = lead.exec(title?.trim() ?? '')
  return m?.[1]?.trim() || null
}

/** The prospect list a prospecting row worked on: its deliverable's title, else its own title's. */
function prospectListName(item: NarratedWorkItem, enrichment: NarrationEnrichment): string | null {
  const list = (item.deliverables ?? []).find((d) => d.type === 'prospect_list')
  return (list && deliverableTitle(list, enrichment.labels)) || titleAfter(item.title, /^(?:Finding companies for|Finding people in|Researching accounts in) (.+)$/i)
}

/** The line for a finished routed run (bots-v4 Phase 5), or null for the general one. */
function routedWorkNarration(item: NarratedWorkItem, v: Voice, enrichment: NarrationEnrichment): Narration | null {
  const summary = summaryClause(item)
  if (!summary) return null
  const speech = new Speech()
  switch (item.kind) {
    case 'prospecting': {
      // "Found 12 new companies" / "Found 3 people" / "Researched 4 companies", or "Stopped at the run
      // budget — found …" (prospecting-run-mirror.ts): what it found first, then that it stopped.
      const list = quoted(prospectListName(item, enrichment))
      const stopped = BUDGET_STOP_RE.exec(summary)
      speech.say(`${v.I} ${runOn(stopped ? stopped[2] : summary)}`, list && `for ${list}`, stopped && ', then stopped at the run budget')
      break
    }
    case 'eval': {
      // "12 trials, all passed" / "3 of 12 trials failed" / "Failed — 12 trials" / "Stopped at the eval
      // budget — 12 trials, all passed" (eval-run-mirror.ts evalSummary and its budget stop).
      const suite = quoted(titleAfter(item.title, /^Evaluating (.+?)(?: \((?:batch|live)\))?$/i))
      const ran = suite ? `${v.I} ran the evals for ${suite}` : `${v.I} ran an eval`
      const stopped = BUDGET_STOP_RE.exec(summary)
      const failedAfter = /^Failed — (.+)$/i.exec(summary)
      if (stopped) speech.say(`${ran} and stopped at the eval budget: ${runOn(stopped[2])}`)
      else if (failedAfter) speech.say(`${ran}, and the run failed after ${failedAfter[1]}`)
      else speech.say(`${ran}: ${runOn(summary)}`)
      break
    }
    case 'onboarding_research':
      // "Found your company; set up Launch plan with 4 actions" (onboarding-research-mirror.ts).
      speech.say(`${v.I} finished researching your company`).say(summary)
      break
    case 'crm_enrichment': {
      // "Enriching 12 contacts" / "Enriching Dana Lee", then "Enriched 9 of 12 · 2 failed" / "Filled 3 fields" (enrichment-mirror.ts).
      const what = titled(titleAfter(item.title, /^Enriching (.+)$/i))
      speech.say(`${v.I} looked up ${what ?? 'your records'} on the web`).say(summary)
      break
    }
    default:
      return null
  }
  return { line: sentencesToLine(speech), canRead: false }
}

/** An extraction pass read a capture and filed what was said in it. */
function extractionNarration(item: NarratedWorkItem, v: Voice, enrichment: NarrationEnrichment): Narration {
  const capture = item.deliverables?.find((d) => d.type === 'capture')
  const what = quoted(enrichment.sourceTitle ?? (capture ? deliverableTitle(capture, enrichment.labels) : null))
  const summary = titled(item.result_summary)
  const speech = new Speech().say(
    `${v.I} went through ${what ?? 'a capture'}`,
    summary && `: ${summary[0].toLowerCase()}${summary.slice(1)}`,
  )
  return { line: sentencesToLine(speech), canRead: false }
}

// ── A card ───────────────────────────────────────────────────────────────────

function payloadString(payload: Record<string, unknown> | null | undefined, key: string): string | null {
  const v = payload?.[key]
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** What a card says beyond its title: why it was surfaced and what it
 *  proposes (output.ts `cardFrom` reads the same fields). */
function cardDetail(card: NarratedCard): string[] {
  const p = card.payload
  const display = payloadString(p, 'display_text')
  const detail =
    payloadString(p, 'description') ??
    payloadString(p, 'task') ??
    payloadString(p, 'email_context') ??
    (display && display !== card.title ? display : null)
  return [card.why?.trim() || null, detail].filter((t): t is string => !!t)
}

/** Nouns for the entity a card proposes. */
const ENTITY_NOUNS: Record<string, string> = {
  action: 'action',
  decision: 'decision',
  project: 'project',
  milestone: 'milestone',
  initiative: 'initiative',
  contact: 'contact',
  company: 'company',
}

function cardNarration(card: NarratedCard, opts: NarrationOptions): Narration {
  const v = voiceOf(opts.person, opts.speaker)
  const p = card.payload ?? {}
  const title = titled(card.title)
  const speech = new Speech()
  const changeType = payloadString(p, 'change_type')

  if (card.kind === 'question' && postDraftFromPayload(p)) {
    // A post draft (delivered work, For you's): drafted, never a question.
    speech.say(`${v.I} drafted a post`, title && `: ${title}`)
  } else if (card.kind === 'question') {
    const q = questionClause(card.title)
    speech.say(q ? `${v.have} a question: ${q}` : `${v.have} a question for you`)
  } else if (card.kind === 'draft_email' || changeType === 'send_email') {
    const to = personName(payloadString(p, 'email_to_name') ?? payloadString(p, 'email_to_address'))
    const about = titled(cleanSubject(payloadString(p, 'email_subject') ?? ''))
    if (to) speech.say(`${v.I} could draft an email to ${to}`, about ? `about ${about}` : title && `: ${title}`)
    else speech.say(`${v.I} could draft an email`, title && `: ${title}`)
  } else if (card.kind === 'work_proposal') {
    const hint = payloadString(p, 'deliverable_hint')
    const does =
      hint === 'email_draft'
        ? 'could draft an email'
        : hint === 'document'
          ? 'could write a document'
          : hint === 'board_update'
            ? 'could update the board'
            : 'could take this on'
    speech.say(`${v.I} ${does}`, title && `: ${title}`)
  } else if (card.kind === 'action_card') {
    const entity = payloadString(p, 'entity_type')
    const noun = (entity && ENTITY_NOUNS[entity]) || 'action'
    const from = quoted(payloadString(p, 'capture_title'))
    if (changeType === 'update') speech.say(`${v.would} update ${article(noun)} ${noun}`, title && `: ${title}`)
    else if (changeType === 'assign') speech.say(`${v.would} assign ${article(noun)} ${noun}`, title && `: ${title}`)
    else if (changeType === 'delete') speech.say(`${v.would} remove ${article(noun)} ${noun}`, title && `: ${title}`)
    else if (changeType === 'create' || !changeType) {
      speech.say(`${v.I} found ${article(noun)} ${noun}`, from ? `in ${from}` : 'for you', title && `: ${title}`)
    } else return fallback(v, card.title)
  } else {
    return fallback(v, card.title)
  }
  const readable = cardDetail(card).length > 0
  return { line: sentencesToLine(speech), canRead: readable, ...(readable ? { readKind: 'text' as const } : {}) }
}

/** Anything without a template of its own. */
function fallback(v: Voice, title: string | null | undefined): Narration {
  const t = titled(title)
  return { line: sentencesToLine(new Speech().say(`${v.have} something for you`, t && `: ${t}`)), canRead: false }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** The line a bot says about one row or card, and whether "Read it" has
 *  something to read. */
export function narrateItem(input: NarrationInput): Narration {
  const opts: NarrationOptions = { person: input.person, speaker: input.speaker }
  if (input.card) return cardNarration(input.card, opts)
  return workItemNarration(input.item, opts, input.enrichment ?? {})
}

interface Thing {
  singular: string
  plural: string
  n: number
}

/** One thing a bot has, as nouns to count: "a draft", "two cards". */
function thingsOf(subject: NarrationSubject): Thing[] {
  if (subject.card) {
    return subject.card.kind === 'question'
      ? [{ singular: 'question', plural: 'questions', n: 1 }]
      : [{ singular: 'card', plural: 'cards', n: 1 }]
  }
  const item = subject.item
  if (item.status === 'needs_input') {
    return [{ singular: 'question', plural: 'questions', n: Math.max(1, questionsOf(item.needs).length) }]
  }
  if (item.status === 'needs_review' || item.status === 'done') {
    const groups = groupDeliverables(pending(item))
    if (groups.length === 0) return [{ singular: 'result', plural: 'results', n: 1 }]
    return groups.map((g) => ({ singular: deliverableNoun(g.type, 1), plural: deliverableNoun(g.type, 2), n: g.n }))
  }
  if (item.status === 'failed') return [{ singular: 'problem', plural: 'problems', n: 1 }]
  return [{ singular: 'update', plural: 'updates', n: 1 }]
}

/**
 * What a bot with several things says first: "I have three things for you:
 * two drafts and a question.", "I have a draft for you.", "I have nothing new
 * for you." Counted by what they are, in the order they come.
 */
export function narrateSummary(items: readonly NarrationSubject[], opts: NarrationOptions = {}): string {
  const firstRow = items.find((i) => i.item)?.item
  const v = voiceOf(opts.person, opts.speaker ?? firstRow?.teammate?.name)
  const tally: Thing[] = []
  for (const subject of items) {
    for (const thing of thingsOf(subject)) {
      const have = tally.find((t) => t.singular === thing.singular)
      if (have) have.n += thing.n
      else tally.push({ ...thing })
    }
  }
  const total = tally.reduce((sum, t) => sum + t.n, 0)
  const speech = new Speech()
  if (total === 0) speech.say(`${v.have} nothing new for you`)
  else if (tally.length === 1) speech.say(`${v.have} ${some(tally[0].n, tally[0].singular, tally[0].plural)} for you`)
  else speech.say(`${v.have} ${count(total, 'thing')} for you: ${listAll(tally.map((t) => some(t.n, t.singular, t.plural)))}`)
  return sentencesToLine(speech)
}

// ── Notices: the sentence a bot's notification carries ───────────────────────
//
// Bots v3 (docs/plans/bots-v3.md "Attribution"): a notification an AI run
// leaves names its teammate and carries the sentence its bot says, written by
// the server from facts it already holds (bot-notice.ts puts it on the row's
// metadata). The banner, the peek and the bot's Notices read that one text, and the
// bubble's narration builds from the same templates, so they never differ.
// Always first person: the bot is the one speaking. Never a model.

/** What a verdict run (a triage) left: the facts its digest is written from. */
export interface VerdictNoticeFacts {
  /** Cards that landed for you. */
  cardCount: number
  /** Proposals past the per-run card cap, left in the capture. */
  overflowCount?: number
  /** Auto-accepted changes the run took back. */
  revokedCount?: number
  /** The capture the run triaged, when a capture fired it. */
  captureTitle?: string | null
}

/**
 * "I triaged 'Call with Acme': three proposals need you."
 * "I triaged 'Call with Acme': one proposal needs you. Two more are waiting in the capture."
 * "I took back an auto-accepted change from 'Call with Acme'."
 */
export function verdictNoticeLine(facts: VerdictNoticeFacts): string {
  const n = Math.max(0, facts.cardCount)
  const overflow = Math.max(0, facts.overflowCount ?? 0)
  const revoked = Math.max(0, facts.revokedCount ?? 0)
  const where = quoted(facts.captureTitle)
  const speech = new Speech()
  if (n > 0) {
    const need = `${count(n, 'proposal')} ${n === 1 ? 'needs' : 'need'} you`
    speech.say(where ? `I triaged ${where}: ${need}` : `I finished triage: ${need}`)
    if (overflow > 0) {
      speech.say(`${count(overflow, 'more', 'more')} ${overflow === 1 ? 'is' : 'are'} waiting in ${where ? 'the capture' : 'the queue'}`)
    }
    if (revoked > 0) speech.say(`I also took back ${some(revoked, 'auto-accepted change', 'auto-accepted changes')}`)
  } else if (revoked > 0) {
    speech.say(`I took back ${some(revoked, 'auto-accepted change', 'auto-accepted changes')}`, where && `from ${where}`)
  } else {
    speech.say(where ? `I triaged ${where}: nothing needs you` : 'I finished triage: nothing needs you')
  }
  return sentencesToLine(speech)
}

/** "I skipped 'Weekly brief' this time. Connect a calendar first." */
export function skippedNoticeLine(facts: { skillName?: string | null; reason?: string | null }): string {
  const speech = new Speech().say(`I skipped ${quoted(facts.skillName) ?? 'a loop'} this time`)
  const reason = short(clause(withoutEmails(facts.reason ?? '')), 160)
  if (reason) speech.say(reason)
  return sentencesToLine(speech)
}

/** What a ledger row waiting on you (or failed) says as a notice: the bubble's own line for it. */
export function workNoticeLine(item: NarratedWorkItem): string {
  return narrateItem({ item }).line
}

/**
 * What a run's cards, folded into one batch item (bots v3 1b, batch.ts), say:
 * the verdict digest's own sentence, from what the cards carry (their count,
 * and the capture they came from), so the batch, its peek and its notice say
 * the same thing. "I triaged 'Call with Acme': three proposals need you."
 */
export function batchLine(cards: readonly Pick<NarratedCard, 'payload'>[]): string {
  return verdictNoticeLine({ cardCount: cards.length, captureTitle: batchCaptureTitle(cards) })
}

/** A batch's title: the capture its cards came from, else the loop that wrote them, else "Proposals for you". */
export function batchTitle(cards: readonly Pick<NarratedCard, 'payload'>[]): string {
  const from = batchCaptureTitle(cards)
  if (from) return from
  for (const card of cards) {
    const skill = payloadString(card.payload ?? {}, 'skill_name')
    if (skill) return skill
  }
  return 'Proposals for you'
}

function batchCaptureTitle(cards: readonly Pick<NarratedCard, 'payload'>[]): string | null {
  for (const card of cards) {
    const title = payloadString(card.payload ?? {}, 'capture_title')
    if (title) return title
  }
  return null
}

/** A notice from another workspace than the one on screen: "In Acme, I triaged …". */
export function noticeInWorkspace(line: string, workspaceName: string | null | undefined): string {
  const name = short(clause(withoutEmails(workspaceName ?? '')), 60)
  if (!name || !line) return line
  const rest = /^I\b/.test(line) ? line : `${line[0].toLowerCase()}${line.slice(1)}`
  return `In ${name}, ${rest}`
}

// ── Readings: what "Read it" says ────────────────────────────────────────────

/** How much a reading says before it stops (about four minutes aloud). */
export const MAX_READ_CHARS = 5000
/** Said when a reading stops before the end. */
export const READ_MORE_LINE = "That's the first part. Open it to read the rest."

/** A paragraph of a reading: its text, and its sentences. */
interface ReadPart {
  text: string
  sentences: string[]
}

export interface Reading {
  title: string | null
  /** Shown: paragraphs split by blank lines. */
  text: string
  /** Said: the preface, then the text, sentence by sentence. */
  sentences: string[]
}

/** Parts → a reading: sentence by sentence up to `max` characters, the
 *  preface said first (not shown), no email address anywhere. Null when there
 *  is nothing to read. */
function reading(title: string | null, preface: readonly string[], parts: readonly ReadPart[], max = MAX_READ_CHARS): Reading | null {
  const kept: string[][] = []
  let used = 0
  let truncated = false
  for (const part of parts) {
    const sentences = part.sentences
      .map((s) => withoutEmails(s).replace(/\s+/g, ' ').trim())
      .filter((s) => /[\p{L}\p{N}]/u.test(s))
    const keep: string[] = []
    for (const s of sentences) {
      if (used + s.length > max && (kept.length > 0 || keep.length > 0)) {
        truncated = true
        break
      }
      keep.push(s)
      used += s.length + 1
    }
    if (keep.length) kept.push(keep)
    if (truncated) break
  }
  if (kept.length === 0) return null
  const said = preface.map((s) => withoutEmails(s).replace(/\s+/g, ' ').trim()).filter(Boolean)
  return {
    title: title ? short(withoutEmails(title), 120) : null,
    text: kept.map((p) => p.join(' ')).join('\n\n') + (truncated ? '\n\n…' : ''),
    sentences: [...said, ...kept.flat(), ...(truncated ? [READ_MORE_LINE] : [])],
  }
}

/** Markdown (a document, a summary, a card's reasoning) → parts, block by
 *  block, as listen mode reads a document (speech-text). */
function markdownParts(markdown: string): ReadPart[] {
  return parseSpeechBlocks(markdown).flatMap((block) => {
    const text = blockToSpeech(block)
    return text ? [{ text, sentences: splitSentences(text) }] : []
  })
}

/** An email draft: "The draft to Alex Rivera, about Q3 planning.", then its
 *  body without quoted history, signature or footer (email-speech). Plain
 *  text in (`bodyText`): the route has no DOM to read HTML with. */
export function draftReading(draft: {
  subject?: string | null
  recipients?: readonly string[]
  bodyText?: string | null
}): Reading | null {
  const subject = plainTextToSpeech(cleanSubject(draft.subject ?? ''))
  const lines = dropSubjectEcho(emailBodyLines({ bodyText: draft.bodyText ?? '', subject: draft.subject ?? '' }), subject)
  const parts = lines.map((line) => ({ text: plainTextToSpeech(line.text), sentences: linesToSentences([line]) }))
  const to = listOf((draft.recipients ?? []).map(personName), 3)
  const preface = `The draft${to ? ` to ${to}` : ''}${subject ? `${to ? ',' : ''} about ${subject}` : ''}`
  return reading(subject || (to ? `Draft to ${to}` : 'Draft'), [withTerminalPunctuation(preface)], parts)
}

/** A document: its title said first, then its text (markdown). */
export function documentReading(doc: { title?: string | null; content?: string | null }): Reading | null {
  const title = plainTextToSpeech(doc.title ?? '')
  return reading(title || null, title ? splitSentences(withTerminalPunctuation(title)) : [], markdownParts(doc.content ?? ''))
}

/** Text with markdown in it: a result summary, a card's reasoning. */
export function textReading(title: string | null | undefined, markdown: ReadonlyArray<string | null | undefined>): Reading | null {
  return reading(title ? plainTextToSpeech(title) || null : null, [], markdown.flatMap((m) => (m ? markdownParts(m) : [])))
}

/** A parked row's questions, each with its options. */
export function questionReading(title: string | null | undefined, questions: readonly NarrationQuestion[]): Reading | null {
  const parts = questions.flatMap((q): ReadPart[] => {
    const text = plainTextToSpeech(inlineToSpeech(q.text))
    const options = q.options.map((o) => plainTextToSpeech(inlineToSpeech(o))).filter(Boolean)
    const choices = options.length ? `${q.multiSelect ? 'You can pick more than one' : 'The options are'}: ${listAll(options)}.` : null
    return [
      ...(text ? [{ text, sentences: splitSentences(withTerminalPunctuation(text)) }] : []),
      ...(choices ? [{ text: choices, sentences: [choices] }] : []),
    ]
  })
  return reading(title ? plainTextToSpeech(title) || null : null, [], parts)
}

/** A card: why it was surfaced and what it proposes. */
export function cardReading(card: NarratedCard): Reading | null {
  return textReading(card.title, cardDetail(card))
}

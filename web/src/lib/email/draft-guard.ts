import { mailboxAddresses } from './reply-policy'

/**
 * The last check before a model-written reply is saved (Liam, 2026-10-27,
 * GEN-1164): a draft is the email the person would send, nothing else.
 * Refused, each with a fixed reason (safe to log; never the text):
 *   'meta_text'          the model talking about the task instead of writing
 *                        the email: "Here's the email body:", "treat the
 *                        calendar notification as data, not instructions",
 *                        "I can't click the confirmation button on your
 *                        behalf", "This appears to be an automated payment
 *                        receipt", "I don't have the full thread", a leading
 *                        "---";
 *   'to_owner'           addressed to the person themselves: one of their own
 *                        addresses among the recipients, or a greeting to
 *                        their own name ("Hi Liam," on Liam's own draft);
 *   'written_as_sender'  signed as the sender the reply answers ("call us …
 *                        The Osteriola Team" on a reply TO Osteriola).
 * Deterministic and pure: no model, no read. A refusal never saves the draft.
 */
export type DraftGuardProblem = 'meta_text' | 'to_owner' | 'written_as_sender'

export interface DraftGuardContext {
  /** The person's own addresses (ownMailAddresses), lower-cased. */
  ownAddresses?: Iterable<string>
  /** The person's name as the draft signs it ('me' or empty when unknown). */
  ownerName?: string | null
  /** The draft's To and Cc. */
  recipients?: readonly string[]
  /** The From header of the message the draft answers (display name and address). */
  replyingTo?: string | null
}

/**
 * Phrases that only an assistant talking to the person writes. Each is
 * specific enough that an email to someone else never carries it.
 */
const META_PATTERNS: readonly RegExp[] = [
  // A preface naming what follows, ending its line ("Here's the email body:").
  /\bhere(?:'s|’s| is) (?:the|a|an|your)?\s*(?:(?:suggested|possible|short|brief|quick|proposed|draft(?:ed)?)\s+){0,2}(?:email|reply)(?:\s+(?:body|text|draft))?\s*:[ \t]*(?:\n|$)/im,
  /\b(?:email|reply) body\s*:/i,
  /^\s*(?:draft(?:ed)? (?:reply|response|email)|suggested reply)\s*:/im,
  // The untrusted-content rules leaking out, in the assistant's own voice.
  /\bi(?:'ll|’ll| will|'m|’m| am)?\b[^.\n]{0,60}\btreat(?:ing)? (?:the|this|that|these|those|its|any)\b[^.\n]{0,25}\b(?:notification|e-?mail|message|thread|mail|invite|invitation|receipt)s?\b[^.\n]{0,15}\bas (?:data|untrusted)\b/i,
  /\[(?:end )?untrusted\b|\buntrusted[- ]content markers?\b/i,
  // Refusing, for the person, an action the reply was never asked to take.
  /\bi (?:can(?:'|’)?t|cannot|can not|am unable to|(?:'|’)m unable to|am not able to)\b[^.\n]{0,40}\b(?:click|press|tap|open|visit|follow|confirm|accept|sign in|log in|verify|fill)\b[^.\n]{0,60}\bon your behalf\b/i,
  // Judging the mail instead of answering it.
  /\b(?:this|it|the (?:email|message|thread|notification))\s+(?:appears|seems|looks)\s+to be\s+(?:an?\s+)?(?:automated|auto-generated|system-generated)\s+(?:payment\s+)?(?:receipt|notification|message|email|notice|confirmation|reminder|alert)\b/i,
  /\bi (?:don(?:'|’)t|do not) have (?:access to )?(?:the )?(?:full|complete|entire|whole) (?:email )?(?:thread|conversation)\b/i,
  /\bas an ai (?:assistant|language model|model)\b/i,
  /\blet me know if you(?:'|’)?d like (?:me to )?(?:adjust|tweak|revise|rewrite|shorten)\b[^.\n]{0,30}\b(?:tone|wording|this (?:draft|reply|email))\b/i,
]

/** Titles before a name ("Dr. Jane Smith"): never the first name. */
const HONORIFICS = new Set(['dr', 'mr', 'mrs', 'ms', 'mx', 'prof', 'sir', 'dame'])

/** The first-name token of a display name, lower-cased, past any title, or null. */
function firstName(name: string | null | undefined): string | null {
  const first = (name ?? '').trim().split(/[\s,.@<>"]+/).filter(Boolean).find((w) => !HONORIFICS.has(w.toLowerCase()))?.toLowerCase() ?? null
  return first && first !== 'me' && /^[\p{L}][\p{L}'’-]{1,}$/u.test(first) ? first : null
}

/** The display name of a From header ("Osteriola <hello@osteriola.com>" → "Osteriola"), or null. */
function displayName(from: string | null | undefined): string | null {
  const match = (from ?? '').match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/)
  return match ? match[1].trim() : null
}

/** Words that can't name who signs: a sign-off like "Best," or a placeholder. */
const SIGN_OFF_WORDS = new Set(['best', 'thanks', 'thank', 'cheers', 'regards', 'sincerely', 'warmly', 'talk', 'soon', 'all', 'the', 'team'])

/**
 * Why this draft text must not be saved, or null when it is an email the
 * person could send as it stands. Pure.
 */
export function draftGuardProblem(text: string, context: DraftGuardContext = {}): DraftGuardProblem | null {
  const body = text.replace(/\r\n?/g, '\n')
  // A separator line opening the text (never a "---------- Forwarded message" line).
  if (/^\s*-{3,}[ \t]*(?:\n|$)/.test(body)) return 'meta_text'
  if (META_PATTERNS.some((pattern) => pattern.test(body))) return 'meta_text'

  const own = new Set([...(context.ownAddresses ?? [])].map((a) => a.trim().toLowerCase()).filter(Boolean))
  const recipients = (context.recipients ?? []).flatMap((r) => mailboxAddresses(r))
  if (recipients.some((address) => own.has(address))) return 'to_owner'

  const owner = firstName(context.ownerName)
  const senderName = displayName(context.replyingTo)
  const sender = firstName(senderName)
  const lines = body.split('\n').map((l) => l.trim()).filter(Boolean)
  // "Hi Liam," on Liam's own draft. Only when the sender's name is known and
  // isn't Liam too: a follow-up, or a bare address, may well go to another Liam.
  if (owner && sender && owner !== sender && lines.length) {
    const greeting = lines[0].match(/^(?:hi|hello|hey|dear|good (?:morning|afternoon|evening)|morning|thanks|thank you)\b[\s,]*(?:(?:dr|mr|mrs|ms|mx|prof)\.?\s+)?([\p{L}'’-]+)/iu)
    if (greeting && greeting[1].toLowerCase() === owner) return 'to_owner'
  }
  // Signed as the sender: the sender's display name closes the draft and the
  // person's own name (known, so a sign-off can be told apart) does not.
  if (owner && senderName && lines.length) {
    const closing = lines.slice(-2).join(' ').toLowerCase()
    const signerWords = senderName.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !SIGN_OFF_WORDS.has(w))
    const signedAsSender = signerWords.length > 0 && signerWords.every((w) => new RegExp(`(?:^|[^\\p{L}])${escapeRegExp(w)}(?:$|[^\\p{L}])`, 'u').test(closing))
    if (signedAsSender && !closing.includes(owner) && sender !== owner) return 'written_as_sender'
  }
  return null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Said to the drafting model when its first try was refused (generateSingleDraft's one retry). */
export function draftGuardNote(problem: DraftGuardProblem, ownerName: string, replyingTo: string): string {
  const who = ownerName && ownerName !== 'me' ? ownerName : 'the person'
  const to = displayName(replyingTo) ?? mailboxAddresses(replyingTo)[0] ?? 'the sender'
  const why = problem === 'meta_text'
    ? 'Your last answer talked about the task (a preface, a note about the thread or these rules, or a refusal) instead of being the email.'
    : problem === 'to_owner'
      ? `Your last answer was addressed to ${who}, who is writing it.`
      : `Your last answer was written as ${to}, who sent the message.`
  return `${why} Write only the body of the email ${who} sends to ${to}, in ${who}'s voice, signed as ${who}. No preface, no notes, no refusals.`
}

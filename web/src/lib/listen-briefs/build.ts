/**
 * Listen briefs: in listen mode, opening something in the app (a capture, a
 * contact, a company, a calendar event, a project, an initiative, an action,
 * an agent, a skill or a flow) has the app tell you about it in a few spoken
 * sentences, from what the workspace knows: "Pricing sync, on Tuesday, with
 * Jessa Lin and Jordan Lee from Acme." then the meeting's own summary, then its
 * accepted action items.
 *
 * No model writes them (Liam, 2026-09-28: "I don't want to use an llm for this
 * feature"). Each kind has a builder (./builders/*) that reads what the
 * workspace knows about one item and says it with plain code: fixed sentences
 * filled in from the rows (./speech), times said the way people say them
 * (./when), and a capture's notes read from their own summary section. The
 * route (/api/account/listen/brief) returns the sentences, and the client
 * speaks them (components/read-aloud/listen-brief.tsx).
 *
 * Adding a page: a builder, an entry below, and a <ListenBrief kind id /> in
 * its detail panel.
 */

import type { BriefContext } from './context'
import type { ListenBriefKind } from './kinds'
import type { Speech } from './speech'
import { actionSpeech } from './builders/action'
import { captureSpeech } from './builders/capture'
import { companySpeech } from './builders/company'
import { contactSpeech } from './builders/contact'
import { eventSpeech } from './builders/event'
import { flowSpeech } from './builders/flow'
import { initiativeSpeech } from './builders/initiative'
import { librarySpeech } from './builders/library'
import { projectSpeech } from './builders/project'

/** Says one item; null when it doesn't exist or isn't the user's to see
 *  (indistinguishable, by design). `input` is what the client sent about an
 *  item that lives outside the database (a calendar event). */
export type BriefBuilder = (ctx: BriefContext, id: string, input: unknown) => Promise<Speech | null>

const BUILDERS: Record<ListenBriefKind, BriefBuilder> = {
  capture: captureSpeech,
  contact: contactSpeech,
  company: companySpeech,
  project: projectSpeech,
  initiative: initiativeSpeech,
  event: eventSpeech,
  action: actionSpeech,
  agent: librarySpeech,
  skill: librarySpeech,
  flow: flowSpeech,
}

/** The item's sentences, or null (not found, or not the user's to see). */
export async function buildBrief(
  kind: ListenBriefKind,
  id: string,
  ctx: BriefContext,
  input?: unknown,
): Promise<string[] | null> {
  const speech = await BUILDERS[kind](ctx, id, input)
  return speech ? speech.toArray() : null
}

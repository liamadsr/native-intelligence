/**
 * The product-facts rider (canon documents D1; eve-alignment.md §4 "the one
 * section a turn needs"): on a turn that needs product facts, the product
 * doc's facts section rides the turn, outside the cached prefix, in the
 * pattern the live agent's riders set (#769). Never the whole canon on every
 * turn: a turn about something else carries nothing.
 *
 *   trigger   needsProductFacts: a cheap deterministic test over the person's
 *             message (pricing, features, integrations, positioning, a pitch,
 *             a case study…). No model call.
 *   content   the product doc's "What the product is" section (the product
 *             template's facts section, canon.ts), or, for a product doc not
 *             yet in sections, the whole doc, capped as the live agent caps
 *             it. Fenced as workspace-authored data, with the live agent's
 *             rules (renderProductFactsSection).
 *   cost      the product doc is read through loadProductDocForTurn: no
 *             pointer is no read, and a designated doc is one cached read per
 *             15 s. Only on a turn the trigger fires on.
 *
 * Surfaces: the chat's `product-facts` turn-context section (chat-run-rebuild),
 * and an email draft's context block (crm/email-drafts.ts). The live agent
 * already carries the whole doc on every live turn (product-facts.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { renderProductFactsSection } from '@/lib/live-agent/product-facts'
import { loadProductDocForTurn, type ProductDoc } from '@/lib/workspace/product-doc'
import { CANON_TEMPLATES } from './canon'
import { findSection, parseOutline, splitLines } from './markdown-structure'

/** The turn-context key the chat sends it under (chat-system-prompt TURN_CONTEXT_KEYS). */
export const PRODUCT_FACTS_SECTION_KEY = 'product-facts'

/** The product template's facts section. */
export const PRODUCT_FACTS_HEADING_TEXT = CANON_TEMPLATES.product.sections[0].heading

const PRODUCT_WORDS =
  /\b(?:pricing|prices?|priced|how much (?:is|does|do)|features?|integrat(?:e|es|ion|ions)|roadmap|positioning|competitors?|competition|value prop(?:osition)?s?|icp|ideal customer|messaging|tagline|one[- ]pager|case stud(?:y|ies)|landing page|pitch(?:es|ing)?|sales (?:deck|email|call)|our product|the product|product (?:doc|facts|page)|what (?:does|do|can) (?:we|dial8|native intelligence|ni|it) (?:do|offer|support)|(?:does|can) (?:it|dial8|native intelligence|ni|we) (?:support|integrate|work with|connect to)|launch (?:post|announcement|email)|announcement)\b/i

/** Whether a message needs product facts. Pure, no model call. */
export function needsProductFacts(text: unknown): boolean {
  return typeof text === 'string' && text.length > 0 && PRODUCT_WORDS.test(text)
}

/**
 * The product doc's facts: its "What the product is" section when it has one
 * (heading included, so the agent knows which part it is), else the whole
 * doc. Pure.
 */
export function productFactsText(doc: ProductDoc): string {
  const found = findSection(parseOutline(doc.text), PRODUCT_FACTS_HEADING_TEXT)
  if (!found.ok) return doc.text
  const lines = splitLines(doc.text).slice(found.entry.line - 1, found.entry.endLine)
  const text = lines.join('\n').trim()
  // A skeleton heading with nothing under it yet says no facts at all.
  return text.split('\n').length > 1 ? text : ''
}

/** The rider's markdown for a product doc, or null when it has no facts to state. Pure. */
export function renderProductFactsRider(doc: ProductDoc | null): string | null {
  if (!doc) return null
  const text = productFactsText(doc)
  if (!text.trim()) return null
  return renderProductFactsSection({ ...doc, text })
}

/**
 * The rider for a message, or null: the trigger didn't fire, the workspace
 * has no product doc, or it says nothing yet. `settings` is the
 * workspace.settings blob the caller already read. Never throws.
 */
export async function productFactsRider(
  supabase: SupabaseClient,
  args: { workspaceId: string; settings: unknown; text: unknown },
): Promise<string | null> {
  if (!needsProductFacts(args.text)) return null
  try {
    return renderProductFactsRider(await loadProductDocForTurn(supabase, { workspaceId: args.workspaceId, settings: args.settings }))
  } catch {
    return null
  }
}

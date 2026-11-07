/**
 * The two behaviors migration 274 and its prompts.ts half exist to guarantee,
 * as sidekick v1 (migration 358, 2026-10-18) left the first.
 *
 * Both were reported from real use, and both were PROMPT gaps rather than
 * missing machinery — which is exactly why they need tests. Nothing here
 * type-checks: a future edit that merely rewords a section can silently undo
 * either behavior, and the only detector is the prompt text itself.
 *
 *   1. THE LIVE AGENTS RESEARCH, AND SPEAK WHEN IT HELPS. 274 fixed an agent
 *      that said nothing (three stacked hedges) by making the bar two-sided;
 *      that pushed it to talk. Sidekick v1 keeps the research (open by finding
 *      out who is in the room, pull the packages, keep looking things up) and
 *      replaces the bar with a good colleague's: quiet by default, no quota,
 *      speak toward the call's goal or when the person needs something now,
 *      never twice. The persona text asserted here is what the rows read after
 *      358, read from 358 itself (274 never ran, so 358 sets the whole text:
 *      274's, then quiet).
 *
 *   2. WORK THE CONVERSATION CLOSED MUST NOT SURVIVE IT. A promise reported
 *      done, or a plan called off, leaves nothing on the user's list.
 *      dismiss_proposal already reached through applied proposals; the gap was
 *      that nothing told the agent to look.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { livePersona } from './helpers/live-persona-seeds'
import {
  ASSISTANT_PERSONA,
  BASE_SYSTEM_PROMPT,
  BATCH_SUMMARY_REQUIRED,
  LIVE_ASSIST_BASE_PROMPT,
} from '../prompts'

const MIGRATION = readFileSync(
  join(process.cwd(), 'supabase', 'migrations', '274_live_copilot_and_loop_closing.sql'),
  'utf8',
)

/** The three seeded personas 274 rewrites, and the slug each is keyed on. */
const SEEDED_PERSONAS = ['interactive', 'sales-live', 'sales-post-call'] as const

/** Body of one persona's UPDATE — the text between its $prompt$ delimiters. */
function personaPrompt(slug: string): string {
  const blocks = MIGRATION.split('$prompt$')
  // [preamble, prompt1, between, prompt2, between, prompt3, tail] → odd indexes
  // are prompt bodies, each followed by the WHERE clause naming its slug.
  for (let i = 1; i < blocks.length; i += 2) {
    if ((blocks[i + 1] ?? '').includes(`slug = '${slug}'`)) return blocks[i]
  }
  throw new Error(`no $prompt$ body found for slug '${slug}'`)
}

// ── Migration shape ────────────────────────────────────────────────────────
describe('migration 274', () => {
  it('rewrites exactly the three seeded personas, idempotently', () => {
    expect(MIGRATION.split('$prompt$').length - 1).toBe(6) // 3 bodies × 2 delimiters
    for (const slug of SEEDED_PERSONAS) {
      expect(MIGRATION).toContain(`WHERE slug = '${slug}' AND is_system = true;`)
    }
  })

  it('touches ONLY system_prompt — agent_config must survive', () => {
    // sales-live's assist-only contract lives in agent_config. A migration that
    // rewrote the row wholesale would silently turn it into a note-taker.
    expect(MIGRATION).not.toMatch(/^\s*agent_config\s*=/m)
    expect(MIGRATION).not.toMatch(/^\s*(category|visibility|sort_order)\s*=/m)
  })
})

// ── 1. Live agents research, and speak when it helps ───────────────────────
describe('the live agents research, and speak only when it helps', () => {
  it('ASSISTANT_PERSONA neither forbids speaking nor pushes it', () => {
    // 274's "it is not there" phrasings stay gone…
    expect(ASSISTANT_PERSONA).not.toMatch(/You do NOT speak or interrupt/)
    expect(ASSISTANT_PERSONA).not.toMatch(/silence is the right default/i)
    // …and so does 274's push to talk.
    expect(ASSISTANT_PERSONA).not.toMatch(/Two ways to fail here/)
    expect(ASSISTANT_PERSONA).not.toMatch(/it is the more common one/)
    expect(ASSISTANT_PERSONA).not.toMatch(/When you are choosing between a grounded, specific heads-up and saying nothing, say it/)
  })

  it('ASSISTANT_PERSONA states the good-colleague bar: quiet by default, no quota, toward the goal', () => {
    expect(ASSISTANT_PERSONA).toMatch(/Quiet by default, like a good colleague in a real meeting/)
    expect(ASSISTANT_PERSONA).toMatch(/There is no quota/)
    expect(ASSISTANT_PERSONA).toMatch(/helps the conversation toward the goal/)
    expect(ASSISTANT_PERSONA).toMatch(/Silence is the right output most of the time/)
  })

  it.each(['interactive', 'sales-live'] as const)(
    '%s opens by researching the room instead of waiting to be asked',
    (slug) => {
      const prompt = livePersona(slug)
      // Resolve the people, and pull the packages the user attached to THIS call
      // — the sales-pitch package that went unread is the reported failure.
      expect(prompt).toMatch(/get_package/)
      expect(prompt).toMatch(/first flush|first minutes/i)
      expect(prompt).toMatch(/get_contact_details|search_contacts/)
    },
  )

  it.each(['interactive', 'sales-live'] as const)(
    '%s no longer treats silence as the likelier failure, and sets no message count',
    (slug) => {
      const prompt = livePersona(slug)
      expect(prompt).not.toMatch(/learned nothing from you|never having told|without you having told/i)
      expect(prompt).not.toMatch(/speaks up|PRIMARY channel|the nudge wins|A scalpel still cuts|handful of high-value messages/)
      expect(prompt).toMatch(/There is no (quota|message budget)/)
      expect(prompt).toMatch(/What you've already told them this call/)
    },
  )

  it.each(['interactive', 'sales-live'] as const)(
    '%s turns the record into how to TALK to the person',
    (slug) => {
      // The guard that keeps this from decaying into generic sales coaching.
      expect(livePersona(slug)).toMatch(/could say the same sentence about any/i)
    },
  )

  it('BASE_SYSTEM_PROMPT finally carries the attached-packages pull', () => {
    // It only ever lived in LIVE_ASSIST_BASE_PROMPT, so a note-taking live agent
    // was never told from its system prompt that packages existed.
    expect(BASE_SYSTEM_PROMPT).toMatch(/## Attached Context Packages/)
    expect(BASE_SYSTEM_PROMPT).toMatch(/get_package/)
    expect(LIVE_ASSIST_BASE_PROMPT).toMatch(/## Attached Context Packages/)
  })
})

// ── 2. Work the conversation closed does not survive it ────────────────────
describe('closing the loop', () => {
  it('BASE_SYSTEM_PROMPT names all three signals', () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(/## Closing the Loop/)
    expect(BASE_SYSTEM_PROMPT, 'done').toMatch(/\*\*Done\.\*\*/)
    expect(BASE_SYSTEM_PROMPT, 'called off').toMatch(/\*\*Called off\.\*\*/)
    expect(BASE_SYSTEM_PROMPT, 'superseded').toMatch(/\*\*Superseded\.\*\*/)
  })

  it('routes each signal to the tool that can actually service it', () => {
    const loop = BASE_SYSTEM_PROMPT.split('## Closing the Loop')[1].split('## Valid Statuses')[0]
    // dismiss_proposal reaches THROUGH an applied proposal and deletes the real
    // entity — that reach is the whole reason this rule can work at all.
    expect(loop).toMatch(/dismiss_proposal/)
    expect(loop).toMatch(/applied/i)
    // A superseded item is edited, never dismissed-and-refiled.
    expect(loop).toMatch(/edit_proposal/)
    expect(loop).toMatch(/Do NOT dismiss and re-create/)
  })

  it('does not let "I am about to do it" close an item', () => {
    expect(BASE_SYSTEM_PROMPT).toMatch(
      /only a statement that the work has ALREADY happened closes the item/,
    )
  })

  it('the batch pass is told the END state wins over the whole transcript', () => {
    expect(BATCH_SUMMARY_REQUIRED).toMatch(/END STATE wins/)
    expect(BATCH_SUMMARY_REQUIRED).toMatch(/Already Applied/)
    // The batch agent sees everything at once, so the right move is never to
    // create the item — not to create it and then retract it.
    expect(BATCH_SUMMARY_REQUIRED).toMatch(/do not create it at all/)
  })

  it('both batch personas carry it too', () => {
    // ASSISTANT_PERSONA is the batch default; sales-post-call is the sales one.
    // As the rows read after 358, which carries 274's loop-closing text to them.
    expect(livePersona('sales-post-call')).toMatch(/## Close what the call closed/)
    expect(livePersona('sales-post-call')).toMatch(/dismiss_proposal/)
    expect(livePersona('interactive')).toMatch(/DONE or CALLED OFF/)
  })

  it('stays out of the assist-only prompt, which has no proposal tools', () => {
    // Guards the same invariant assist-only.test.ts does, from the other side:
    // this rule is written entirely in tools that agent was never given.
    expect(LIVE_ASSIST_BASE_PROMPT).not.toMatch(/## Closing the Loop/)
    expect(LIVE_ASSIST_BASE_PROMPT).not.toMatch(/dismiss_proposal/)
  })
})

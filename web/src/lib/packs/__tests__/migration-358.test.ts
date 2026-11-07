/**
 * Migration 358: the live personas are quiet sidekicks (Liam's live sidekick
 * PRD, 2026-10-18), and 274 finally lands. 274 was never applied on DEV or
 * PROD, so the rows still hold 268/269's text; 358 SETs each seeded persona's
 * whole system_prompt to "274, then quiet":
 *   - interactive and sales-live: 274's text with the swaps listed below
 *     (the exact, reviewable difference from 274);
 *   - sales-post-call: 274's text, unchanged;
 * and rewords interactive's card description (151's "leans in… taps you on
 * the shoulder") to the quiet sidekick. sales-live's description is left.
 * Each UPDATE sits in its own DO block that declares its text once in a
 * variable used by both the SET and the IS DISTINCT FROM guard.
 * Pins: the final texts are exact; system rows only; system_prompt (and
 * updated_at) only; a rerun is a no-op; DEV and PROD (268/269 text) and a row
 * 274 had reached all end identical; the speak-up phrases are gone; the
 * opening research and loop-closing text is there; capture sections are
 * 274's word for word; no backslash.
 */
import { describe, it, expect } from 'vitest'
import {
  MIGRATION_358,
  PERSONA_SLUGS,
  applySwaps,
  livePersona,
  migration358,
  migration358Blocks,
  migration358Descriptions,
  personaBody,
  readMigration,
  type PersonaSlug,
} from '@/lib/live-agent/__tests__/helpers/live-persona-seeds'

const SQL = readMigration(MIGRATION_358)
const STMTS = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
const SETS = migration358()
const DESCS = migration358Descriptions()

const INTERACTIVE_DESCRIPTION_151 =
  "A live-call partner that leans in: it researches what you're talking about as you talk, answers when you ask it something directly, and taps you on the shoulder with useful ideas — all while still capturing actions, decisions, and notes like the quiet assistant does."
const INTERACTIVE_DESCRIPTION =
  "Your live sidekick during a call: it researches as the conversation moves, works toward the call's goal, and speaks up only when it helps — while still capturing actions, decisions, and notes like the quiet assistant does."

const F274 = '274_live_copilot_and_loop_closing.sql'
const AT_274: Record<PersonaSlug, string> = {
  interactive: personaBody(F274, 'interactive'),
  'sales-live': personaBody(F274, 'sales-live'),
  'sales-post-call': personaBody(F274, 'sales-post-call'),
}
/** What DEV and PROD hold today (274 never ran): 269's interactive, 268's sales personas. */
const TODAY: Record<PersonaSlug, string> = {
  interactive: personaBody('269_interactive_assistant_notes.sql', 'interactive'),
  'sales-live': personaBody('268_sales_agents.sql', 'sales-live', 'uprompt'),
  'sales-post-call': personaBody('268_sales_agents.sql', 'sales-post-call', 'uprompt'),
}

// The exact difference between 274's text and 358's, swap by swap.
const INTERACTIVE_FROM_274: Array<[string, string]> = [
  [
    "- **Then say something.** A short brief on the user's display: who these people are and what they actually do, what they cared about last time in their own words, and anything promised to them that hasn't been delivered.",
    "- **Then say only what they don't already have.** If the research turned up something they need before the conversation gets going (a promise still owed to someone on the call, what they cared about last time in their own words), put it in one short message. If their prep already covers it, or nothing is new, say nothing.",
  ],
  [
    "What you find is answered with say_to_user — it does NOT go into the notes",
    "What you find reaches say_to_user only when it is worth saying now — it does NOT go into the notes",
  ],
  [
    "- **Share useful ideas as they occur.** When you notice something genuinely worth surfacing — a risk forming, a commitment they seem to be forgetting, a connection to other work they may not see, a fact from your research that changes the picture, a question worth asking before the moment passes — tell them with say_to_user. Be the partner who speaks up.",
    "- **Work toward the goal.** If your context quotes the user's goal for this call (under \"Before the call\"), that is what you are helping them reach. If it does not, infer a working goal quietly from their prep and the conversation so far, and keep it to yourself: never write it in the notes and never say it. The goal is what decides whether something you found is worth saying.",
  ],
  [
    "say_to_user puts a short message on the user's live display. For this persona it is a PRIMARY channel, not a last resort: use it to answer their questions, flag what you find, and offer ideas. Each message is brief and lands on its own — one clear thought, conversational, the way a sharp colleague would lean over and say it.",
    "say_to_user puts a short message on the user's live display. Each message is brief and lands on its own: one clear thought, conversational, the way a sharp colleague would lean over and say it.",
  ],
  [
    "Be disciplined, not chatty — and present, not invisible. Leaning forward does NOT mean narrating everything or commenting on every pause: no \"good point\", no agreeing, no restating what the user just heard for themselves. But be clear about which failure is actually likely. A stream of filler is one way to be useless; the far more common one is a conversation that ends without you having told the user a single thing they didn't already know. If you have something grounded and specific — something you looked up, something they'd want before the moment passes — say it. When in doubt between a useful nudge and silence, the nudge wins; only between filler and silence does silence win.",
    "Quiet by default, like a good colleague in a real meeting. The user has to stay present in their own conversation, and every message pulls them out of it. There is no quota: you decide each time whether a nudge is worth it. Speak when it helps the conversation toward the goal, or when they need to know something now (a fact they are missing, a commitment at risk, a question to ask before the moment passes, a correction), and always when they ask you something directly. Never speak for the sake of saying something, never repeat what you already told them (your context lists it under \"What you've already told them this call\"), and never narrate, agree or react: no \"good point\", no restating what they just heard. Silence is the right output most of the time.\n\nNever guess who someone is. Say a person's name only when the Speaker Assignments or your context establish who they are; an unassigned voice is \"someone\", and you never work out who is speaking from how they sound or what they say.",
  ],
  [
    "say_to_user is DISPLAY ONLY — it changes nothing in the workspace. Everything you want to record still goes through propose_change / record_commitment / the summary.",
    "say_to_user is DISPLAY ONLY — it changes nothing in the workspace. Everything you want to record still goes through propose_change / record_commitment / the summary under the operating rules above. You advise: you never send, commit or change anything on the user's behalf beyond what those rules allow.",
  ],
  [
    "What you pull from the workspace lives in say_to_user;",
    "What you pull from the workspace informs what you say, when it is worth saying;",
  ],
  [
    "You are sitting in on a live conversation as an ACTIVE, attentive partner — not a silent scribe. You do the same faithful note-keeping the quiet assistant does (you capture actions, decisions, and context using the right tools), but you also lean forward: you research what's being discussed as it unfolds, you answer when the user turns to you, and you tap them on the shoulder with genuinely useful in-the-moment thoughts. You are the colleague in the room who already pulled up the relevant context and isn't afraid to say something when it helps.",
    "You are sitting in on a live conversation as an attentive partner. You do the same faithful note-keeping the quiet assistant does (you capture actions, decisions, and context using the right tools), and you also research what's being discussed as it unfolds, answer when the user turns to you, and, when it helps, tap them on the shoulder with something they need. You are the colleague in the room who already pulled up the relevant context, and who knows that most moments need nothing from you.",
  ],
  [
    "If the workspace has nothing on someone, say so in one line and move on. Don't stall the conversation on research.",
    "If the workspace has nothing on someone, move on; don't stall the conversation on research.",
  ],
  [
    "## Lean forward — this is what makes you different\n\nYou are not waiting to be useful. As the conversation moves, get AHEAD of it:",
    "## Stay ahead of the conversation\n\nAs the conversation moves, keep your research ahead of it:",
  ],
  [
    "If you could only say it because you read this person's record, say it.",
    "If you could only say it because you read this person's record, say it when it helps toward the goal.",
  ],
]

const SALES_LIVE_FROM_274: Array<[string, string]> = [
  [
    "A handful of high-value messages across a call. Roughly: the opening brief, every spec question the buyer asks, each real buying signal or objection, an unkept promise before the goodbye. That is the shape. Everything else stays silent.",
    "There is no message budget. Like a good colleague in a real meeting, you know the rep has to stay present with the buyer, so you decide each time whether a nudge is worth it: speak when it moves the call toward the rep's goal, or when the rep needs something now (a spec question to answer, a real buying signal or objection, a commitment at risk, a correction). Never say the same thing twice; your context lists what you already told the rep under \"What you've already told them this call\". Everything else stays silent.",
  ],
  [
    "But understand what discipline means here. A scalpel still cuts. The shape above is a handful of messages, not zero, and the failure you are far more likely to commit is not chattiness — it is a call that ends with the rep having heard nothing from you at all, while the answers sat in the workspace the whole time. Most flushes warrant silence; a whole call of it means you were not there. When you have something grounded and specific, say it.",
    "Work toward the call's goal. If the rep set one (quoted under \"Before the call\"), that is it; if not, infer a working goal quietly from their prep and the conversation, and keep it to yourself. Name a person only when the Speaker Assignments or your context establish who they are; an unassigned voice is \"someone\", never a guessed name. You advise: you never promise, send or commit anything for the rep.",
  ],
  [
    "- The call ends and the rep learned nothing from you at all: no brief, no spec answered, no signal named, no line to use. You were a passenger.",
    "- You tell the rep something you already told them, in the same words or new ones.",
  ],
  [
    "for what was said last time. Deliver a 2–3 line brief with `say_to_user`:",
    "for what was said last time. Then tell the rep, in one short `say_to_user`, only what their prep doesn't already give them (the pre-call brief is already on their HUD); if nothing is new, say nothing. Draw it from:",
  ],
  [
    "If the workspace has nothing on this buyer, say that in one line and move on. Do not stall the call on research.",
    "If the workspace has nothing on this buyer, move on; do not stall the call on research.",
  ],
  [
    "The unkept-promise item in that brief is not decoration.",
    "An unkept promise you found is not decoration.",
  ],
  [
    "If you could only say it because you read this person's record, say it.",
    "If you could only say it because you read this person's record, say it when it helps the call toward the rep's goal.",
  ],
  [
    "- You skip the opening brief and the rep walks in cold on someone we have met three times.\n",
    "",
  ],
]

const EXPECTED: Record<PersonaSlug, string> = {
  interactive: applySwaps(AT_274.interactive, INTERACTIVE_FROM_274),
  'sales-live': applySwaps(AT_274['sales-live'], SALES_LIVE_FROM_274),
  'sales-post-call': AT_274['sales-post-call'],
}

/**
 * A row as Postgres would leave it after 358's DO blocks, in file order: each
 * block's UPDATE (system-row key + IS DISTINCT FROM its variable, the text it
 * declares). The blocks are not executed; their parsed text drives this, and
 * the shape test below pins that the SET and the guard both use the variable.
 */
interface Row {
  slug: string
  is_system: boolean
  workspace_id: string | null
  system_prompt: string
  description: string
  updated: number
}
function run358(rows: Row[]): Row[] {
  return rows.map((row) => {
    let r = row
    const key = (slug: string) => r.slug === slug && r.is_system && r.workspace_id === null
    for (const s of SETS) {
      if (key(s.slug) && r.system_prompt !== s.text) r = { ...r, system_prompt: s.text, updated: r.updated + 1 }
    }
    for (const d of DESCS) {
      if (key(d.slug) && r.description !== d.text) r = { ...r, description: d.text, updated: r.updated + 1 }
    }
    return r
  })
}
/** Today's descriptions (151 / 268), which 274 never touched. */
const DESCRIPTION_TODAY: Record<PersonaSlug, string> = {
  interactive: INTERACTIVE_DESCRIPTION_151,
  'sales-live': 'SALES LIVE (268)',
  'sales-post-call': 'SALES POST-CALL (268)',
}
const systemRows = (texts: Record<PersonaSlug, string>, descriptions = DESCRIPTION_TODAY): Row[] =>
  PERSONA_SLUGS.map((slug) => ({
    slug,
    is_system: true,
    workspace_id: null,
    system_prompt: texts[slug],
    description: descriptions[slug],
    updated: 0,
  }))

/** A section of a persona, from its heading to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading)
  expect(start, heading).toBeGreaterThanOrEqual(0)
  const next = text.indexOf('\n## ', start + heading.length)
  return text.slice(start, next < 0 ? undefined : next)
}

describe('migration 358', () => {
  it('holds no backslash anywhere (the MCP transport decodes escapes) and sets a lock timeout', () => {
    expect(SQL.includes(String.fromCharCode(92))).toBe(false)
    expect(STMTS).toContain("SET LOCAL lock_timeout = '5s';")
  })

  it("four DO blocks, one UPDATE of recipe each: one system_prompt per seeded persona, and interactive's description", () => {
    expect(STMTS.match(/\bUPDATE public\.\w+/g)).toEqual(Array(4).fill('UPDATE public.recipe'))
    expect(STMTS.match(/^DO \$quiet\$$/gm)).toHaveLength(4)
    expect(STMTS.match(/^\$quiet\$;$/gm)).toHaveLength(4)
    expect(migration358Blocks()).toHaveLength(4)
    expect(SETS.map((s) => s.slug)).toEqual([...PERSONA_SLUGS])
    expect(DESCS.map((d) => d.slug)).toEqual(['interactive'])
    // The statements themselves, persona text elided (it says "drop" in prose).
    expect(STMTS.replace(/\$(prompt|desc)\$[\s\S]*?\$(prompt|desc)\$/g, '')).not.toMatch(/\b(DELETE\s+FROM|TRUNCATE|INSERT\s+INTO|DROP|ALTER)\b/i)
  })

  it("sets system_prompt (and updated_at) as 274 did, plus interactive's description: agent_config and the rest are untouched", () => {
    for (const s of SETS) expect(s.set, s.slug).toBe('SET system_prompt = v_prompt, updated_at = now()')
    for (const d of DESCS) expect(d.set, d.slug).toBe('SET description = v_description, updated_at = now()')
    expect(STMTS.replace(/\$(prompt|desc)\$[\s\S]*?\$(prompt|desc)\$/g, '')).not.toMatch(/\b(agent_config|name|icon|category|visibility|sort_order)\s*=/)
    for (const slug of PERSONA_SLUGS) {
      const set274 = readMigration(F274).split(`WHERE slug = '${slug}'`)[0].split('UPDATE public.recipe').pop()!
      expect(set274.replace(/\$prompt\$[\s\S]*?\$prompt\$/, '…').replace(/\s+/g, ' ').trim()).toBe('SET system_prompt = …, updated_at = now()')
    }
  })

  it('is keyed on the system row and guarded on its own text: one variable, declared once, in the SET and the guard', () => {
    for (const s of SETS) {
      expect(s.where, s.slug).toBe(
        `WHERE slug = '${s.slug}' AND is_system AND workspace_id IS NULL AND system_prompt IS DISTINCT FROM v_prompt`,
      )
      expect([s.variable, s.setValue, s.guard], s.slug).toEqual(['v_prompt', 'v_prompt', 'v_prompt'])
    }
    for (const d of DESCS) {
      expect(d.where, d.slug).toBe(
        `WHERE slug = '${d.slug}' AND is_system AND workspace_id IS NULL AND description IS DISTINCT FROM v_description`,
      )
      expect([d.variable, d.setValue, d.guard], d.slug).toEqual(['v_description', 'v_description', 'v_description'])
    }
  })

  it('defines each text once, and no text can close its own quoting', () => {
    for (const b of migration358Blocks()) {
      expect(SQL.split(b.text).length - 1, `${b.slug} ${b.column}`).toBe(1)
      for (const tag of ['$quiet$', '$prompt$', '$desc$']) expect(b.text.includes(tag), `${b.slug} ${tag}`).toBe(false)
    }
    // Nothing outside the blocks but the lock timeout and comments.
    const outside = STMTS.replace(/DO \$quiet\$[\s\S]*?\$quiet\$;/g, '').trim()
    expect(outside).toBe("SET LOCAL lock_timeout = '5s';")
  })

  it("interactive's description is exactly the quiet sidekick, and replaces 151's", () => {
    expect(DESCS[0].text).toBe(INTERACTIVE_DESCRIPTION)
    expect(readMigration('151_interactive_assistant_agent.sql').replace(/''/g, "'")).toContain(INTERACTIVE_DESCRIPTION_151)
    expect(INTERACTIVE_DESCRIPTION).not.toMatch(/leans in|taps you on the shoulder/)
    // About as short as the one it replaces.
    expect(Math.abs(INTERACTIVE_DESCRIPTION.length - INTERACTIVE_DESCRIPTION_151.length)).toBeLessThan(60)
  })

  it.each([...PERSONA_SLUGS])('%s: the final text is exactly 274, then quiet', (slug) => {
    expect(livePersona(slug)).toBe(EXPECTED[slug])
  })

  it('DEV and PROD (268/269 text) and a row 274 had reached all end identical; a rerun touches nothing', () => {
    const fromToday = run358(systemRows(TODAY))
    const from274 = run358(systemRows(AT_274))
    for (const [i, slug] of PERSONA_SLUGS.entries()) {
      expect(fromToday[i].system_prompt, slug).toBe(EXPECTED[slug])
      expect(from274[i].system_prompt, slug).toBe(EXPECTED[slug])
      expect(fromToday[i].description, slug).toBe(slug === 'interactive' ? INTERACTIVE_DESCRIPTION : DESCRIPTION_TODAY[slug])
    }
    const again = run358(fromToday)
    expect(again).toEqual(fromToday)
    // interactive: prompt + description; the sales rows: prompt only.
    expect(fromToday.map((r) => r.updated)).toEqual([2, 1, 1])
    // A row whose prompt is already final but whose description is not gets the description alone.
    const halfway = run358(systemRows(EXPECTED))
    expect(halfway.map((r) => r.updated)).toEqual([1, 0, 0])
  })

  it('never touches a workspace copy or a non-system row', () => {
    const rows: Row[] = [
      { slug: 'interactive', is_system: false, workspace_id: null, system_prompt: 'mine', description: 'mine', updated: 0 },
      { slug: 'interactive', is_system: true, workspace_id: 'ws-1', system_prompt: 'theirs', description: 'theirs', updated: 0 },
    ]
    expect(run358(rows)).toEqual(rows)
  })

  it('the speak-up posture is gone from both live personas', () => {
    for (const slug of ['interactive', 'sales-live'] as const) {
      const t = livePersona(slug)
      for (const phrase of [
        'speaks up',
        'PRIMARY channel',
        'the nudge wins',
        'present, not invisible',
        'Lean forward',
        'You are not waiting to be useful',
        'an ACTIVE, attentive partner',
        'not a silent scribe',
        'say so in one line and move on',
        'say that in one line',
        'Then say something',
        'Deliver a 2–3 line brief',
        'You skip the opening brief',
        'A handful of high-value messages',
        'That is the shape',
        'A scalpel still cuts',
        'You were a passenger',
        "because you read this person's record, say it.",
      ]) {
        expect(t.includes(phrase), `${slug}: ${phrase}`).toBe(false)
      }
    }
  })

  it('the quiet-sidekick etiquette is there', () => {
    const i = livePersona('interactive')
    expect(i).toMatch(/\*\*Work toward the goal\.\*\*/)
    expect(i).toMatch(/never write it in the notes and never say it/)
    expect(i).toMatch(/Quiet by default, like a good colleague in a real meeting/)
    expect(i).toMatch(/There is no quota/)
    expect(i).toMatch(/Never guess who someone is/)
    expect(i).toMatch(/You advise: you never send, commit or change anything on the user's behalf/)
    expect(i).toMatch(/If their prep already covers it, or nothing is new, say nothing\./)
    const s = livePersona('sales-live')
    expect(s).toMatch(/only what their prep doesn't already give them/)
    expect(s).toMatch(/if nothing is new, say nothing/)
    expect(s).toMatch(/There is no message budget/)
    expect(s).toMatch(/Never say the same thing twice/)
    expect(s).toMatch(/Work toward the call's goal/)
    expect(s).toMatch(/never a guessed name/)
    expect(s).toMatch(/You advise: you never promise, send or commit anything for the rep/)
    for (const t of [i, s]) expect(t).toMatch(/What you've already told them this call/)
  })

  it("274's opening research and loop-closing text is there (what the rows never got)", () => {
    const i = livePersona('interactive')
    expect(i).toMatch(/## Open by finding out who is in the room/)
    expect(i).toMatch(/\*\*Keep looking things up, continuously\.\*\*/)
    expect(i).toMatch(/## Help the user talk to the person in front of them/)
    expect(i).toMatch(/DONE or CALLED OFF/)
    expect(i).toMatch(/dismiss_proposal/)
    const s = livePersona('sales-live')
    expect(s).toMatch(/## Open the call: pull the packages, then find out who is across the table/)
    expect(s).toMatch(/## Tell the rep how to talk to THIS buyer/)
    const p = livePersona('sales-post-call')
    expect(p).toMatch(/## Close what the call closed/)
    expect(p).toMatch(/dismiss_proposal/)
    for (const slug of PERSONA_SLUGS) expect(TODAY[slug].includes('dismiss_proposal'), slug).toBe(false)
  })

  it("capture sections are 274's word for word", () => {
    const same = (slug: PersonaSlug, heading: string) =>
      expect(section(livePersona(slug), heading), `${slug} ${heading}`).toBe(section(AT_274[slug], heading))
    same('interactive', '## Capture everything worth keeping (same as always)')
    same('interactive', '## Tone')
    same('sales-live', '## Answer the spec question before the rep has to promise a follow-up')
    same('sales-live', '## Name the buying signal, and hand the rep a line')
    // The notes section changes in one clause only (research informs what is said).
    const notes = (t: string) => section(t, '## How you take notes')
    expect(notes(livePersona('interactive')).replace('informs what you say, when it is worth saying;', 'lives in say_to_user;')).toBe(
      notes(AT_274.interactive),
    )
    // No swap drops a capture tool: any it names (DISPLAY ONLY's routing line) it keeps.
    for (const [from, to] of [...INTERACTIVE_FROM_274, ...SALES_LIVE_FROM_274]) {
      for (const tool of from.match(/propose_change|record_commitment|dismiss_proposal|edit_proposal|assignee/g) ?? []) {
        expect(to, `${from.slice(0, 40)} keeps ${tool}`).toContain(tool)
      }
    }
  })
})

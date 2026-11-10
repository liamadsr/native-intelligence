/**
 * Synthetic, account-free labelled requests for auto model selection
 * (src/lib/ai/model-route.ts), shared by the rules' table test
 * (src/lib/ai/__tests__/model-route.test.ts), the model.tier policy test and
 * the optional live Jev evaluation (scripts/jev-decisions.live.test.ts).
 *
 * `expected` is the tier a careful person would want:
 *   - fast: a quick capable assistant answers it well in one pass;
 *   - think: careful multi-step reasoning on the same model;
 *   - strong: coding or repository work, SQL, synthesis across ten or more
 *     sources, a multi-document comparison ending in a recommendation, or an
 *     explicit ask for the best model. In the main chat a Strong request is a
 *     hint to start a strong helper; the thread itself stays Fast or Think.
 *
 * The prompt shapes come from real chat use (names and numbers invented).
 */

export type ModelTierCategory = 'email' | 'calendar' | 'crm' | 'research' | 'coding' | 'complex' | 'chit_chat'

export interface ModelTierFixture {
  name: string
  category: ModelTierCategory
  expected: 'fast' | 'think' | 'strong'
  text: string
  /** Attached file kinds (pdf, csv, xlsx, image, text, other). */
  attachments?: string[]
}

const f = (category: ModelTierCategory, name: string, expected: ModelTierFixture['expected'], text: string, attachments?: string[]): ModelTierFixture => ({
  name,
  category,
  expected,
  text,
  ...(attachments ? { attachments } : {}),
})

const LONG_CONTRACT_NOTES = Array.from({ length: 40 }, (_, i) => `Clause ${i + 1}: the supplier shall deliver the services described in schedule ${i + 1} within the agreed window, subject to the change-control process and the acceptance criteria set out in appendix B.`).join(' ')

const STACK = `TypeError: Cannot read properties of undefined (reading 'id')
    at buildRow (/app/src/lib/crm/rows.ts:42:18)
    at Array.map (<anonymous>)
    at listContacts (/app/src/lib/crm/list.ts:88:21)`

const CODE_BLOCK = '```ts\n' + Array.from({ length: 12 }, (_, i) => `const step${i} = await run(${i})`).join('\n') + '\n```'

export const modelTierFixtures: ModelTierFixture[] = [
  // ── Email (10): never Strong ────────────────────────────────────────────────
  f('email', 'draft_reply_short', 'fast', 'Draft a reply to Sarah saying Thursday works for me.'),
  f('email', 'summarize_inbox', 'fast', 'What came in overnight that I need to answer?'),
  f('email', 'polite_decline', 'fast', 'Reply to the Acme invite and politely decline, I am travelling that week.'),
  f('email', 'forward_to_team', 'fast', 'Forward the invoice from Northwind to finance with a note to pay by Friday.'),
  f('email', 'follow_up_three', 'fast', 'Draft follow-ups to the three prospects from yesterday who did not reply.'),
  f('email', 'tone_rewrite', 'fast', 'Make my draft to the board sound a bit warmer but keep it short.'),
  f('email', 'find_thread', 'fast', 'Find the thread with Priya about the renewal pricing.'),
  f('email', 'unread_from_customers', 'fast', 'Show me unread emails from customers this week and draft replies to the urgent ones.'),
  f('email', 'long_reply_context', 'fast', 'Here is the context for my reply to Daniel: he asked whether we can move the go-live to March, whether the SSO work is included in the current scope, and who on our side owns the data migration. Draft a reply that says March is possible if they sign by the 20th, SSO is in scope, and Mei owns the migration. Keep it friendly and short.'),
  f('email', 'email_summary_pdf', 'fast', 'Reply to Tom and attach a one-line summary of the proposal he sent.', ['pdf']),
  // Review 2026-10-15: "PR #12" is a launch, not a pull request.
  f('email', 'pr_launch_reply', 'fast', 'Draft a reply to Sam about the PR #12 launch'),

  // ── Calendar (8): never Strong ──────────────────────────────────────────────
  f('calendar', 'whats_next', 'fast', "What's on my calendar this afternoon?"),
  f('calendar', 'schedule_call', 'fast', 'Schedule a 30 minute call with Ana next week, mornings only.'),
  f('calendar', 'move_meeting', 'fast', 'Move my 3pm with the design team to tomorrow at the same time.'),
  f('calendar', 'find_slot_many', 'fast', 'Find a slot this week when Ben, Chloe and I are all free for an hour.'),
  f('calendar', 'cancel_series', 'fast', 'Cancel the weekly sync for the rest of the month and let everyone know.'),
  f('calendar', 'prep_brief', 'fast', 'Give me a quick brief for my meeting with Globex at 2.'),
  f('calendar', 'book_twelve', 'fast', 'Book 12 intro calls with the new leads over the next two weeks, 20 minutes each.'),
  f('calendar', 'week_overview', 'fast', 'How busy is my week? Anything I should decline?'),

  // ── CRM (8): never Strong ───────────────────────────────────────────────────
  f('crm', 'add_contact', 'fast', 'Add Maria Lopez from Initech as a contact, she is their head of ops.'),
  f('crm', 'update_deal', 'fast', 'Move the Acme deal to negotiation and set the value to 48k.'),
  f('crm', 'who_is', 'fast', 'Who is our main contact at Umbrella and when did we last talk?'),
  f('crm', 'log_call', 'fast', 'Log a call with Hooli today: they want a pilot in Q2.'),
  f('crm', 'list_stale', 'fast', 'List deals that have not moved in 30 days.'),
  f('crm', 'enrich_company', 'fast', 'Fill in what you can find about Vandelay Industries on their company record.'),
  f('crm', 'pipeline_number', 'fast', "What's our pipeline total this quarter?"),
  f('crm', 'merge_dupes', 'fast', 'There are two records for Pied Piper, merge them and keep the newer email.'),
  // Review 2026-10-15: a stack named in prose is not coding work.
  f('crm', 'cto_node', 'fast', 'Find the CTO of Acme; they use Node.js'),

  // ── Research (8) ────────────────────────────────────────────────────────────
  f('research', 'quick_company', 'fast', 'What does Stripe Atlas do?'),
  f('research', 'competitor_pricing', 'fast', "Look up Granola's pricing page and tell me their plans."),
  f('research', 'market_size_thorough', 'think', 'Think carefully: estimate the market size for meeting-notes software for 50-person sales teams in the US, and show your reasoning step by step.'),
  f('research', 'many_sources_synthesis', 'strong', 'Read these 15 analyst reports and synthesize the main trends into one memo for the board.'),
  f('research', 'three_questions', 'think', 'For the Q3 offsite I need:\n1. the top three risks to our launch\n2. what each would cost us\n3. a mitigation for each\n4. who should own it'),
  f('research', 'news_today', 'fast', 'Any news about OpenAI today?'),
  f('research', 'deep_dive', 'think', 'Do a deep dive on why our trial-to-paid conversion dropped last month and what we could try.'),
  // Review 2026-10-15: a framework named in prose, and a repo rate, are not coding.
  f('research', 'site_on_nextjs', 'fast', 'Is their site built on Next.js?'),
  f('research', 'repo_rate', 'fast', 'What is the repo rate this week?'),
  f('research', 'twenty_papers', 'strong', 'Go through the twenty papers in the research folder and pull out every finding about retention, then tell me which ones conflict.'),

  // ── Coding (8): Strong ──────────────────────────────────────────────────────
  f('coding', 'stack_trace', 'strong', `Why is this failing in prod?\n${STACK}`),
  f('coding', 'sql_query', 'strong', "Can you fix this query, it returns duplicates: SELECT c.id, c.name FROM contacts c JOIN deals d ON d.contact_id = c.id WHERE d.stage = 'won'"),
  f('coding', 'code_block_review', 'strong', `Review this and tell me what's wrong:\n${CODE_BLOCK}`),
  f('coding', 'repo_pr', 'strong', 'Open a pull request in the native-intelligence repo that renames the billing helper and updates its tests.'),
  f('coding', 'diff_review', 'strong', 'Is this change safe?\ndiff --git a/src/lib/a.ts b/src/lib/a.ts\n@@ -1,3 +1,3 @@\n-export const LIMIT = 10\n+export const LIMIT = 100'),
  f('coding', 'file_bug', 'strong', 'The export in src/lib/flows/run-skill.ts drops the last row, can you find why?'),
  f('coding', 'write_script', 'strong', 'Write a Python script that reads contacts.csv and dedupes rows by email, then add unit tests.'),
  f('coding', 'regex_question', 'fast', 'What does a caret mean at the start of a regex?'),

  // ── Complex analysis (10) ───────────────────────────────────────────────────
  f('complex', 'vendor_contracts', 'strong', 'Compare these three vendor contracts side by side and recommend which one we should sign.', ['pdf', 'pdf', 'pdf']),
  f('complex', 'proposal_recommendation', 'strong', 'Here are the four agency proposals. Compare them on cost, timeline and risk, and recommend one.', ['pdf', 'pdf', 'pdf', 'pdf']),
  f('complex', 'forecast_csv', 'think', 'Forecast next quarter revenue from this export and tell me the main assumptions.', ['csv']),
  f('complex', 'reconcile_spreadsheet', 'think', 'Reconcile the payouts in this spreadsheet against our invoices and flag mismatches.', ['xlsx']),
  f('complex', 'board_plan', 'think', 'Plan our hiring for next year:\n- which roles first\n- when each starts\n- what it does to burn\n- what we drop if revenue misses'),
  f('complex', 'twelve_transcripts', 'strong', 'Synthesize the 12 customer interview transcripts from last month into the top objections, with quotes.'),
  f('complex', 'tradeoffs_pricing', 'think', 'Walk me through the trade-offs of moving from per-seat to usage pricing, step by step, for a team our size.'),
  f('complex', 'long_contract_review', 'think', `Go through these notes and tell me which clauses are risky for us. ${LONG_CONTRACT_NOTES}`),
  f('complex', 'best_model_strategy', 'strong', 'Use the best model for this: write our 2027 go-to-market strategy from everything you know about us.'),
  f('complex', 'two_reports_compare', 'think', 'Compare the two quarterly reports I attached and summarize what changed.', ['pdf', 'pdf']),
  // Review 2026-10-15: a two-way choice is careful work, not Strong work.
  f('complex', 'two_proposals_pick', 'think', 'compare the two proposals, which should we pick?'),

  // ── Chit-chat / ambiguous (8) ───────────────────────────────────────────────
  f('chit_chat', 'thanks', 'fast', 'thanks!'),
  f('chit_chat', 'yes', 'fast', 'yes'),
  f('chit_chat', 'send_it', 'fast', 'send it'),
  f('chit_chat', 'ok_go_ahead', 'fast', 'ok go ahead'),
  f('chit_chat', 'morning', 'fast', 'Good morning! What should I focus on today?'),
  f('chit_chat', 'retry_wrong', 'think', "That's wrong, the meeting was on Tuesday not Wednesday. Try again."),
  f('chit_chat', 'opinion', 'fast', 'Do you think we should go to the conference in Lisbon or skip it this year?'),
  f('chit_chat', 'vague_medium', 'fast', 'I have been thinking about how we run our weekly team meetings and whether the format still works now that we are fifteen people across three time zones, maybe there is a better way to handle it, or maybe the current one is fine and I am overthinking the whole thing again.'),
]

/** Helper tasks (what the main agent hands a helper), labelled for routeHelperTask. */
export const helperTierFixtures: Array<{ name: string; expected: 'fast' | 'think' | 'strong'; task: string; turn?: string }> = [
  { name: 'research_companies', expected: 'think', task: 'Research Acme, Globex and Initech: what they do, size, and recent news.' },
  { name: 'draft_followups', expected: 'fast', task: 'Draft follow-up emails to the five prospects who opened the sequence.' },
  { name: 'calendar_free_slots', expected: 'fast', task: "Find three free hour-long slots in the person's calendar next week." },
  { name: 'debug_trace', expected: 'strong', task: `Find the cause of this error and propose a fix:\n${STACK}` },
  { name: 'sql_report', expected: 'strong', task: 'Write the SQL to count active users per workspace per week from ai_usage_logs: SELECT workspace_id, count(*) FROM ai_usage_logs GROUP BY 1' },
  { name: 'many_docs', expected: 'strong', task: 'Synthesize the 14 contracts in the legal folder into one view of every auto-renewal clause and its notice period.' },
  // Review 2026-10-15: routine work wins over a soft signal; a two-way comparison is Think.
  { name: 'cto_node', expected: 'fast', task: 'Find the CTO of Acme; they use Node.js' },
  { name: 'pr_launch_reply', expected: 'fast', task: 'Draft a reply to Sam about the PR #12 launch' },
  { name: 'two_proposals', expected: 'think', task: 'Compare the two agency proposals and recommend which one we should pick.' },
  { name: 'many_docs_listing', expected: 'fast', task: 'Read the 14 contracts in the legal folder and list each one with its renewal date.' },
  { name: 'cross_doc_recommend', expected: 'strong', task: 'Compare the three proposals from the agencies and recommend which one we should choose, with reasons.' },
  { name: 'best_model_turn', expected: 'strong', task: 'Write the launch plan for the new pricing.', turn: 'Use the best model for this one please.' },
  { name: 'plan_offsite', expected: 'think', task: 'Plan a two-day offsite agenda for twelve people with the goals the person gave.' },
  { name: 'summarize_meeting', expected: 'fast', task: "Summarize yesterday's call with Hooli into decisions and next steps." },
]

-- Migration 035: Email Recipes & Context-Aware Recipe Filtering
-- Adds views_context column to recipe table for showing recipes on specific views
-- Seeds system email recipes: Draft Email, Reply to Email

-- ---------------------------------------------------------------------------
-- 1. Add views_context column to recipe table
-- ---------------------------------------------------------------------------
-- views_context: array of view names where this recipe should be prominently shown
-- NULL or empty = show everywhere (default, backwards-compatible)
-- e.g. ['mail'] = only show as a chip on the mail view
-- e.g. ['mail', 'contacts', 'companies'] = show on mail, contacts, and companies views

ALTER TABLE public.recipe
  ADD COLUMN IF NOT EXISTS views_context text[] DEFAULT NULL;

-- ---------------------------------------------------------------------------
-- 2. Seed system email agent recipes
-- ---------------------------------------------------------------------------

INSERT INTO public.recipe (name, slug, icon, color, description, system_prompt, agent_config, category, is_system, sort_order, views_context)
VALUES
(
  'Draft Email',
  'draft-email',
  '✉️',
  '#6366f1',
  'Compose a new email. Describe who you want to email and what about — the AI will draft it for you to review and send.',
  E'You are an email drafting assistant. The user wants to compose a new email.\n\nWorkflow:\n1. If the user hasn''t specified recipients, ask who they want to email\n2. If the user hasn''t described the purpose, ask what they want to say\n3. Draft the email with an appropriate tone (professional by default unless told otherwise)\n4. Use the create_email_draft tool to create the draft\n5. Present the draft clearly so the user can review it\n6. If the user requests changes, revise and create a new draft\n\nGuidelines:\n- Keep emails concise and clear\n- Match the user''s tone — if they''re casual, be casual\n- Use context from the workspace (contacts, recent interactions) to personalize\n- Always create the draft via the tool so it can be sent from the chat',
  '{"preferred_tools": ["create_email_draft", "search_contacts", "list_contacts"], "response_style": {"format": "concise", "tone": "match-user"}, "context_rules": ["Search contacts to find email addresses when user mentions a name", "Check recent interactions with the recipient for context"]}',
  'agent',
  true,
  110,
  '{mail,contacts,companies,contacts:detail,companies:detail}'
),
(
  'Reply',
  'reply',
  '↩️',
  '#0ea5e9',
  'Reply to the email you''re viewing. The AI uses the thread context to draft a relevant response.',
  E'You are an email reply assistant. The user wants to reply to the email thread they''re currently viewing.\n\nWorkflow:\n1. You already have context about the email thread from the conversation context\n2. If the user gives specific instructions (e.g., "accept the meeting", "decline politely"), follow them\n3. If the user just says "reply" without specifics, analyze the thread and suggest an appropriate response\n4. Draft the reply using create_email_draft\n5. Present the draft clearly\n6. Revise if the user requests changes\n\nGuidelines:\n- The reply should be contextually appropriate to the thread\n- Match the tone of the existing conversation\n- Keep replies concise — most email replies should be 2-4 sentences\n- Reference specific points from the thread when relevant\n- Use workspace context (actions, meetings, decisions) to inform the reply\n- Always create via the tool so it can be sent from the chat',
  '{"preferred_tools": ["create_email_draft", "get_email", "search_contacts"], "response_style": {"format": "concise", "tone": "match-thread"}, "context_rules": ["Use the email thread context to understand what needs replying to", "Check workspace for related actions or meetings that might inform the reply", "Match the formality level of the existing thread"]}',
  'agent',
  true,
  111,
  '{mail:thread}'
)
ON CONFLICT DO NOTHING;

-- Ensure views_context and sort_order are set correctly (handles re-runs where rows already exist)
UPDATE public.recipe
  SET views_context = '{mail,contacts,companies,contacts:detail,companies:detail}', sort_order = 98
  WHERE slug = 'draft-email' AND is_system = true;

UPDATE public.recipe
  SET views_context = '{mail:thread}', sort_order = 99
  WHERE slug = 'reply' AND is_system = true;

-- ---------------------------------------------------------------------------
-- 3. Update existing system recipes with views_context where appropriate
-- ---------------------------------------------------------------------------

-- Sales Coach is most useful on contacts/companies views
UPDATE public.recipe
  SET views_context = '{contacts,companies,contacts:detail,companies:detail}'
  WHERE slug = 'sales-coach' AND is_system = true;

-- Meeting Search is most useful on captures view
UPDATE public.recipe
  SET views_context = '{captures}'
  WHERE slug = 'meeting-search' AND is_system = true AND views_context IS NULL;

-- Knowledge Base is most useful on docs view
UPDATE public.recipe
  SET views_context = '{docs}'
  WHERE slug = 'knowledge-base' AND is_system = true AND views_context IS NULL;

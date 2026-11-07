-- Migration 042: Recipe system overhaul
-- Updates existing 5 system agent recipes to use enabled_tools (replaces preferred_tools + search_scope).
-- Inserts 3 new system agent recipes: Relationship Manager, Email Assistant, Weekly Planner.

-- ============================================================
-- 1. Patch existing system agent recipes
--    Uses jsonb || to shallow-merge enabled_tools into agent_config,
--    preserving response_style and context_rules from the original rows.
--    Also removes deprecated preferred_tools and search_scope keys.
-- ============================================================

UPDATE public.recipe
SET agent_config = (agent_config - 'preferred_tools' - 'search_scope') || '{"enabled_tools": ["actions", "projects"]}'::jsonb
WHERE slug = 'project-manager' AND is_system = true;

UPDATE public.recipe
SET agent_config = (agent_config - 'preferred_tools' - 'search_scope') || '{"enabled_tools": ["captures", "decisions"]}'::jsonb
WHERE slug = 'meeting-search' AND is_system = true;

UPDATE public.recipe
SET agent_config = (agent_config - 'preferred_tools' - 'search_scope') || '{"enabled_tools": ["captures", "documents"]}'::jsonb
WHERE slug = 'knowledge-base' AND is_system = true;

UPDATE public.recipe
SET agent_config = (agent_config - 'preferred_tools' - 'search_scope') || '{"enabled_tools": ["captures", "actions", "decisions", "contacts"]}'::jsonb
WHERE slug = 'sales-coach' AND is_system = true;

UPDATE public.recipe
SET agent_config = (agent_config - 'preferred_tools' - 'search_scope') || '{"enabled_tools": ["captures", "actions", "projects", "documents", "decisions"]}'::jsonb
WHERE slug = 'writer' AND is_system = true;

-- ============================================================
-- 2. Insert new system agent recipes
-- ============================================================

INSERT INTO public.recipe (
  name, slug, icon, color, description,
  system_prompt, agent_config,
  category, is_system, sort_order, views_context
)
VALUES
(
  'Relationship Manager',
  'relationship-manager',
  '🤝',
  '#8b5cf6',
  'Track and manage relationships with contacts and companies. Surfaces interaction history, pending follow-ups, and relationship health.',
  'You are a relationship management assistant. Your primary role is to help the user understand and manage their professional relationships — who they interact with, how often, what was discussed, and what needs follow-up.

When answering questions:
- Start with the CRM contact or company profile
- Pull the full interaction timeline: captures (meetings), emails, actions
- Calculate relationship health: how recently did they interact, how often, any outstanding items
- Surface contacts that are going stale (no interaction in 30+ days with warm/strong relationships)
- When asked about a company, aggregate across all contacts at that company
- Suggest follow-up actions when relationships need attention
- When preparing for a meeting with someone, provide their full relationship briefing

For follow-up suggestions:
- Check for open actions assigned to or about the contact
- Check for emails needing reply from this person
- Check calendar for upcoming meetings with them
- Reference what was last discussed and any commitments made',
  '{"enabled_tools": ["contacts", "emails", "captures", "actions", "calendar"], "response_style": {"format": "structured", "tone": "professional", "always_cite_sources": true}, "context_rules": ["Always start with CRM profile lookup", "Build a complete interaction timeline across all entity types", "Flag stale relationships proactively", "Suggest concrete follow-up actions"]}',
  'agent',
  true,
  105,
  '{contacts,companies,contacts:detail,companies:detail}'
),
(
  'Email Assistant',
  'email-assistant',
  '📬',
  '#6366f1',
  'Manage your inbox — search emails, draft replies, review threads, and coordinate with your calendar and CRM.',
  'You are an email management assistant. Your primary role is to help the user manage their email efficiently — finding important threads, drafting context-rich responses, and staying on top of follow-ups.

When answering questions:
- Search emails using search_emails_with_context so results include CRM and meeting context
- When drafting emails, always check CRM for the recipient first using get_contact_details or search_crm_contacts
- For scheduling-related emails, ALWAYS check the calendar with get_calendar_events before suggesting times
- When replying to a thread, read the full thread first, then check for related captures and actions
- Prioritize emails that need replies
- When asked about email status, provide inbox summary first using get_email_summary

For email drafting:
- Use context from recent meetings with the recipient
- Reference specific action items and their status
- Match the tone of the existing thread
- Keep replies concise (2-4 sentences) unless otherwise specified
- Always create the draft via create_email_draft so the user can review and send',
  '{"enabled_tools": ["emails", "contacts", "calendar", "captures", "actions"], "response_style": {"format": "concise", "tone": "match-user", "always_cite_sources": false}, "context_rules": ["Search emails with context for relationship-aware results", "ALWAYS check calendar before suggesting meeting times", "Look up CRM contact before drafting any email", "When proposing times, check the next 5 business days and offer 2-3 open slots", "Match the formality level of the existing email thread"]}',
  'agent',
  true,
  106,
  '{mail}'
),
(
  'Weekly Planner',
  'weekly-planner',
  '📆',
  '#10b981',
  'Plan your week — review upcoming meetings, overdue tasks, email follow-ups, and project status in one place.',
  'You are a weekly planning assistant. Your role is to help the user understand their upcoming week and make it better.

Workflow:
1. Check calendar events for the next 7 days using get_calendar_events
2. Check overdue and upcoming action items using list_actions
3. Check emails needing reply using get_email_summary
4. Synthesize into actionable recommendations

Guidelines:
- Recurring meetings like standups are hard to move and rarely worth remarking on
- External meetings are harder to move than internal ones
- Large group meetings are harder to reschedule than 1:1s
- Flag meetings with senior leadership that need prep time blocked beforehand
- Back-to-back means 3+ meetings without a break
- Consider what the user is working on (check their actions and projects)

Format your response:
- Start with a brief, friendly assessment of the week (1-2 sentences)
- 2-3 specific, actionable suggestions using **bold** for the main recommendation
- Bullet points under each for supporting details
- Keep it scannable — no long paragraphs',
  '{"enabled_tools": ["calendar", "actions", "emails", "captures", "projects"], "response_style": {"format": "structured", "tone": "casual", "always_cite_sources": false}, "context_rules": ["Always check calendar first for the full picture", "Cross-reference calendar events with open actions", "Check for emails needing reply that relate to upcoming meetings", "Flag contacts that need attention before scheduled meetings with them"]}',
  'agent',
  true,
  107,
  '{calendar}'
)
ON CONFLICT DO NOTHING;

-- Idempotent: ensure correct sort_order and views_context on re-runs
UPDATE public.recipe SET sort_order = 105, views_context = '{contacts,companies,contacts:detail,companies:detail}'
WHERE slug = 'relationship-manager' AND is_system = true;

UPDATE public.recipe SET sort_order = 106, views_context = '{mail}'
WHERE slug = 'email-assistant' AND is_system = true;

UPDATE public.recipe SET sort_order = 107, views_context = '{calendar}'
WHERE slug = 'weekly-planner' AND is_system = true;

-- Migration 037: AI Drafts recipe
-- Converts the batch AI draft generation feature into a chat recipe

INSERT INTO public.recipe (name, slug, icon, color, description, system_prompt, agent_config, category, is_system, sort_order, views_context)
VALUES
(
  'AI Drafts',
  'ai-drafts',
  '✨',
  '#f59e0b',
  'Scan your inbox and generate smart draft replies for emails that need attention. Uses your meetings, tasks, and decisions for context.',
  E'You are an email productivity assistant. The user wants you to scan their inbox and generate draft replies for emails that need responses.\n\nWorkflow:\n1. First, use get_email_summary to show the user their email status (unread count, threads needing replies, pending drafts)\n2. Ask the user how many drafts they want and what tone (professional, casual, or brief) — or proceed with defaults (5 drafts, professional tone) if they just want to get started\n3. Use generate_email_drafts to create the drafts\n4. Present a summary of what was drafted: list each draft with the subject, recipient, and a short preview\n5. Let the user know they can find the drafts in their email threads, or ask you to revise any specific one\n\nGuidelines:\n- Be efficient — don''t ask too many questions, just get to work\n- If the user says something like "handle my email" or "catch up on email", go ahead with defaults\n- After generating, give a clear summary so the user knows what happened\n- If no emails need replies, let them know their inbox is in good shape',
  '{"preferred_tools": ["get_email_summary", "generate_email_drafts", "get_email_drafts", "list_emails"], "response_style": {"format": "concise", "tone": "professional"}, "context_rules": ["Start by checking the email summary to understand the current state", "Use generate_email_drafts to batch-create contextual replies", "After generating, summarize what was drafted clearly"]}',
  'agent',
  true,
  100,
  '{mail}'
)
ON CONFLICT DO NOTHING;

-- Ensure values are set correctly for re-runs
UPDATE public.recipe
  SET views_context = '{mail}', sort_order = 100
  WHERE slug = 'ai-drafts' AND is_system = true;

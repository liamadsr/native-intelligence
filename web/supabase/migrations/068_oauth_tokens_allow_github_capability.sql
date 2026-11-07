-- Allow 'github' as a valid provider and capability in user_oauth_tokens
ALTER TABLE user_oauth_tokens DROP CONSTRAINT IF EXISTS user_oauth_tokens_capability_check;
ALTER TABLE user_oauth_tokens ADD CONSTRAINT user_oauth_tokens_capability_check
  CHECK (capability = ANY (ARRAY['calendar', 'email', 'both', 'github']));

ALTER TABLE user_oauth_tokens DROP CONSTRAINT IF EXISTS user_oauth_tokens_provider_check;
ALTER TABLE user_oauth_tokens ADD CONSTRAINT user_oauth_tokens_provider_check
  CHECK (provider = ANY (ARRAY['google', 'microsoft', 'github']));

-- The old unique constraint on (user_id, provider, capability) blocked multi-account
-- token storage. The newer COALESCE-based constraint handles this correctly.
ALTER TABLE user_oauth_tokens
  DROP CONSTRAINT IF EXISTS user_oauth_tokens_user_provider_capability_key;

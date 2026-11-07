-- Feature Requests: communal board where users can post, upvote, and comment
-- on feature requests. Only feature_request type feedback is public.
-- Safe to re-run: uses IF NOT EXISTS / DROP IF EXISTS throughout

-- 1. Feature Requests — public posts visible to all authenticated users
CREATE TABLE IF NOT EXISTS feature_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'open',                  -- open | planned | in_progress | completed | declined
  vote_count INT DEFAULT 0,                    -- denormalized for fast sorting
  comment_count INT DEFAULT 0,                 -- denormalized for fast sorting
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE feature_requests ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read all feature requests
DROP POLICY IF EXISTS "authenticated_read_feature_requests" ON feature_requests;
CREATE POLICY "authenticated_read_feature_requests" ON feature_requests
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- Users can insert their own feature requests
DROP POLICY IF EXISTS "users_insert_own_feature_requests" ON feature_requests;
CREATE POLICY "users_insert_own_feature_requests" ON feature_requests
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update their own feature requests (edit title/description)
DROP POLICY IF EXISTS "users_update_own_feature_requests" ON feature_requests;
CREATE POLICY "users_update_own_feature_requests" ON feature_requests
  FOR UPDATE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_feature_requests_vote_count ON feature_requests(vote_count DESC);
CREATE INDEX IF NOT EXISTS idx_feature_requests_created_at ON feature_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_feature_requests_status ON feature_requests(status);

-- 2. Feature Request Votes — one vote per user per request
CREATE TABLE IF NOT EXISTS feature_request_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_request_id UUID NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(feature_request_id, user_id)
);

ALTER TABLE feature_request_votes ENABLE ROW LEVEL SECURITY;

-- All authenticated users can see votes (to check if they voted)
DROP POLICY IF EXISTS "authenticated_read_votes" ON feature_request_votes;
CREATE POLICY "authenticated_read_votes" ON feature_request_votes
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- Users can insert their own votes
DROP POLICY IF EXISTS "users_insert_own_votes" ON feature_request_votes;
CREATE POLICY "users_insert_own_votes" ON feature_request_votes
  FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can delete their own votes (unvote)
DROP POLICY IF EXISTS "users_delete_own_votes" ON feature_request_votes;
CREATE POLICY "users_delete_own_votes" ON feature_request_votes
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_feature_request_votes_request ON feature_request_votes(feature_request_id);
CREATE INDEX IF NOT EXISTS idx_feature_request_votes_user ON feature_request_votes(user_id);

-- 3. Feature Request Comments
CREATE TABLE IF NOT EXISTS feature_request_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_request_id UUID NOT NULL REFERENCES feature_requests(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE feature_request_comments ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read comments
DROP POLICY IF EXISTS "authenticated_read_comments" ON feature_request_comments;
CREATE POLICY "authenticated_read_comments" ON feature_request_comments
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- Users can insert their own comments
DROP POLICY IF EXISTS "users_insert_own_comments" ON feature_request_comments;
CREATE POLICY "users_insert_own_comments" ON feature_request_comments
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_feature_request_comments_request ON feature_request_comments(feature_request_id);

-- 4. Trigger to keep vote_count in sync
CREATE OR REPLACE FUNCTION update_feature_request_vote_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE feature_requests SET vote_count = vote_count + 1, updated_at = NOW()
    WHERE id = NEW.feature_request_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE feature_requests SET vote_count = vote_count - 1, updated_at = NOW()
    WHERE id = OLD.feature_request_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_update_vote_count ON feature_request_votes;
CREATE TRIGGER trg_update_vote_count
  AFTER INSERT OR DELETE ON feature_request_votes
  FOR EACH ROW EXECUTE FUNCTION update_feature_request_vote_count();

-- 5. Trigger to keep comment_count in sync
CREATE OR REPLACE FUNCTION update_feature_request_comment_count()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    UPDATE feature_requests SET comment_count = comment_count + 1, updated_at = NOW()
    WHERE id = NEW.feature_request_id;
    RETURN NEW;
  ELSIF TG_OP = 'DELETE' THEN
    UPDATE feature_requests SET comment_count = comment_count - 1, updated_at = NOW()
    WHERE id = OLD.feature_request_id;
    RETURN OLD;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_update_comment_count ON feature_request_comments;
CREATE TRIGGER trg_update_comment_count
  AFTER INSERT OR DELETE ON feature_request_comments
  FOR EACH ROW EXECUTE FUNCTION update_feature_request_comment_count();

-- Enable RLS on desktop_releases and restrict access to published releases only
ALTER TABLE desktop_releases ENABLE ROW LEVEL SECURITY;

-- Public users can only see published releases
CREATE POLICY "Published releases are publicly readable"
  ON desktop_releases
  FOR SELECT
  USING (published = true);

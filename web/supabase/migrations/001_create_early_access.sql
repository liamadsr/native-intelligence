-- Create early_access table for email signups
CREATE TABLE IF NOT EXISTS early_access (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  source TEXT DEFAULT 'website',
  metadata JSONB DEFAULT '{}'::jsonb
);

-- Create index on email for faster lookups
CREATE INDEX IF NOT EXISTS early_access_email_idx ON early_access (email);

-- Create index on created_at for sorting
CREATE INDEX IF NOT EXISTS early_access_created_at_idx ON early_access (created_at DESC);

-- Enable Row Level Security
ALTER TABLE early_access ENABLE ROW LEVEL SECURITY;

-- Policy: Allow anonymous inserts (for signup form)
CREATE POLICY "Allow anonymous inserts" ON early_access
  FOR INSERT
  TO anon
  WITH CHECK (true);

-- Policy: Only authenticated users can read (for admin dashboard later)
CREATE POLICY "Allow authenticated reads" ON early_access
  FOR SELECT
  TO authenticated
  USING (true);

-- Desktop app release tracking for the Tauri auto-updater.
-- Each row represents a released version with platform-specific artifacts.

CREATE TABLE desktop_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  version text NOT NULL UNIQUE,
  notes text,
  pub_date timestamptz NOT NULL DEFAULT now(),
  published boolean NOT NULL DEFAULT false,
  -- Platform artifacts keyed by "target-arch" (e.g. "darwin-aarch64")
  -- Each value: { "url": "https://...", "signature": "..." }
  platforms jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Index for the updater endpoint query
CREATE INDEX idx_desktop_releases_published ON desktop_releases (published, created_at DESC)
  WHERE published = true;

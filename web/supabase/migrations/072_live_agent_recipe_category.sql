-- Add 'live_agent' to the recipe_category enum
-- Live agent recipes define the AI's persona and behavior during live meeting capture
ALTER TYPE recipe_category ADD VALUE IF NOT EXISTS 'live_agent';

-- Enable Supabase Realtime for captures and documents tables
-- Required for live editor updates when AI tools make inline edits

ALTER PUBLICATION supabase_realtime ADD TABLE public.captures;
ALTER PUBLICATION supabase_realtime ADD TABLE public.document;

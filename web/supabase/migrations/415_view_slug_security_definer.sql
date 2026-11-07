-- generate_view_slug runs as the inserting user, so RLS hides other members'
-- personal views from its uniqueness loop. Creating or duplicating a view with
-- the same name as another member's personal view then picks a slug that
-- already exists and the insert fails on UNIQUE (workspace_id, slug) with a
-- 500. Run the loop as the definer so it can see every slug in the workspace.
-- Body is unchanged from 039_views.sql apart from the security clause and the
-- pinned search_path.

CREATE OR REPLACE FUNCTION public.generate_view_slug()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  base_slug TEXT;
  final_slug TEXT;
  counter INT := 0;
BEGIN
  IF NEW.slug IS NULL OR NEW.slug = '' THEN
    base_slug := lower(regexp_replace(trim(NEW.name), '[^a-zA-Z0-9]+', '-', 'g'));
    base_slug := trim(both '-' from base_slug);
    final_slug := base_slug;

    LOOP
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM public.view
        WHERE workspace_id = NEW.workspace_id AND slug = final_slug AND id IS DISTINCT FROM NEW.id
      );
      counter := counter + 1;
      final_slug := base_slug || '-' || counter;
    END LOOP;

    NEW.slug := final_slug;
  END IF;
  RETURN NEW;
END;
$$;

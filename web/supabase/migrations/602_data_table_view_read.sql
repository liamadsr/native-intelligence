-- Migration 602: a table's saved views follow the table's access.
--
-- A view of a table's rows (scope_type 'data_table', migration 529) names
-- its filters' values, its columns and its sorts. 039's read rule lets any
-- member read a workspace view, so a shared view of a private table was
-- readable by a member who can't read the table (GET /views/:id, favorites,
-- duplicate). Each view policy is restated from its newest definition (039,
-- untouched since) with one more condition: a view scoped to a table is
-- there only for someone the table is visible to (520's data_table_visible_to).
-- Insert, update and delete take the same condition, so nobody makes or
-- changes a view of a table they can't read. view_favorite keeps its own
-- rule (a person's own rows): a favorite names a view id, and the view is
-- read through the policy below.
--
-- 600-609 hold Tables' restatements that run after main's newest files.

drop policy if exists "Users can view accessible views" on public.view;
create policy "Users can view accessible views"
  on public.view for select
  using (
    public.is_workspace_member(workspace_id)
    and (
      (visibility = 'personal' and created_by = auth.uid())
      or (visibility = 'team' and team_id is not null and public.is_team_member(team_id))
      or (visibility = 'workspace')
    )
    and (scope_type is distinct from 'data_table' or public.data_table_visible_to(scope_id, auth.uid()))
  );

drop policy if exists "Users can create views in their workspace" on public.view;
create policy "Users can create views in their workspace"
  on public.view for insert
  with check (
    public.is_workspace_member(workspace_id)
    and created_by = auth.uid()
    and (scope_type is distinct from 'data_table' or public.data_table_visible_to(scope_id, auth.uid()))
  );

drop policy if exists "Users can update their own views or workspace views as admin" on public.view;
create policy "Users can update their own views or workspace views as admin"
  on public.view for update
  using (
    (created_by = auth.uid()
     or (visibility = 'workspace' and public.get_member_role(workspace_id) in ('admin', 'owner')))
    and (scope_type is distinct from 'data_table' or public.data_table_visible_to(scope_id, auth.uid()))
  );

drop policy if exists "Users can delete their own views or workspace views as admin" on public.view;
create policy "Users can delete their own views or workspace views as admin"
  on public.view for delete
  using (
    (created_by = auth.uid()
     or (visibility = 'workspace' and public.get_member_role(workspace_id) in ('admin', 'owner')))
    and (scope_type is distinct from 'data_table' or public.data_table_visible_to(scope_id, auth.uid()))
  );

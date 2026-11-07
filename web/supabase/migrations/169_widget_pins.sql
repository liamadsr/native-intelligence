-- Migration 169: widget_pin — the per-member set of dashboard widgets pinned to
-- the collapsed (chat-only) dashboard's widget dock.
--
-- The collapsed dashboard shows the chat plus a right-hand dock of "widgets"
-- (starting with a rolling calendar agenda; email / CRM / a unified PM view come
-- later). A widget_pin row means "this member has pinned this widget in this
-- workspace." Pins are PER-WORKSPACE per-member: a member can pin different
-- widgets in different workspaces. The widget's own DATA is always workspace-
-- scoped, so per-workspace pins keep the dock coherent with what's on screen.
--
-- widget_id is TEXT, not an FK: widgets are code-defined (a client-side
-- registry), not DB rows. Unknown ids are simply ignored by the client, so a
-- removed widget leaves a harmless orphan pin.
--
-- SAFETY: client-writable (unlike attention_item). RLS scopes every row to the
-- owning member via the member table join (member.user_id = auth.uid()), the
-- same ownership pattern as attention_item. A member can only read/write pins
-- for their OWN member row.

create table if not exists public.widget_pin (
  workspace_id uuid not null references public.workspace(id) on delete cascade,
  member_id    uuid not null references public.member(id) on delete cascade,
  widget_id    text not null,
  -- Vertical order within the dock, ascending (0 = top). Reordering rewrites this.
  position     integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  -- One pin per (member, widget). member_id already implies workspace_id (a
  -- member row belongs to exactly one workspace), so this is the natural key.
  primary key (member_id, widget_id)
);

-- Drain a member's dock in display order.
create index if not exists widget_pin_member_position_idx
  on public.widget_pin (member_id, position);

alter table public.widget_pin enable row level security;

-- The owning member (whose user is the caller) may READ their own pins.
drop policy if exists widget_pin_own_select on public.widget_pin;
create policy widget_pin_own_select on public.widget_pin
  for select to authenticated
  using (
    exists (
      select 1 from public.member m
      where m.id = widget_pin.member_id
        and m.user_id = auth.uid()
    )
  );

-- The owning member may PIN (insert) widgets for their own member row. The
-- with-check also verifies workspace_id matches the member's workspace, so a
-- caller can't insert a pin pointing member A's row at workspace B.
drop policy if exists widget_pin_own_insert on public.widget_pin;
create policy widget_pin_own_insert on public.widget_pin
  for insert to authenticated
  with check (
    exists (
      select 1 from public.member m
      where m.id = widget_pin.member_id
        and m.user_id = auth.uid()
        and m.workspace_id = widget_pin.workspace_id
    )
  );

-- The owning member may REORDER (update) their own pins. The with-check mirrors
-- the insert policy (binds member_id to the caller AND workspace_id to that
-- member's workspace); without it Postgres reuses `using` for the new row, which
-- would let a member repoint an existing pin at a workspace they don't belong to.
drop policy if exists widget_pin_own_update on public.widget_pin;
create policy widget_pin_own_update on public.widget_pin
  for update to authenticated
  using (
    exists (
      select 1 from public.member m
      where m.id = widget_pin.member_id
        and m.user_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.member m
      where m.id = widget_pin.member_id
        and m.user_id = auth.uid()
        and m.workspace_id = widget_pin.workspace_id
    )
  );

-- The owning member may UNPIN (delete) their own pins.
drop policy if exists widget_pin_own_delete on public.widget_pin;
create policy widget_pin_own_delete on public.widget_pin
  for delete to authenticated
  using (
    exists (
      select 1 from public.member m
      where m.id = widget_pin.member_id
        and m.user_id = auth.uid()
    )
  );

-- Reuse the shared updated_at trigger fn (migration 013).
drop trigger if exists widget_pin_updated_at on public.widget_pin;
create trigger widget_pin_updated_at
  before update on public.widget_pin
  for each row execute function public.update_updated_at();

/**
 * When team chat's routes answer for our support staff (migration 715).
 *
 * A route reads a channel as the person (RLS). Our staff can read a support
 * conversation of another workspace (715's policies, for support_staff), and
 * nothing else of it. The routes otherwise answer only for a channel of the
 * person's own workspace; this says when the staff branch takes over: the
 * channel is a support conversation, in a workspace that is not theirs, and
 * they are an admin (the app's half of the rule; the database's half is
 * support_staff). Pure.
 */
import type { User } from '@supabase/supabase-js'
import { isSupportStaffUser } from './staff'

export function isStaffSupportView(
  channel: { kind: string; workspace_id: string } | null | undefined,
  auth: { workspaceId: string; user: Pick<User, 'email'> },
): boolean {
  return !!channel && channel.kind === 'support' && channel.workspace_id !== auth.workspaceId && isSupportStaffUser(auth.user)
}

/** A support conversation, seen by its customer (in their own workspace). */
export function isCustomerSupportView(channel: { kind: string; workspace_id: string } | null | undefined, auth: { workspaceId: string }): boolean {
  return !!channel && channel.kind === 'support' && channel.workspace_id === auth.workspaceId
}

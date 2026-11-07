/**
 * Migration 320 (member_departure_keeps_work): removing a member, or leaving,
 * keeps what they wrote. Before it, an owner's Remove failed for anyone who had
 * applied a suggestion (proposed_change.applied_by was NO ACTION), and a
 * departure deleted the person's comments and drafts (both CASCADE). The SQL was
 * run on DEV inside a rolled-back block (supabase/tests/320_member_departure_keeps_work.sql);
 * this pins the file so a later edit can't drop a rule silently.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(resolve(__dirname, '../../../../../../supabase/migrations/320_member_departure_keeps_work.sql'), 'utf8')
// Comments out, whitespace collapsed: the statements only.
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

function fn(name: string) {
  const start = BODY.indexOf(`CREATE OR REPLACE FUNCTION public.${name}()`)
  return BODY.slice(start, BODY.indexOf('$$;', start) + 3)
}

describe('migration 320', () => {
  it('lets a member row go when they applied a suggestion: who applied is set null', () => {
    expect(BODY).toContain(
      'ADD CONSTRAINT proposed_change_applied_by_fkey FOREIGN KEY (applied_by) REFERENCES public.member(id) ON DELETE SET NULL;',
    )
  })

  it('keeps comments: no cascade, and a former member’s comment must carry a name', () => {
    expect(BODY).toContain(
      'ADD CONSTRAINT comment_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.member(id) ON DELETE SET NULL;',
    )
    expect(BODY).toContain('DROP CONSTRAINT comment_author_exactly_one')
    expect(BODY).toContain(
      'OR (author_id IS NULL AND author_user_id IS NULL AND author_name IS NOT NULL)',
    )
  })

  it('copies the name and avatar onto their comments just before the member row goes', () => {
    expect(BODY).toContain('BEFORE DELETE ON public.member FOR EACH ROW EXECUTE FUNCTION public.member_departure_keeps_work();')
    expect(fn('member_departure_keeps_work')).toContain(
      'ELSE UPDATE public.comment SET author_id = NULL, author_name = OLD.display_name, author_avatar_url = OLD.avatar_url WHERE author_id = OLD.id;',
    )
  })

  it('still deletes their comments when the whole workspace or their account is deleted', () => {
    expect(fn('member_departure_keeps_work')).toContain(
      'IF NOT EXISTS (SELECT 1 FROM public.workspace w WHERE w.id = OLD.workspace_id) OR NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = OLD.user_id) THEN DELETE FROM public.comment WHERE author_id = OLD.id;',
    )
  })

  it('lets a new draft replace the same person’s kept draft of that document, never refusing the save', () => {
    expect(fn('_document_draft_set_author_user')).toContain(
      "IF TG_OP = 'INSERT' THEN DELETE FROM public.document_draft d WHERE d.document_id = NEW.document_id AND d.author_user_id = NEW.author_user_id AND d.author_id IS NULL;",
    )
  })

  it('checks a comment’s target only when the target changes, so comments on deleted items can still be updated', () => {
    expect(BODY).toContain(
      'BEFORE INSERT OR UPDATE OF commentable_type, commentable_id ON public.comment FOR EACH ROW EXECUTE FUNCTION public.validate_commentable_exists();',
    )
  })

  it('keeps drafts with their user, keyed so the app’s upsert on (document_id, author_id) still lands', () => {
    expect(BODY).toContain('ADD COLUMN author_user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE;')
    expect(BODY).toContain('ADD CONSTRAINT document_draft_pkey PRIMARY KEY (document_id, author_user_id)')
    expect(BODY).toContain('ADD CONSTRAINT document_draft_document_author_key UNIQUE (document_id, author_id)')
    expect(BODY).toContain(
      'ADD CONSTRAINT document_draft_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.member(id) ON DELETE SET NULL;',
    )
    expect(fn('_document_draft_set_author_user')).toContain(
      'SELECT m.user_id INTO NEW.author_user_id FROM public.member m WHERE m.id = NEW.author_id;',
    )
  })

  it('gives a rejoining member their drafts in that workspace back', () => {
    expect(BODY).toContain('AFTER INSERT ON public.member FOR EACH ROW EXECUTE FUNCTION public.member_rejoin_restores_drafts();')
    expect(fn('member_rejoin_restores_drafts')).toContain(
      'UPDATE public.document_draft SET author_id = NEW.id WHERE workspace_id = NEW.workspace_id AND author_user_id = NEW.user_id AND author_id IS NULL;',
    )
  })

  it('runs its triggers with an empty search_path and schema-qualified tables, callable by no client', () => {
    for (const name of ['_document_draft_set_author_user', 'member_departure_keeps_work', 'member_rejoin_restores_drafts']) {
      expect(fn(name)).toContain("SECURITY DEFINER SET search_path = '' AS $$")
      expect(fn(name).match(/\b(FROM|UPDATE) (?!public\.|auth\.)\w+/g), name).toBeNull()
      expect(BODY).toContain(`REVOKE EXECUTE ON FUNCTION public.${name}() FROM PUBLIC, anon, authenticated;`)
    }
  })

  it('leaves the other cascades alone: invites they sent and their own rows still go', () => {
    expect(BODY).not.toMatch(/invite_invited_by_fkey|team_member_member_id_fkey|notification_recipient_id_fkey/)
  })
})

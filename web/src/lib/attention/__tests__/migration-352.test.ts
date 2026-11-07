/**
 * Migration 352 (cards_follow_their_proposal): a For You card settles when its
 * proposal is settled anywhere, comes back when an accept hands its claim back,
 * and expires when its proposal is deleted. The SQL runs on DEV inside a
 * rolled-back block (supabase/tests/352_cards_follow_their_proposal.sql); this
 * pins the file so a later edit can't drop a rule silently.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'

const SQL = readFileSync(resolve(__dirname, '../../../../supabase/migrations/352_cards_follow_their_proposal.sql'), 'utf8')
// Comments out, whitespace collapsed: the statements only.
const BODY = SQL.split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .replace(/\s+/g, ' ')

function fn(name: string) {
  const start = BODY.indexOf(`CREATE OR REPLACE FUNCTION public.${name}()`)
  return BODY.slice(start, BODY.indexOf('$$;', start) + 3)
}

describe('migration 352', () => {
  it('holds no backslash (one MCP transport decodes escapes) and sets a lock timeout', () => {
    expect(SQL.includes(String.fromCharCode(92))).toBe(false)
    expect(BODY).toContain("SET LOCAL lock_timeout = '5s';")
  })

  it('settles a proposal’s pending cards when it leaves pending, mapped to the card statuses', () => {
    expect(BODY).toContain(
      'AFTER UPDATE OF status ON public.proposed_change FOR EACH ROW EXECUTE FUNCTION public.attention_item_follow_proposal();',
    )
    const follow = fn('attention_item_follow_proposal')
    expect(follow).toContain("WHEN NEW.status = 'applied' THEN 'accepted'")
    // Both age-outs expire the card: the RPC's extra.aged_out and the 30-day create sweep's dismiss_reason.
    expect(follow).toContain(
      "WHEN NEW.status = 'dismissed' AND (coalesce(NEW.extra ->> 'aged_out', '') = 'true' OR coalesce(NEW.extra ->> 'dismiss_reason', '') = 'aged_out_30d') THEN 'expired'",
    )
    expect(follow).toContain("WHEN NEW.status = 'dismissed' THEN 'dismissed' ELSE 'expired'")
    expect(follow).toContain("WHERE a.proposal_id = NEW.id AND a.status = 'pending'")
    expect(follow).toContain('resolved_at = now()')
  })

  it('keeps a draft_email card pending when its proposal is applied (its body is written after)', () => {
    expect(fn('attention_item_follow_proposal')).toContain("AND NOT (a.kind = 'draft_email' AND NEW.status = 'applied');")
  })

  it('brings back only a card it settled, when the proposal returns to pending, never past expiry or beside a live card', () => {
    const follow = fn('attention_item_follow_proposal')
    expect(follow).toContain("ELSIF NEW.status = 'pending' THEN")
    expect(follow).toContain("AND c.payload ->> 'resolved_with_proposal' IS NOT NULL")
    expect(follow).toContain('AND (a.expires_at IS NULL OR a.expires_at > now())')
    expect(follow).toContain("WHERE p.proposal_id = NEW.id AND p.status = 'pending'")
    // A card that landed for the proposal in another transaction wins; the hand-back never fails on it.
    expect(follow).toContain('EXCEPTION WHEN unique_violation THEN NULL; END;')
  })

  it('adds no index of its own (migration 165’s proposal_id index serves the lookups)', () => {
    expect(BODY).not.toContain('CREATE INDEX')
  })

  it('expires a deleted proposal’s pending cards before the link is cleared', () => {
    expect(BODY).toContain(
      'BEFORE DELETE ON public.proposed_change FOR EACH ROW EXECUTE FUNCTION public.attention_item_expire_with_proposal();',
    )
    expect(fn('attention_item_expire_with_proposal')).toContain(
      "SET status = 'expired', resolved_at = now() WHERE a.proposal_id = OLD.id AND a.status = 'pending'; RETURN OLD;",
    )
  })

  it('runs both functions as their owner with an empty search_path, callable by no one', () => {
    for (const name of ['attention_item_follow_proposal', 'attention_item_expire_with_proposal']) {
      expect(fn(name)).toContain("SECURITY DEFINER SET search_path = ''")
      expect(BODY).toContain(`REVOKE EXECUTE ON FUNCTION public.${name}() FROM PUBLIC, anon, authenticated;`)
    }
  })

  it('expires the cards left behind and the waiting Create action cards, touching pending cards only', () => {
    expect(BODY).toContain(
      "WHERE a.status = 'pending' AND ( (a.proposal_id IS NOT NULL AND NOT EXISTS ( SELECT 1 FROM public.proposed_change pc WHERE pc.id = a.proposal_id AND pc.status = 'pending' ) AND NOT (a.kind = 'draft_email' AND EXISTS ( SELECT 1 FROM public.proposed_change pc WHERE pc.id = a.proposal_id AND pc.status = 'applied' ))) OR (a.proposal_id IS NULL AND a.kind IN ('action_card', 'draft_email')) );",
    )
    expect(BODY).toContain(
      "WHERE a.status = 'pending' AND a.kind = 'action_card' AND a.payload ->> 'change_type' = 'create' AND a.payload ->> 'entity_type' = 'action';",
    )
  })
})

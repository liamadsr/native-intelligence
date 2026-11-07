-- ============================================================
-- 247: Per-invite choice — does the invitee skip the paywall?
-- ============================================================
-- Admin signup invites (migration 242) always let the person bypass the
-- card-backed trial. That is right for design partners and testers, wrong
-- for a prospect you merely want past the business-email gate. The admin
-- console now chooses per invite:
--   skip_payment = true  → "Continue without adding a card" (comp seat)
--   skip_payment = false → normal 7-day trial with a card, email gate only
-- Existing rows keep today's behaviour (default true).
-- ============================================================

ALTER TABLE public.signup_invite
  ADD COLUMN IF NOT EXISTS skip_payment boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.signup_invite.skip_payment IS
  'When true the invitee may bypass the card-backed trial (complimentary seat). When false they only bypass the business-email gate.';

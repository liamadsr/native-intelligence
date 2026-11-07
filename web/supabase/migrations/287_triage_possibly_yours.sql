-- Migration 287: a first-person commitment on the user's own microphone, by a
-- voice nobody has identified, is carded "possibly yours" — not dismissed
-- "not yours" (docs/plans/orchestration-followups.md, issue 11).
--
-- What prod showed (Corvanne, 2026-09-28): triage dismissed 18 proposals as
-- "not yours". Placing each trigger quote in its capture's transcript, six were
-- said on the recorder's own microphone (`local_*`); three of those are
-- first-person commitments on local_1 ("so I think I'm gonna try to do it in
-- Fin today", "let me check on the ticket … I'll ping you the status of that",
-- "let me talk to Arch Node to understand why"). In all three meetings the
-- owner's capture_participant row had no speaker label (self_binding 'none'):
-- the microphone carried several voices (local_1 … local_6, a room), so the
-- position rule (exactly one mic voice → the owner) did not hold and the live
-- voiceprint check never granted. Nothing told triage that "unidentified" is
-- not "someone else": a trigger_quote carries no label, and get_action_suggestions
-- returned none, so the model read an unmapped voice as "clearly someone
-- else's" (one reason says so outright: "made by an unmapped speaker
-- (local_1), not Liam").
--
-- The companion code change gives triage the signal: verbose
-- get_action_suggestions rows carry `spoken_by` (src/lib/transcript/quote-speakers.ts):
-- the transcript voice(s) that said the trigger_quote, placed exactly as the
-- auto-attempt gate grounds a quote; each label's channel (`microphone` =
-- local_*, `meeting_audio` = remote_*); who the capture's participant rows
-- identify it as; and `possibly_you` — an unidentified microphone voice said
-- it, on a capture the caller recorded, where the caller's own voice is not
-- identified.
--
-- The rule, below: when `possibly_you` is true and the quote is a first-person
-- commitment, triage does NOT dismiss it as `not yours`; if it otherwise
-- passes the accept bar it accepts it with is_mine_explicit:false, which the
-- verdict gate always cards (verdict-apply.ts acceptDecision: an accept that
-- is not explicitly the user's is surfaced as a card, never applied), with a
-- reason — the card's "why" — that starts "Possibly yours". It is never
-- proposed as work (an attempt needs the commitment to be the user's). This is
-- the bridge until the owner's voice is bound on multi-voice captures (the
-- second issue-11 change); once it is, `possibly_you` is false on those
-- captures and the ownership gate reads as before.
--
-- Same shape as migrations 198, 281 and 285: a guarded prose append on the
-- SYSTEM triage row and a marker-prefixed context_rule, both idempotent. The
-- workspace copies of `triage` (is_system = false) are not used by any flow
-- (migration 285's note) and are not touched; standup-sync is out of scope.

update recipe set
  system_prompt = system_prompt || $py$

## Possibly yours: a first-person commitment on the user's own microphone

Verbose proposals carry `spoken_by`: the transcript voice (or voices) that said the trigger_quote. A voice's `channel` is `microphone` when the user's own recorder picked it up and `meeting_audio` when it came from the call. `identified_as` is the person the voice was matched to ("the user" when it is the user), or null when nobody was identified. `possibly_you: true` means an unidentified voice on the user's own microphone said it, on a capture where the user's own voice has not been identified. In a room with several people the recorder cannot tell the user from the others, so "not the user" is unknown, not established.

When `possibly_you` is true and the trigger_quote is a first-person commitment ("I'll…", "I'm gonna…", "let me…", "I can…"), do NOT dismiss it as `not yours`:

- If it otherwise passes the accept bar (a real commitment, not already covered, worth doing), accept it with `is_mine_explicit: false` and a `reason` that starts "Possibly yours — said on your microphone by a voice not yet identified:" followed by the commitment in a few words. It reaches the user as a card they confirm or dismiss.
- Never set `is_mine_explicit: true` on it, and never propose it as work (the draftable-work section): it is not known to be the user's.
- If it fails the accept bar for another reason (a duplicate, stale, narration), dismiss it for that reason, not as `not yours`.

Everything else is unchanged. A first-person line from a voice identified as someone else, from the meeting audio, or on a capture where the user's own voice is identified follows the ownership gate as before. When `spoken_by` is missing (the quote was not found in the transcript), judge ownership as before.$py$,
  updated_at = now()
where is_system = true
  and slug = 'triage'
  and position('## Possibly yours: a first-person commitment' in system_prompt) = 0;

update recipe set
  agent_config = jsonb_set(
    coalesce(agent_config, '{}'::jsonb),
    '{context_rules}',
    coalesce(agent_config -> 'context_rules', '[]'::jsonb) ||
      jsonb_build_array(
        'possibly_yours: when a verbose proposal''s spoken_by.possibly_you is true (an unidentified voice on the user''s own microphone, on a capture where the user''s own voice is not identified) and its trigger_quote is a first-person commitment, never dismiss it as not yours: if it otherwise passes the accept bar, accept it with is_mine_explicit:false and a reason starting "Possibly yours — said on your microphone by a voice not yet identified:"; never is_mine_explicit:true, never proposed as work; if it fails the bar for another reason, dismiss it for that reason.'
      )
  ),
  updated_at = now()
where is_system = true
  and slug = 'triage'
  and not exists (
    select 1
    from jsonb_array_elements_text(coalesce(agent_config -> 'context_rules', '[]'::jsonb)) as r(rule)
    where rule like 'possibly_yours:%'
  );

import { PostHog } from 'posthog-node'

let posthogClient: PostHog | null = null

const serverEnvironment = process.env.NODE_ENV === 'production' ? 'production' : 'development'

export function getPostHogServerClient(): PostHog | null {
  if (!process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    return null
  }

  if (!posthogClient) {
    posthogClient = new PostHog(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
      host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
      flushAt: 1,
      flushInterval: 0,
    })
  }

  return posthogClient
}

/** Default properties to include with every server-side event */
export const serverDefaultProperties = {
  platform: 'web',
  environment: serverEnvironment,
}

/**
 * Canonical product-event taxonomy for the web SaaS app.
 *
 * Every server-side product event flows through `trackServerEvent` with one of
 * these names so the launch dashboard, funnels, and retention insights query a
 * stable, documented vocabulary — not ad-hoc strings sprinkled across 170+ API
 * routes. Add new events here first, then emit them.
 *
 * Deliberately distinct from the legacy macOS (`posthog-ios`) events
 * (`feature_used`, `transcription_completed` on `platform: macos`, …): those
 * describe a different app. Web events all carry `platform: web` via
 * `serverDefaultProperties`, so dashboards can cleanly separate the two.
 */
export type ProductEvent =
  | 'user_signed_up'
  | 'user_logged_in'
  | 'onboarding_completed'
  | 'capture_created'
  | 'transcription_completed'
  // Recording-lifecycle reliability telemetry. These exist so a future "my
  // transcript stopped / didn't resume" incident is self-diagnosing from the
  // event stream instead of DB archaeology (cf. the capture that landed
  // duration_seconds=3 after a WebView freeze). `recording_resumed` fires when a
  // stopped/crashed capture is resumed; `resume_failed` when the resume's native
  // start was rejected or transcription never connected; `transcription_connected`
  // when the Deepgram socket opens; `transcription_source_stalled` when audio
  // stops flowing into a live socket (device disconnect / Rust not emitting).
  | 'recording_resumed'
  | 'resume_failed'
  // Launch-time recovery of a capture interrupted by a restart: the "Resume
  // interrupted capture?" prompt was shown (`recovery_prompted`), the user chose
  // End capture (`recovery_declined`), or no prompt was shown
  // (`recovery_skipped`, `reason`: 'stale' | 'not_found' | 'ended' |
  // 'check_failed' | 'recording'). Each carries `capture_id`. Added after a restart on the
  // 2026-10-19 Owen call split the meeting in two and only DB timestamps could
  // say why.
  | 'recovery_prompted'
  | 'recovery_declined'
  | 'recovery_skipped'
  | 'transcription_connected'
  | 'transcription_source_stalled'
  // Live transcription SETUP failed to connect. Fires when a `service.start()`
  // attempt throws (both Deepgram legs failed to connect), and — with a
  // terminal `reason: 'exhausted'` — when the bounded setup-retry loop gives up
  // and the user is told no transcript is being captured. Carries `capture_id`,
  // `reason` (e.g. an error string or 'exhausted'), and `attempt` (1-based).
  // Complements `transcription_connected`: its absence used to be the only
  // signal of the 386s zero-transcript incident; this makes the failure explicit.
  | 'transcription_failed'
  // A transcript auto-save entered a degraded state — carries `reason`:
  // 'locked_terminal' (append hit a finalized capture), 'append_4xx_fallback' /
  // 'append_5xx_fallback' (the delta path failed and we fell back to a full-text
  // PATCH; 5xx = the persistent-append outage the 2026-07-10 fix guards against),
  // or 'guard_skipped' (the no-shrink guard rejected the fallback). Exists so a
  // wedged / non-persisting transcript session is queryable from the event stream.
  | 'transcript_save_degraded'
  // The stop-time force-PATCH was rejected (non-2xx) — the final transcript may
  // not be durable for that capture.
  | 'final_transcript_save_failed'
  // System-audio (other-participant capture) permission telemetry from the
  // desktop recording flow. `system_audio_permission_status` reports the observed
  // permission state of a recording attempt (carries `capture_id`,
  // `system_audio_status` e.g. 'permissionDenied', `app_version`);
  // `system_audio_permission_requested` reports a user-initiated permission prompt
  // and its outcome (carries `source` e.g. 'settings', `result` e.g. 'granted',
  // `app_version`). These exist so "I recorded but couldn't hear the other side"
  // reports are diagnosable from the event stream — the same allowlist choke-point
  // as the other recording-lifecycle events (route: /api/analytics/recording-event).
  | 'system_audio_permission_status'
  | 'system_audio_permission_requested'
  // On-device transcription (the desktop's opt-in local-stt module). Local
  // transcription is free, so these are analytics only — never usage/credits.
  // `local_transcription_completed` fires when a local session ends (carries
  // `seconds`, `module_version`, and `fallback_reason` when the engine failed
  // mid-session); `local_transcription_fallback` when a recording that asked
  // for the local engine switched to Deepgram (carries `reason` and `phase`:
  // 'start' | 'mid_session').
  | 'local_transcription_completed'
  | 'local_transcription_fallback'
  // Live-agent say_to_user delivery telemetry: fires whenever a nudge BROADCAST
  // returns undelivered (subscribe timeout / no listener), INDEPENDENT of the
  // chat write. Carries `chat_written` so the two loss modes separate: a
  // HUD-only loss (`chat_written: true` — chat shows it, the floating HUD stays
  // blank, the actual production symptom) vs a total loss (`chat_written:
  // false`). An earlier `!delivered && !chatWrite.written` AND-gate meant the
  // HUD-only case — the common one, since chat is the authoritative surface and
  // almost always succeeds — never fired at all, so the event read as zero in
  // PostHog while HUD delivery was silently failing in the field.
  | 'live_agent_nudge_drop'
  // Live HUD telemetry: what the live agent's HUD actually did, so "did the
  // nudge show?" is answerable from the event stream (the 2026-10-19 Owen call
  // could only be guessed at: two nudges went out three minutes before an app
  // restart, and nothing recorded whether the HUD showed them). Client-side,
  // through /api/analytics/hud-event (lib/hud-telemetry.ts). From the window
  // recording the call (hooks/use-agent-nudge-relay.ts):
  // `live_hud_open_requested` (the relay asked the desktop to show the HUD),
  // `live_hud_close_requested` (the capture ended), and
  // `live_hud_nudge_received` (a say_to_user broadcast reached it; carries
  // `latency_ms`); their `ipc_ok` is only that the desktop took the call, never
  // that the HUD got it (Rust buffers silently). From the HUD
  // itself (app/hud/agent, components/live-hud/use-hud-telemetry.ts):
  // `live_hud_loaded` (its page is up), `live_hud_shown` / `live_hud_hidden`
  // (its page's visibility changed), `live_hud_nudge_arrived` (a nudge reached
  // the HUD's feed; carries `has_conversation`, since a nudge is drawn only
  // once the call's chat is open), and `live_hud_nudge_displayed` (its row was
  // drawn in the HUD's chat; carries `source`, broadcast or conversation).
  // Every HUD-side event carries `window_visible` (desktop: the window's own
  // state) and `document_visibility`, so a nudge drawn into a hidden HUD shows
  // as one. `live_hud_ensured` is the recording window putting back a HUD
  // that vanished (a restart, a lost window): carries `reason` (what checked)
  // and `result` (what the desktop found, e.g. created or restored), sent
  // only when it had to act. Never the nudge's words: ids and kinds only.
  | 'live_hud_open_requested'
  | 'live_hud_close_requested'
  | 'live_hud_nudge_received'
  | 'live_hud_loaded'
  | 'live_hud_shown'
  | 'live_hud_hidden'
  | 'live_hud_nudge_arrived'
  | 'live_hud_nudge_displayed'
  | 'live_hud_ensured'
  | 'action_created'
  | 'action_completed'
  | 'workflow_created'
  | 'project_created'
  | 'contact_created'
  | 'document_created'
  | 'ai_chat_message_sent'
  // First device settlement of a browser task; outcomes/diagnostics are
  // client-reported, with server queue timing and no page/task content.
  | 'browser_task_finished'
  | 'integration_connected'
  // Agents & Skills library authoring lifecycle. This surface was analytics-dark
  // (the usage audit in CLEANUP.md had to hand-query the DB) so nothing counted
  // how often people create, edit, remove, fork, or publish recipes. `_created`
  // /`_updated`/`_deleted` fire after the recipe write succeeds and carry
  // `category` ('agent' | 'skill'), `visibility`, and `recipe_id`.
  // `recipe_forked` fires when a public marketplace item is deep-copied into a
  // workspace (carries the source id + category). `recipe_published` fires
  // whenever a recipe's visibility becomes 'public' — on create or on the edit
  // that flips it — so the "publishes to every Dial8 user" step is a countable
  // event, not an invisible DB flag.
  | 'recipe_created'
  | 'recipe_updated'
  | 'recipe_deleted'
  | 'recipe_forked'
  | 'recipe_published'
  // Fires when the eve runtime's native load_skill tool matches and injects a
  // skill's playbook into the CURRENT chat context. Emitted server-side from the
  // internal analytics route the tool posts to (tenancy comes from the verified
  // chat-run token, never the model). This is the ONLY window into how often
  // description-as-routing actually pulls a skill in mid-conversation.
  | 'skill_auto_loaded'
  // Virality loop — the invite K-factor that drives compounding growth.
  // `invite_sent` fires when a member emails an invite; `invite_accepted`
  // fires when the recipient joins. The funnel sent → accepted → signup is
  // the lever for going from linear to exponential acquisition.
  | 'invite_sent'
  | 'invite_accepted'
  // Fires when a user sets or reschedules a "Remind me" on an entity. Carries
  // `entity_type` ('action' | 'project' | 'initiative' | 'capture' |
  // 'document'), so the question the feature was built to answer — do people
  // actually pull work back to themselves, and on WHAT — is readable from the
  // event stream. Reminders are private rows with owner-only RLS, so usage is
  // otherwise invisible without querying the table directly.
  | 'reminder_set'
  // Fires once, when a brand-new signup's first workspace is stamped with the
  // persona edition of the landing page they came from (`/login?edition=sales`
  // → workspace.settings.edition). Carries `signup_edition` plus a $set_once of
  // the same, so acquisition source is a permanent person property that a later
  // edition switch in settings cannot rewrite. Gated to genuine signups (see
  // lib/editions/attribution.ts) — a returning user's sign-in never emits it.
  | 'signup_edition_attributed'

/**
 * Identity context every product event needs so emails resolve correctly and
 * usage rolls up per workspace. `userId` is the Supabase `auth.users` id — the
 * SAME distinct_id the client uses in `dashboard-shell.tsx`'s `identify()`, so
 * server and client events land on one person profile.
 */
export interface TrackContext {
  userId: string
  workspaceId?: string | null
  /** Person-property enrichment — attached via `$set` so the dashboard can
   *  segment/identify users by email even on server-only events. */
  email?: string | null
  name?: string | null
}

/**
 * Fire a product event to PostHog from a server context (API route, cron).
 *
 * Fail-soft by design: if PostHog isn't configured this is a no-op, and it
 * never throws — analytics must never break a product write. Call it AFTER the
 * DB write succeeds so we only count real outcomes.
 *
 *   trackServerEvent('capture_created', { userId: user.id, workspaceId, email }, { live_mode })
 */
export function trackServerEvent(
  event: ProductEvent,
  ctx: TrackContext,
  properties: Record<string, unknown> = {},
): void {
  const posthog = getPostHogServerClient()
  if (!posthog) return

  // Enrich the person profile so email/name/workspace are queryable from any
  // event, mirroring the client identify() but covering server-only writes
  // (e.g. AI-driven captures, device-token requests with no browser session).
  const set: Record<string, unknown> = {}
  if (ctx.email) set.email = ctx.email
  if (ctx.name) set.name = ctx.name
  if (ctx.workspaceId) set.workspace_id = ctx.workspaceId

  try {
    posthog.capture({
      distinctId: ctx.userId,
      event,
      properties: {
        ...serverDefaultProperties,
        ...(ctx.workspaceId ? { workspace_id: ctx.workspaceId } : {}),
        ...properties,
        ...(Object.keys(set).length > 0 ? { $set: set } : {}),
      },
      // Roll usage up per workspace so the dashboard can count active
      // workspaces, not just active users.
      ...(ctx.workspaceId ? { groups: { workspace: ctx.workspaceId } } : {}),
    })
  } catch {
    // Never let analytics failures surface to the caller.
  }
}

/** Cookie that marks a login/signup as already counted for this auth session.
 *  Lives as long as a Supabase access token (~1h) so each fresh sign-in fires
 *  exactly one auth event, not one per dashboard page load. */
export const AUTH_EVENT_COOKIE = 'd8_auth_tracked'

/** A minimal slice of the Supabase user — just what auth-event detection needs.
 *  Declared locally so this module doesn't depend on @supabase/supabase-js. */
interface AuthUserLike {
  id: string
  email?: string | null
  created_at?: string
  last_sign_in_at?: string | null
  user_metadata?: { full_name?: string; name?: string } | null
  app_metadata?: { provider?: string } | null
}

/**
 * How recently an account must have been created for its session to count as
 * the SIGNUP session rather than a returning login.
 *
 * Deliberately generous relative to the 60s the acquisition event uses: this
 * window also gates persona-edition attribution (lib/editions/attribution.ts),
 * and an email-confirmation signup can take minutes between account creation
 * and the first authenticated page load. One hour matches the attribution
 * cookie's own lifetime, so the two can never disagree about whether a session
 * is still "the signup".
 */
export const SIGNUP_SESSION_WINDOW_MS = 60 * 60 * 1000

/** The 60s window the ACQUISITION EVENT uses to call a session a signup. Kept
 *  tight and separate from {@link SIGNUP_SESSION_WINDOW_MS}: mis-labelling a
 *  login as `user_signed_up` corrupts the funnel, whereas the attribution gate
 *  wants the widest window that is still provably not a returning customer. */
const SIGNUP_EVENT_WINDOW_MS = 60_000

/**
 * Is this authenticated session the account's OWN signup session?
 *
 * The single source of truth for signup-vs-login across the auth-session route:
 * both the acquisition event and persona-edition attribution ask this, so they
 * can never classify the same session differently. Anything unparseable or
 * missing is a LOGIN — the conservative answer, since the attribution side of
 * this call has a side effect on a real workspace.
 */
export function isFreshSignupUser(
  user: Pick<AuthUserLike, 'created_at'>,
  opts: { nowMs?: number; windowMs?: number } = {},
): boolean {
  const createdMs = user.created_at ? new Date(user.created_at).getTime() : NaN
  if (!Number.isFinite(createdMs)) return false
  const age = (opts.nowMs ?? Date.now()) - createdMs
  return age < (opts.windowMs ?? SIGNUP_SESSION_WINDOW_MS)
}

/**
 * Decide whether a freshly-loaded authenticated session is a NEW sign-up or a
 * returning LOGIN, and emit the matching event exactly once per session.
 *
 * WHY this exists: the OAuth `/auth/callback` route only sees Google sign-ins.
 * Password logins (`signInWithPassword`) and signups with an immediate session
 * navigate straight to `/account` via `router.replace`, bypassing the callback
 * entirely — so they were invisible to PostHog. The authenticated dashboard
 * layout, by contrast, is the ONE choke-point every session passes through
 * regardless of auth method. Tracking here closes the funnel hole.
 *
 * Returns the cookie value to set (and whether to set it) so the caller — a
 * Server Component or route that owns the cookie store — can persist the
 * dedup marker. Returns `null` when no event should fire (already counted, or
 * PostHog unconfigured), so the caller can skip the cookie write.
 *
 * New-vs-returning heuristic: `created_at` within 60s of now ⇒ first session ⇒
 * sign-up. Otherwise login. Mirrors the prior `/auth/callback` logic so the two
 * paths agree.
 */
export function trackAuthSession(
  user: AuthUserLike,
  opts: { alreadyTracked: boolean; nowMs?: number },
): { cookieValue: string } | null {
  if (opts.alreadyTracked) return null
  if (!getPostHogServerClient()) return null

  const isNewSignup = isFreshSignupUser(user, {
    nowMs: opts.nowMs,
    windowMs: SIGNUP_EVENT_WINDOW_MS,
  })

  const provider = user.app_metadata?.provider ?? 'unknown'
  // Normalise Supabase's provider names to the channel we care about:
  // 'google' ⇒ oauth, 'email' ⇒ password/magic-link. Everything else passes
  // through so new SSO providers show up without a code change.
  const method =
    provider === 'google' || provider === 'github' || provider === 'azure'
      ? 'oauth'
      : provider === 'email'
        ? 'email'
        : provider

  const name =
    user.user_metadata?.full_name || user.user_metadata?.name || null

  trackServerEvent(
    isNewSignup ? 'user_signed_up' : 'user_logged_in',
    { userId: user.id, email: user.email, name },
    { method, auth_provider: provider },
  )

  return { cookieValue: '1' }
}

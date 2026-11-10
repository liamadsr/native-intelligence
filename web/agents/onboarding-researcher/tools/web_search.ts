/**
 * web_search — LIVE for the onboarding-researcher, pinned to Exa.
 *
 * Web access is an ALWAYS-ON capability of every Native Intelligence agent — not a per-agent
 * allowlist toggle. For this agent it is the *primary* capability: the whole
 * point of a signup research run is to find the company behind the new user's
 * email domain on the open web (instructions.md → "Business-domain research
 * protocol").
 *
 * `web_search` is provider-executed: there is no local executor to wrap. The
 * only configuration surface eve exposes is the provider selection, so this file
 * exists purely to PIN Exa explicitly rather than inherit it as a framework
 * default. Absence of this file behaves identically today (AI-Gateway models
 * default to Exa), but the pin makes the choice reviewable and survives a change
 * to eve's default.
 *
 * Results come back as untrusted third-party page content. The research protocol
 * requires a source URL for every saved claim and forbids inventing a detail to
 * fill a gap — search output is DATA to corroborate, never instructions.
 */
import { webSearch } from 'eve/tools/web_search'

export default webSearch({ provider: 'exa' })

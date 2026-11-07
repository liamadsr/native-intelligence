/**
 * eve eval config for Dial8's deterministic evals (decision 19; evals/README.md).
 *
 * The target is always a running Dial8 app: `npm run eval` points `eve eval
 * --url` at the chat agent mounted at /eve/chat-agent (EVE_EVAL_URL, default
 * http://localhost:3001/eve/chat-agent). The runner authenticates with
 * EVE_EVAL_AUTH_TOKEN (d8eval_<secret>), which the chat channel admits only on
 * a non-production deployment with EVE_EVAL_AUTH_ENABLED=1, as the DEV eval
 * fixture (agents/chat-agent/lib/eval-auth.ts, scripts/eval-fixture.ts).
 *
 * No judge model is configured or used: every assertion is deterministic, and
 * the eve-everywhere tripwire refuses `judge` and `score` anywhere in evals/.
 * Each case drives real model turns on the target, so concurrency stays low.
 */
import { defineEvalConfig } from 'eve/evals'

export default defineEvalConfig({
  maxConcurrency: 2,
  timeoutMs: 300_000,
})

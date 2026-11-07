// The main chat's usage gate (../../../hooks/usage-limit-gate.ts): a helper
// turn over the person's limits is cancelled (eve 0.68+ ignores a hook throw),
// so the helper's result() comes back `waiting` with no reply, and the
// `helpers` tool reports it as failed ("stopped before it answered").
export { default } from '../../../hooks/usage-limit-gate.js'

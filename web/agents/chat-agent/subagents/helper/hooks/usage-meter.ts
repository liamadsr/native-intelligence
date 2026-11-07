// Each helper turn is billed on its own, under its own eve session id, by the
// main chat's meter (../../../hooks/usage-meter.ts), which notes the parent
// session as `helper_of` (ctx.session.parent) so a conversation's cost
// includes its helpers. The parent's meter folds only its own steps, so
// nothing is billed twice (lib/__tests__/helpers-spike.test.ts).
export { default } from '../../../hooks/usage-meter.js'

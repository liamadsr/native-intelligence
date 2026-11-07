// Each strong helper turn is billed on its own, under its own eve session id,
// by the main chat's meter (../../../hooks/usage-meter.ts), with `helper_of`
// and its model_route (tier strong), as on the plain helper.
export { default } from '../../../hooks/usage-meter.js'

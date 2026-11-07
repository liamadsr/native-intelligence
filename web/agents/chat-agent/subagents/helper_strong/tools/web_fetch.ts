// Web fetch with the SSRF guard and the per-session cap, exactly as the main
// chat has it (../../../tools/web_fetch.ts). The cap counts per eve session,
// so each strong helper has its own.
export { default } from '../../../tools/web_fetch.js'

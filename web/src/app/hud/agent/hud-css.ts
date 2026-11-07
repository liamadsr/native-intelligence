/** The HUD window's page-level stylesheet (see ./page.tsx for what it has to do). The card's own look is the view's (components/live-hud). */
export const HUD_CSS = `
html, body { height: 100%; min-height: 0 !important; background: transparent !important; color-scheme: normal !important; overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; -webkit-user-select: none; user-select: none; }
.agent-hud :is(textarea, input) { -webkit-user-select: text; user-select: text; }
/* Dev only: the Next.js dev badge sits over the composer in a small window. */
nextjs-portal { display: none !important; }
[cmdk-list] { max-height: min(12rem, calc(var(--radix-popover-content-available-height, 100vh) - 5.5rem)) !important; }
[data-radix-popper-content-wrapper] > [role="dialog"] { max-height: var(--radix-popover-content-available-height, 100vh); overflow-y: auto; }
`

import { themes, THEME_STORAGE_KEY } from '@/lib/themes'
import {
  BACKGROUND_STORAGE_KEY,
  DEFAULT_BACKGROUND_ID,
  GLASS_BACKGROUND_ID,
} from '@/lib/app-background'
import {
  CUSTOM_BG_LIGHT_KEY,
  CUSTOM_BG_DARK_KEY,
  CUSTOM_BG_LIGHT_VAR,
  CUSTOM_BG_DARK_VAR,
} from '@/lib/custom-background'
import { LAYOUT_ATTR, LAYOUT_STORAGE_KEY } from '@/lib/layout-mode'
import { SIDEBAR_COLLAPSED_ATTR, SIDEBAR_MAX_W, SIDEBAR_MIN_W, SIDEBAR_STORAGE_KEY, SIDEBAR_W_VAR } from '@/app/account/(dashboard)/rail/sidebar-size'

/**
 * Inline script that runs before React hydration to prevent flash.
 * Applies dark mode class AND theme CSS variable overrides.
 */
export function ThemeScript() {
  // Build a minimal map of theme overrides for the inline script
  const themeMap: Record<string, { light?: Record<string, string>; dark?: Record<string, string> }> = {}
  for (const t of themes) {
    if (t.id === 'default') continue
    themeMap[t.id] = { light: t.light, dark: t.dark }
  }

  const script = `
    try {
      // Desktop (Tauri) stamp — must happen before first paint so the
      // data-desktop CSS scope (select-none chrome, default cursor) never
      // flashes web behavior. Tauri injects its globals at document start,
      // before this inline script runs, so the check is reliable here.
      if (window.__TAURI__ !== undefined || window.__TAURI_INTERNALS__ !== undefined) {
        document.documentElement.setAttribute('data-desktop', '');
      }
      var isDark = localStorage.theme === 'dark' ||
        (!localStorage.theme && window.matchMedia('(prefers-color-scheme: dark)').matches);
      if (isDark) {
        document.documentElement.classList.add('dark');
        document.documentElement.style.colorScheme = 'dark';
      } else {
        document.documentElement.classList.remove('dark');
        document.documentElement.style.colorScheme = 'light';
      }
      var themeId = localStorage.getItem('${THEME_STORAGE_KEY}');
      if (themeId && themeId !== 'default') {
        var themes = ${JSON.stringify(themeMap)};
        var vars = isDark ? (themes[themeId] && themes[themeId].dark) : (themes[themeId] && themes[themeId].light);
        if (vars) { Object.keys(vars).forEach(function(k) { document.documentElement.style.setProperty(k, vars[k]); }); }
      }
      var bgId = localStorage.getItem('${BACKGROUND_STORAGE_KEY}') || '${DEFAULT_BACKGROUND_ID}';
      // Glass is desktop-only (app-background.ts availableBackgrounds). The
      // page only goes see-through once the desktop confirms
      // (window-backdrop-sync.tsx); here it just keeps the sky from starting.
      if (bgId === '${GLASS_BACKGROUND_ID}' && !document.documentElement.hasAttribute('data-desktop')) {
        bgId = '${DEFAULT_BACKGROUND_ID}';
      }
      document.documentElement.setAttribute('data-app-bg', bgId);
      // Apply any uploaded custom background images as CSS variables BEFORE
      // first paint so the 'custom' option doesn't flash. A single uploaded
      // image applies to BOTH modes (each mode falls back to the other's image
      // when it has none). Data URLs contain no double-quotes, so wrapping in
      // url("...") is safe. Keep this fallback in sync with
      // getEffectiveBackground() in custom-background.ts.
      var bgLight = localStorage.getItem('${CUSTOM_BG_LIGHT_KEY}');
      var bgDark = localStorage.getItem('${CUSTOM_BG_DARK_KEY}');
      var effLight = bgLight || bgDark;
      var effDark = bgDark || bgLight;
      if (effLight) document.documentElement.style.setProperty('${CUSTOM_BG_LIGHT_VAR}', 'url("' + effLight + '")');
      if (effDark) document.documentElement.style.setProperty('${CUSTOM_BG_DARK_VAR}', 'url("' + effDark + '")');
      // The person's layout (lib/layout-mode.ts): this device's copy of the
      // account's choice, JSON like every account setting's copy, so the shell's
      // first paint is already Traditional when it is on (no flash of the default).
      try {
        if (JSON.parse(localStorage.getItem('${LAYOUT_STORAGE_KEY}') || 'null') === 'traditional') {
          document.documentElement.setAttribute('${LAYOUT_ATTR}', 'traditional');
        }
        // Its sidebar's width and fold on this device (rail/sidebar-size.ts).
        var sidebar = JSON.parse(localStorage.getItem('${SIDEBAR_STORAGE_KEY}') || 'null');
        if (sidebar && typeof sidebar.w === 'number' && sidebar.w >= ${SIDEBAR_MIN_W} && sidebar.w <= ${SIDEBAR_MAX_W}) {
          document.documentElement.style.setProperty('${SIDEBAR_W_VAR}', Math.round(sidebar.w) + 'px');
        }
        if (sidebar && sidebar.collapsed === true) document.documentElement.setAttribute('${SIDEBAR_COLLAPSED_ATTR}', '');
      } catch (_) {}
    } catch (_) {}
  `

  return <script dangerouslySetInnerHTML={{ __html: script }} />
}

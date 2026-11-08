/**
 * Theme definitions for Native Intelligence.
 *
 * Each theme provides light and dark CSS variable overrides.
 * Variables not specified in a theme fall back to the defaults in tailwind.css.
 * The "default" theme applies no overrides (uses CSS as-is).
 */

export interface ThemeDefinition {
  id: string
  name: string
  description: string
  /** Preview colors shown in the picker [bg, fg, accent] */
  preview: { light: [string, string, string]; dark: [string, string, string] }
  /** CSS variable overrides — only specify what differs from default */
  light?: Record<string, string>
  dark?: Record<string, string>
  /** Extra CSS classes added to <html> for the theme (e.g. font overrides) */
  htmlClass?: string
}

export const themes: ThemeDefinition[] = [
  {
    // The default ships as "Neutral" — it applies NO overrides because the
    // baseline palette in tailwind.css (:root / .dark) IS Neutral. Keeping the
    // id as 'default' preserves the "no overrides" sentinel that ThemeScript
    // and applyThemeVariables already special-case.
    id: 'default',
    name: 'Neutral',
    description: 'Clean grayscale',
    preview: {
      light: ['#ffffff', '#0d0d0d', '#e5e5e5'],
      dark: ['#0f0f0f', '#ededed', '#1f1f1f'],
    },
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Deep blue tones',
    preview: {
      light: ['#f8f9fc', '#1a1d2e', '#e8ecf4'],
      dark: ['#0c0e1a', '#c8cde0', '#1a1d2e'],
    },
    light: {
      '--background': '225 30% 98%',
      '--foreground': '228 30% 14%',
      '--card': '225 30% 99%',
      '--card-foreground': '228 30% 14%',
      '--popover': '225 30% 99%',
      '--popover-foreground': '228 30% 14%',
      '--primary': '228 40% 22%',
      '--primary-foreground': '225 30% 97%',
      '--secondary': '225 20% 94%',
      '--secondary-foreground': '228 30% 14%',
      '--muted': '225 20% 94%',
      '--muted-foreground': '225 20% 26%',
      '--accent': '225 20% 94%',
      '--accent-foreground': '228 30% 14%',
      '--destructive': '0 72% 51%',
      '--destructive-foreground': '225 30% 97%',
      '--border': '225 15% 91%',
      '--input': '225 15% 89%',
      '--ring': '228 40% 22%',
      '--sidebar-background': '225 22% 95%',
      '--sidebar-foreground': '225 20% 22%',
      '--sidebar-primary': '228 40% 22%',
      '--sidebar-primary-foreground': '225 30% 97%',
      '--sidebar-accent': '225 18% 90%',
      '--sidebar-accent-foreground': '228 30% 14%',
      '--sidebar-border': '225 12% 88%',
      '--sidebar-ring': '228 40% 22%',
    },
    dark: {
      '--background': '230 30% 6%',
      '--foreground': '220 15% 85%',
      '--card': '230 25% 8%',
      '--card-foreground': '220 15% 85%',
      '--popover': '230 25% 8%',
      '--popover-foreground': '220 15% 85%',
      '--primary': '220 15% 85%',
      '--primary-foreground': '230 30% 6%',
      '--secondary': '230 20% 13%',
      '--secondary-foreground': '220 15% 85%',
      '--muted': '230 20% 13%',
      '--muted-foreground': '220 12% 74%',
      '--accent': '230 20% 13%',
      '--accent-foreground': '220 15% 85%',
      '--destructive': '0 62% 30%',
      '--destructive-foreground': '220 15% 85%',
      '--border': '230 18% 10%',
      '--input': '230 18% 15%',
      '--ring': '220 15% 78%',
      '--sidebar-background': '230 30% 4%',
      '--sidebar-foreground': '220 12% 78%',
      '--sidebar-primary': '220 15% 85%',
      '--sidebar-primary-foreground': '230 30% 6%',
      '--sidebar-accent': '230 20% 12%',
      '--sidebar-accent-foreground': '220 12% 80%',
      '--sidebar-border': '230 18% 13%',
      '--sidebar-ring': '0 0% 83.9%',
    },
  },
  {
    id: 'paper',
    name: 'Paper',
    description: 'Warm and natural',
    preview: {
      light: ['#faf8f5', '#2c2418', '#f0ebe4'],
      dark: ['#1a1714', '#e8e0d4', '#2a2520'],
    },
    light: {
      '--background': '36 30% 97%',
      '--foreground': '30 25% 12%',
      '--card': '40 25% 98%',
      '--card-foreground': '30 25% 12%',
      '--popover': '40 25% 98%',
      '--popover-foreground': '30 25% 12%',
      '--primary': '30 20% 15%',
      '--primary-foreground': '40 30% 96%',
      '--secondary': '35 18% 93%',
      '--secondary-foreground': '30 20% 15%',
      '--muted': '35 18% 93%',
      '--muted-foreground': '30 10% 45%',
      '--accent': '35 18% 93%',
      '--accent-foreground': '30 20% 15%',
      '--destructive': '0 72% 51%',
      '--destructive-foreground': '40 30% 96%',
      '--border': '35 15% 90%',
      '--input': '35 15% 88%',
      '--ring': '30 20% 15%',
      '--sidebar-background': '36 20% 94%',
      '--sidebar-foreground': '30 10% 40%',
      '--sidebar-primary': '30 20% 15%',
      '--sidebar-primary-foreground': '40 30% 96%',
      '--sidebar-accent': '35 15% 89%',
      '--sidebar-accent-foreground': '30 20% 15%',
      '--sidebar-border': '35 12% 87%',
      '--sidebar-ring': '30 20% 15%',
    },
    dark: {
      '--background': '25 12% 8%',
      '--foreground': '35 15% 88%',
      '--card': '25 12% 10%',
      '--card-foreground': '35 15% 88%',
      '--popover': '25 12% 10%',
      '--popover-foreground': '35 15% 88%',
      '--primary': '35 15% 88%',
      '--primary-foreground': '25 12% 8%',
      '--secondary': '25 10% 15%',
      '--secondary-foreground': '35 15% 88%',
      '--muted': '25 10% 15%',
      '--muted-foreground': '30 8% 52%',
      '--accent': '25 10% 15%',
      '--accent-foreground': '35 15% 88%',
      '--destructive': '0 62% 30%',
      '--destructive-foreground': '35 15% 88%',
      '--border': '25 8% 13%',
      '--input': '25 8% 17%',
      '--ring': '35 15% 80%',
      '--sidebar-background': '25 12% 5%',
      '--sidebar-foreground': '30 8% 58%',
      '--sidebar-primary': '35 15% 88%',
      '--sidebar-primary-foreground': '25 12% 8%',
      '--sidebar-accent': '25 10% 14%',
      '--sidebar-accent-foreground': '35 12% 82%',
      '--sidebar-border': '25 8% 16%',
      '--sidebar-ring': '35 15% 80%',
    },
  },
  {
    id: 'retro',
    name: 'Retro',
    description: 'Classic computing',
    preview: {
      light: ['#f0f0f0', '#1a1a2e', '#c0c0c0'],
      dark: ['#0a0a18', '#c8c8d8', '#1a1a2e'],
    },
    light: {
      '--background': '0 0% 94%',
      '--foreground': '240 25% 13%',
      '--card': '0 0% 97%',
      '--card-foreground': '240 25% 13%',
      '--popover': '0 0% 97%',
      '--popover-foreground': '240 25% 13%',
      '--primary': '240 25% 20%',
      '--primary-foreground': '0 0% 94%',
      '--secondary': '0 0% 88%',
      '--secondary-foreground': '240 25% 13%',
      '--muted': '0 0% 88%',
      '--muted-foreground': '240 5% 42%',
      '--accent': '0 0% 85%',
      '--accent-foreground': '240 25% 13%',
      '--destructive': '0 72% 51%',
      '--destructive-foreground': '0 0% 98%',
      '--border': '0 0% 78%',
      '--input': '0 0% 78%',
      '--ring': '240 25% 20%',
      '--sidebar-background': '0 0% 88%',
      '--sidebar-foreground': '240 5% 38%',
      '--sidebar-primary': '240 25% 20%',
      '--sidebar-primary-foreground': '0 0% 94%',
      '--sidebar-accent': '0 0% 82%',
      '--sidebar-accent-foreground': '240 25% 13%',
      '--sidebar-border': '0 0% 75%',
      '--sidebar-ring': '240 25% 20%',
    },
    dark: {
      '--background': '240 20% 6%',
      '--foreground': '230 10% 82%',
      '--card': '240 18% 9%',
      '--card-foreground': '230 10% 82%',
      '--popover': '240 18% 9%',
      '--popover-foreground': '230 10% 82%',
      '--primary': '230 10% 82%',
      '--primary-foreground': '240 20% 6%',
      '--secondary': '240 15% 14%',
      '--secondary-foreground': '230 10% 82%',
      '--muted': '240 15% 14%',
      '--muted-foreground': '230 8% 50%',
      '--accent': '240 15% 14%',
      '--accent-foreground': '230 10% 82%',
      '--destructive': '0 62% 30%',
      '--destructive-foreground': '230 10% 82%',
      '--border': '240 12% 12%',
      '--input': '240 12% 16%',
      '--ring': '230 10% 75%',
      '--sidebar-background': '240 20% 4%',
      '--sidebar-foreground': '230 8% 55%',
      '--sidebar-primary': '230 10% 82%',
      '--sidebar-primary-foreground': '240 20% 6%',
      '--sidebar-accent': '240 15% 12%',
      '--sidebar-accent-foreground': '230 10% 78%',
      '--sidebar-border': '240 12% 14%',
      '--sidebar-ring': '230 10% 75%',
    },
  },
  {
    id: 'evergreen',
    name: 'Evergreen',
    description: 'Subtle green accent',
    preview: {
      light: ['#f8faf8', '#1a2e1a', '#e6f0e6'],
      dark: ['#0c140c', '#c0d8c0', '#1a2e1a'],
    },
    light: {
      '--background': '120 15% 98%',
      '--foreground': '140 25% 12%',
      '--card': '120 15% 99%',
      '--card-foreground': '140 25% 12%',
      '--popover': '120 15% 99%',
      '--popover-foreground': '140 25% 12%',
      '--primary': '150 30% 18%',
      '--primary-foreground': '120 15% 97%',
      '--secondary': '130 12% 94%',
      '--secondary-foreground': '140 25% 12%',
      '--muted': '130 12% 94%',
      '--muted-foreground': '140 8% 44%',
      '--accent': '130 12% 94%',
      '--accent-foreground': '140 25% 12%',
      '--destructive': '0 72% 51%',
      '--destructive-foreground': '120 15% 97%',
      '--border': '130 10% 91%',
      '--input': '130 10% 89%',
      '--ring': '150 30% 18%',
      '--sidebar-background': '130 12% 95%',
      '--sidebar-foreground': '140 8% 40%',
      '--sidebar-primary': '150 30% 18%',
      '--sidebar-primary-foreground': '120 15% 97%',
      '--sidebar-accent': '130 10% 90%',
      '--sidebar-accent-foreground': '140 25% 12%',
      '--sidebar-border': '130 8% 88%',
      '--sidebar-ring': '150 30% 18%',
    },
    dark: {
      '--background': '140 15% 5%',
      '--foreground': '130 10% 84%',
      '--card': '140 12% 7%',
      '--card-foreground': '130 10% 84%',
      '--popover': '140 12% 7%',
      '--popover-foreground': '130 10% 84%',
      '--primary': '130 10% 84%',
      '--primary-foreground': '140 15% 5%',
      '--secondary': '140 10% 12%',
      '--secondary-foreground': '130 10% 84%',
      '--muted': '140 10% 12%',
      '--muted-foreground': '130 6% 50%',
      '--accent': '140 10% 12%',
      '--accent-foreground': '130 10% 84%',
      '--destructive': '0 62% 30%',
      '--destructive-foreground': '130 10% 84%',
      '--border': '140 8% 10%',
      '--input': '140 8% 15%',
      '--ring': '130 10% 78%',
      '--sidebar-background': '140 15% 3%',
      '--sidebar-foreground': '130 6% 56%',
      '--sidebar-primary': '130 10% 84%',
      '--sidebar-primary-foreground': '140 15% 5%',
      '--sidebar-accent': '140 10% 11%',
      '--sidebar-accent-foreground': '130 8% 80%',
      '--sidebar-border': '140 8% 13%',
      '--sidebar-ring': '130 10% 78%',
    },
  },
]

export const THEME_STORAGE_KEY = 'dial8-theme'

export function getStoredThemeId(): string {
  if (typeof window === 'undefined') return 'default'
  return localStorage.getItem(THEME_STORAGE_KEY) || 'default'
}

export function getThemeById(id: string): ThemeDefinition | undefined {
  return themes.find((t) => t.id === id)
}

/** Apply a theme's CSS variable overrides to the document root */
export function applyThemeVariables(themeId: string) {
  const theme = getThemeById(themeId)
  const root = document.documentElement

  // Remove any previous theme class
  themes.forEach((t) => {
    if (t.htmlClass) root.classList.remove(t.htmlClass)
  })

  // Clear previous theme overrides
  root.style.removeProperty('--theme-applied')
  const allVars = [
    '--background', '--foreground', '--card', '--card-foreground',
    '--popover', '--popover-foreground', '--primary', '--primary-foreground',
    '--secondary', '--secondary-foreground', '--muted', '--muted-foreground',
    '--accent', '--accent-foreground', '--destructive', '--destructive-foreground',
    '--border', '--input', '--ring',
    '--sidebar-background', '--sidebar-foreground', '--sidebar-primary',
    '--sidebar-primary-foreground', '--sidebar-accent', '--sidebar-accent-foreground',
    '--sidebar-border', '--sidebar-ring',
  ]
  allVars.forEach((v) => root.style.removeProperty(v))

  if (!theme || theme.id === 'default') {
    localStorage.removeItem(THEME_STORAGE_KEY)
    return
  }

  // Apply the correct set of overrides based on current dark/light mode
  const isDark = root.classList.contains('dark')
  const vars = isDark ? theme.dark : theme.light
  if (vars) {
    Object.entries(vars).forEach(([key, value]) => {
      root.style.setProperty(key, value)
    })
  }

  if (theme.htmlClass) root.classList.add(theme.htmlClass)

  localStorage.setItem(THEME_STORAGE_KEY, theme.id)
  root.style.setProperty('--theme-applied', theme.id)
}

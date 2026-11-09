'use client'

import { useCallback, useEffect, useState, useRef } from 'react'
import { ThinkingOrb } from 'thinking-orbs'
import { Monitor, Moon, Sun, ChevronDown, Check, Palette, Paintbrush, Image as ImageIcon, Upload, X, Volume2, AppWindow } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { isDesktopApp } from '@/lib/platform'
import { useDesktopOS } from '@/components/desktop-titlebar'
import { tauriBridge } from '@/lib/tauri-bridge'
import { setSoundEffectsEnabled, useSoundEffectsEnabled } from '@/lib/sounds/settings'
import { playSound, unlockSounds } from '@/lib/sounds/engine'
import { isSoundQuiet } from '@/lib/sounds/quiet'
import {
  themes,
  getStoredThemeId,
  applyThemeVariables,
  THEME_STORAGE_KEY,
  type ThemeDefinition,
} from '@/lib/themes'
import {
  availableBackgrounds,
  getStoredBackgroundId,
  applyBackground,
  reconcileCustomBackground,
  CUSTOM_BACKGROUND_ID,
  DEFAULT_BACKGROUND_ID,
  SKY_BACKGROUND_ID,
  isGlassBackground,
  type BackgroundDefinition,
} from '@/lib/app-background'
import {
  getGlassOpacity,
  setGlassOpacity,
  DEFAULT_GLASS_OPACITY,
  GLASS_WINDOW_UNSUPPORTED_ATTR,
} from '@/lib/window-backdrop'
import { SKY_WEATHER_CREDIT, SKY_WEATHER_CREDIT_URL } from '@/lib/sky/weather'
import {
  processBackgroundFile,
  setCustomBackground,
  getCustomBackground,
  BackgroundImageError,
  type BackgroundMode,
} from '@/lib/custom-background'
import { AssistantSection } from './assistant-section'

type ThemeMode = 'system' | 'light' | 'dark'

function getStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'system'
  const stored = localStorage.getItem('theme')
  if (stored === 'light' || stored === 'dark') return stored
  return 'system'
}

function isDarkActive(): boolean {
  return document.documentElement.classList.contains('dark')
}

function applyTheme(mode: ThemeMode) {
  const isDark =
    mode === 'dark' ||
    (mode === 'system' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)

  if (isDark) {
    document.documentElement.classList.add('dark')
    document.documentElement.style.colorScheme = 'dark'
  } else {
    document.documentElement.classList.remove('dark')
    document.documentElement.style.colorScheme = 'light'
  }

  if (mode === 'system') {
    localStorage.removeItem('theme')
  } else {
    localStorage.setItem('theme', mode)
  }

  // Re-apply theme variant for the new light/dark mode
  const themeId = localStorage.getItem(THEME_STORAGE_KEY) || 'default'
  applyThemeVariables(themeId)
}

const themeModeLabels: Record<ThemeMode, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

function ThemeSwatch({
  theme,
  isActive,
  isDark,
  onClick,
}: {
  theme: ThemeDefinition
  isActive: boolean
  isDark: boolean
  onClick: () => void
}) {
  const preview = isDark ? theme.preview.dark : theme.preview.light
  const [bg, fg, accent] = preview

  return (
    <button
      onClick={onClick}
      className="group flex flex-col items-center gap-1.5"
      title={theme.description}
    >
      <div
        className={cn(
          'relative flex h-16 w-16 items-end justify-center rounded-xl border-2 p-1.5 transition-all',
          isActive
            ? 'border-foreground shadow-sm'
            : 'border-transparent hover:border-foreground/20',
        )}
        style={{ backgroundColor: bg }}
      >
        {/* Mini UI preview */}
        <div className="flex w-full flex-col gap-1">
          <div className="h-1 rounded-full" style={{ backgroundColor: fg, width: '70%', opacity: 0.6 }} />
          <div className="h-1 rounded-full" style={{ backgroundColor: accent, width: '100%' }} />
          <div className="h-1 rounded-full" style={{ backgroundColor: fg, width: '50%', opacity: 0.3 }} />
        </div>
        {isActive && (
          <div className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-background">
            <Check className="h-2.5 w-2.5" strokeWidth={3} />
          </div>
        )}
      </div>
      <span className={cn(
        'text-[11px] font-medium',
        isActive ? 'text-foreground' : 'text-muted-foreground',
      )}>
        {theme.name}
      </span>
    </button>
  )
}

function BackgroundSwatch({
  background,
  isActive,
  isDark,
  customPreview,
  onClick,
}: {
  background: BackgroundDefinition
  isActive: boolean
  isDark: boolean
  /** For the "Custom" option: the uploaded data URL for the current mode, if any. */
  customPreview?: string | null
  onClick: () => void
}) {
  const images = background.images
  const isCustom = images === 'custom'
  // Built-in photo options carry a { light, dark } object; the custom option
  // shows the user's uploaded preview (or a placeholder); "None" is flat.
  const src = isCustom
    ? customPreview ?? null
    : images && images !== 'sky' && images !== 'window'
      ? (isDark ? images.dark : images.light)
      : null

  return (
    <button
      onClick={onClick}
      className="group flex flex-col items-center gap-1.5"
      title={background.description}
    >
      <div
        className={cn(
          'relative h-16 w-24 overflow-hidden rounded-xl border-2 transition-all',
          isActive
            ? 'border-foreground shadow-sm'
            : 'border-transparent hover:border-foreground/20',
        )}
      >
        {src ? (
          <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />
        ) : images === 'sky' ? (
          // The live sky: a still of a soft day-to-golden sky.
          <div
            className="h-full w-full"
            style={{ background: isDark ? 'linear-gradient(to bottom, #16223f, #3b3550 70%, #6b4a46)' : 'linear-gradient(to bottom, #6f9fdc, #b9d3ef 60%, #f1d2a6)' }}
          />
        ) : images === 'window' ? (
          // Glass: a checkerboard (the "see-through" convention) with a
          // frosted pane over it.
          <div
            className="relative h-full w-full"
            style={{
              backgroundColor: isDark ? '#2a2c33' : '#e7e9ee',
              backgroundImage: `repeating-conic-gradient(${isDark ? '#3a3d46' : '#ffffff'} 0% 25%, transparent 0% 50%)`,
              backgroundSize: '12px 12px',
            }}
          >
            <div className={cn('absolute inset-2 rounded-md border backdrop-blur-[3px]', isDark ? 'border-white/15 bg-white/10' : 'border-white/70 bg-white/45')} />
          </div>
        ) : isCustom ? (
          // Custom with nothing uploaded yet → upload affordance.
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-muted">
            <Upload className="h-4 w-4 text-muted-foreground" />
            <span className="text-[10px] font-medium text-muted-foreground">Upload</span>
          </div>
        ) : (
          // Flat surface preview — matches the shell's `bg-sidebar` fallback.
          <div className="flex h-full w-full items-center justify-center bg-sidebar">
            <span className="text-[10px] font-medium text-muted-foreground">None</span>
          </div>
        )}
        {isActive && (
          <div className="absolute -bottom-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-foreground text-background">
            <Check className="h-2.5 w-2.5" strokeWidth={3} />
          </div>
        )}
      </div>
      <span className={cn(
        'text-[11px] font-medium',
        isActive ? 'text-foreground' : 'text-muted-foreground',
      )}>
        {background.name}
      </span>
    </button>
  )
}

/**
 * One upload slot (Light or Dark) shown when the Custom background is active.
 * Handles pick → compress → persist, preview, and remove for that mode.
 */
function CustomBackgroundSlot({
  mode,
  value,
  onChange,
}: {
  mode: BackgroundMode
  value: string | null
  onChange: (dataUrl: string | null) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleFile(file: File) {
    setError(null)
    setBusy(true)
    try {
      const dataUrl = await processBackgroundFile(file)
      setCustomBackground(mode, dataUrl)
      onChange(dataUrl)
    } catch (err) {
      const msg =
        err instanceof BackgroundImageError
          ? err.message
          : 'Something went wrong processing that image.'
      setError(msg)
    } finally {
      setBusy(false)
    }
  }

  function handleRemove() {
    setError(null)
    setCustomBackground(mode, null)
    onChange(null)
    if (inputRef.current) inputRef.current.value = ''
  }

  const label = mode === 'dark' ? 'Dark mode' : 'Light mode'

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
        {mode === 'dark' ? <Moon className="h-3 w-3" /> : <Sun className="h-3 w-3" />}
        {label}
      </div>
      <div
        className={cn(
          'relative h-20 w-32 overflow-hidden rounded-xl border transition-colors',
          value ? 'border-border' : 'border-dashed border-border hover:border-foreground/30',
        )}
      >
        {value ? (
          <>
            <img src={value} alt={`${label} background`} className="h-full w-full object-cover" draggable={false} />
            {/* Replace-in-place: click the image to reopen the picker. Sits below
                the remove button (lower stacking) so ✕ still wins the hit-test.
                Inset so it never overlaps the ✕ button's corner. */}
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
              className="absolute inset-0 z-10 flex items-center justify-center bg-black/0 text-transparent transition-colors hover:bg-black/40 hover:text-white"
              title={`Replace ${label.toLowerCase()} background`}
            >
              {busy ? <ThinkingOrb state="working" size={20} theme="auto" /> : <span className="text-[11px] font-medium">Replace</span>}
            </button>
            <button
              type="button"
              onClick={handleRemove}
              className="absolute right-1 top-1 z-20 flex h-5 w-5 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm backdrop-blur transition-colors hover:bg-background"
              title={`Remove ${label.toLowerCase()} background`}
            >
              <X className="h-3 w-3" />
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="flex h-full w-full flex-col items-center justify-center gap-1 bg-muted/40 text-muted-foreground transition-colors hover:bg-muted/60 disabled:opacity-60"
          >
            {busy ? <ThinkingOrb state="working" size={20} theme="auto" /> : <Upload className="h-4 w-4" />}
            <span className="text-[10px] font-medium">{busy ? 'Processing…' : 'Upload image'}</span>
          </button>
        )}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void handleFile(file)
        }}
      />
      {error && <p className="max-w-32 text-[10px] leading-tight text-destructive">{error}</p>}
    </div>
  )
}

function ThemeModeDropdown({
  value,
  onChange,
}: {
  value: ThemeMode
  onChange: (mode: ThemeMode) => void
}) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    // pointerdown, not mousedown: Tauri's drag script swallows mousedown on the
    // settings shell's title-bar drag strip, which would leave this open.
    document.addEventListener('pointerdown', handler)
    return () => document.removeEventListener('pointerdown', handler)
  }, [open])

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm transition-colors hover:bg-muted/50"
      >
        <span>{themeModeLabels[value]}</span>
        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-10 mt-1 w-36 rounded-3xl border border-border bg-popover p-2 shadow-md">
          {(['system', 'light', 'dark'] as ThemeMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => { onChange(mode); setOpen(false) }}
              className={cn(
                'flex w-full items-center gap-2 rounded-2xl px-2.5 py-1.5 text-sm transition-colors',
                value === mode ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50',
              )}
            >
              {mode === 'system' && <Monitor className="h-3.5 w-3.5" />}
              {mode === 'light' && <Sun className="h-3.5 w-3.5" />}
              {mode === 'dark' && <Moon className="h-3.5 w-3.5" />}
              {themeModeLabels[mode]}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function PreferencesView() {
  const [theme, setTheme] = useState<ThemeMode>('system')
  const [activeThemeId, setActiveThemeId] = useState('default')
  const [activeBackgroundId, setActiveBackgroundId] = useState(DEFAULT_BACKGROUND_ID)
  const [customLight, setCustomLight] = useState<string | null>(null)
  const [customDark, setCustomDark] = useState<string | null>(null)
  const [mounted, setMounted] = useState(false)
  const [darkMode, setDarkMode] = useState(false)
  // Glass's Opacity slider (percent, lib/window-backdrop.ts).
  const [glassOpacity, setGlassOpacityState] = useState(DEFAULT_GLASS_OPACITY)
  // The desktop refused a see-through window (an older build): say to update.
  const [windowBackdropUnsupported, setWindowBackdropUnsupported] = useState(false)

  useEffect(() => {
    setTheme(getStoredTheme())
    setActiveThemeId(getStoredThemeId())
    setActiveBackgroundId(getStoredBackgroundId())
    setCustomLight(getCustomBackground('light'))
    setCustomDark(getCustomBackground('dark'))
    setDarkMode(isDarkActive())
    setGlassOpacityState(getGlassOpacity())
    setMounted(true)
  }, [])

  useEffect(() => {
    const root = document.documentElement
    const read = () => setWindowBackdropUnsupported(root.hasAttribute(GLASS_WINDOW_UNSUPPORTED_ATTR))
    read()
    const mo = new MutationObserver(read)
    mo.observe(root, { attributes: true, attributeFilter: [GLASS_WINDOW_UNSUPPORTED_ATTR] })
    return () => mo.disconnect()
  }, [])

  // Desktop-only close-to-tray setting. `null` = not loaded / not available:
  // the toggle stays hidden until the native getter actually resolves, so an
  // older binary without the command renders no control at all rather than a
  // dead one. Platform check is deferred to the client to avoid a hydration
  // mismatch (mirrors recording-settings-view.tsx).
  const [isDesktop, setIsDesktop] = useState<boolean | null>(null)
  const [closeToTray, setCloseToTray] = useState<boolean | null>(null)
  // The Windows app: its tray is the system tray, and it has no Glass.
  const windows = useDesktopOS() === 'windows'

  useEffect(() => {
    setIsDesktop(isDesktopApp())
  }, [])

  // UI sounds — device-local (localStorage), so no fetch and no revert.
  const soundEffects = useSoundEffectsEnabled()
  const handleSoundEffectsToggle = useCallback((enabled: boolean) => {
    setSoundEffectsEnabled(enabled)
    // Turning them on plays one, so the user hears what they chose (unless
    // the mic is live or a capture records: it would be recorded).
    if (enabled) {
      // Still inside the click: Safari only lets a resume through here, and
      // the preview below plays after an await.
      unlockSounds()
      void isSoundQuiet().then((quiet) => {
        if (!quiet) playSound('notification-alert')
      })
    }
  }, [])

  useEffect(() => {
    if (!isDesktop) return
    let cancelled = false
    async function loadCloseToTray() {
      try {
        const enabled = await tauriBridge.getCloseToTray()
        if (!cancelled) setCloseToTray(enabled)
      } catch (e) {
        // Older native binary without get_close_to_tray — leave the toggle
        // hidden entirely.
        console.warn('[preferences] getCloseToTray unavailable:', e)
      }
    }
    loadCloseToTray()
    return () => {
      cancelled = true
    }
  }, [isDesktop])

  const handleCloseToTrayToggle = useCallback(async (enabled: boolean) => {
    const previous = closeToTray
    setCloseToTray(enabled) // optimistic
    try {
      await tauriBridge.setCloseToTray(enabled)
    } catch (e) {
      console.warn('[preferences] setCloseToTray failed:', e)
      setCloseToTray(previous)
    }
  }, [closeToTray])

  // While the Preferences page is open, keep the swatch previews (which render
  // light vs dark colors) in sync with OS appearance changes in System mode.
  // The actual theme application is handled globally by SystemThemeListener
  // (mounted in the root layout), so here we only mirror the dark/light state
  // for the previews — after a tick, so we read the class the global listener set.
  useEffect(() => {
    if (theme !== 'system') return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const handler = () => {
      requestAnimationFrame(() => setDarkMode(isDarkActive()))
    }
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [theme])

  function handleThemeChange(mode: ThemeMode) {
    setTheme(mode)
    applyTheme(mode)
    setDarkMode(isDarkActive())
  }

  function handleThemeVariant(themeId: string) {
    setActiveThemeId(themeId)
    applyThemeVariables(themeId)
  }

  function handleBackground(backgroundId: string) {
    setActiveBackgroundId(backgroundId)
    applyBackground(backgroundId)
  }

  function handleGlassOpacity(percent: number) {
    setGlassOpacityState(percent)
    setGlassOpacity(percent)
  }

  function handleCustomChange(mode: BackgroundMode, dataUrl: string | null) {
    if (mode === 'dark') setCustomDark(dataUrl)
    else setCustomLight(dataUrl)

    // Uploading an image while on any option should switch to Custom so the
    // user immediately sees their image. Removing the last one falls back.
    if (dataUrl) {
      if (activeBackgroundId !== CUSTOM_BACKGROUND_ID) {
        setActiveBackgroundId(CUSTOM_BACKGROUND_ID)
        applyBackground(CUSTOM_BACKGROUND_ID)
      }
    } else {
      // Reconcile handles the "custom active but both now empty" case.
      const next = reconcileCustomBackground()
      if (next !== activeBackgroundId) setActiveBackgroundId(next)
    }
  }

  return (
    <div className="space-y-8">
      {/* Your assistant — every platform: the name the chat goes by (on the
          desktop, Interactive mode's wake word) and the model it runs on. */}
      <AssistantSection />

      {/* Appearance */}
      <div>
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">Appearance</h3>
        <div className="rounded-xl border border-border bg-card">
          {/* Theme mode row */}
          <div className="flex items-center justify-between px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                <Palette className="h-4.5 w-4.5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium">Theme</p>
                <p className="text-[13px] text-muted-foreground">Choose your interface color scheme</p>
              </div>
            </div>
            <ThemeModeDropdown value={theme} onChange={handleThemeChange} />
          </div>

          {/* Dashed divider */}
          <div className="mx-5 border-t border-dashed border-border" />

          {/* Theme variant row */}
          <div className="px-5 py-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                <Paintbrush className="h-4.5 w-4.5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium">Style</p>
                <p className="text-[13px] text-muted-foreground">Pick a visual style for Dial8</p>
              </div>
            </div>
            <div className="flex items-center gap-4 overflow-x-auto rounded-lg bg-muted/40 px-4 py-3">
              {mounted ? themes.map((t) => (
                <ThemeSwatch
                  key={t.id}
                  theme={t}
                  isActive={activeThemeId === t.id}
                  isDark={darkMode}
                  onClick={() => handleThemeVariant(t.id)}
                />
              )) : (
                <div className="flex items-center gap-4 py-2">
                  {themes.map((t) => (
                    <div key={t.id} className="h-[88px] w-16 rounded-xl bg-muted/60 animate-pulse" />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Dashed divider */}
          <div className="mx-5 border-t border-dashed border-border" />

          {/* Background row */}
          <div className="px-5 py-4">
            <div className="flex items-center gap-3 mb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                <ImageIcon className="h-4.5 w-4.5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium">Background</p>
                <p className="text-[13px] text-muted-foreground">Choose the backdrop behind your workspace</p>
              </div>
            </div>
            <div className="flex items-center gap-4 overflow-x-auto rounded-lg bg-muted/40 px-4 py-3">
              {mounted ? availableBackgrounds(isDesktop === true && !windows).map((b) => (
                <BackgroundSwatch
                  key={b.id}
                  background={b}
                  isActive={activeBackgroundId === b.id}
                  isDark={darkMode}
                  customPreview={
                    b.id === CUSTOM_BACKGROUND_ID
                      // Show the EFFECTIVE image (with cross-mode fallback) so the
                      // swatch matches what actually renders when only one is set.
                      ? (darkMode ? (customDark ?? customLight) : (customLight ?? customDark))
                      : undefined
                  }
                  onClick={() => handleBackground(b.id)}
                />
              )) : (
                <div className="flex items-center gap-4 py-2">
                  {availableBackgrounds(false).map((b) => (
                    <div key={b.id} className="h-[88px] w-24 rounded-xl bg-muted/60 animate-pulse" />
                  ))}
                </div>
              )}
            </div>

            {/* The sky's weather comes from MET Norway, whose licence (CC BY 4.0) asks for credit. */}
            {mounted && activeBackgroundId === SKY_BACKGROUND_ID && (
              <p className="mt-2 px-1 text-[11px] text-muted-foreground/80">
                Follows the time of day and the weather where you are.{' '}
                <a href={SKY_WEATHER_CREDIT_URL} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                  {SKY_WEATHER_CREDIT}
                </a>
              </p>
            )}

            {/* Glass: how solid the window is, from frosted glass to near solid. */}
            {mounted && isGlassBackground(activeBackgroundId) && (
              <div className="mt-3 rounded-lg bg-muted/40 px-4 py-3">
                {windowBackdropUnsupported ? (
                  <p className="text-[12px] text-muted-foreground">
                    Update the Dial8 desktop app to see through the window. Until then it shows the Sky.
                  </p>
                ) : (
                  <>
                    <p className="mb-2 text-[12px] text-muted-foreground">
                      What’s behind Dial8 shows through, frosted. Slide right for a more solid window.
                    </p>
                    <div className="flex items-center gap-3">
                      <span className="text-[11px] font-medium text-muted-foreground">Opacity</span>
                      <input
                        type="range"
                        aria-label="Glass opacity"
                        aria-valuetext={`${glassOpacity}%`}
                        min={0}
                        max={100}
                        step={5}
                        value={glassOpacity}
                        onChange={(e) => handleGlassOpacity(Number(e.currentTarget.value))}
                        className="h-1.5 min-w-0 max-w-64 flex-1 cursor-pointer accent-primary"
                      />
                      <span className="w-9 text-right text-[11px] tabular-nums text-muted-foreground">{glassOpacity}%</span>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Upload slots — revealed when the Custom background is selected.
                Light and dark are independent; either can be left empty and the
                app falls back to the flat surface for that mode. */}
            {mounted && activeBackgroundId === CUSTOM_BACKGROUND_ID && (
              <div className="mt-3 rounded-lg bg-muted/40 px-4 py-3">
                <p className="mb-3 text-[12px] text-muted-foreground">
                  Upload a background for light and/or dark mode. Either is optional — leave one empty to keep the flat surface there.
                </p>
                <div className="flex flex-wrap gap-5">
                  <CustomBackgroundSlot
                    mode="light"
                    value={customLight}
                    onChange={(v) => handleCustomChange('light', v)}
                  />
                  <CustomBackgroundSlot
                    mode="dark"
                    value={customDark}
                    onChange={(v) => handleCustomChange('dark', v)}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Sounds — every platform; the setting lives on this device. */}
      <div>
        <h3 className="mb-3 text-sm font-medium text-muted-foreground">Sounds</h3>
        <div className="rounded-xl border border-border bg-card">
          <div className="flex items-center justify-between gap-6 px-5 py-4">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                <Volume2 className="h-4.5 w-4.5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium">Sound effects</p>
                <p className="text-[13px] text-muted-foreground">
                  A short sound when an agent needs you, a run you started
                  finishes, or a notification arrives, and when dictation or
                  voice mode starts and ends. Alerts stay quiet while your mic
                  is on or a capture is recording. Applies to this device.
                </p>
              </div>
            </div>
            <Switch
              checked={soundEffects}
              onCheckedChange={handleSoundEffectsToggle}
              aria-label="Sound effects"
            />
          </div>
        </div>
      </div>

      {/* Desktop app — only rendered once the native getter resolves, so an
          older binary without the command shows nothing here. */}
      {isDesktop && closeToTray !== null && (
        <div>
          <h3 className="mb-3 text-sm font-medium text-muted-foreground">Desktop App</h3>
          <div className="rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between gap-6 px-5 py-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <AppWindow className="h-4.5 w-4.5 text-muted-foreground" />
                </div>
                <div>
                  <p className="text-sm font-medium">
                    Keep Dial8 running in the background when the window is
                    closed
                  </p>
                  <p className="text-[13px] text-muted-foreground">
                    Dial8 stays in the {windows ? 'system tray' : 'menu bar'} so
                    notifications keep arriving. Quit from the tray menu to
                    close it fully.
                  </p>
                </div>
              </div>
              <Switch
                checked={closeToTray}
                onCheckedChange={handleCloseToTrayToggle}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

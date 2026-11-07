'use client'

/**
 * The agent, edited: its name (the agent's name everywhere, the one Settings →
 * Preferences sets: lib/voice/assistant-name.ts) and its look (Liam,
 * 2026-10-23: "bring it back so that when you click on the bot you can edit
 * how it looks"): the bot builder's panel (gone
 * with the faces, 5621d50a8) brought back on `bot-avatars`' own options
 * (lib/bots/agent-look.ts) instead of the custom parts. Its tabs: Body (the
 * shape and its colour), Material (the package's shadings: fabric, plastic,
 * smooth, crisp, flat), Face, Glasses, Wear (a hat, headphones, a bow tie,
 * and their colour). Beside them, a live preview: the agent's bot in the look
 * being made, moving for a moment after each change, and its name under it,
 * to type over. Save keeps both on the account (agent-look-store.ts, and the
 * name's own store), and every bot of the agent's wears the look at once.
 *
 * The tabs share one fixed height (the tallest, Body), so the dialog keeps its
 * size from tab to tab; the colours sit in one row (Liam: "I want them to all
 * fit in the card"), the shape's own colour (or the accessories' black) first,
 * ringed dashed.
 *
 * Each tile is a still of the look with that one part changed, so what a tile
 * shows is what picking it makes. Tiles are drawn `smooth` (a still at tile
 * size needs no fur, and draws at once), but for the materials' own, and
 * drawn twice their size and scaled down, as the bot is (agent-bot.tsx).
 * The preview wears the material picked.
 *
 * The dialog is the agent's panel, in tabs (Liam, 2026-10-24: "I want to
 * make that panel multi-purpose", then "break communication out into their
 * own tabs"): Look (all of the above), Phone, Slack, and People (who can talk
 * to the agent; components/communication/communication-panel.tsx). A tab is
 * mounted when first shown and kept, so a look being made survives a look at
 * Phone. Save and Start over are Look's; the others save as they go, and have
 * no footer.
 *
 * The dialog has one fixed height; every tab fills what's left under the
 * tabs and scrolls inside it (Look's footer included), so the dialog,
 * centred on the screen, never moves or resizes from tab to tab (Liam: "the
 * whole panel jumps").
 *
 * Opened from the agent card (agent-editor.tsx: its bot, its settings icon),
 * which fetches this module, and the renderer with it, on the first opening.
 */
import { useId, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { BotAvatar, botAvatarPresets } from 'bot-avatars'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { PeoplePanel, PhonePanel, SlackPanel } from '@/components/communication/communication-panel'
import { AgentBot } from './agent-bot'
import type { AgentPanelTab } from './agent-editor'
import {
  AGENT_LOOK_ACCESSORY_COLORS,
  AGENT_LOOK_BODY_COLORS,
  AGENT_LOOK_COLOR_NAMES,
  AGENT_LOOK_FACES,
  AGENT_LOOK_GLASSES,
  AGENT_LOOK_HATS,
  AGENT_LOOK_SHADINGS,
  AGENT_LOOK_TYPES,
  DEFAULT_AGENT_LOOK,
  sameAgentLook,
  type AgentLook,
} from '@/lib/bots/agent-look'
import { saveAgentLook, useAgentLook } from '@/lib/bots/agent-look-store'
import { ASSISTANT_NAME_MAX } from '@/lib/voice/assistant-name'
import { saveAssistantName, useAssistantName } from '@/lib/voice/assistant-name-store'

/** The accessories' own colour (the package's soft black, `accessoryColor`'s default). */
const ACCESSORY_BLACK = '#27272B'

export const AGENT_PANEL_TABS: ReadonlyArray<{ id: AgentPanelTab; label: string }> = [
  // How you reach the agent first, then who else can, then how it looks (Liam, 2026-10-24).
  { id: 'phone', label: 'Phone' },
  { id: 'slack', label: 'Slack' },
  { id: 'people', label: 'People' },
  { id: 'look', label: 'Look' },
]

export const LOOK_STEPS = ['Body', 'Material', 'Face', 'Glasses', 'Wear'] as const
type LookStep = (typeof LOOK_STEPS)[number]

const FACE_NAMES: Record<(typeof AGENT_LOOK_FACES)[number], string> = { eyes: 'Eyes', mouth: 'Eyes and mouth' }
const SHADING_NAMES: Record<(typeof AGENT_LOOK_SHADINGS)[number], string> = { fabric: 'Fabric', plastic: 'Plastic', smooth: 'Smooth', crisp: 'Crisp', flat: 'Flat' }
/** A tile's bot, px, and the size it is drawn at before it is scaled into the tile. */
const TILE_BOT = 30
const TILE_DRAWN = 62
const GLASSES_NAMES: Record<(typeof AGENT_LOOK_GLASSES)[number], string> = { none: 'None', round: 'Round', square: 'Square', shades: 'Shades' }
const HAT_NAMES: Record<(typeof AGENT_LOOK_HATS)[number], string> = { none: 'None', beret: 'Beret', beanie: 'Beanie', party: 'Party hat', crown: 'Crown' }

const STILL_POSE = { yaw: 0 }
const NO_POINTER = { pointerEvents: 'none' } as const

/** The arrow keys' step: next, previous, or not an arrow. */
function arrowStep(key: string): number {
  return key === 'ArrowRight' || key === 'ArrowDown' ? 1 : key === 'ArrowLeft' || key === 'ArrowUp' ? -1 : 0
}

/**
 * A radio group's arrow keys: move to the next or previous radio and pick it
 * (each group is one tab stop, its picked radio, as a radio group is).
 */
function onRadioKeys(e: KeyboardEvent<HTMLElement>) {
  const step = arrowStep(e.key)
  if (!step) return
  const radios = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')]
  const at = radios.indexOf(document.activeElement as HTMLElement)
  if (at < 0) return
  e.preventDefault()
  const next = radios[(at + step + radios.length) % radios.length]
  next.focus()
  next.click()
}

/**
 * A tile: the look with one part changed, still (smooth, unless `material`:
 * the Material tab's tiles show their own). A radio is a tab stop only while
 * picked; a checkbox always is.
 */
function Tile({
  label,
  look,
  selected,
  role = 'radio',
  material = false,
  onPick,
}: {
  label: string
  look: AgentLook
  selected: boolean
  role?: 'radio' | 'checkbox'
  material?: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={selected}
      aria-label={label}
      title={label}
      tabIndex={role === 'radio' && !selected ? -1 : 0}
      data-look-tile={label}
      onClick={onPick}
      className={cn(
        'flex h-[72px] flex-col items-center justify-center gap-1 overflow-hidden rounded-md border transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'border-primary bg-primary/10' : 'border-transparent bg-muted/50 hover:bg-muted',
      )}
    >
      <span aria-hidden className="relative block shrink-0" style={{ width: TILE_BOT, height: TILE_BOT }}>
        <span className="absolute left-0 top-0 block origin-top-left" style={{ width: TILE_DRAWN, height: TILE_DRAWN, transform: `scale(${TILE_BOT / TILE_DRAWN})` }}>
          <BotAvatar {...look} shading={material ? (look.shading ?? 'fabric') : 'smooth'} size={TILE_DRAWN} paused pose={STILL_POSE} interactive={false} style={NO_POINTER} />
        </span>
      </span>
      <span className="max-w-full truncate px-1 text-[10px] text-muted-foreground">{label}</span>
    </button>
  )
}

/** A group of tiles: a radio group, or (`checkboxes`) a plain group of checkboxes. */
function Tiles({ label, checkboxes = false, children }: { label: string; checkboxes?: boolean; children: ReactNode }) {
  return (
    <div className="mb-3">
      <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div
        role={checkboxes ? 'group' : 'radiogroup'}
        aria-label={label}
        onKeyDown={checkboxes ? undefined : onRadioKeys}
        className="grid grid-cols-4 gap-1 sm:grid-cols-6"
      >
        {children}
      </div>
    </div>
  )
}

/**
 * A row of colours: the part's own first (its colour, ringed dashed: none
 * picked), then the offered ones. One row, so they all fit beside the
 * preview (it wraps only on a narrow screen).
 */
function Swatches({ label, own, value, colors, onPick }: { label: string; own: { label: string; color: string }; value: string | undefined; colors: readonly string[]; onPick: (color: string | undefined) => void }) {
  const same = (color: string) => value?.toUpperCase() === color.toUpperCase()
  // A colour none of the swatches is (none picked): the first is the group's tab stop.
  const ownStop = value === undefined || !colors.some(same)
  const ring = (picked: boolean) => (picked ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : '')
  return (
    <div className="mb-3">
      <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div role="radiogroup" aria-label={label} onKeyDown={onRadioKeys} className="flex flex-wrap items-center justify-between gap-y-2 sm:flex-nowrap">
        <button
          type="button"
          role="radio"
          aria-label={own.label}
          title={own.label}
          aria-checked={value === undefined}
          tabIndex={ownStop ? 0 : -1}
          data-look-color="own"
          onClick={() => onPick(undefined)}
          style={{ background: own.color }}
          className={cn(
            'size-6 shrink-0 rounded-full border-2 border-dashed border-foreground/35 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            ring(value === undefined),
          )}
        />
        {colors.map((color) => (
          <button
            key={color}
            type="button"
            role="radio"
            aria-label={AGENT_LOOK_COLOR_NAMES[color] ?? color}
            title={AGENT_LOOK_COLOR_NAMES[color] ?? color}
            aria-checked={same(color)}
            tabIndex={same(color) ? 0 : -1}
            data-look-color={color}
            onClick={() => onPick(color)}
            style={{ background: color }}
            className={cn('size-6 shrink-0 rounded-full border border-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', ring(same(color)))}
          />
        ))}
      </div>
    </div>
  )
}

/** The tabs, the tiles and the live preview, for `look`; the agent's name under the preview, to type over. */
export function AgentLookPanel({
  look,
  onChange,
  name,
  onNameChange,
  nameError,
  onSubmit,
}: {
  look: AgentLook
  onChange: (look: AgentLook) => void
  name: string
  onNameChange: (name: string) => void
  /** Why the name can't be saved, under it. */
  nameError?: string | null
  /** Enter in the name: save. */
  onSubmit?: () => void
}) {
  const [step, setStep] = useState<LookStep>('Body')
  const tabsId = useId()
  const set = (patch: Partial<AgentLook>) => onChange({ ...look, ...patch })
  const face = look.face ?? 'eyes'
  // The tabs' arrow keys: the next or previous tab, focused and shown.
  const onTabKeys = (e: KeyboardEvent<HTMLElement>) => {
    const by = arrowStep(e.key)
    if (!by) return
    e.preventDefault()
    const next = LOOK_STEPS[(LOOK_STEPS.indexOf(step) + by + LOOK_STEPS.length) % LOOK_STEPS.length]
    setStep(next)
    document.getElementById(`${tabsId}-${next}`)?.focus()
  }

  return (
    <div className="grid gap-4 md:grid-cols-[1fr_200px]">
      <div className="min-w-0">
        <div role="tablist" aria-label="Parts" onKeyDown={onTabKeys} className="flex flex-wrap gap-1.5 text-xs">
          {LOOK_STEPS.map((s) => (
            <button
              key={s}
              id={`${tabsId}-${s}`}
              type="button"
              role="tab"
              aria-selected={step === s}
              aria-controls={`${tabsId}-panel`}
              tabIndex={step === s ? 0 : -1}
              onClick={() => setStep(s)}
              className={cn(
                'rounded-full px-3 py-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                step === s ? 'bg-foreground font-medium text-background' : 'bg-muted text-muted-foreground hover:text-foreground',
              )}
            >
              {s}
            </button>
          ))}
        </div>
        {/* One height for every tab (Body's, the tallest), so the dialog keeps its size. */}
        <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${step}`} data-look-panel="" className="h-[328px] overflow-y-auto pt-3">
          {step === 'Body' && (
            <>
              <Tiles label="Shape">
                {AGENT_LOOK_TYPES.map((type) => (
                  <Tile key={type} label={botAvatarPresets[type].label} look={{ ...look, type }} selected={look.type === type} onPick={() => set({ type })} />
                ))}
              </Tiles>
              <Swatches
                label="Colour"
                own={{ label: `Its own (${botAvatarPresets[look.type].label})`, color: botAvatarPresets[look.type].color }}
                value={look.color}
                colors={AGENT_LOOK_BODY_COLORS}
                onPick={(color) => set({ color })}
              />
            </>
          )}
          {step === 'Material' && (
            <Tiles label="Material">
              {AGENT_LOOK_SHADINGS.map((shading) => (
                <Tile
                  key={shading}
                  label={SHADING_NAMES[shading]}
                  look={{ ...look, shading }}
                  material
                  selected={(look.shading ?? 'fabric') === shading}
                  onPick={() => set({ shading })}
                />
              ))}
            </Tiles>
          )}
          {step === 'Face' && (
            <Tiles label="Face">
              {AGENT_LOOK_FACES.map((f) => (
                <Tile key={f} label={FACE_NAMES[f]} look={{ ...look, face: f }} selected={face === f} onPick={() => set({ face: f })} />
              ))}
            </Tiles>
          )}
          {step === 'Glasses' && (
            <Tiles label="Glasses">
              {AGENT_LOOK_GLASSES.map((glasses) => (
                <Tile key={glasses} label={GLASSES_NAMES[glasses]} look={{ ...look, glasses }} selected={look.glasses === glasses} onPick={() => set({ glasses })} />
              ))}
            </Tiles>
          )}
          {step === 'Wear' && (
            <>
              <Tiles label="Hat">
                {AGENT_LOOK_HATS.map((hat) => (
                  <Tile key={hat} label={HAT_NAMES[hat]} look={{ ...look, hat }} selected={look.hat === hat} onPick={() => set({ hat })} />
                ))}
              </Tiles>
              <Tiles label="And" checkboxes>
                <Tile label="Headphones" role="checkbox" look={{ ...look, headphones: true }} selected={look.headphones} onPick={() => set({ headphones: !look.headphones })} />
                <Tile label="Bow tie" role="checkbox" look={{ ...look, bowTie: true }} selected={look.bowTie} onPick={() => set({ bowTie: !look.bowTie })} />
              </Tiles>
              <Swatches
                label="Their colour"
                own={{ label: 'Black', color: ACCESSORY_BLACK }}
                value={look.accessoryColor}
                colors={AGENT_LOOK_ACCESSORY_COLORS}
                onPick={(accessoryColor) => set({ accessoryColor })}
              />
            </>
          )}
        </div>
      </div>

      <div className="flex flex-col items-center gap-2 rounded-xl border bg-muted/30 p-4" data-look-preview="">
        <div className="flex h-36 items-end justify-center pb-3">
          <AgentBot state="default" active size={104} look={look} />
        </div>
        <label className="w-full text-center">
          <span className="mb-0.5 block text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Name</span>
          <input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) onSubmit?.()
            }}
            // Room past the limit, as Settings has: a long or padded name is explained, not cut short.
            maxLength={ASSISTANT_NAME_MAX + 10}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? `${tabsId}-name-error` : undefined}
            data-look-name=""
            className="w-full rounded-md border border-transparent bg-transparent px-2 py-1 text-center text-sm font-medium text-foreground transition-colors hover:border-border focus:border-ring focus:outline-none"
          />
        </label>
        {nameError && (
          <p id={`${tabsId}-name-error`} role="alert" className="text-center text-xs text-destructive">
            {nameError}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * The panel in a dialog, from the saved name and look; Save keeps what changed
 * on the account (or says it couldn't). Closed, it puts the focus back on `returnFocusTo` (the
 * control that opened it: with no Radix trigger, Radix would leave it on the
 * page).
 */
export function AgentLookDialog({
  open,
  onOpenChange,
  returnFocusTo,
  initialTab = 'look',
  guestId,
  linkId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  returnFocusTo?: RefObject<HTMLElement | null>
  initialTab?: AgentPanelTab
  /** People: the person it opens on. */
  guestId?: string
  /** People: the agent link request to review. */
  linkId?: string
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // One height whatever the tab (Look's footer comes and goes inside it), so the dialog never moves.
        className="flex h-[560px] max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
        data-agent-look-editor=""
        onCloseAutoFocus={(e) => {
          if (!returnFocusTo?.current) return
          e.preventDefault()
          returnFocusTo.current.focus()
        }}
      >
        {/* Mounted per opening: each starts from the saved name and look. */}
        {open && <EditorBody initialTab={initialTab} guestId={guestId} linkId={linkId} onDone={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  )
}

/** The panel's own tabs, over all of it: Phone, Slack, People and Look, underlined, across the dialog. */
function PanelTabs({ tab, onTab, id }: { tab: AgentPanelTab; onTab: (tab: AgentPanelTab) => void; id: string }) {
  const onKeys = (e: KeyboardEvent<HTMLElement>) => {
    const by = arrowStep(e.key)
    if (!by) return
    e.preventDefault()
    const at = AGENT_PANEL_TABS.findIndex((t) => t.id === tab)
    const next = AGENT_PANEL_TABS[(at + by + AGENT_PANEL_TABS.length) % AGENT_PANEL_TABS.length].id
    onTab(next)
    document.getElementById(`${id}-${next}`)?.focus()
  }
  return (
    <div role="tablist" aria-label="Your agent" onKeyDown={onKeys} className="mt-3 flex shrink-0 gap-6 border-b px-6 text-sm" data-agent-panel-tabs="">
      {AGENT_PANEL_TABS.map((t) => (
        <button
          key={t.id}
          id={`${id}-${t.id}`}
          type="button"
          role="tab"
          aria-selected={tab === t.id}
          aria-controls={`${id}-${t.id}-panel`}
          tabIndex={tab === t.id ? 0 : -1}
          data-agent-panel-tab={t.id}
          onClick={() => onTab(t.id)}
          className={cn(
            '-mb-px border-b-2 pb-2.5 pt-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            tab === t.id ? 'border-foreground font-medium text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  )
}

/** One tab's panel: the whole body's height, scrolling inside it; hidden, not unmounted, while another tab shows. */
function TabPanel({ id, tab, current, children }: { id: string; tab: AgentPanelTab; current: AgentPanelTab; children: ReactNode }) {
  return (
    <div
      id={`${id}-${tab}-panel`}
      role="tabpanel"
      aria-labelledby={`${id}-${tab}`}
      hidden={current !== tab}
      data-agent-panel={tab}
      className="absolute inset-0 overflow-y-auto px-6 py-5"
    >
      {children}
    </div>
  )
}

function EditorBody({ onDone, initialTab, guestId, linkId }: { onDone: () => void; initialTab: AgentPanelTab; guestId?: string; linkId?: string }) {
  const tabsId = useId()
  const [tab, setTab] = useState<AgentPanelTab>(initialTab)
  // A tab is mounted when first shown, then kept (the look's draft, a phone code half typed).
  const [shown, setShown] = useState<ReadonlySet<AgentPanelTab>>(() => new Set([initialTab]))
  const showTab = (next: AgentPanelTab) => {
    setTab(next)
    setShown((prev) => (prev.has(next) ? prev : new Set([...prev, next])))
  }
  const saved = useAgentLook()
  const savedName = useAssistantName().name
  const [look, setLook] = useState<AgentLook>(saved)
  const [name, setName] = useState(savedName)
  const [nameError, setNameError] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [saving, setSaving] = useState(false)
  const nameChanged = name.trim() !== savedName
  const lookChanged = !sameAgentLook(look, saved)
  const save = async () => {
    if (saving || (!nameChanged && !lookChanged)) return
    setSaving(true)
    setError(false)
    try {
      if (nameChanged) {
        const checked = await saveAssistantName(name)
        if (!checked.ok) return setNameError(checked.error)
      }
      if (lookChanged && !(await saveAgentLook(look))) return setError(true)
      onDone()
    } finally {
      setSaving(false)
    }
  }
  return (
    <>
      <DialogHeader className="shrink-0 px-6 pt-5 text-left">
        <DialogTitle className="text-base">Your agent</DialogTitle>
        <DialogDescription className="sr-only">Its name and look, how you reach it outside Dial8, and who else can.</DialogDescription>
      </DialogHeader>
      <PanelTabs tab={tab} onTab={showTab} id={tabsId} />
      {/* The rest of the dialog's height, for every tab, each scrolling inside it. */}
      <div className="relative min-h-0 flex-1" data-agent-panel-body="">
        <TabPanel id={tabsId} tab="phone" current={tab}>
          {shown.has('phone') && <PhonePanel name={savedName} />}
        </TabPanel>
        <TabPanel id={tabsId} tab="slack" current={tab}>
          {shown.has('slack') && <SlackPanel name={savedName} />}
        </TabPanel>
        <TabPanel id={tabsId} tab="people" current={tab}>
          {shown.has('people') && <PeoplePanel name={savedName} active={tab === 'people'} onOpenTab={showTab} focusGuestId={guestId} focusLinkId={linkId} />}
        </TabPanel>
        <TabPanel id={tabsId} tab="look" current={tab}>
          {shown.has('look') && (
            <AgentLookPanel
              look={look}
              onChange={setLook}
              name={name}
              onNameChange={(next) => {
                setName(next)
                setNameError(null)
              }}
              nameError={nameError}
              onSubmit={() => void save()}
            />
          )}
        </TabPanel>
      </div>
      {/* Only Look saves; the others save as they go, and the dialog's close is theirs. */}
      {tab === 'look' && (
        <DialogFooter className="shrink-0 gap-2 border-t px-6 py-3 sm:justify-between">
          <Button variant="ghost" disabled={sameAgentLook(look, DEFAULT_AGENT_LOOK)} onClick={() => setLook(DEFAULT_AGENT_LOOK)} data-look-reset="">
            Start over
          </Button>
          <div className="flex items-center gap-2">
            {/* In the footer's row, not over it: the dialog keeps its height. */}
            {error && <p className="text-sm text-destructive">Couldn’t save. Try again.</p>}
            <Button variant="outline" onClick={onDone}>
              Cancel
            </Button>
            <Button onClick={() => void save()} disabled={saving || (!nameChanged && !lookChanged)} data-look-save="">
              Save
            </Button>
          </div>
        </DialogFooter>
      )}
    </>
  )
}

/**
 * The Studio's icons: the app's own set (lucide), drawn as the app draws them (a 1.75 stroke, 16px in toolbars and
 * menus, 14px in dense rows, the colour of the text around them). One name per thing the Studio shows, so a button
 * names what it does (`<Icon name="undo"/>`) and the glyph for it is chosen here, once: the same lucide icon the
 * rest of the app uses for the same thing (the app's menus for more, close, undo, refresh, settings).
 *
 * Imported by name, so only these icons reach the bundle.
 */
import React from 'react';
import {
  AppWindow, ArrowLeft, CircleCheck, FolderDown, MonitorUp, TriangleAlert, ArrowLeftRight, ArrowRight, ChartGantt, ChartSpline, Check, ChevronDown, ChevronRight, CircleSmall,
  Component, Download, Eraser, Eye, File, FileText, Film, Folder, Frame, GalleryHorizontalEnd, Grid2x2Plus, Hand, History,
  House, Image, Keyboard, Layers, LayoutGrid, LayoutPanelLeft, Lock, Magnet, Mic, MousePointer2, Music, MoreHorizontal, PanelLeft, PanelRight,
  Pause, Pencil, Play, Plus, RefreshCw, Redo2, RotateCcw, Save, ScanEye, Scissors, ScrollText, Search, Settings2, Slash, Slice,
  Sparkles, Spline, StepBack, StepForward, Trash2, Type, Undo2, Users, Video, Volume2, WandSparkles, Webcam, X, ZoomIn,
  type LucideIcon,
} from 'lucide-react';

const ICONS = {
  // The app's chrome.
  plus: Plus, close: X, check: Check, more: MoreHorizontal, chevron: ChevronDown, chevronRight: ChevronRight,
  undo: Undo2, redo: Redo2, save: Save, trash: Trash2, refresh: RefreshCw, replay: RotateCcw, settings: Settings2,
  history: History, search: Search, lock: Lock, download: Download, export: Download,
  arrowLeft: ArrowLeft, arrowRight: ArrowRight, swap: ArrowLeftRight,
  // Where you are: the Studio's pages (its pages rail, AppRail.tsx).
  home: House, stack: Layers, grid: LayoutGrid, storyboard: GalleryHorizontalEnd, people: Users, timeline: ChartGantt,
  apps: Grid2x2Plus, browser: PanelLeft,
  // The inspector, the side panel on the right: the Browser's icon, mirrored.
  inspector: PanelRight,
  // Things in a video.
  folder: Folder, file: File, image: Image, clip: Film, type: Type, transcript: FileText, keyboard: Keyboard,
  audio: Volume2, sound: Music, background: Frame, cursor: MousePointer2, zoom: ZoomIn, motion: Spline,
  presenter: Webcam, agent: Sparkles, components: Component, layout: LayoutPanelLeft,
  // Recording.
  record: CircleSmall, screen: AppWindow, mic: Mic, camera: Video, prompter: ScrollText, share: MonitorUp,
  // How something ended, and where a file goes.
  done: CircleCheck, warning: TriangleAlert, saveTo: FolderDown,
  // Playback.
  play: Play, pause: Pause, previous: StepBack, next: StepForward,
  // Editing tools: the timeline's, and the automation lane's.
  select: MousePointer2, hand: Hand, blade: Slice, split: Scissors, snap: Magnet, automation: ChartSpline, transition: ArrowLeftRight,
  pencil: Pencil, line: Slash, eraser: Eraser, cleanup: WandSparkles,
  // The worker's checks.
  motionCheck: ScanEye, review: Eye,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** One of the Studio's icons. Decorative: the button or row it sits in carries the words (its text, or its label). */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  const Glyph = ICONS[name];
  // The record mark is a filled dot, the colour of its button (a state, red, as everywhere a recording is).
  return <Glyph size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" {...(name === 'record' ? { fill: 'currentColor' } : null)} />;
}

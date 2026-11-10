/**
 * @native-intelligence/ui — Native Intelligence presentational design-system kit.
 *
 * Re-exports the app's shadcn/ui primitives and clean marketing components
 * from <repo>/src/components/**, via the `@/` path alias. This barrel is the
 * package's public API and the surface design-sync imports into claude.ai/design.
 *
 * App-coupled components (capture/*, views/*, dialogs reaching @/app/account,
 * stores, tauri) intentionally stay in the app and are NOT exported here.
 */

/* ─── shadcn/ui primitives ─────────────────────────────────────────────── */
export * from '@/components/ui/accordion'
export * from '@/components/ui/alert-dialog'
export * from '@/components/ui/avatar'
export * from '@/components/ui/avatar-group'
export * from '@/components/ui/badge'
export * from '@/components/ui/button'
export * from '@/components/ui/calendar'
export * from '@/components/ui/card'
export * from '@/components/ui/carousel'
export * from '@/components/ui/checkbox'
export * from '@/components/ui/collapsible'
export * from '@/components/ui/command'
export * from '@/components/ui/confirm-dialog'
export * from '@/components/ui/context-menu'
export * from '@/components/ui/datetime-picker'
export * from '@/components/ui/dialog'
export * from '@/components/ui/dot-glyph'
export * from '@/components/ui/dropdown-menu'
export * from '@/components/ui/emoji-icon-picker'
export * from '@/components/ui/form'
export * from '@/components/ui/input'
export * from '@/components/ui/label'
export * from '@/components/ui/loader'
export * from '@/components/ui/popover'
export * from '@/components/ui/prompt-input'
export * from '@/components/ui/resizable'
export * from '@/components/ui/scroll-area'
export * from '@/components/ui/scroll-button'
export * from '@/components/ui/select'
export * from '@/components/ui/separator'
export * from '@/components/ui/sheet'
export * from '@/components/ui/sidebar'
export * from '@/components/ui/skeleton'
export * from '@/components/ui/switch'
export * from '@/components/ui/table'
export * from '@/components/ui/tabs'
export * from '@/components/ui/textarea'
export * from '@/components/ui/time-input'
export * from '@/components/ui/toggle'
export * from '@/components/ui/toggle-group'
export * from '@/components/ui/tooltip'

/*
 * Excluded from the design-system kit (AI chat-output renderers, not brand
 * primitives — they pull heavy deps that blow the 5MB upload limit and don't
 * preview meaningfully): code-block (shiki), markdown (remark stack), message,
 * reasoning, response-stream, chat-container. Still live in the app under
 * @/components/ui/*; re-add here if they ever need design-system cards.
 */

/* ─── Marketing / landing components ───────────────────────────────────── */
export * from '@/components/animated-number'
export * from '@/components/bento-card'
export * from '@/components/container'
export * from '@/components/feature-section'
export * from '@/components/gradient'
export * from '@/components/keyboard'
export * from '@/components/linked-avatars'
export * from '@/components/logo'
export * from '@/components/logo-cloud'
export * from '@/components/logo-cluster'
export * from '@/components/logo-timeline'
export * from '@/components/map'
export * from '@/components/plus-grid'
export * from '@/components/screenshot'
export * from '@/components/text'

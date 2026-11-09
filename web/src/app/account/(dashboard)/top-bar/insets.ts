/**
 * The top bar's own insets from the row it spans (it starts after the app
 * rail): where its first control on the left and its last on the right sit.
 * The side panels line up with them (side-panels.tsx, chat/for-you-column.tsx:
 * Liam, 11-09, For you's cards under its button, not off to the side).
 */
import { MACOS_TRAFFIC_LIGHT_WIDTH } from '@/lib/platform'

/**
 * The room the macOS traffic lights take at the bar's left: their width from
 * the window's edge, less the app rail's (rail/app-rail.tsx), which the bar
 * starts after and which the lights mostly sit over. 4px at least, the web's.
 */
export const TRAFFIC_LIGHT_GUTTER = `max(4px, calc(${MACOS_TRAFFIC_LIGHT_WIDTH}px - var(--app-rail-w, 0px)))`

/** The bar's left inset on the web (no traffic lights). */
export const TOP_BAR_LEFT_INSET_PX = 4

/** The bar's right inset (its trailing cluster's `pr-2`). */
export const TOP_BAR_RIGHT_INSET_PX = 8

/** Where the bar's first control on the left starts: past the traffic lights in the Mac app. */
export function topBarLeftInset(trafficLights: boolean): string | number {
  return trafficLights ? TRAFFIC_LIGHT_GUTTER : TOP_BAR_LEFT_INSET_PX
}

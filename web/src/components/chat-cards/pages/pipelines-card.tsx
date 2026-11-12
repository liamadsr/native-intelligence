'use client'

/**
 * The Deals page as a card (Tables, phase 7): the tables card on the
 * pipelines, opening on the default pipeline's board (./tables-card.tsx).
 */
import type { PageCardProps } from './page-card'
import { TablesPageCard } from './tables-card'

export default function PipelinesCard(props: PageCardProps) {
  return <TablesPageCard {...props} pipelines />
}

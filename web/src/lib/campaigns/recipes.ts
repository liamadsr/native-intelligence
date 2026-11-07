/**
 * The opt-in campaign recipes (roadmap D2), the campaign twin of the loop
 * recipes (src/lib/flows/recipes.ts): capabilities, not defaults. Nothing
 * here is seeded or switched on for anyone. The owner asks in their own words
 * (by text, "send a win-back to customers we haven't seen in 6+ months"); the
 * agent builds it with `create_campaign { recipe }`, which saves the campaign
 * and a DRAFT sequence with the recipe's copy, then asks to launch it
 * (`launch_campaign`, the owner's card). Nothing sends before that yes.
 *
 *   win_back   customers last in touch more than N months ago (6 by
 *              default), two short emails a week apart from the owner's own
 *              mailbox, and ROLLING: each week the customers who newly cross
 *              the line get a card of their own. Pausing the campaign stops
 *              it (update_campaign status paused).
 *
 * The copy is a starting point in plain words the agent tailors to the
 * business (what it knows from the site and the owner's mail) before it asks
 * to launch. Every merge field has a fallback, so no recipient blocks a launch.
 *
 * Pure: no I/O.
 */
import type { CampaignAudience } from './shape'

export const CAMPAIGN_RECIPES = ['win_back'] as const
export type CampaignRecipe = (typeof CAMPAIGN_RECIPES)[number]

export function isCampaignRecipe(value: unknown): value is CampaignRecipe {
  return typeof value === 'string' && (CAMPAIGN_RECIPES as readonly string[]).includes(value)
}

/** What a person can change about a recipe by asking. */
export interface CampaignRecipeOptions {
  /** win_back: months since the last touch (1-36, 6 by default). */
  months?: number
}

/** One email of the recipe's sequence, in create_sequence's step shape. */
export interface RecipeStep {
  step_order: number
  subject?: string
  body: string
  delay_days: number
}

export interface RecipeCampaign {
  recipe: CampaignRecipe
  name: string
  objective: string
  description: string
  audience: CampaignAudience
  rolling: boolean
  sequence: { name: string; description: string; steps: RecipeStep[] }
  /** What the agent tells the person in its one line. */
  note: string
}

const DAYS_PER_MONTH = 30

/**
 * A recipe's campaign, with the person's options over the defaults, or an
 * Error naming the field to fix. `business`: the workspace's name, signed
 * under the emails when the sender has no name of their own. Pure.
 */
export function recipeCampaign(recipe: CampaignRecipe, options: CampaignRecipeOptions = {}, business = 'us'): RecipeCampaign | Error {
  switch (recipe) {
    case 'win_back': {
      if (options.months !== undefined && (!Number.isInteger(options.months) || options.months < 1 || options.months > 36)) {
        return new Error('recipe_options.months must be a whole number of months from 1 to 36')
      }
      const months = options.months ?? 6
      const signoff = `{{sender_name|${business.replace(/[{}|]/g, '').trim() || 'us'}}}`
      return {
        recipe,
        name: 'Win-back',
        objective: `Bring back customers we haven't seen in ${months}+ months`,
        description: `Customers last in touch more than ${months} months ago get two short check-in emails a week apart, from your own mailbox. Each week, customers who newly pass ${months} months get a card of their own. A reply stops their emails.`,
        audience: { relationship_types: ['customer'], last_contacted_more_than_days: months * DAYS_PER_MONTH },
        rolling: true,
        sequence: {
          name: 'Win-back',
          description: `Check-in for customers we haven't seen in ${months}+ months.`,
          steps: [
            {
              step_order: 1,
              subject: 'Checking in, {{first_name|there}}',
              body: `Hi {{first_name|there}},\n\nIt's been a while since we last worked together, and I wanted to check in. If there's anything we can help with, just reply to this email and I'll get you on the schedule.\n\nThanks,\n${signoff}`,
              delay_days: 0,
            },
            {
              step_order: 2,
              body: `Hi {{first_name|there}}, just following up in case my last note got buried. Reply anytime and I'll take care of the rest.\n\n${signoff}`,
              delay_days: 7,
            },
          ],
        },
        note: `Customers quiet for ${months}+ months get two check-ins a week apart; new ones get a card each week. Nothing sends until you say yes.`,
      }
    }
  }
}

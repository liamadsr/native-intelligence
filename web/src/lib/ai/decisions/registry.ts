import { browserNext } from './tasks/browser-next'
import { browserCompletion } from './tasks/browser-completion'
import { emailReply } from './tasks/email-reply'
import { emailUnderstand } from './tasks/email-understand'
import { knowledgeAnchor } from './tasks/knowledge-anchor'
import { knowledgeRelationship } from './tasks/knowledge-relationship'
import { knowledgeExtraction } from './tasks/knowledge-extraction'
import { retrievalRelevance } from './tasks/retrieval-relevance'
import { automationReconcile } from './tasks/automation-reconcile'
import { helperChoice } from './tasks/helper-choice'
import { actionReview } from './tasks/action-review'
import { eventNeedsPerson } from './tasks/event-needs-person'
import { modelTier } from './tasks/model-tier'
import { nudgeWorth } from './tasks/nudge-worth'
import { actionDoneByEmail } from './tasks/action-done-by-email'
import { meetingNeedsPrep } from './tasks/meeting-needs-prep'

/** Feature policy lives here; only the runner may call the provider adapter. */
export const decisionTasks = {
  'browser.next_action': browserNext,
  'browser.completion': browserCompletion,
  'email.reply_required': emailReply,
  'email.understand': emailUnderstand,
  'knowledge.anchor': knowledgeAnchor,
  'knowledge.relationship': knowledgeRelationship,
  'knowledge.extraction_required': knowledgeExtraction,
  'retrieval.relevance': retrievalRelevance,
  'automation.reconcile_required': automationReconcile,
  'helper.choice': helperChoice,
  'action.review': actionReview,
  'event.needs_person': eventNeedsPerson,
  'model.tier': modelTier,
  'nudge.worth': nudgeWorth,
  'action.done_by_email': actionDoneByEmail,
  'meeting.needs_prep': meetingNeedsPrep,
} as const
export type DecisionKind = keyof typeof decisionTasks

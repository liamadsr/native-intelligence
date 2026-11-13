import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'
import {
  emailInitialImport,
  emailIncrementalSync,
  emailProcessWebhook,
  emailDraftReplies,
  emailUnderstandArrivals,
  emailHoldExpiry,
} from '@/lib/inngest/email-functions'
import { attachmentIndex } from '@/lib/inngest/attachment-embedding'
import {
  flowDispatchOnStatusChange,
  flowDispatchOnSchedule,
  flowDispatchOnCaptureProcessed,
  flowDispatchOnPrStatusChange,
  flowDispatchOnQuoteReceived,
  flowDispatchOnEmailReceived,
  flowDispatchOnChatMessage,
  flowDispatchOnDocumentCreated,
  flowResumeOnStepSettled,
} from '@/lib/inngest/flow-functions'
import { captureIngest } from '@/lib/inngest/capture-ingest'
import { vocabularyHarvestPersonal, vocabularyHarvestWorkspace } from '@/lib/inngest/vocabulary-harvest'
import { agentLogCaptureProcessed } from '@/lib/inngest/agent-log-capture'
import { keptUpToDateOnCaptureProcessed } from '@/lib/inngest/kept-up-to-date'
import { agentEventCaptureProcessed, agentEventDigest, agentEventMeetingSoon, agentEventRoute } from '@/lib/inngest/agent-events'
import { emailAutoArchive } from '@/lib/inngest/email-auto-archive'
import { lookAheadRun, lookAheadTravel } from '@/lib/inngest/look-ahead'
import { captureReindex } from '@/lib/inngest/capture-reindex'
import { abandonedCaptureSweep, finalizeAbandonedCapture } from '@/lib/inngest/capture-finalizer'
import { claimExtraction } from '@/lib/inngest/claim-extraction'
import { conversationIngest } from '@/lib/inngest/conversation-ingest'
import { chatIdleCompaction } from '@/lib/inngest/chat-idle-compaction'
import { homeTurn } from '@/lib/inngest/home-turn'
import { approvalTurn } from '@/lib/inngest/approval-turn'
import { slackTurn } from '@/lib/inngest/slack-turn'
import { teamChatTurn } from '@/lib/inngest/team-chat-turn'
import { teamChatLinkPreview } from '@/lib/inngest/team-chat-link-preview'
import { teamChatEmail, teamChatNotify } from '@/lib/inngest/team-chat-reach'
import { meetingLinksPrune, teamCallMissed, teamCallRingTimer, teamCallsEject, teamCallsSweep } from '@/lib/inngest/team-calls'
import { teamCallNotesFile, teamCallNotesFinish, teamCallNotesRetention, teamCallNotesStop } from '@/lib/inngest/team-call-notes'
import { textTurn } from '@/lib/inngest/text-turn'
import { agentNumbersBalance, agentNumbersDaily } from '@/lib/inngest/agent-numbers'
import { agentLinkTurn } from '@/lib/inngest/agent-link-turn'
import { reachRoute } from '@/lib/inngest/reach-route'
import { homeAsks } from '@/lib/inngest/home-asks'
import { knowledgeWeaver } from '@/lib/inngest/knowledge-weaver'
import { referenceIngest } from '@/lib/inngest/reference-ingest'
import { agentRunExecute, agentRunCancel, agentRunReaper } from '@/lib/inngest/agent-run-functions'
import { workRunChildSettled, workRunExecute, workRunResume } from '@/lib/inngest/work-run-functions'
import { agentMemorySummarize } from '@/lib/inngest/agent-memory-functions'
import { memoryCapture } from '@/lib/inngest/memory-capture-functions'
import { workspaceAutonomyOff } from '@/lib/inngest/workspace-autonomy-functions'
import { usageLogRetry } from '@/lib/inngest/billing-functions'
import { chatUsageOutboxSweep } from '@/lib/inngest/chat-usage-outbox'
import { mcpTokenKeepalive } from '@/lib/inngest/mcp-token-keepalive'
import { evalFlywheelSweep } from '@/lib/inngest/eval-flywheel'
import {
  hubspotInitialImport,
  hubspotIncrementalSync,
} from '@/lib/inngest/hubspot-functions'
import {
  crmEnrichContactManual,
  crmEnrichCompanyManual,
} from '@/lib/inngest/crm-enrichment'
import { hubspotLogCapture } from '@/lib/inngest/hubspot-log-capture'
import { hubspotPushContact } from '@/lib/inngest/hubspot-push-contact'
import { hubspotPushSweep } from '@/lib/inngest/hubspot-push-sweep'
import { contactImportApply, contactImportBrevo, contactImportGoogle, contactImportStripe, contactImportUndo } from '@/lib/inngest/contact-import-functions'
import { websiteChangeMerged, websitePrOpened } from '@/lib/inngest/website-functions'
import { seoAiVisibilityRun } from '@/lib/inngest/seo-ai-visibility-functions'
import { seoAuditRun } from '@/lib/inngest/seo-audit-functions'
import { seoLocalScanRun } from '@/lib/inngest/seo-local-functions'
import { seoRankCheckRun } from '@/lib/inngest/seo-rank-functions'
import { sequenceStepSend } from '@/lib/inngest/sequence-functions'
import { campaignRollingPass, reviewRequestOnJob } from '@/lib/inngest/outreach-functions'
import { dailyJobsPass, dailyJobsSend } from '@/lib/inngest/daily-jobs'
import { customerRemindersPass, customerRemindersSend } from '@/lib/inngest/customer-reminders'
import { timeOffersSweep } from '@/lib/inngest/time-offers'
import { prospectingRunExecute } from '@/lib/inngest/prospecting-functions'
import { evalRunExecute } from '@/lib/inngest/eval-functions'
import { asanaEchoStatus } from '@/lib/inngest/asana-echo-status'
import { actionDoneSettlesReview } from '@/lib/inngest/action-done-review'
import { paymentPaidFollowups } from '@/lib/payments/paid'
import { asanaApplyRemote } from '@/lib/inngest/asana-apply-remote'
import { asanaEnsureWebhook } from '@/lib/inngest/asana-ensure-webhook'
import { asanaReconcile } from '@/lib/inngest/asana-reconcile'
import { jiraEchoStatus } from '@/lib/inngest/jira-echo-status'
import { jiraApplyRemote } from '@/lib/inngest/jira-apply-remote'
import { jiraEnsureWebhook } from '@/lib/inngest/jira-ensure-webhook'
import { jiraReconcile } from '@/lib/inngest/jira-reconcile'
import { linearEchoStatus } from '@/lib/inngest/linear-echo-status'
import { linearApplyRemote } from '@/lib/inngest/linear-apply-remote'
import { linearReconcile } from '@/lib/inngest/linear-reconcile'
// NOTE: there is deliberately no `linearEnsureWebhook`. Linear's webhooks are
// app-level (one URL + one signing secret in the OAuth app console,
// auto-provisioned per authorizing organization), so unlike Asana and Jira there
// is no per-account registration to converge or keep alive.

// Inngest steps can be long-running (email fetch, webhook setup, backfill,
// attachment embedding with large PDFs). Extended duration for this route.
// 600s: a flow dispatch runs a verdict skill (the triage sweep) on a 480s wall
// inside one step, plus the tail reserve (run-skill.ts INNGEST_FUNCTION_BUDGET_MS,
// pinned to this value). It is a ceiling: every step still ends when its work does.
export const maxDuration = 600

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    emailInitialImport,
    emailIncrementalSync,
    emailProcessWebhook,
    emailDraftReplies,
    emailUnderstandArrivals,
    emailHoldExpiry,
    attachmentIndex,
    flowDispatchOnStatusChange,
    flowDispatchOnSchedule,
    flowDispatchOnCaptureProcessed,
    flowDispatchOnPrStatusChange,
    flowDispatchOnQuoteReceived,
    flowDispatchOnEmailReceived,
    flowDispatchOnChatMessage,
    flowDispatchOnDocumentCreated,
    flowResumeOnStepSettled,
    captureIngest,
    vocabularyHarvestWorkspace,
    vocabularyHarvestPersonal,
    agentLogCaptureProcessed,
    keptUpToDateOnCaptureProcessed,
    agentEventCaptureProcessed,
    agentEventMeetingSoon,
    agentEventRoute,
    agentEventDigest,
    emailAutoArchive,
    lookAheadRun,
    lookAheadTravel,
    captureReindex,
    abandonedCaptureSweep,
    finalizeAbandonedCapture,
    claimExtraction,
    conversationIngest,
    chatIdleCompaction,
    homeTurn,
    approvalTurn,
    slackTurn,
    teamChatTurn,
    teamChatLinkPreview,
    teamChatNotify,
    teamChatEmail,
    teamCallRingTimer,
    teamCallsSweep,
    teamCallMissed,
    teamCallsEject,
    meetingLinksPrune,
    teamCallNotesFile,
    teamCallNotesFinish,
    teamCallNotesStop,
    teamCallNotesRetention,
    textTurn,
    agentNumbersBalance,
    agentNumbersDaily,
    agentLinkTurn,
    reachRoute,
    homeAsks,
    knowledgeWeaver,
    referenceIngest,
    agentRunExecute,
    agentRunCancel,
    agentRunReaper,
    workRunExecute,
    workRunResume,
    workRunChildSettled,
    agentMemorySummarize,
    memoryCapture,
    workspaceAutonomyOff,
    usageLogRetry,
    chatUsageOutboxSweep,
    mcpTokenKeepalive,
    evalFlywheelSweep,
    hubspotInitialImport,
    hubspotIncrementalSync,
    // Bringing existing customers in (roadmap track G): one importer for every source.
    contactImportApply,
    websitePrOpened,
    websiteChangeMerged,
    // The SEO area's site audit: a polite crawl of one website, a chunk per step.
    seoAuditRun,
    // The SEO area's AI visibility checks: paid posts and live answers made once, queued answers read for free on a backoff, late ones filled in.
    seoAiVisibilityRun,
    // Local SEO: one scan of a rank grid (Google Maps positions around a business), a paid post per keyword then free reads.
    seoLocalScanRun,
    // The SEO area's rank checks: paid searches posted once, read back for free on a sleep-and-collect cadence.
    seoRankCheckRun,
    contactImportUndo,
    contactImportGoogle,
    contactImportBrevo,
    contactImportStripe,
    crmEnrichContactManual,
    crmEnrichCompanyManual,
    hubspotLogCapture,
    hubspotPushContact,
    hubspotPushSweep,
    sequenceStepSend,
    // Outreach (roadmap D2/D3): a rolling campaign's weekly card, a finished job's review request.
    campaignRollingPass,
    reviewRequestOnJob,
    // The owner's daily list of jobs (roadmap F3): 7 o'clock local, confirmed bookings only.
    dailyJobsPass,
    dailyJobsSend,
    customerRemindersPass,
    customerRemindersSend,
    // Time offers (availability phase 3a): lapsed offers let their held times go; a booking left half-written is finished or failed.
    timeOffersSweep,
    prospectingRunExecute,
    evalRunExecute,
    asanaEchoStatus,
    actionDoneSettlesReview,
    paymentPaidFollowups,
    asanaApplyRemote,
    asanaEnsureWebhook,
    asanaReconcile,
    jiraEchoStatus,
    jiraApplyRemote,
    jiraEnsureWebhook,
    jiraReconcile,
    linearEchoStatus,
    linearApplyRemote,
    linearReconcile,
  ],
})

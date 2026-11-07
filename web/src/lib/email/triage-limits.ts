/**
 * The inbox triage's limits (GEN-1166), shared by update_email_thread
 * (src/lib/ai/tools/email.ts) and the chat's same-turn guard
 * (src/lib/chat/flow-go-ahead-guard.ts), which adds up a turn's calls.
 */

/**
 * More threads than this changed in one turn wait for the person to say yes in
 * the chat first ("bulk changes over ~10 threads need a confirmation in chat").
 */
export const BULK_THREAD_CONFIRM_OVER = 10
/** Threads one update_email_thread call takes at most. */
export const MAX_THREADS_PER_UPDATE = 100

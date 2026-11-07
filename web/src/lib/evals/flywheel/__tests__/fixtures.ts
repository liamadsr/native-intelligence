/** Stored chat message fixtures shared by the flywheel tests. */

/** An assistant UIMessage as eve-turn-parts.ts stores it: a skill load, an INPUT_INVALID refusal, a REPEATED_FAILURE break, a mail tool, text. */
export const assistantMessage = (id = 'msg-a1') => ({
  id,
  role: 'assistant',
  metadata: { eve_written: true },
  parts: [
    { type: 'reasoning', text: 'The person wants ENG-1 done.' },
    {
      type: 'dynamic-tool',
      toolName: 'load_skill',
      toolCallId: 'call-1',
      state: 'output-available',
      input: { skill: 'Triage' },
      output: { skill: 'triage', instructions: '# Triage\n…', note: 'Follow this playbook for the current task.' },
    },
    {
      type: 'dynamic-tool',
      toolName: 'list_actions',
      toolCallId: 'call-2',
      state: 'output-error',
      input: { status: 'finished' },
      errorText: "list_actions: input failed tool schema validation [INPUT_INVALID] — status: Invalid option: expected one of 'todo'|'done'",
    },
    {
      type: 'dynamic-tool',
      toolName: 'update_action',
      toolCallId: 'call-3',
      state: 'output-available',
      input: { id: 'ENG-1', status_name: 'Done' },
      output: { success: false, code: 'REPEATED_FAILURE', error: 'This exact call failed 3 times. Stop retrying it.' },
    },
    {
      type: 'dynamic-tool',
      toolName: 'create_email_draft',
      toolCallId: 'call-4',
      state: 'output-available',
      input: { to: ['dana@acme.co'], subject: 'Pricing for Acme', body: 'Hi Dana, here is the pricing…', thread_id: 'thr-1' },
      output: { success: true, draft_id: 'd-1' },
    },
    { type: 'text', text: 'I could not move ENG-1 to Done.' },
    { type: 'text', text: 'Want me to try another way?' },
  ],
})

export const userMessage = (text: string, id = 'msg-u1') => ({ id, role: 'user', parts: [{ type: 'text', text }] })

/** A live agent's say_to_user nudge row as the conversation writer stores it (lib/live-agent/tools.ts). */
export const nudgeMessage = (id: string, text: string, nudgeKind = 'reminder', captureId = 'd1000000-0000-4000-8000-000000000001') => ({
  id,
  role: 'assistant',
  metadata: { live_capture: true, capture_id: captureId, kind: 'say_to_user', nudge_kind: nudgeKind },
  parts: [{ type: 'text', text }],
})

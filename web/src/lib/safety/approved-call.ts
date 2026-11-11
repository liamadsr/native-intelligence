/**
 * The approval a tool call is being replayed under (src/lib/safety/approvals.ts
 * executeStoredCall). Set ONLY by executeStoredCall, after the person's own
 * Accept on the card passed every re-check (membership, the kill switch, the
 * input hash, the ceiling); never by a tool route, never from anything a
 * model sends. A tool that raises its own verified card (the flow tools' F1
 * switch-on, delete and ownership cards, src/lib/flows/flow-approvals.ts)
 * reads it to know it is running the stored call the person accepted.
 *
 * Plain data, no imports: createTools' options carry it without pulling the
 * approvals module (and its createTools import) into every tool family.
 */

/** What a flow card records, so the replay can check the loop is still what the card showed. */
export interface FlowApprovalContext {
  /** transfer: the owner (or an admin) hands it over; takeover: a member asks the owner for it. */
  kind: 'enable' | 'delete' | 'transfer' | 'takeover'
  flow_id: string
  /** flowDefinitionHash at card time (trigger, steps, owner, the skills' tool configs). */
  definition_hash: string
  /** Who asked (transfer: re-checked at accept time). */
  requested_by?: string
  /** transfer: the user the card is for, who becomes the owner. */
  new_owner?: string
}

/**
 * What a connection card records (flows-connectors F2: disconnect, and a
 * set_tool_access that loosens), so the replay runs only on the connection
 * the card showed, as it was then.
 */
export interface ConnectionApprovalContext {
  kind: 'disconnect' | 'tool_access'
  connection_id: string
  /** connectionStateHash at card time (tool_access: the server's lists and tools). */
  state_hash: string
}

/**
 * What an unsubscribe card showed (GEN-1166, src/lib/safety/outward-gate.ts):
 * the way the list offered to unsubscribe when the card was made, as
 * unsubscribeMethodKey writes it. The replay refuses when the list now offers
 * another (a newer message with another link or address).
 */
export interface UnsubscribeApprovalContext {
  method: 'one_click' | 'mailto' | 'link'
  key: string
}

/**
 * What a quote reply card showed (roadmap F3: send_quote, book_quote,
 * src/lib/safety/outward-gate.ts): which quote, and the hash of the card's
 * own words (who gets what text, when). The replay builds the card again
 * from the rows as they are then, and sends nothing when its words differ.
 */
export interface QuoteReplyApprovalContext {
  kind: 'send' | 'book'
  quote_id: string
  card_hash: string
}

/**
 * What a time offer's card showed (availability phase 3a: offer_times by
 * email or text, src/lib/time-offers/send.ts): the offer made for the card
 * (its times held while the card waits) and the hash of the card's words
 * (who gets what, from where). The replay builds the card again from that
 * offer as it is then, and sends nothing when its words differ.
 */
export interface TimeOfferApprovalContext {
  offer_id: string
  card_hash: string
}

/**
 * What an agent card records (GEN-1168: delete_bot, merge_bots), so the replay
 * runs only on the agents the card showed, as they were then.
 */
export interface BotApprovalContext {
  kind: 'delete' | 'merge'
  /** Every agent the card names (the kept ones too), sorted. */
  bot_ids: string[]
  /** botStateHash at card time (src/lib/bots/manage-bots.ts): names, kinds, teams, personas and the loops they front. */
  state_hash: string
}

/**
 * What a document delete card records (GEN-1169, delete_document), so the
 * replay deletes only the document the card showed, as it was then: a
 * document edited after its card was made is not deleted.
 */
export interface DocumentApprovalContext {
  kind: 'delete'
  document_id: string
  /** document.revision at card time (migration 364: every text change bumps it). */
  revision: number
}

/**
 * What an outreach launch card records (roadmap D1/D2: launch_sequence,
 * launch_campaign), so the replay sends only what the card showed: the
 * sequence's copy and schedule as they were (content_hash, a change refuses)
 * and only to the people the card named (recipient_ids: enrollment ids for a
 * sequence, contact ids for a campaign). Set by the server, never by a model.
 */
export interface OutreachApprovalContext {
  kind: 'sequence' | 'campaign'
  /** The sequence (kind sequence) or campaign (kind campaign) the card is for. */
  id: string
  /** outreachContentHash at card time (src/lib/sequences/launch.ts). */
  content_hash: string
  /** Who the card named; the replay reaches no one else. */
  recipient_ids: string[]
  /**
   * A campaign card: each named contact's address as the card showed it
   * (lowercased, same order as recipient_ids). A contact whose address
   * changed since is not sent to: the person approved that address.
   */
  recipient_emails?: string[]
}

export interface ApprovedCall {
  approvalId: string
  /** The registry tool name being replayed. */
  tool: string
  /** An outreach launch card's context (launch_sequence, launch_campaign), when the approval is one. */
  outreach?: OutreachApprovalContext
  /** The flow card's context, when the approval is one. */
  flow?: FlowApprovalContext
  /** A connection card's context, when the approval is one. */
  connection?: ConnectionApprovalContext
  /** An agent card's context (delete_bot, merge_bots), when the approval is one. */
  bots?: BotApprovalContext
  /** A document delete card's context, when the approval is one. */
  document?: DocumentApprovalContext
  /**
   * P9: the approval was a post card's own Typefully click (settle-card.ts),
   * whose account was resolved and shown on the card at delivery. Only then
   * does publish_post / schedule_post honour the input's account_id.
   */
  postCard?: true
  /**
   * The cloud browser's card (docs/plans/cloud-browser.md, C2): the step the
   * person approved. The replayed run_browser_task carries it as its grant, and
   * the relay lets through only that origin, target and context.
   */
  browser?: { origin: string; target: string; context_hash: string }
  /** An unsubscribe card's own check: the way to unsubscribe it showed. */
  unsubscribe?: UnsubscribeApprovalContext
  /** A quote reply card's own check (send_quote, book_quote): the words it showed. */
  quoteReply?: QuoteReplyApprovalContext
  /** A time offer card's own check (offer_times by email or text): its offer and the words it showed. */
  timeOffer?: TimeOfferApprovalContext
}

/**
 * A flow STEP held for the person (F4, src/lib/flows/call-tool.ts, door
 * 'flow_step'): which loop, which step, which run, and the exact connection
 * and tool. The accept re-check refuses when the step no longer calls that
 * tool there, and the resume carries the run on from the step.
 */
export interface FlowStepApprovalContext {
  flow_id: string
  action_id: string
  flow_run_id: string
  /** The owner's connected_mcp_server id the call runs on. */
  connection: string
  /** The server's own tool name. */
  tool: string
  /** Which rule asked (mcp-client/input-policy.ts). */
  rule: 'public_content' | 'destructive' | 'explicit' | 'outside_egress' | 'typefully_draft' | 'connector' | 'tool_level'
  /** True when the call publishes or reaches people. */
  public_content: boolean
  /**
   * The run was a person's Test (the fire route), often of a loop still off:
   * its card is answered whether or not the loop is on (F4 review R1). The
   * owner, step and connection checks still hold.
   */
  manual?: true
  /** Who fired the Test. */
  fired_by?: string
}

/**
 * A loop's skill run raised this (native) card on a flow step (F4 review N1):
 * the accept checks the loop is still on, unless the run was a person's Test.
 */
export interface LoopStepApprovalContext {
  flow_id: string
  action_id: string
  manual?: true
}

/**
 * A connected app's write a loop's SKILL run staged (F4, the skill-run door):
 * the connection it runs on and the connections its step was given. The
 * accept re-check refuses when that connection is no longer one of them, or
 * no longer the person's.
 */
export interface SkillRunMcpContext {
  connection: string
  tool: string
  /** The connections the step had when the write was staged (for the record; the re-check reads the step's current ones). */
  connections: string[]
  /** The loop and its run_skill step: the accept re-reads that step's CURRENT connections and the loop's on/off. */
  flow_id: string
  action_id: string
  /** A person's Test (R1): answered whether or not the loop is on. */
  manual?: true
}

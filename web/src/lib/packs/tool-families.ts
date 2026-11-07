/**
 * Packs for the main agent's own tools that belong to no area
 * (NO_AREA_TOOL_NAMES in registry.ts): its agents, its helpers, the local
 * agents and coding runs, and other people's agents. Running the show is no
 * area of Dial8, but its know-how is as long as an area's, and it used to sit
 * in the chat-agent's always-on instructions, re-sent on every model call.
 *
 * A tool family is a pack the chat spec carries beside the area packs
 * (chat-packs.ts rebuildChatPacks) and the chat-agent loads the same way
 * (agents/chat-agent/lib/expertise.ts): with the `search_tools` result that
 * reveals one of its tools, or the first call of one, once per conversation
 * (once per summary). Unlike a tool's description (src/lib/ai/tool-guides.ts,
 * capped at OpenAI's 1024 characters), a pack has no length limit.
 *
 * Code only: a family has no playbook, skills or memory, and its key is no
 * AreaKey, so nothing in the database, the skill editor or memory names it.
 * The main chat alone holds these tools, so background runs never read them.
 */
import type { ChatPack } from './chat-packs'

export const TOOL_FAMILY_KEYS = ['agents', 'helpers', 'local_agents', 'agent_links'] as const
export type ToolFamilyKey = (typeof TOOL_FAMILY_KEYS)[number]

export interface ToolFamily {
  key: ToolFamilyKey
  /** The pack's heading, as the agent reads it. */
  name: string
  /** Its tools: a search revealing one, or the first call of one, loads the pack. */
  toolNames: readonly string[]
  /** What the agent needs to use them well. */
  guide: string
}

export const TOOL_FAMILIES: readonly ToolFamily[] = [
  {
    key: 'agents',
    name: 'Your agents',
    toolNames: ['list_bot_work', 'get_bot_item', 'settle_card', 'settle_work_item', 'send_work_answer', 'send_bot_message', 'wait_for_bot_reply', 'rename_bot', 'delete_bot', 'merge_bots'],
    guide: [
      '- The agent `list_bot_work` marks `self` is you: what it holds is your own work, so speak of it in the first person ("I drafted a reply to Dana", "I have three cards for you from the Acme call"). Captures (Triage, Extraction and the Reconciler), Mail, Prospecting, Evals and CRM are areas of your work, not separate agents, each item carrying its `area`; name every other agent (custom agents, role teammates, loops) as itself. Work no other agent holds (your area work, work with no area, older work with no teammate, a deleted agent\'s work, cards nothing raised) is yours: it waits under you in For you and on your page, and `list_bot_work` lists it under you (`self`). Sequence sends are the one thing with no agent (`without_bot`): they live on the Sequences card (`show` kind `sequences`).',
      '- What\'s pending: go agent by agent, new before seen, with the counts it gives (the numbers the app shows); then what waits with no agent (`without_bot`, by lane; rarely `unowned_cards`, each readable by its id), and last `asks_in_chat` (approvals, suggestions and questions waiting as cards in the chat: say how many and point to them there). The id of an agent whose page they have open is its `bot_id`.',
      '- Busy agents are in `bots`, the rest in `idle_bots` (capped; `more_idle_bots` counts the rest). Each has its `state` (working, asleep or awake), `asleep_because` and `about`, so it answers "which agents do I have?", "is Writer asleep, and why?" and "what does Research do?". For one agent, pass its `bot_id`, or `name` to find it by name (past the caps too). Never say they have no agent by a name until `name` finds none. No `state` (`states_unread`): say you can\'t tell, never guess. `asleep_because` on a working agent means it sleeps once what it runs finishes.',
      '- Say why an agent sleeps in those words; you can\'t wake it from here. "Switched off": what it may do on its own is set by a workspace owner or admin (Settings → Autonomy). "Attempts paused": its last tries were all dismissed; an owner or admin of its workspace resumes it on its page (About → Resume). Anyone else asks one of them. "Stopped by the AI limit": their plan\'s AI usage limit was reached; it wakes once their plan allows more, not from its page.',
      '- A card they replied to (their message ends `[Replying to my card …]` or `[Replying to my work item …]`, with a `Replying to a card` section) is the item they mean, in that message and the ones after: read it by that id with `get_bot_item`, never ask which. One they only describe ("the Dana card", "that draft on the left"): find it with `list_bot_work` before you ask.',
      '- Read an item in full only with `get_bot_item`, and act only when they ask, one tool per item by the id `list_bot_work` or `get_bot_item` gave: a card (type `card`, or one of a run\'s cards by its `card_id`) → `settle_card` to accept, dismiss or start it; a draft to change ("make it shorter") → `revise_email_draft` by one of the review\'s `draft_ids` (it never sends); a review → `settle_work_item` (dismissing a Mail draft item, `draft:…`, discards that draft, with its `reason`; several take `discard_email_draft`); a question → `send_work_answer`, in their words. `settle_card` and `revise_email_draft` work in this chat\'s workspace only: for another workspace\'s item, say so and point them to the agent\'s page. A bulk action they didn\'t spell out item by item ("dismiss everything from Captures", "mark them all reviewed"): name the items and wait for their yes.',
      '- To tell or ask another agent something ("make Writer\'s draft more formal", "tell Writer to sign off as Liam from now on"): `send_bot_message` with their words, with an item\'s id (into the chat of the run that made it, or the agent\'s own chat about it) or the agent\'s `bot_id` (its own chat with them, marked as from you). The run, or the agent, acts there with its own tools, within its own limits (never yours), and replies to you; for their own run (`bot` null) it is their run\'s chat. Refused (no way to reach the agent as them right now, no chat to reach, a busy run): say so and offer to open the agent\'s chat. A run of yours with a chat still takes it, by the item\'s id.',
      '- The person can also talk to an agent on its page, with its chat on the left. It opens from that agent\'s work in For you, a work item or one of its notices. That chat is the agent\'s own, within its own limits, and it doesn\'t see this chat.',
      '- An agent\'s notices show as toasts, and live under Notices on its page; its delivered work waits in For you and on its page; its questions and approvals ask in the chat.',
      '- Where things live: an agent\'s page has its chat on the left and For you (what waits on them, new then seen), Working on, Done lately, About, Conversations and Notices (with Mark all read) on the right; an item opens there beside its run\'s chat. The Library\'s Agents & skills lists their agents (they make or change one there); what\'s running shows in the side panel\'s Agents row. An automatic drafting pass finishes as done work: its drafts wait in Mail\'s Drafts, and each still waiting is your item (`draft:…`, area mail).',
      '- From here you can rename an agent, delete one, or merge duplicates, only when they ask. For anything else, send them to its page → About → Customize (or its row in the Agents & skills card), the one editor: name, voice (desktop app only), instructions, tools, up to 5 skills it always checks, and what it may change on its own: "Read only" or "Read, and change Dial8 records" (never sending or publishing), which only workspace owners and admins choose. Instructions, tools and skills can be shared by several teammates: changing them changes every teammate that shares them, unless they make a copy for this one first. A loop\'s agent, and a member\'s own agent, stay read and propose; a built-in teammate speaks from its job.',
    ].join('\n'),
  },
  {
    key: 'helpers',
    name: 'Background helpers',
    toolNames: ['start_helper', 'stop_helper'],
    guide: [
      '- A general helper is the default. When the person asks one of their custom agents to do it ("have my SDR agent research these leads"), pass its `agent_id` (its `bot_id` from `list_bot_work`): it works as itself, within its own limits.',
      '- Choose its `model` from "Models for helpers": the cheapest that does it well. Drafting is usually `haiku`, research `flash-thinking`, code or synthesis across many sources `sonnet`. A premium pick past their daily cap, or on an unpaid plan, runs on `flash-thinking`; the result says which model it got.',
      '- Helpers read and draft (documents, email drafts). They never send, publish, delete or move things on the board, and never get tools this chat lacks. At most three run at once per conversation.',
      '- Manage them like a to-do list: `list_bot_work` shows what each is working on and its plan; `stop_helper` stops one when the person asks. To change one\'s direction while it works ("tell the researcher to stick to fintech"), pass the person\'s words with `send_bot_message` and its `work_item_id`: it adjusts at its next step.',
      '- A step of its plan (or yours) becomes an action on the board only when it needs a person to decide or do something, is a commitment for later ("follow up with Acme on Thursday", with a due date), spans days or another owner picks it up, or the person asks ("make that a task"). Work nobody is watching files such a step as a suggested action for the person to confirm, never as a confirmed one.',
    ].join('\n'),
  },
  {
    key: 'local_agents',
    name: 'Local agents and coding runs',
    toolNames: ['local_agents', 'start_local_agent', 'message_local_agent', 'read_local_agent', 'stop_local_agent', 'start_cloud_coding_run'],
    guide: [
      '- A local agent is you on their Mac in one of the folders they added (the + menu\'s Select folder…, or Add folder… in the side panel\'s Environment card, in the Dial8 desktop app), with your Dial8 tools plus hands there: its files, the shell, edits on a branch. The person meets it as "Dial8 on <their Mac\'s name>", with its own thread; it reports to you, and you start it, keep it on track and tell them what it found. `local_agents` lists all their Macs (online or not), every folder, and this chat\'s local agents with their status and last signal.',
      '- An edit runs on a new git branch in a separate copy on their Mac; their files and current branch stay as they are, and the branch name comes back when it finishes. It is pushed, with a pull request, only when the person says yes on their Mac; its link then shows in its thread and as `pull_request` in `local_agents` and `read_local_agent`. A read-only folder is made editable only on their Mac (they pick it again and allow changes).',
      '- One agent per folder; several can run at once, one per folder: you orchestrate them. A follow-up on the same task goes to the running one with `message_local_agent`. A start in a folder whose agent works for this chat goes to it as its next turn (`joined`); one another chat\'s agent holds, or a read-only one working when you asked for edits, is refused (`FOLDER_BUSY`, naming it): tell the person, and stop that one only if they want this instead.',
      '- It returns at once: say it\'s working on their Mac and reports back here; never claim it finished, and never start another copy to check. A refusal or an error is final for that request unless they ask again. An offline Mac holds the request up to 6 hours. When the answer carries a `cloud_fallback` (the folder is linked to a project repository), ask whether to run it in the cloud instead, naming the environment and its network level as its note says, and start it only if they agree.',
      '- Keep them updated without flooding them: when it reports, asks or finishes, say what it found or needs in a line or two. `read_local_agent` shows its transcript, compact (messages from you and the person, its replies, tool calls, reports, its question, its finish summary, an edit\'s branch and pull request): never paste it.',
      '- The person can open any local agent from Agents (top right) to watch it work and type to it directly; you see what they type in its transcript, marked from the person. Never tell them they can\'t watch it or write to it themselves.',
      '- A coding run in the cloud (`start_cloud_coding_run`, or an action Started on an agent with a repo): before any code a pre-check reads the action, and when building it could go two ways it asks the person in the chat and waits (a skip goes ahead with sensible defaults). A reviewer on another model checks the real diff against the acceptance criteria and can send the coder back twice; a change it still won\'t approve opens no PR (the run says why). A run nobody started by hand only ever opens a draft. Red CI on a PR a run opened gets up to two fix runs only when its owner has the `ci_fix_loop` on. Say these plainly when someone asks why a run stopped or is waiting.',
    ].join('\n'),
  },
  {
    key: 'agent_links',
    name: "Other people's agents",
    toolNames: ['ask_agent'],
    guide: [
      '- Reach for `ask_agent` whenever what the person asked for needs another person\'s answer: a time to meet ("move my 3pm with Sarah"), the status of work they share, a file or a decision the other person holds. Ask their agent instead of telling the person to chase it, or drafting an email for something an agent can answer.',
      '- Write as the person\'s agent, in a few plain sentences, and only what the other side needs: never their mail, private notes, other people\'s details, or anything they told you in confidence.',
      '- Where its approval card shows: right under your message in a chat, after your reply when they wrote by text (a code to reply with) or on Slack (Approve and Decline buttons), or in their home thread (with a ping on Slack or by text) from a background update.',
      '- When it answers, say what came back and whose agent said it, and set up the next step for their yes: the calendar invite for the time it offered, which waits as their card ("Sarah\'s agent says Thursday at 10 works. The invite is ready for your OK.").',
      '- Hand off action items too: when a call leaves one that belongs to someone the person has linked agents with, add `hand_off` (a short title, and a due date if one was agreed). Once the person approves, it lands on the other person\'s board as a suggestion for them to confirm. If their agent doesn\'t take tasks, the result says so: send the message without it.',
      '- Propose a message whenever the work needs one, in a chat or a background update: the person\'s card decides whether it goes.',
    ].join('\n'),
  },
]

/** A family's pack, as the chat spec carries it beside the area packs. */
export function toolFamilyPack(family: ToolFamily): ChatPack {
  return {
    area: family.key,
    name: family.name,
    playbookSkill: null,
    toolNames: [...family.toolNames],
    cardKinds: [],
    markdown: `# ${family.name}\n\n${family.guide}`,
  }
}


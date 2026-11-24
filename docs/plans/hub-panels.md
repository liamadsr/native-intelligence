# Hubs: Home and Inbox open just the one item

Branch `claude/hub-panels`. No migration. Merged is not live: see "How production works" in
`CLAUDE.md`.

## What the owner said (2026-11-23)

> "I noticed an issue where the inbox page doesn't have a sub-menu panel and if you click on any
> of the notifications like for mail or something then it loads that page without its side panel.
> I also noticed that from the home page if I click on a chat history it loads the panel but also
> navigates me to the team chat and I see the team chat sub-nav. The homepage is supposed to be an
> easy access place nothing from the home page should open the full page that's so I can flip
> through the recent things I've looked at"

Asked how Inbox should work, they picked **"Like Home"**: Inbox gets a panel holding its list and
its filter (All / Messages / Mentions & assignments / Mail / Held); clicking a notification opens
just that item beside the list; the panel stays and J/K flips; nothing opens the full Mail or Team
chat page.

```
[rail] | Inbox panel            | opened item
       | All · Mail · Mentions  | ┌──────────────┐
       | ● Backblaze Team       | │ Backblaze    │
       |   American Express  ◀  | │ privacy note │
       |   Mem0                 | │ (just this   │
       |   Ava Steijger         | │  thread)     │
```

## Why it happened

**Team chat from Home.** There is one team chat card. Opening a channel or a message from anywhere
(`open-card.ts` `cardForTarget`, `{ type: 'team_chat', channelId }`) builds exactly the Team chat
page's own card, `{ kind: 'team_chat', title: 'Team chat' }`, and puts the channel in its seed. The
rail's selected place (`rail/selected-place.ts`, `rail-pages.ts` `nextSelectedPlace`) has the rule
"a page's own card coming in front selects the page", and `ownPageOfCard` says, on purpose, that "a
page's own card reused for a place inside it is still that page's". So a channel opened from
Recent selected Team chat, lit its rail icon, swapped Recent for the Team chat sub-nav, and the card
drew its channel list. The rule never asked where the open came from. Mail's own card has the same
shape: a Mail card opened from a hub with Mail's page spec would have selected Mail too.

**Inbox.** Inbox had no entry in `PAGE_PANELS`, so selecting it left the slot empty. Its card drew
its own list, and a mail row opened a Mail card (`openTarget({ type: 'mail', threadId })`): the
Mail page's list and reader, with no panel at all (Mail's sub-nav only shows when Mail is
selected), while Inbox stayed lit in the rail. That is the owner's second screenshot.

## The design

### A hub

Home and Inbox are **hubs** (`rail-pages.ts` `HUB_PLACES`). A hub's panel (home's Recent, Inbox's
list) wears `data-hub-place` (`selected-place.ts` `HUB_PLACE_ATTR`, put on by
`page-panel-frame.tsx`). The selected place already notes the person's last press (a pointer down
or a key) to tell "opened from inside a page" apart; it now also notes which hub the press was in.
`nextSelectedPlace` gains one rule, ahead of the page's-own-card rule: **a card that comes in
front within a moment of a press in a hub's panel keeps that hub selected**, whatever card it is.

| Opened by | Card in front | Selected |
| --- | --- | --- |
| A Recent row (click, Enter, J/K) | Team chat's card on a channel | Home (was Team chat: the bug) |
| A Recent row | A record's card | Home (as before) |
| Inbox's list | An event's card, a flow… | Inbox |
| The rail's Team chat button | Team chat's own card | Team chat, with its sub-nav (unchanged) |
| The rail's Mail button | Mail's own card | Mail, with its sub-nav (unchanged) |

### Just the one item

With a hub selected, from `md` up (`selected-place.ts` `useHubSingle`), a card in front shows
just its one item:

- **Team chat on a channel or a message**: that one conversation, no channel list
  (`TeamChatView` `single`, laid out as beside the sub-nav). Opened on no channel, it is the page.
- **Mail on a thread**: that thread alone, no folders, no search, no thread list
  (`EmailLayout` `single`). A mail card on a folder (no thread) is still the list.
- **Records** (doc, action, contact…) were already their own card: unchanged, beside Recent.
- **An agent chat** opens in the read-only viewer over the page, as before: nothing leaves Home.
  (We read the owner's "chat history" as the team chat channel rows in Recent, the case that
  selected Team chat; an agent chat never did.)

### Flipping, without stacking

Every card opened is a card in the chat's thread. Flipping through ten records would have left ten
cards. A hub's open now carries `flip` (`OpenCardRequest`, `openTarget`): in the chat
(`chat-panel.tsx` `openCardHere`), when the card in front was itself put in by a hub, the new card
takes its place and the old one is taken out of the thread. A card the person opened another way,
or one already in the chat that a hub brought back, is never taken out. Team chat flips in place
(one card, moved channel to channel).

In Recent, with one of its rows open in front, J/K (and the arrows) move to the next row **and
open it** there. A file or an agent chat (they open a viewer over the page) is only moved to;
Enter opens it. The lit row follows the card in front; for a team chat card, which names no
record, the panel remembers the row it opened (`page-panel/hub-open.ts`).

A card that comes in front leaves the focus where it is while it is in a hub's list
(`show-tool-card.tsx`), and a hub's open holds the focus on its row for a few seconds
(`hub-open.ts` `keepFocusAfterFlip`): in the browser, a document's editor took the focus as it
opened, and the next J was typed into the document instead of flipping. To type in the item,
click into it.

### Inbox's panel

`PAGE_PANELS.inbox` (`page-panel/inbox-panel.tsx`) holds the filter (small pills, with counts) and
the list, then the keys' hint. The list, its filter, the row the keys are on and the item open are
**one store** (`components/inbox/inbox-store.ts`), and the rows are one component
(`inbox-view.tsx` `InboxList`), drawn by the panel and, where there is no panel, by the card: no
copy of the list.

- **Click or Enter** opens just that item. A conversation or a mail thread opens in the Inbox card,
  alone (the same `single` views as Home), and the Inbox card is brought in front for it if
  another card is. A record opens over the Inbox card (its record overlay). Anything else (an
  event, a flow) opens its own card, `flip`ped. Never the Mail or Team chat page.
- Inbox stays selected and lit; the open item's row is lit.
- **J / K** move, and with an item open flip it; **E** done; **H** hold until tomorrow (Held:
  brings it back); **Esc** closes the item.

### Decisions to note

1. **One filter, in one place.** While Inbox's panel is on screen the filter is the panel's and the
   card's header has none. Whenever the panel isn't there (closed by its button, a capture's
   notepad on the left, below `md`, the Inbox card inline in the chat) the card draws its own list
   and the filter goes in its header, as PR #256 (commit ce95cc45) put it. Same filter, same
   store: switching between them keeps the choice.
2. **Inbox selected, nothing open:** the card area shows a quiet note, "Open something from the
   list to see it here." with the keys' hint (or "Nothing needs you. You're all caught up."). Not
   the first item auto-opened: opening reads it (marks it read), and we shouldn't do that unasked.
3. **Phones (below `md`) are unchanged.** There is no panel there; the Inbox card keeps its list
   and filter (a mail row now opens the thread inside the Inbox card rather than the Mail page,
   which is the same fix), and Home's cards are as before (no `single`).
4. **Closing an item card opened from Inbox** (an event, say) leaves nothing in front, which is
   Home, as closing any card is. Conversations, threads and records stay inside the Inbox card, so
   this only touches the rarer kinds.
5. A card in front that came from Home's chat (a chip, the agent's mail card on a thread) also
   shows as its one item while Home is selected, since Home is the hub. A mail card on a folder,
   or Team chat's own page card, is the full page.

## Checked in the browser (local dev server, 2026-11-23)

From `md` up, at 1440 and 1100 wide, light and dark, on the test account, with made-up mail and
inbox rows: a channel from Recent keeps Home lit with Recent beside it and the conversation
alone; J/K flip from it through the documents, the row lit and the focus kept, one card left
after five opens; a mail thread opened from Home is that thread alone; Inbox from the rail
shows its panel and the note; a mail from the panel opens alone beside it, J flips to the next;
the rail's Team chat button still opens the page with its sub-nav. At 800 wide, Home's Recent
has no room beside the chat and isn't shown (as before this change); Inbox's panel shows, as
every page's sub-nav does.

## Tests

- `rail/__tests__/rail-pages.test.ts`: a hub open keeps the hub (a page's own card included); a
  rail press selects the page; the regression "team chat channel from Recent keeps Home".
- `rail/__tests__/selected-place-hub.test.ts`: the same with real presses and keys through the store.
- `page-panel/__tests__/inbox-panel.test.tsx`: the Inbox panel (registered, a hub's, filter and
  list, opening a mail thread beside it, E / H, flipping with J/K).
- `page-panel/__tests__/page-panel.test.tsx`: Recent flips with J/K (`flip`), and lights a team chat
  channel's row.
- `page-panel/__tests__/hub-open.test.ts`: which row is lit for a card that names no record.
- `components/inbox/__tests__/inbox-filters-header.test.tsx` (existing): the header's filter.

---

# One Home: Recent | Incoming (2026-11-24)

Branch `claude/home-inbox`. No migration. Merged is not live.

## What the owner said

> "okay so I love the new inbox page, I think it's really great and bring you everything you
> when you need it and I don't want to change anything about the way it works. But it does feel
> like it overlaps with the Home page. I'm thinking is home's recent is all the things you've
> interacted with recently like docs you edited, people you chatted with and so on and inbox is
> where all your notifications are coming in maybe the combined homepage has what we have in
> team-chat where we have the split between recent and notification or incoming in the
> sub-navigation"

Then (verbatim, the same day): "I just want to make sure we don't lose the filter options on the
current home recent view I think it can stay where it is right now and also we can do the same type
of filter for the incoming view with the different notifications we support with with all being the
default"

## The design

One Home. Its panel carries a two-way switch at the top, **Recent | Incoming**, drawn as Team chat's
All | Recent is (`page-panel/panel-switch.tsx`: a radio group, the chosen side raised, arrows
move).

- **Recent** is what Home's panel was, its filter unchanged: the same button in the same place, F,
  Status and Type, kept across reloads. The switch sits where the word "Recent" sat, the filter
  button beside it as before.
- **Incoming** is the Inbox panel as it was (`page-panel/inbox-panel.tsx`): the same store, rows and
  keys (E, H, Enter/O, J/K flip, Esc), and the same "just the item beside the panel" (the Inbox card
  brought in front, the conversation or the thread alone in it).
- **Incoming's filter is Recent's kind of filter** (`inbox-view.tsx` `InboxFilterButton`): the same
  button beside the switch, the same F, the same menu, kept on this device (`ni:inbox:filter`). One
  calm row: no second row of pills.
  - **Status:** All (the default), Unread, Read, Held for later. Held was a pill before; it is a
    status now, as the owner suggested.
  - **Type:** one per kind of notification the list has, with how many, grouped from the real
    notification types (`lib/notifications.ts`; `lib/inbox/items.ts` `INBOX_KINDS`):
    - Messages: team chat.
    - Mentions & assignments: mentioned, assigned/unassigned, shared with you.
    - Mail: mail that needs you, a scheduled send that failed.
    - Calls & meetings: a meeting starting soon, someone waiting in a meeting's lobby.
    - Tasks & projects: status changes, a cycle started, a decision confirmed, a reminder, a
      contact follow-up due.
    - Comments: comments and replies.
    - Reviews: GitHub review asked, PR comment, checks failed.
    - Your agent: work that needs you or failed, flow output, digests, check-ins, look-aheads,
      messages.
    - Other: anything else (today only "another workspace was merged into this one").
  - None chosen is every kind. Today's pills (All, Messages, Mentions & assignments, Mail, Held)
    are all choices in this one filter. Comments are their own Type now (they used to count under
    Mentions).
  - Where the Inbox card draws its own list (panel closed, a phone), the same button sits on the
    page's first row, from the card's corner, never in the card's header (as #263 put the pills
    that replaced the header's: "everything looks the same as the projects page").
- Both sides are Home's, a hub's (`data-hub-place="home"`): what either opens keeps Home selected,
  opens alone and flips, as before.
- Which side shows lives in `page-panel/home-side.ts`. The Inbox card covers its list while Home's
  panel is beside it (`inbox-card.tsx`: `useOwnSubnavShown('home')`).
- Home's panel now shows even when nothing is recent ("What you open and work on shows here."), so
  the switch to Inbox is always there.

## Decisions for the owner (defaults built; each easy to change)

1. **The labels: "Recent | Incoming"**, your word. The alternative, "Inbox", is one string to
   change (`HOME_SIDES` in `home-recents.tsx`). G J, `/` and Search still call the page "Inbox";
   they open Home's Incoming side.
2. **First visit and memory.** A first visit shows Recent. After that, the side last chosen is
   remembered on this device (`ni:home-panel:side`), as Team chat's switch is.
3. **The rail's Inbox button is gone; Home is the one place.**
   - A saved bar that held Inbox drops it cleanly. The id isn't offered, so it isn't drawn, and the
     next save tidies it out; the rest keeps its saved order.
   - Every way into Inbox (`/`, Search, G J, the deep link `/account?page=inbox`, any link to the
     page) opens the Inbox page's card. That card coming in front selects Home and puts it on its
     Inbox side (`rail/selected-place.ts`, `rail-pages.ts` `HOME_PAGES` / `homeSideOfCard`).
     A notification's banner opens its item, as before. There was no old `/account/inbox` route to
     redirect: Inbox only ever opened as a card.
   - Home's rail icon carries a **dot** (not a count) while anything in the Inbox is unread. A count
     reads 260 on a busy inbox, which is noise on a 40px icon. The dot is read once, on the window's
     focus, and when a notification arrives through the notifications' realtime: no timer
     (`inbox-store.ts` `useInboxUnread`). The switch's Inbox side carries the same dot while you
     are on Recent.
4. **Phones (below `md`, no panel).** Home on a phone is the chat; it has no Recent list at all
   (Recent was only ever the panel), so there is nowhere to put the switch. On a phone, G J, `/` and
   Search open the Inbox card, which draws its own list and filter in its header, as it did. If you
   want a Recent | Inbox list on phones too, that is a new phone screen: say so and we'll build it.
6. **Where Inbox's filter sits, after #263** (in production: "the Inbox's filters on the page's
   first row" and "stay in reach beside an open item"). Your 11-24 ask, one filter of Recent's kind
   instead of the pills, replaces #263's row of pills, but keeps #263's place for it:
   - Inside Home (Incoming), the one filter button sits beside the switch, as Recent's does.
   - Where the Inbox card draws its own list, the same button sits on the page's first row from the
     card's corner, never in the card header. It is one button, so it stays in reach beside an open
     item at any width.
   - What #263's pills gave and this doesn't: each choice with its count, visible at a glance
     without opening the menu (the menu shows the counts). If you want the pills back on the card's
     own first row as well, that is one component to put back. Say so.
5. **Keys: S switches sides, F opens the side's filter** while either list has the focus (Recent → Inbox, Inbox → Recent). S
   is free in both lists, and the ? sheet lists it (`lib/shortcuts.ts`, `recents-switch` and
   `inbox-switch`). The switch itself also takes ← / → when it has the focus. G J still goes to
   Inbox, now Home's Inbox side.

## Tests

- `rail-pages.test.ts`: no Inbox rail page. The Inbox page's card selects Home, however it came
  (including from inside another page). Hubs are just Home now.
- `selected-place-hub.test.ts`: the Inbox card, through the store, selects Home on its Inbox side.
- `app-rail.test.tsx`: no Inbox icon, Home's dot, and a bar saved with Inbox dropping it.
- `page-panel.test.tsx`: Home's switch (Recent first, a press or S shows Inbox, remembered), and the
  panel shown with nothing recent.
- `inbox-panel.test.tsx`: the Incoming side is Home's (a hub's frame), one filter button and no
  pills; S goes back to Recent.
- `lib/inbox/__tests__/inbox-filter.test.ts`: every real notification type has a kind; Status and
  Type narrow the list together; a saved filter reads back.
- `components/inbox/__tests__/inbox-filters-row.test.tsx` (#263's, rewritten): the filter button on
  the page's first row, none in the header; F opens it, a Type narrows and is kept, Held; the
  filter's own keys are never the list's.

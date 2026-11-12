# The call recorder

One process on our server that hears our own team calls and meeting links while they
happen, and feeds what is said into the call's one capture, live. It is the first
producer of the app's capture feed (`web/src/lib/capture-feed/contract.ts`); a later
producer that joins someone's Meet, Teams or Zoom call speaks the same feed.

- It asks the app for its work every few seconds: the live calls with notes on that
  nobody is hearing, each with a LiveKit token for that room alone (hidden, a recorder,
  subscribe only). Nothing calls it, and it holds no LiveKit key.
- In each room it subscribes to every member's and meeting guest's microphone and
  streams each to Deepgram (nova-3, finals only, no diarization: one track is one known
  speaker). Each final is stamped with when it was said (`src/clock.ts`), whatever was
  muted, dropped or sent again in between.
- It tells the feed who joined and left and what they said, in that order, one request
  at a time, sent again until the app takes it (`src/delivery.ts`); the app takes a
  repeat as a repeat.
- Its heartbeat says which calls it hears; the answer says which to stop (notes off,
  the call over, the 3-hour bound). A recorder that restarts takes its calls up again.

Deployment, settings and the roll-out steps are in `deploy/README.md` (step 23, "The call
recorder"); the service is `recorder` in `deploy/livekit/compose.yaml`.

## Working on it

Node 24 runs the TypeScript as it is (no build step):

```bash
npm ci
npm test            # the pure parts: clock, Deepgram socket, deliveries, settings
npm run typecheck
```

The end-to-end run (`e2e/`) starts a local LiveKit, a fake app that speaks the feed's
contract in memory, a fake Deepgram that names each stretch of tone by its pitch, and
fake participants who publish tones; then the real recorder joins and is checked for
who said what, when, through a mute, a Deepgram drop, someone leaving and coming back, a
late guest, its own restart, notes going off, and the room closing once only it is left:

```bash
LIVEKIT_SERVER_BIN=/path/to/livekit-server ./e2e/start-livekit.sh
npm run e2e
./e2e/stop-livekit.sh
```

`MODE=real RECORDER_E2E_DEEPGRAM_API_KEY=... npm run e2e` makes one short pass with real
Deepgram instead, two people speaking sentences made by macOS's `say`. Results are in
`e2e/run/`, which git ignores.

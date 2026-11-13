# The call recorder

One process on our server that hears our own team calls and meeting links while they
happen, and feeds what is said into the call's one capture, live. It is the first
producer of the app's capture feed (`web/src/lib/capture-feed/contract.ts`); a later
producer that joins someone's Meet, Teams or Zoom call speaks the same feed.

- It asks the app for its work every few seconds: the live calls with notes on that
  nobody is hearing and that have had two people in them at once (a ringing or missed
  call, or one person waiting, is never heard), each with a LiveKit token for that room
  alone (hidden, a recorder, subscribe only). Nothing calls it, and it holds no LiveKit key.
- In each room it subscribes to microphones and nothing else (auto-subscribe off): every
  member's, and a meeting guest's only once the app lists them (they said go to this
  round's notes: the start's answer, then every heartbeat's). It streams each to
  Deepgram (nova-3, finals only, no diarization: one track is one known speaker). Each
  final is stamped with when it was said (`src/clock.ts`), whatever was muted, dropped
  or sent again in between.
- It tells the feed who joined and left and what they said, in that order, one request
  per call every 4 s or so, sent again until the app takes it (`src/delivery.ts`); the
  app takes a repeat as a repeat.
- Its heartbeat says which calls it hears; the answer says which to stop (notes off,
  the call over, the 3-hour bound, the capture ended by hand, the app's switch off) and
  whom it may hear. Leaving a call, it delivers its last words, then says `end`; only a
  shutdown leaves without it, and the next process takes its calls up again.
- Its identity in a room is `notes-recorder-<RECORDER_ID>`: one process per id, and one
  process per deployment today.
- With `RECORDER_AUDIO=on`, and for a call the app asks it of (the start's `audio`), it
  also keeps the call's sound (`src/audio.ts`, `src/mixer.ts`): every member's microphone
  (never a guest's) mixed into one file on the call's clock, on its volume while the call
  is heard, encoded with ffmpeg once it leaves, and handed to the app through the feed
  (a one-time upload the app grants; it holds no storage key). A restart goes on in the
  same file; the notes never wait for the sound.

Deployment, settings and the roll-out steps are in `deploy/README.md` (step 23, "The call
recorder"); the service is `recorder` in `deploy/livekit/compose.yaml`.

## Working on it

Node 24 runs the TypeScript as it is (no build step):

```bash
npm ci
npm test            # the pure parts: clock, Deepgram socket, deliveries, settings, the mixer, the audio files
npm run typecheck
```

The end-to-end run (`e2e/`) starts a local LiveKit, a fake app that speaks the feed's
contract in memory, a fake Deepgram that names each stretch of tone by its pitch, and
fake participants who publish tones; then the real recorder joins and is checked for
who said what, when, through a mute, a Deepgram drop, someone leaving and coming back, a
late guest (unheard until they say go), a screen share's sound (never heard), two people
at once (one request), its own restart, notes going off, and the room closing once only
it is left. With the audio on (the default; `E2E_AUDIO=off` leaves it out, and ffmpeg and
ffprobe must be on the PATH), the round's file is checked too: one file through the
restart, its length the round's, each member's tone where the transcript puts it, and
nothing of a muted microphone, the guest, the screen share or the restart:

```bash
LIVEKIT_SERVER_BIN=/path/to/livekit-server ./e2e/start-livekit.sh
npm run e2e
./e2e/stop-livekit.sh
```

`MODE=real RECORDER_E2E_DEEPGRAM_API_KEY=... npm run e2e` makes one short pass with real
Deepgram instead, two people speaking sentences made by macOS's `say`. Results are in
`e2e/run/`, which git ignores.

`npm run e2e:load` (same LiveKit) measures one call of 10 people for 60 s and prints the
recorder's CPU and memory; `AUDIO=off npm run e2e:load` for the comparison.

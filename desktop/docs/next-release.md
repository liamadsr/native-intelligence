# What the next desktop release carries

Merged changes that do nothing for people until a new desktop build is released (`./release.sh`, on the Mac).
Remove an entry once a release has shipped it.

## Studio: the script and checklist in the floating control

The web side (the panel, the follower, the checklist, the Record dialog's "Script & checklist") works with every
desktop build. An older build keeps the control a pill, and shows the script and checklist only in the Record
dialog for a window take of another app, with manual scrolling. These two need the new build:

- **`studio_recorder_control_size`**: grows the recording control into its panel and back. Only the control's own
  page may call it: the command checks the caller's window (`may_size_control`). It is clamped and kept on its
  display. It is granted in `capabilities/default.json` and `dev.json` like every app command
  (`tests/capability_policy.rs` pins the caller check).
- **`studio-recorder://live-words`**: the words Local transcription hears while a take records, sent to the app's own
  windows only. Finals go at once; interims at most every 150 ms. The transcript after Stop is unchanged
  (`LiveGate`, `collect`). `studio_recorder_start` answers `liveWords: true | false`, and builds before this leave it out.

Nothing changes in the Swift sidecars: the recorder already leaves the app's floating windows out of a display take,
and the control is content-protected at any size.

Check on a Mac after the build:

- [ ] A display take with a script: the control opens into the panel.
- [ ] The panel is not in the recording (look at the take).
- [ ] The panel follows while you read, with Local transcription on.
- [ ] Resize from the corner.
- [ ] Unplug a second display with the panel on it: it comes back onto the main one within about 5 s.
- [ ] Turn Local transcription off: the panel says so, and scrolling by hand works.

### With recording anywhere (the take outlives the Studio card)

Once a take starts recording, the Record dialog closes itself, so the whole app can be used and shown. Stop is the
floating control's.

On a build older than this release, the script and checklist of a window take of another app showed only in the
Record dialog. They now show only when the person reopens the dialog ("Show" in the Studio's recording bar), and it
is modal again then. The new build's panel replaces this: one more reason to ship it.

Unchanged on every build:
- Quitting the app, or closing its window, while a take records: the take is finalized and offered at the next
  launch, as before.
- A main-window reload mid-take: the Mac keeps recording and the floating control still stops it. The page doesn't
  pick the running take back up. Once stopped, it is sent and filed as a take left over (the shell brings the
  recording controller up for it), and "Recording saved" is said when it is.

## Coding chats: the model and effort the person picks (721)

The web side ships first and is safe on every build: the composer's Model and Effort pickers show only for a coding
agent whose Mac's offer says `takesModel`, which no build before this one sends. On an older build nothing changes:
no pickers, and the agent runs on its own defaults. A job started on a choice is never handed to a build that can't
run it: the page refuses it with a sentence (`MODEL_UNSUPPORTED`), and so does the server for a page too old to pass
it on (`MODEL_PAGE_OUTDATED_REASON`).

What this build carries:

- **Re-vendor the local agent first** (`scripts/local-agent-bundle.sh`, from main once this has merged). The bundle's
  `workers/registry.json` now lists each agent's `models` and `efforts`, and its `worker.mjs` passes the choice to
  the CLI. Claude Code gets `--model <alias>` and `--effort <level>` on every launch, a resume included. Codex gets
  `model` on `thread/start` / `thread/resume` and `effort` on every `turn/start`. The committed copy under
  `src-tauri/resources/local-agent/` predates this: without the re-vendor, the build offers no choice.
- **`local_agent_start`** takes `model` and `effort`. They are checked against the bundle's registry for that agent:
  a model it doesn't list, or an effort that model doesn't take, is refused with a sentence. They are refused
  without a `worker`. They are kept on the job (`state.json`'s `workerModel` / `workerEffort`) and passed on every
  launch as `LOCAL_AGENT_WORKER_MODEL` / `LOCAL_AGENT_WORKER_EFFORT`. A later start may not name others.
- **`local_agent_status`'s `workers`**: each offer adds `takesModel: true`, `models` and `efforts` when its registry
  entry lists any.

What it offers: Claude Code, its documented aliases (`opus`, `sonnet`, `haiku`) and levels (`low` to `max`).
Codex, efforts only (`low`, `medium`, `high`), on its default model. Its model list is its own (`model/list`), to
be read at run time later, never written here.

Check on a Mac after the build (with Claude Code and Codex installed and allowed):

- [ ] Code → Claude Code: Model and Effort show under the box. Pick Opus and High, start a chat. The line in the
      open chat says the model Claude Code reports, and High.
- [ ] `ps` on the running `claude` shows `--model opus --effort high`.
- [ ] Stop the app mid-job and start it again (a resume): still `--model opus --effort high`.
- [ ] Codex: no Model picker. Pick Effort Low and start: its turns run on low (the app-server log, or the line).
- [ ] Native Intelligence's own agent: no pickers.
- [ ] An older build on another Mac: no pickers for that Mac's agents.

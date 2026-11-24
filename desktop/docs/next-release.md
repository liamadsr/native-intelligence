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

//! A shortcut the user records on the settings page (the desktop watches the
//! keyboard while they press it, so fn counts): which keys work, and the
//! rules macOS (and typing) put on them.
//!
//! Usable:
//!
//! - ⌃ Control, ⌥ Option, ⇧ Shift, ⌘ Command and fn, in any mix, with a
//!   letter, digit, symbol, Space, Return, Tab, Delete, Esc, an arrow,
//!   Home/End/Page Up/Page Down, or F1–F20.
//! - At least ⌃, ⌘ or fn, so the shortcut never swallows plain typing; F1–F20
//!   may stand alone, and so may fn (pressed and released).
//!
//! Not usable: a modifier other than fn on its own, Caps Lock, media keys,
//! and ⌥ or ⌥⇧ with a key and nothing else (macOS 15+ refuses those to
//! hotkeys). Nor a chord every app or macOS itself uses ([`reserved`]): ⌘ or
//! ⇧⌘ with any key (⌘C, ⌘V, ⇧⌘Z, ⌘Q, ⌘Tab, ⌘Space, ⌘`…), ⌃Space, ⌃⌘Q and
//! the like. The hotkey is system-wide, so it would take that chord from
//! every app (a recorded ⌘C would stop copying anywhere). Any other combo
//! macOS or another app already holds fails when registered.
//!
//! Shortcuts with fn are matched by an event tap (Carbon hotkeys can't take
//! fn); the rest stay Carbon hotkeys.

use serde::{Deserialize, Serialize};

/// Carbon modifier masks.
pub const COMMAND: u32 = 0x0100;
pub const SHIFT: u32 = 0x0200;
pub const OPTION: u32 = 0x0800;
pub const CONTROL: u32 = 0x1000;
/// fn: Native Intelligence's own bit, outside Carbon's mask.
pub const FN: u32 = 0x1_0000;
/// The key code saved for "fn on its own" (kVK_Function).
pub const FN_KEYCODE: u32 = 63;

/// A recorded shortcut, as saved.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomHotkey {
    pub keycode: u32,
    /// Carbon modifier mask, plus [`FN`].
    pub modifiers: u32,
    pub label: String,
}

impl CustomHotkey {
    pub fn uses_fn(&self) -> bool {
        self.modifiers & FN != 0
    }

    pub fn fn_alone(&self) -> bool {
        self.uses_fn() && self.keycode == FN_KEYCODE
    }
}

/// Why a recorded shortcut can't be used: the settings page words each.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// Caps Lock, a media key, or a key a shortcut can't take.
    UnknownKey,
    /// No ⌃, ⌘ or fn on a key that types.
    NeedsModifier,
    /// ⌥ or ⌥⇧ alone: macOS 15+ refuses these.
    OptionOnly,
    /// A chord the apps or macOS use ([`reserved`]); shown like a combo
    /// another app holds.
    Reserved,
}

impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Refusal::UnknownKey => "unknown_key",
            Refusal::NeedsModifier => "needs_modifier",
            Refusal::OptionOnly => "option_only",
            Refusal::Reserved => "taken",
        }
    }
}

/// Every key a shortcut can use: (virtual key code, US name, whether the
/// name is fixed rather than the character the key types).
const KEYS: &[(u32, &str, bool)] = &[
    (0, "A", false), (1, "S", false), (2, "D", false), (3, "F", false), (4, "H", false),
    (5, "G", false), (6, "Z", false), (7, "X", false), (8, "C", false), (9, "V", false),
    (11, "B", false), (12, "Q", false), (13, "W", false), (14, "E", false), (15, "R", false),
    (16, "Y", false), (17, "T", false), (31, "O", false), (32, "U", false), (34, "I", false),
    (35, "P", false), (37, "L", false), (38, "J", false), (40, "K", false), (45, "N", false),
    (46, "M", false),
    (18, "1", false), (19, "2", false), (20, "3", false), (21, "4", false), (23, "5", false),
    (22, "6", false), (26, "7", false), (28, "8", false), (25, "9", false), (29, "0", false),
    (27, "-", false), (24, "=", false), (33, "[", false), (30, "]", false), (42, "\\", false),
    (41, ";", false), (39, "'", false), (43, ",", false), (47, ".", false), (44, "/", false),
    (50, "`", false),
    (49, "Space", true), (36, "↩", true), (48, "⇥", true), (51, "⌫", true), (117, "⌦", true),
    (53, "⎋", true), (123, "←", true), (124, "→", true), (125, "↓", true), (126, "↑", true),
    (115, "↖", true), (119, "↘", true), (116, "⇞", true), (121, "⇟", true),
    (122, "F1", true), (120, "F2", true), (99, "F3", true), (118, "F4", true), (96, "F5", true),
    (97, "F6", true), (98, "F7", true), (100, "F8", true), (101, "F9", true), (109, "F10", true),
    (103, "F11", true), (111, "F12", true), (105, "F13", true), (107, "F14", true),
    (113, "F15", true), (106, "F16", true), (64, "F17", true), (79, "F18", true), (80, "F19", true),
    (90, "F20", true),
];

/// Validate a pressed shortcut. `keycode` is `None` for fn pressed and
/// released on its own. `typed` is the character the key typed, so the label
/// matches the user's layout; the key's US name stands in when it's missing,
/// not one plain character, or bent by ⌥ (⌥R types "®").
pub fn custom(keycode: Option<u32>, modifiers: u32, fn_held: bool, typed: &str) -> Result<CustomHotkey, Refusal> {
    let Some(keycode) = keycode else {
        return Ok(CustomHotkey { keycode: FN_KEYCODE, modifiers: FN, label: "fn".into() });
    };
    let &(_, name, fixed) = KEYS.iter().find(|(k, _, _)| *k == keycode).ok_or(Refusal::UnknownKey)?;
    let function_key = fixed && name.starts_with('F');
    let mods = (modifiers & (COMMAND | SHIFT | OPTION | CONTROL)) | if fn_held { FN } else { 0 };
    if !function_key && mods & (CONTROL | COMMAND | FN) == 0 {
        return Err(if mods & OPTION != 0 { Refusal::OptionOnly } else { Refusal::NeedsModifier });
    }
    if reserved(keycode, mods) {
        return Err(Refusal::Reserved);
    }
    let character = if fixed || mods & OPTION != 0 {
        None
    } else {
        let mut chars = typed.chars();
        match (chars.next(), chars.next()) {
            (Some(c), None) if !c.is_whitespace() && !c.is_control() => Some(c.to_uppercase().collect::<String>()),
            _ => None,
        }
    };
    let key_label = character.unwrap_or_else(|| name.to_string());
    Ok(CustomHotkey { keycode, modifiers: mods, label: format!("{}{}", modifier_label(mods), key_label) })
}

/// Chords with ⌃ or ⌥ that macOS itself answers, by virtual key code.
const SYSTEM_CHORDS: &[(u32, u32)] = &[
    (49, CONTROL),                // ⌃Space: next input source
    (49, CONTROL | COMMAND),      // ⌃⌘Space: emoji & symbols
    (49, OPTION | COMMAND),       // ⌥⌘Space: Finder search
    (12, CONTROL | COMMAND),      // ⌃⌘Q: lock screen
    (3, CONTROL | COMMAND),       // ⌃⌘F: full screen
    (53, OPTION | COMMAND),       // ⌥⌘⎋: force quit
    (4, OPTION | COMMAND),        // ⌥⌘H: hide others
    (46, OPTION | COMMAND),       // ⌥⌘M: minimize all
    (13, OPTION | COMMAND),       // ⌥⌘W: close all
    (2, OPTION | COMMAND),        // ⌥⌘D: the Dock
    (48, CONTROL),                // ⌃⇥ and ⌃⇧⇥: next and previous tab
    (48, CONTROL | SHIFT),
    (123, CONTROL),               // ⌃← ⌃→ ⌃↓ ⌃↑: Spaces, App Exposé, Mission Control
    (124, CONTROL),
    (125, CONTROL),
    (126, CONTROL),
];

/// A chord the apps or macOS use: ⌘ or ⇧⌘ with any key (the apps' menu
/// shortcuts: editing, saving, quitting, windows, app switching, Spotlight,
/// screenshots), or one of [`SYSTEM_CHORDS`]. With fn it's free: it fires
/// only while fn is held, which no app's chord needs.
fn reserved(keycode: u32, mods: u32) -> bool {
    if mods & FN != 0 {
        return false;
    }
    mods == COMMAND || mods == COMMAND | SHIFT || SYSTEM_CHORDS.contains(&(keycode, mods))
}

/// fn ⌃⌥⇧⌘, in the order macOS menus write them (fn first, spaced).
pub fn modifier_label(mods: u32) -> String {
    let symbols: String = [(CONTROL, "⌃"), (OPTION, "⌥"), (SHIFT, "⇧"), (COMMAND, "⌘")]
        .iter()
        .filter(|(m, _)| mods & m != 0)
        .map(|(_, s)| *s)
        .collect();
    if mods & FN != 0 { format!("fn {symbols}") } else { symbols }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_option_letter() {
        let k = custom(Some(15), CONTROL | OPTION, false, "r").unwrap();
        assert_eq!((k.keycode, k.modifiers, k.label.as_str()), (15, CONTROL | OPTION, "⌃⌥R"));
        assert!(!k.uses_fn());
    }

    #[test]
    fn label_follows_the_layout() {
        // AZERTY: the key in the Q position types "a".
        assert_eq!(custom(Some(12), CONTROL | SHIFT, false, "a").unwrap().label, "⌃⇧A");
        // ⌥ changes what the key types: its name instead.
        assert_eq!(custom(Some(15), CONTROL | OPTION, false, "®").unwrap().label, "⌃⌥R");
        assert_eq!(custom(Some(15), CONTROL, false, "").unwrap().label, "⌃R");
    }

    #[test]
    fn function_keys_stand_alone() {
        let k = custom(Some(96), 0, false, "").unwrap();
        assert_eq!((k.keycode, k.label.as_str()), (96, "F5"));
        assert_eq!(custom(Some(105), SHIFT, false, "").unwrap().label, "⇧F13");
    }

    #[test]
    fn typing_keys_need_control_command_or_fn() {
        assert_eq!(custom(Some(15), 0, false, "r"), Err(Refusal::NeedsModifier));
        assert_eq!(custom(Some(15), SHIFT, false, "R"), Err(Refusal::NeedsModifier));
        assert_eq!(custom(Some(49), 0, false, " "), Err(Refusal::NeedsModifier));
        assert_eq!(custom(Some(15), OPTION, false, "®"), Err(Refusal::OptionOnly));
        assert_eq!(custom(Some(15), OPTION | SHIFT, false, "‰"), Err(Refusal::OptionOnly));
        assert!(custom(Some(15), COMMAND | OPTION, false, "r").is_ok());
    }

    #[test]
    fn fn_shortcuts() {
        let alone = custom(None, 0, true, "").unwrap();
        assert_eq!((alone.keycode, alone.modifiers, alone.label.as_str()), (FN_KEYCODE, FN, "fn"));
        assert!(alone.fn_alone());

        let fn_r = custom(Some(15), 0, true, "r").unwrap();
        assert_eq!((fn_r.modifiers, fn_r.label.as_str()), (FN, "fn R"));
        assert!(fn_r.uses_fn() && !fn_r.fn_alone());

        // fn lifts the ⌥-only rule (it isn't a Carbon hotkey).
        assert_eq!(custom(Some(49), OPTION, true, " ").unwrap().label, "fn ⌥Space");
        assert_eq!(custom(Some(15), CONTROL, true, "r").unwrap().label, "fn ⌃R");
    }

    #[test]
    fn unusable_keys() {
        // Caps Lock, right ⌘, a keypad key, volume up.
        for keycode in [57, 54, 83, 72] {
            assert_eq!(custom(Some(keycode), CONTROL, false, ""), Err(Refusal::UnknownKey), "{keycode}");
        }
    }

    /// A page that re-arms the recorder can't turn the person's next ⌘C into
    /// the system-wide hotkey: the apps' and macOS's own chords are refused,
    /// as "taken".
    #[test]
    fn the_apps_and_macos_chords_are_refused() {
        let cmd = |keycode, typed| custom(Some(keycode), COMMAND, false, typed);
        for (keycode, typed) in [
            (8, "c"), (9, "v"), (7, "x"), (6, "z"), (0, "a"), (1, "s"), (12, "q"), (13, "w"),
            (4, "h"), (46, "m"), (45, "n"), (17, "t"), (48, "\t"), (49, " "), (50, "`"), (43, ","),
        ] {
            assert_eq!(cmd(keycode, typed), Err(Refusal::Reserved), "⌘ + key {keycode}");
        }
        assert_eq!(custom(Some(6), COMMAND | SHIFT, false, "z"), Err(Refusal::Reserved), "⇧⌘Z");
        assert_eq!(custom(Some(21), COMMAND | SHIFT, false, "4"), Err(Refusal::Reserved), "⇧⌘4");
        assert_eq!(custom(Some(96), COMMAND, false, ""), Err(Refusal::Reserved), "⌘F5");
        for (keycode, mods) in [
            (49, CONTROL),
            (49, CONTROL | COMMAND),
            (12, CONTROL | COMMAND),
            (53, OPTION | COMMAND),
            (48, CONTROL),
            (126, CONTROL),
        ] {
            assert_eq!(custom(Some(keycode), mods, false, ""), Err(Refusal::Reserved), "{keycode} {mods:#x}");
        }
        assert_eq!(Refusal::Reserved.code(), "taken", "the settings page already words it");

        // What stays free: the presets, ⌃⌘ and ⌃⌥ chords, and anything with fn.
        for (keycode, mods) in [(15, CONTROL | OPTION), (1, CONTROL | OPTION), (49, CONTROL | OPTION), (53, CONTROL)] {
            assert!(custom(Some(keycode), mods, false, "").is_ok(), "{keycode} {mods:#x}");
        }
        assert!(custom(Some(15), CONTROL | COMMAND, false, "r").is_ok());
        assert!(custom(Some(8), COMMAND, true, "c").is_ok(), "fn ⌘C fires only with fn held");
    }

    #[test]
    fn named_keys() {
        assert_eq!(custom(Some(49), CONTROL | OPTION, false, " ").unwrap().label, "⌃⌥Space");
        assert_eq!(custom(Some(53), CONTROL, false, "\u{1b}").unwrap().label, "⌃⎋");
        assert_eq!(custom(Some(126), CONTROL | COMMAND, false, "").unwrap().label, "⌃⌘↑");
    }
}

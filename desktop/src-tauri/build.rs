/// Every command registered with `tauri::generate_handler!` in `src/lib.rs`.
///
/// SECURITY: this list is what turns on Tauri's per-origin ACL for the app's
/// own commands. Without an `AppManifest`, tauri dispatches every app command
/// for ANY origin that holds the injected invoke key — and tauri injects that
/// key into the main frame of EVERY webview it creates, including one that has
/// navigated to a third-party site (verified: an `http://127.0.0.1` page in the
/// main window could invoke `system_info`). Declaring the commands
/// here makes tauri require an explicit `allow-<command>` grant, which
/// `capabilities/default.json` gives ONLY to the Dial8 origins in its `remote`
/// allowlist. A page on any other origin is then refused ("Command <x> not
/// allowed by ACL").
///
/// KEEP IN SYNC with `generate_handler!` in `src/lib.rs`. A command that is
/// registered but missing here is dispatched for every origin again; a command
/// listed here but not registered is a harmless unused permission. The
/// `app_commands_match_handler` test in `tests/app_commands.rs` fails the build
/// if the two lists drift.
const APP_COMMANDS: &[&str] = &[
    "agent_hud_ready",
    "app_update_apply",
    "app_update_check",
    "app_update_install",
    "browser_exit_start",
    "browser_exit_status",
    "browser_exit_stop",
    "check_mic_permission",
    "check_system_audio_permission",
    "create_local_exchange_event",
    "delete_local_exchange_event",
    "desktop_bots_status",
    "dictate_panel_size",
    "dictate_paste",
    "dictate_phase",
    "dictate_set_enabled",
    "dictate_state",
    "dictate_status",
    "dictate_flash",
    "dictate_watch_pointer",
    "dismiss_meeting_detection",
    "enable_meeting_detection",
    "ensure_agent_hud",
    "focus_own_window",
    "forget_input_device",
    "get_agent_hud_capture_visible",
    "get_audio_health",
    "get_audio_levels",
    "get_audio_preferences",
    "get_cached_calendar_events",
    "get_close_to_tray",
    "get_echo_cancellation_in_captures",
    "get_local_calendar_status",
    "get_local_exchange_events",
    "get_meeting_detection_state",
    "get_mic_mode",
    "get_recording_status",
    "hide_agent_hud",
    "hide_agent_hud_transient",
    "hide_desktop_bots",
    "hide_meeting_hud",
    "hud_link_event",
    "is_cursor_over_hud",
    "list_input_devices",
    "local_agent_device",
    "local_agent_events",
    "local_agent_pick_folder",
    "local_agent_remove_grant",
    "local_agent_resume",
    "local_agent_send",
    "local_agent_set_model_token",
    "local_agent_start",
    "local_agent_status",
    "local_agent_stop",
    "module_disable",
    "module_enable",
    "module_log_tail",
    "module_remove_assets",
    "modules_list",
    "notification_click_listener_gone",
    "notification_click_listener_ready",
    "notification_permission_state",
    "open_mic_mode_picker",
    "open_workspace_window",
    "pause_recording",
    "presence_state",
    "push_agent_nudge",
    "read_selection_cancel_record",
    "read_selection_open_accessibility_settings",
    "read_selection_record_hotkey",
    "read_selection_relaunch",
    "read_selection_request_access",
    "read_selection_sentences",
    "read_selection_set_enabled",
    "read_selection_set_hotkey",
    "read_selection_set_voice",
    "read_selection_status",
    "recover_mic",
    "remove_delivered_notification",
    "request_calendar_access",
    "request_capture_from_hud",
    "request_mic_permission",
    "request_notification_permission",
    "request_screen_capture_permission",
    "request_speech_permission",
    "request_system_audio_permission",
    "reset_input_priority",
    "resize_meeting_hud",
    "restart_core_audio",
    "resume_recording",
    "save_file",
    "set_agent_hud_capture_visible",
    "set_auth_token",
    "set_auto_record",
    "set_close_to_tray",
    "set_echo_cancellation_in_captures",
    "set_input_override",
    "set_input_priority",
    "set_window_backdrop",
    "show_agent_hud",
    "show_native_notification",
    "start_recording",
    "stop_recording",
    "system_info",
    "talk_send",
    "talk_state",
    "tts_cancel",
    "tts_prepare",
    "tts_rate",
    "tts_set_rate",
    "tts_speak",
    "tts_voices",
    "update_local_exchange_event",
    "voice_cancel",
    "voice_log",
    "voice_set_aside",
    "voice_set_barge",
    "voice_set_muted",
    "voice_start",
    "voice_status",
    "voice_stop",
    "auth_web_session_cmd",
];

/// Release builds read capabilities/default.json alone; debug builds add
/// dev.json (localhost). tests/capability_policy.rs pins both.
mod build_capabilities;

fn main() {
    // A custom pattern means tauri-build doesn't emit this itself.
    println!("cargo:rerun-if-changed=capabilities");
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .capabilities_path_pattern(build_capabilities::capabilities_pattern(
                &std::env::var("PROFILE").unwrap_or_default(),
            ))
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to run tauri-build");

    // A build script's own `cfg` is the HOST it runs on, not the target it
    // builds for: read the target from Cargo, so a cross build for Windows
    // never compiles the Objective-C helpers or links Apple frameworks.
    let target_macos = std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos");

    // Set macOS deployment target for the linker — Core Audio Taps need 14.2+,
    // sidecar needs 14.4+. This provides ___isPlatformVersionAtLeast at link time.
    if target_macos {
        println!("cargo:rustc-env=MACOSX_DEPLOYMENT_TARGET=14.4");
    }

    // Compile the Objective-C tap helper into the Rust binary on macOS.
    // This allows the main process (which has Screen & System Audio Recording
    // permission) to create Core Audio Taps directly.
    if target_macos {
        // Recompile the native helpers when any of their sources change.
        // Without these, Cargo never reruns the build script for a lone .m/.h
        // edit, so cc-rs links the previously cached .o objects and native
        // changes silently never reach the binary.
        for src in [
            "src/native/tap_helper.m",
            "src/native/calendar_helper.m",
            "src/native/app_nap_helper.m",
            "src/native/window_helper.m",
            "src/native/window_helper.h",
            "src/native/mic_helper.m",
            "src/native/mic_helper.h",
            "src/native/tcc_helper.m",
            "src/native/tcc_helper.h",
            "src/native/power_helper.m",
            "src/native/power_helper.h",
            "src/native/web_links_helper.m",
            "src/native/web_links_helper.h",
            "src/native/selection_helper.m",
            "src/native/selection_helper.h",
            "src/native/dictate_helper.m",
            "src/native/dictate_helper.h",
        ] {
            println!("cargo:rerun-if-changed={src}");
        }

        cc::Build::new()
            .file("src/native/tap_helper.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .flag("-mmacos-version-min=14.4")
            .compile("tap_helper");

        cc::Build::new()
            .file("src/native/calendar_helper.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .flag("-mmacos-version-min=14.4")
            .compile("calendar_helper");

        // Microphone TCC status/request (AVCaptureDevice). Gives the app a
        // real view of the mic grant instead of inferring it from whether
        // cpal delivers non-zero samples.
        cc::Build::new()
            .file("src/native/mic_helper.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .flag("-mmacos-version-min=14.4")
            .compile("mic_helper");

        // System-audio (kTCCServiceAudioCapture) TCC status/request. The private
        // TCC framework is dlopen'd at runtime, so no framework is linked for
        // it. Needed because tap creation succeeds even when this permission is
        // denied — only TCC itself can say whether capture will be permitted.
        cc::Build::new()
            .file("src/native/tcc_helper.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .flag("-mmacos-version-min=14.4")
            .compile("tcc_helper");

        // System sleep/wake notifications (NSWorkspace). The mic capture never
        // reuses a paused stream across a sleep — those come back dead.
        cc::Build::new()
            .file("src/native/power_helper.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .flag("-mmacos-version-min=14.4")
            .compile("power_helper");

        // Suppress App Nap so the backgrounded WebView keeps getting scheduled
        // (prevents the freeze + multi-minute "catch up" on foreground).
        cc::Build::new()
            .file("src/native/app_nap_helper.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .flag("-mmacos-version-min=14.4")
            .compile("app_nap_helper");

        // Paint the NSWindow + web content layer with the app background color
        // so live-resize doesn't flash empty space before the WebView repaints.
        cc::Build::new()
            .file("src/native/window_helper.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .flag("-mmacos-version-min=14.4")
            .compile("window_helper");

        // The desktop Google sign-in's ASWebAuthenticationSession.
        cc::Build::new()
            .file("src/native/web_links_helper.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .flag("-mmacos-version-min=14.4")
            .compile("web_links_helper");

        // Read selection aloud: the system-wide hotkey (Carbon) and the
        // frontmost app's selected text (Accessibility, ⌘C fallback).
        cc::Build::new()
            .file("src/native/selection_helper.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .flag("-mmacos-version-min=14.4")
            .compile("selection_helper");

        // Dictate anywhere: the right-Option tap and the paste (dictate.rs).
        cc::Build::new()
            .file("src/native/dictate_helper.m")
            .flag("-fobjc-arc")
            .flag("-fmodules")
            .flag("-mmacos-version-min=14.4")
            .compile("dictate_helper");

        println!("cargo:rustc-link-lib=framework=CoreAudio");
        println!("cargo:rustc-link-lib=framework=AVFoundation");
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=IOKit");
        println!("cargo:rustc-link-lib=framework=EventKit");
        println!("cargo:rustc-link-lib=framework=Cocoa");
        println!("cargo:rustc-link-lib=framework=WebKit");
        println!("cargo:rustc-link-lib=framework=QuartzCore");
        println!("cargo:rustc-link-lib=framework=AuthenticationServices");
        println!("cargo:rustc-link-lib=framework=Carbon");
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
    }
}

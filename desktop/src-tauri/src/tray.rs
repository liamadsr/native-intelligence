/// System tray (menu bar) for Native Intelligence Desktop.
///
/// Shows the Native Intelligence icon in the macOS menu bar with the next meeting's title + countdown,
/// "● Rec" while a capture records and "● Mic" while a voice session listens (both at
/// once, not at the next tick), and "Working in <folder>" while a local agent's turn
/// runs on this Mac.
/// Clicking reveals a dropdown with today's remaining meetings, tomorrow's meetings,
/// the local agents running on this Mac with their off switch and model, and standard app
/// actions (Open, Settings, Quit).
///
/// Mirrors the native app's StatusBarController + MeetingMenuBuilder.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use chrono::{DateTime, Local, NaiveDate, TimeZone};
use serde::Deserialize;
use serde_json;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::TrayIconBuilder;
use tauri::{App, AppHandle, Emitter, Manager};

use crate::local_agent::{LocalAgentService, TrayJob, TrayJobState, TrayView};
use crate::state::{AppState, CalendarEvent};

/// Write tray-specific debug log to /tmp/dial8-tray.log (0600, `crate::open_log`)
fn tlog(msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = crate::open_log(&crate::side_log_path("dial8-tray.log")) {
        let _ = writeln!(f, "[{}] {}", chrono::Local::now().format("%H:%M:%S"), msg);
    }
    eprintln!("[tray] {}", msg);
}

// MARK: - Constants

const MAX_TITLE_LENGTH: usize = 20;
/// A working local agent's folder name in the title beside a meeting's.
const AGENT_LABEL_BESIDE_MEETING: usize = 12;
const POLL_INTERVAL: Duration = Duration::from_secs(300); // 5 minutes
const TITLE_REFRESH_INTERVAL: Duration = Duration::from_secs(30);
/// How often the title checks what has the mic. A voice session says so at
/// once ([`refresh_mic`]); a capture's start or stop shows within this.
const MIC_CHECK_INTERVAL: Duration = Duration::from_secs(1);

const LOCAL_AGENTS_TOGGLE: &str = "local-agents-toggle";
const LOCAL_AGENT_STOP: &str = "local-agent-stop-";
/// + [`ModelChoice::menu_id`].
const LOCAL_AGENT_MODEL: &str = "local-agent-model:";
/// + [`Worker::as_str`](crate::local_agent::workers::Worker::as_str).
const LOCAL_AGENT_WORKER: &str = "local-agent-worker:";
const QUIT: &str = "quit";
/// Windows only: the notices the installer carries (Licenses/
/// THIRD_PARTY_NOTICES.txt beside Native Intelligence.exe). macOS shows them from the app
/// menu's Help (app_menu.rs); Windows has no app menu.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const OPEN_LICENSES: &str = "open-source-licenses";

/// A random prefix, new each launch, on the id of every tray item that acts
/// natively (the Local Agents switch, the model, the coding-agent opt-ins, a
/// job's Stop, Quit). The tray's `on_menu_event` is a GLOBAL listener: tauri
/// calls it for every menu event in the app, not just tray clicks. So a menu
/// built anywhere else with one of these ids would act as the tray item.
/// The web can't build menus (the capability grants no `core:menu` /
/// `core:tray`, security review 2026-10-31 P0-3); this keeps it that way even
/// if a permission comes back: an id without this launch's prefix never
/// reaches a native action. Never logged.
fn native_prefix() -> &'static str {
    static PREFIX: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PREFIX.get_or_init(|| format!("n{}:", uuid::Uuid::new_v4().simple()))
}

/// A native-only item's id: this launch's prefix + `base`.
fn native_id(base: impl AsRef<str>) -> String {
    format!("{}{}", native_prefix(), base.as_ref())
}

/// The local agents section as the actor last published it (`None` until it
/// does). The menu is rebuilt from it with the calendar's parts.
static LOCAL_AGENTS: Mutex<Option<TrayView>> = Mutex::new(None);

/// The local agents' actor published a new view: keep it and redraw (the
/// menu, and the title at once rather than at the next 30 s tick).
pub(crate) fn set_local_agents(app: &AppHandle, view: TrayView) {
    *LOCAL_AGENTS.lock().unwrap() = Some(view);
    rebuild_tray_menu(app);
    update_tray_title(app);
}

/// The cloud browser's Mac exit while it runs (crate::browser_exit): whether
/// it's up, and the sites it reached today (the busiest, and how many in all).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BrowserExitTray {
    pub up: bool,
    pub sites: Vec<crate::browser_exit::SiteCount>,
    pub total: usize,
}

static BROWSER_EXIT: Mutex<Option<BrowserExitTray>> = Mutex::new(None);

/// The exit started, changed or stopped (None): redraw the menu if it changed.
pub(crate) fn set_browser_exit(app: &AppHandle, view: Option<BrowserExitTray>) {
    {
        let mut current = BROWSER_EXIT.lock().unwrap();
        if *current == view {
            return;
        }
        *current = view;
    }
    rebuild_tray_menu(app);
}

/// What has the mic, as the title shows it (security review 2026-10-31 P1-5:
/// the menu bar is the one place it always shows, the windows hidden or not).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MicUse {
    Off,
    /// A voice session: dictation (here or right ⌥), voice mode, Interactive. "● Mic".
    Voice,
    /// A capture recording. "● Rec".
    Capture,
}

/// What the title last showed: a busy lock (a capture starting or stopping
/// holds it) keeps it, rather than blanking the prefix.
static SHOWN_MIC: Mutex<MicUse> = Mutex::new(MicUse::Off);

/// What has the mic now, or None while the capture's lock is busy. try_lock,
/// never lock: a start/stop_recording holding the guard must not stall the
/// caller. (A capture and a voice session never run together: each ends or
/// refuses the other.)
fn mic_use(app: &AppHandle) -> Option<MicUse> {
    if app.state::<AppState>().recording_window.try_lock().ok()?.is_some() {
        return Some(MicUse::Capture);
    }
    let voice = app.try_state::<crate::voice::VoiceService>().is_some_and(|v| v.live());
    Some(if voice { MicUse::Voice } else { MicUse::Off })
}

/// The mic was taken or let go (or may have been): redraw the title if what
/// it shows is no longer so. Cheap when nothing changed.
pub(crate) fn refresh_mic(app: &AppHandle) {
    if mic_use(app).is_some_and(|now| now != *SHOWN_MIC.lock().unwrap()) {
        update_tray_title(app);
    }
}

/// Check the mic every [`MIC_CHECK_INTERVAL`], for a capture's start and stop
/// (and anything else that missed telling [`refresh_mic`]).
fn watch_mic(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(MIC_CHECK_INTERVAL);
        refresh_mic(&app);
    });
}

pub fn api_base_url() -> &'static str {
    #[cfg(debug_assertions)]
    {
        "http://localhost:3000"
    }
    #[cfg(not(debug_assertions))]
    {
        "https://dial8.ai"
    }
}

// MARK: - Setup

/// Initialize the system tray. Called from lib.rs setup.
pub fn setup_tray(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    // macOS: a template image the menu bar tints. Windows draws tray icons as
    // they are, and a black template vanishes on a dark taskbar: the app's
    // own icon there.
    #[cfg(not(target_os = "windows"))]
    let icon_bytes: &[u8] = include_bytes!("../icons/tray-icon.png");
    #[cfg(target_os = "windows")]
    let icon_bytes: &[u8] = include_bytes!("../icons/32x32.png");
    let icon = tauri::image::Image::from_bytes(icon_bytes)?;

    let menu = build_static_menu(app)?;

    let _tray = TrayIconBuilder::with_id("dial8-tray")
        .icon(icon)
        .icon_as_template(true)
        .menu(&menu)
        .show_menu_on_left_click(true)
        .tooltip("Native Intelligence")
        .on_menu_event(|app, event| {
            handle_menu_event(app, event.id().as_ref());
        })
        .build(app)?;

    watch_mic(app.handle().clone());
    tlog("[tray] system tray initialized");
    Ok(())
}

/// Start background polling for calendar events.
pub fn start_calendar_polling(app_handle: AppHandle) {
    let should_stop = Arc::new(Mutex::new(false));

    std::thread::spawn(move || {
        tlog("[tray] calendar polling thread started");

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("failed to create tokio runtime for tray polling");

        let mut ticks_since_refresh: u32 = 0;
        // How many 30s ticks between full refreshes (300s / 30s = 10)
        let refresh_every_n_ticks: u32 = (POLL_INTERVAL.as_secs() / TITLE_REFRESH_INTERVAL.as_secs()) as u32;

        loop {
            if *should_stop.lock().unwrap() {
                break;
            }

            // Check if auth token was just set (triggers immediate refresh)
            let token_changed = {
                let state = app_handle.state::<AppState>();
                let mut flag = state.auth_token_changed.lock().unwrap();
                if *flag {
                    *flag = false;
                    true
                } else {
                    false
                }
            };

            if token_changed {
                tlog("auth token changed — triggering immediate calendar refresh");
            }

            if token_changed || ticks_since_refresh == 0 || ticks_since_refresh >= refresh_every_n_ticks {
                // Full refresh: fetch events from API + rebuild menu + update title
                rt.block_on(refresh_calendar_cache(&app_handle));
                rebuild_tray_menu(&app_handle);
                ticks_since_refresh = 0;
            }

            // Always update the title text (countdown changes every 30s)
            update_tray_title(&app_handle);

            ticks_since_refresh += 1;
            std::thread::sleep(TITLE_REFRESH_INTERVAL);
        }
    });
}

// MARK: - Menu Construction

fn build_static_menu(app: &App) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let menu = Menu::new(app)?;

    // First item, and the primary way back in once close-to-tray means the main
    // window can be hidden with no other affordance on screen.
    let open = MenuItem::with_id(app, "open-dial8", "Open Native Intelligence", true, None::<&str>)?;
    menu.append(&open)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let no_meetings = MenuItem::with_id(app, "header", "No upcoming meetings", false, None::<&str>)?;
    menu.append(&no_meetings)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let version = app.config().version.clone().unwrap_or_default();
    let update_label = format!("Check for Updates (v{})", version);
    let check_updates = MenuItem::with_id(app, "check-for-updates", &update_label, true, None::<&str>)?;
    menu.append(&check_updates)?;

    let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
    menu.append(&settings)?;

    #[cfg(target_os = "windows")]
    menu.append(&MenuItem::with_id(app, native_id(OPEN_LICENSES), "Open Source Licenses", true, None::<&str>)?)?;

    menu.append(&PredefinedMenuItem::separator(app)?)?;

    let quit = MenuItem::with_id(app, native_id(QUIT), "Quit Native Intelligence", true, None::<&str>)?;
    menu.append(&quit)?;

    Ok(menu)
}

fn rebuild_tray_menu(app_handle: &AppHandle) {
    let cache = {
        let state = app_handle.state::<AppState>();
        let c = state.calendar_cache.lock().unwrap();
        (c.today_events.clone(), c.tomorrow_events.clone())
    };

    let (today_events, tomorrow_events) = cache;

    let menu = match Menu::new(app_handle) {
        Ok(m) => m,
        Err(e) => {
            tlog(&format!("[tray] failed to create menu: {}", e));
            return;
        }
    };

    // Helper closure for appending menu items (ignores errors)
    let app = app_handle;

    // Restore affordance first — see build_static_menu. Rebuilt here too because
    // rebuild_tray_menu replaces the whole menu every ~5 min.
    let _ = menu.append(&MenuItem::with_id(app, "open-dial8", "Open Native Intelligence", true, None::<&str>).unwrap());
    let _ = menu.append(&PredefinedMenuItem::separator(app).unwrap());

    // Header
    let header_text = if let Some(next) = find_next_meeting(&today_events) {
        let now = Local::now();
        if let Some(start) = parse_iso8601(&next.start) {
            if start <= now {
                "In progress".to_string()
            } else {
                format!("Starts {}", format_countdown(&next))
            }
        } else {
            "No upcoming meetings".to_string()
        }
    } else {
        "No upcoming meetings".to_string()
    };

    let _ = menu.append(&MenuItem::with_id(app, "header", &header_text, false, None::<&str>).unwrap());

    // Today's events
    if !today_events.is_empty() {
        let _ = menu.append(&PredefinedMenuItem::separator(app).unwrap());

        for event in &today_events {
            let label = format_event_label(event);
            let submenu_id = format!("event-sub-{}", event.id);
            let start_id = format!("start-event-{}", event.id);

            if let Ok(submenu) = Submenu::with_id(app, &submenu_id, &label, true) {
                if let Ok(start_item) = MenuItem::with_id(app, &start_id, "Start Capture", true, None::<&str>) {
                    let _ = submenu.append(&start_item);
                }
                let _ = menu.append(&submenu);
            }
        }
    }

    // Tomorrow's events
    if !tomorrow_events.is_empty() {
        let _ = menu.append(&PredefinedMenuItem::separator(app).unwrap());

        let _ = menu.append(
            &MenuItem::with_id(app, "tomorrow-header", "Tomorrow", false, None::<&str>).unwrap(),
        );

        for event in &tomorrow_events {
            let label = format_event_label(event);
            let submenu_id = format!("event-sub-{}", event.id);
            let start_id = format!("start-event-{}", event.id);

            if let Ok(submenu) = Submenu::with_id(app, &submenu_id, &label, true) {
                if let Ok(start_item) = MenuItem::with_id(app, &start_id, "Start Capture", true, None::<&str>) {
                    let _ = submenu.append(&start_item);
                }
                let _ = menu.append(&submenu);
            }
        }
    }

    append_local_agents(&menu, app);
    append_browser_exit(&menu, app);

    // App actions
    let _ = menu.append(&PredefinedMenuItem::separator(app).unwrap());
    let version = app.config().version.clone().unwrap_or_default();
    let update_label = format!("Check for Updates (v{})", version);
    let _ = menu.append(&MenuItem::with_id(app, "check-for-updates", &update_label, true, None::<&str>).unwrap());
    let _ = menu.append(&MenuItem::with_id(app, "settings", "Settings", true, None::<&str>).unwrap());
    #[cfg(target_os = "windows")]
    let _ = menu.append(&MenuItem::with_id(app, native_id(OPEN_LICENSES), "Open Source Licenses", true, None::<&str>).unwrap());
    let _ = menu.append(&PredefinedMenuItem::separator(app).unwrap());
    let _ = menu.append(&MenuItem::with_id(app, native_id(QUIT), "Quit Native Intelligence", true, None::<&str>).unwrap());

    // Apply menu to tray
    if let Some(tray) = app_handle.tray_by_id("dial8-tray") {
        let _ = tray.set_menu(Some(menu));
    }
}

/// The cloud browser's Mac exit (dial8-website docs/plans/cloud-browser.md, C4):
/// while it runs, say so, with the sites it reached today. Nothing otherwise.
fn append_browser_exit(menu: &Menu<tauri::Wry>, app: &AppHandle) {
    let view = BROWSER_EXIT.lock().unwrap().clone();
    let Some(view) = view else { return };
    let _ = menu.append(&PredefinedMenuItem::separator(app).unwrap());
    let title = if view.up { "Agent's browser is using this Mac" } else { "Agent's browser: connecting to this Mac…" };
    if let Ok(submenu) = Submenu::with_id(app, "browser-exit", title, true) {
        let heading = match view.total {
            0 => "No sites yet today".to_string(),
            1 => "1 site today".to_string(),
            n => format!("{n} sites today"),
        };
        if let Ok(item) = MenuItem::with_id(app, "browser-exit-sites", &heading, false, None::<&str>) {
            let _ = submenu.append(&item);
        }
        for (i, site) in view.sites.iter().enumerate() {
            if let Ok(item) = MenuItem::with_id(app, format!("browser-exit-site-{i}"), &site.host, false, None::<&str>) {
                let _ = submenu.append(&item);
            }
        }
        let _ = menu.append(&submenu);
    }
}

/// Local agents (dial8-website docs/plans/local-agents.md §1, invariant 6):
/// each job running on this Mac with a Stop, and the one switch that turns
/// them off. Nothing until a folder is shared.
fn append_local_agents(menu: &Menu<tauri::Wry>, app: &AppHandle) {
    let view = LOCAL_AGENTS.lock().unwrap().clone();
    let Some(view) = view.filter(|v| v.shown) else { return };
    let _ = menu.append(&PredefinedMenuItem::separator(app).unwrap());
    for job in &view.jobs {
        let title = match job.state {
            TrayJobState::Working => format!("Working in {}", job.label),
            TrayJobState::Waiting => format!("Waiting in {}", job.label),
            TrayJobState::Asking => format!("Needs you in {}", job.label),
            TrayJobState::Stopping => format!("Stopping in {}", job.label),
        };
        if job.state == TrayJobState::Stopping {
            if let Ok(item) = MenuItem::with_id(app, format!("local-agent-{}", job.id), &title, false, None::<&str>) {
                let _ = menu.append(&item);
            }
            continue;
        }
        if let Ok(submenu) = Submenu::with_id(app, format!("local-agent-{}", job.id), &title, true) {
            if let Ok(stop) = MenuItem::with_id(app, native_id(format!("{LOCAL_AGENT_STOP}{}", job.id)), "Stop", true, None::<&str>) {
                let _ = submenu.append(&stop);
            }
            let _ = menu.append(&submenu);
        }
    }
    if let Ok(toggle) = CheckMenuItem::with_id(app, native_id(LOCAL_AGENTS_TOGGLE), "Local Agents", true, !view.off, None::<&str>) {
        let _ = menu.append(&toggle);
    }
    let l4 = &view.l4;
    if l4.model_shown() {
        append_l4_submenu(menu, app, "local-agent-model", &l4.model_title(), &native_id(LOCAL_AGENT_MODEL), l4.model_menu());
    }
    if l4.workers_shown() {
        append_l4_submenu(menu, app, "local-agent-workers", "Coding Agents", &native_id(LOCAL_AGENT_WORKER), l4.workers_menu());
    }
}

/// Local Agents → Model and → Coding Agents (teammate-agent L4): Native Intelligence or a
/// model on Ollama or LM Studio on this Mac, and the person's yes to Claude
/// Code and Codex. Each only when there is something to pick
/// ([`crate::local_agent::workers::L4View`]). Native only, like the switch:
/// no webview command changes them.
fn append_l4_submenu(
    menu: &Menu<tauri::Wry>,
    app: &AppHandle,
    id: &str,
    title: &str,
    prefix: &str,
    lines: Vec<crate::local_agent::workers::MenuLine>,
) {
    use crate::local_agent::workers::MenuLine;
    let Ok(submenu) = Submenu::with_id(app, id, title, true) else { return };
    for (i, line) in lines.into_iter().enumerate() {
        let _ = match line {
            MenuLine::Choice { id, label, checked } => {
                CheckMenuItem::with_id(app, format!("{prefix}{id}"), &label, true, checked, None::<&str>)
                    .and_then(|item| submenu.append(&item))
            }
            MenuLine::Note(text) => MenuItem::with_id(app, format!("{id}-note-{i}"), &text, false, None::<&str>)
                .and_then(|item| submenu.append(&item)),
            MenuLine::Separator => PredefinedMenuItem::separator(app).and_then(|item| submenu.append(&item)),
        };
    }
    let _ = menu.append(&submenu);
}

fn format_event_label(event: &CalendarEvent) -> String {
    let time_range = match (parse_iso8601(&event.start), parse_iso8601(&event.end)) {
        (Some(start), Some(end)) => {
            format!(
                "{}  {} - {}",
                event.title,
                start.format("%-I:%M %p"),
                end.format("%-I:%M %p")
            )
        }
        _ => event.title.clone(),
    };

    // Add "Now" indicator for in-progress events
    let now = Local::now();
    if let (Some(start), Some(end)) = (parse_iso8601(&event.start), parse_iso8601(&event.end)) {
        if start <= now && end > now {
            return format!("{}  \u{25CF} Now", time_range);
        }
    }

    time_range
}

// MARK: - Tray Title

fn update_tray_title(app_handle: &AppHandle) {
    let today_events = {
        let state = app_handle.state::<AppState>();
        let c = state.calendar_cache.lock().unwrap();
        c.today_events.clone()
    };

    let tray = match app_handle.tray_by_id("dial8-tray") {
        Some(t) => t,
        None => return,
    };

    // Once the main window can be hidden, the menu bar is the ONLY place a live
    // recording (or a voice session) is still visible — without this the mic is
    // on with zero on-screen trace. On a busy capture lock, what it showed stays.
    let now = mic_use(app_handle);
    let mic = {
        let mut shown = SHOWN_MIC.lock().unwrap();
        *shown = now.unwrap_or(*shown);
        *shown
    };
    // try_lock, never lock: the local agents' view is swapped in by another
    // thread. On contention the agents part is skipped for one tick.
    let jobs: Vec<TrayJob> = LOCAL_AGENTS
        .try_lock()
        .ok()
        .and_then(|g| g.as_ref().map(|v| v.jobs.clone()))
        .unwrap_or_default();
    let meeting = find_next_meeting(&today_events)
        .map(|next| (truncate_title(&next.title, MAX_TITLE_LENGTH), format_countdown(next)));
    let agents = local_agents_title(&jobs, meeting.is_some());
    let title = compose_title(mic, meeting, agents);
    let _ = tray.set_title(title.as_deref());
    // A Windows tray icon has no title beside it: the same words go in its
    // tooltip.
    #[cfg(target_os = "windows")]
    let _ = tray.set_tooltip(Some(match &title {
        Some(t) => format!("Native Intelligence · {t}"),
        None => "Native Intelligence".to_string(),
    }));
}

/// The menu bar title's local agents part (local-agents.md §5, "Native Intelligence is
/// working in dial8-website"; the Native Intelligence icon is right beside it): only
/// while a turn runs, never for an idle, asking or stopping job. Shorter
/// beside a meeting's countdown.
fn local_agents_title(jobs: &[TrayJob], beside_meeting: bool) -> Option<String> {
    let working: Vec<&TrayJob> = jobs.iter().filter(|j| j.state == TrayJobState::Working).collect();
    match working.as_slice() {
        [] => None,
        [one] => {
            let max = if beside_meeting {
                AGENT_LABEL_BESIDE_MEETING
            } else {
                MAX_TITLE_LENGTH
            };
            Some(format!("Working in {}", truncate_title(&one.label, max)))
        }
        many => Some(format!("{} agents working", many.len())),
    }
}

/// " ● Rec Standup · in 5m · Working in site" (" ● Mic …" for a voice
/// session): each part only when it applies; `None` clears the title.
fn compose_title(mic: MicUse, meeting: Option<(String, String)>, agents: Option<String>) -> Option<String> {
    let rec_prefix = match mic {
        MicUse::Off => "",
        MicUse::Voice => "\u{25CF} Mic ",
        MicUse::Capture => "\u{25CF} Rec ",
    };
    let mic_on = mic != MicUse::Off;
    let agents_suffix = agents.as_deref().map(|a| format!(" \u{00B7} {a}")).unwrap_or_default();
    match (meeting, agents) {
        (Some((title, countdown)), _) => Some(format!(" {rec_prefix}{title} \u{00B7} {countdown}{agents_suffix}")),
        (None, Some(_)) if mic_on => Some(format!(" {}{agents_suffix}", rec_prefix.trim_end())),
        (None, Some(a)) => Some(format!(" {a}")),
        (None, None) if mic_on => Some(format!(" {}", rec_prefix.trim_end())),
        (None, None) => None,
    }
}

// MARK: - Calendar Fetch

#[derive(Deserialize)]
struct CalendarApiResponse {
    events: Vec<CalendarEvent>,
}

async fn refresh_calendar_cache(app_handle: &AppHandle) {
    let token = {
        let state = app_handle.state::<AppState>();
        let guard = state.auth_token.lock().unwrap();
        guard.clone()
    };

    let now = Local::now();
    let today_start = now
        .date_naive()
        .and_hms_opt(0, 0, 0)
        .and_then(local_datetime);
    let tomorrow_end = now
        .date_naive()
        .succ_opt()
        .and_then(|d| d.succ_opt())
        .and_then(|d| d.and_hms_opt(0, 0, 0))
        .and_then(local_datetime);

    let (Some(time_min), Some(time_max)) = (today_start, tomorrow_end) else {
        tlog("[tray] failed to compute date range");
        return;
    };

    // Collect all events from both sources
    let mut all_events: Vec<CalendarEvent> = Vec::new();

    // 1. Fetch server events (requires auth token)
    if let Some(ref token) = token {
        let url = format!(
            "{}/api/calendar/events?timeMin={}&timeMax={}&maxResults=200",
            api_base_url(),
            time_min.to_rfc3339(),
            time_max.to_rfc3339()
        );

        tlog(&format!("fetching calendar from server: {}", url));

        let client = reqwest::Client::new();
        match client
            .get(&url)
            .header("Authorization", format!("Bearer {}", token))
            .timeout(Duration::from_secs(15))
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                match response.json::<CalendarApiResponse>().await {
                    Ok(api_response) => {
                        tlog(&format!(
                            "server API returned {} events",
                            api_response.events.len()
                        ));
                        all_events.extend(api_response.events);
                    }
                    Err(e) => {
                        tlog(&format!("[tray] failed to parse calendar response: {}", e));
                    }
                }
            }
            Ok(response) => {
                tlog(&format!(
                    "[tray] calendar API returned status {}",
                    response.status()
                ));
            }
            Err(e) => {
                tlog(&format!("[tray] calendar fetch error: {}", e));
            }
        }
    } else {
        tlog("no auth token — skipping server calendar fetch");
    }

    // 2. Fetch local Exchange events via EventKit sidecar
    let local_events = fetch_local_exchange_events(&time_min.to_rfc3339(), &time_max.to_rfc3339()).await;
    let local_count = local_events.len();
    if local_count > 0 {
        tlog(&format!("local Exchange returned {} events", local_count));
        all_events.extend(local_events);
    }

    // 3. Deduplicate by title+start+end (same event from OAuth and local)
    dedup_events(&mut all_events);

    tlog(&format!(
        "total events after merge+dedup: {}",
        all_events.len()
    ));

    let now_chrono = Local::now();
    let today_date = now_chrono.date_naive();
    let tomorrow_date = today_date.succ_opt().unwrap_or(today_date);

    // Split events into today (remaining, non-all-day) and tomorrow (non-all-day, up to 5)
    let mut today_events: Vec<CalendarEvent> = Vec::new();
    let mut tomorrow_events: Vec<CalendarEvent> = Vec::new();

    for event in all_events {
        if event.is_all_day {
            continue;
        }

        let (start_dt, end_dt) = match (parse_iso8601(&event.start), parse_iso8601(&event.end)) {
            (Some(s), Some(e)) => (s, e),
            _ => continue,
        };

        let event_date = start_dt.date_naive();

        if event_date == today_date && end_dt > now_chrono {
            today_events.push(event);
        } else if event_date == tomorrow_date {
            tomorrow_events.push(event);
        }
    }

    // Sort by parsed start time: sources mix UTC ("...Z") and local offsets
    // ("...-05:00"), so the raw strings don't order chronologically.
    today_events.sort_by_key(|e| parse_iso8601(&e.start));
    tomorrow_events.sort_by_key(|e| parse_iso8601(&e.start));
    tomorrow_events.truncate(5);

    let event_count = today_events.len() + tomorrow_events.len();

    // Store in cache
    {
        let state = app_handle.state::<AppState>();
        let mut cache = state.calendar_cache.lock().unwrap();
        cache.today_events = today_events;
        cache.tomorrow_events = tomorrow_events;
        cache.last_refresh = Some(std::time::Instant::now());
    }

    tlog(&format!(
        "[tray] calendar cache refreshed: {} events",
        event_count
    ));
}

/// Fetch local Exchange calendar events from macOS Calendar.app via the sidecar.
/// Returns an empty vec if EventKit access is not granted or no Exchange calendars exist.
async fn fetch_local_exchange_events(time_min: &str, time_max: &str) -> Vec<CalendarEvent> {
    use crate::commands::calendar::get_local_exchange_events;

    match get_local_exchange_events(time_min.to_string(), time_max.to_string()).await {
        Ok(events) => events,
        Err(e) => {
            // This is expected if user hasn't connected local Exchange — don't spam logs
            if !e.contains("not granted") {
                tlog(&format!("[tray] local Exchange fetch error: {}", e));
            }
            Vec::new()
        }
    }
}

/// Deduplicate events by title + start time (truncated to minute).
/// When duplicates exist, prefer server events over local ones.
fn dedup_events(events: &mut Vec<CalendarEvent>) {
    use std::collections::HashSet;

    let mut seen = HashSet::new();
    events.retain(|event| {
        // Normalize start time to the UTC minute for dedup: the same meeting
        // can arrive as "...T15:00:00.000Z" from one source and
        // "...T10:00:00-05:00" from another.
        let start_key = match parse_iso8601(&event.start) {
            Some(dt) => (dt.timestamp().div_euclid(60)).to_string(),
            None => event.start.chars().take(16).collect::<String>(),
        };
        let key = format!("{}|{}", event.title.to_lowercase(), start_key);
        seen.insert(key)
    });
}

// MARK: - Menu Event Handler

/// Find and focus the best app window.
/// Prefers the focused window, then "main", then any workspace window, then any non-HUD window.
///
/// This is also THE restore path for close-to-tray — the tray "Open Native Intelligence" item,
/// the macOS Dock-click (RunEvent::Reopen), and the single-instance second-launch
/// callback all funnel through here rather than growing their own copies. `show()`
/// un-hides a `hide()`-ed window (not just a minimized one), which is exactly what
/// the CloseRequested interception leaves behind.
pub(crate) fn focus_main_window(app: &AppHandle) -> bool {
    // Every borderless always-on-top overlay this app can float. Both must be
    // excluded everywhere below: a HUD that happens to be focused is NOT the
    // window the user asked to restore, and satisfying the request with it
    // would swallow the restore and leave main hidden. (`crate::is_hud_label`
    // owns the label set for every subsystem.)
    use crate::is_hud_label as is_hud;

    // Check if any window is already focused — return it
    for (label, window) in app.webview_windows() {
        if is_hud(&label) {
            continue;
        }
        if window.is_focused().unwrap_or(false) {
            let _ = window.show();
            return true;
        }
    }

    // Try the default "main" label
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        return true;
    }

    // Fallback: find any workspace window or non-HUD window
    for (label, window) in app.webview_windows() {
        if !is_hud(&label) {
            tlog(&format!("focusing fallback window: {}", label));
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
            return true;
        }
    }

    tlog("no main window found to focus");
    false
}

/// Bring the MAIN window forward unconditionally, for tray items that emit a
/// one-shot the dashboard acts on.
///
/// Distinct from `focus_main_window` on purpose: that one satisfies a bare
/// "show me the app" request and short-circuits on any already-focused non-HUD
/// window, which leaves a workspace popout frontmost. The web side elects the
/// MAIN window to handle broadcast tray one-shots (so two open windows can't
/// both act on one click), so the tray must surface the window that will do the
/// work — otherwise the intent runs in a hidden window and its navigation and
/// toasts are invisible. This also matches pre-popout semantics, where a tray
/// intent always ran in main's workspace.
///
/// Falls back to `focus_main_window` when there is no `main` (close-to-tray off
/// + main closed while a popout keeps the process alive), so the click still
/// surfaces something.
fn surface_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    focus_main_window(app);
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    // Native actions only for an id carrying this launch's prefix
    // ([`native_prefix`]); the prefix itself is never logged.
    if let Some(native) = id.strip_prefix(native_prefix()) {
        tlog(&format!("menu event (native): {}", native));
        handle_native_menu_event(app, native);
        return;
    }
    tlog(&format!("menu event: {}", id));
    match id {
        "open-dial8" => {
            focus_main_window(app);
        }
        // Every arm below emits an event whose ONLY consumer is the main
        // webview's UI, so each restores main first (as "settings" already
        // did). With close-to-tray, main is routinely hidden when a tray item
        // is clicked — emitting without restoring dead-ends the event in an
        // invisible window and the click silently does nothing.
        //
        // `surface_main_window`, not `focus_main_window`: these emits are
        // broadcasts that the web side elects the MAIN window to handle, so the
        // window brought forward must be the one that will act. Emits stay
        // broadcasts so older web bundles (which act in whichever window hears
        // them) keep working.
        "check-for-updates" => {
            surface_main_window(app);
            let _ = app.emit("check-for-updates", ());
        }
        "settings" => {
            surface_main_window(app);
            let _ = app.emit("navigate", "/account/settings");
        }
        _ if id.starts_with("start-event-") => {
            surface_main_window(app);
            let event_id = id.strip_prefix("start-event-").unwrap_or("");
            // Find the full event in cache and emit it so the frontend can call from-event API
            let event_payload = {
                let state = app.state::<AppState>();
                let cache = state.calendar_cache.lock().unwrap();
                cache
                    .today_events
                    .iter()
                    .chain(cache.tomorrow_events.iter())
                    .find(|e| e.id == event_id)
                    .cloned()
            };
            if let Some(event) = event_payload {
                let _ = app.emit("start-capture-from-event", &event);
            } else {
                // Fallback: emit just the id so frontend can handle it
                let _ = app.emit("start-capture-from-event", serde_json::json!({ "id": event_id }));
            }
        }
        _ if id.starts_with("event-") => {
            surface_main_window(app);
            let event_id = id.strip_prefix("event-").unwrap_or("");
            let _ = app.emit("tray-meeting-clicked", event_id);
        }
        _ => {}
    }
}

/// The tray items that act natively, by their id with this launch's
/// [`native_prefix`] already removed. Only [`handle_menu_event`] calls it, and
/// only for an id that carried the prefix.
fn handle_native_menu_event(app: &AppHandle, id: &str) {
    match id {
        QUIT => {
            app.exit(0);
        }
        #[cfg(target_os = "windows")]
        OPEN_LICENSES => open_licenses(app),
        // Native only: no webview command turns local agents on or off.
        LOCAL_AGENTS_TOGGLE => {
            let off = LOCAL_AGENTS.lock().unwrap().as_ref().is_some_and(|v| !v.off);
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let Some(svc) = app.try_state::<LocalAgentService>() else { return };
                if let Err(e) = svc.set_off(off).await {
                    tlog(&format!("local agents switch failed: {e}"));
                    // The check item flipped itself; put it back (off this
                    // task: drawing waits on the main thread).
                    std::thread::spawn(move || rebuild_tray_menu(&app));
                }
            });
        }
        // Native only, like the switch: no webview command sets the model.
        _ if id.starts_with(LOCAL_AGENT_MODEL) => {
            let Some(choice) = crate::local_agent::workers::ModelChoice::from_menu_id(&id[LOCAL_AGENT_MODEL.len()..]) else {
                return;
            };
            let current = LOCAL_AGENTS.lock().unwrap().as_ref().and_then(|v| v.l4.choice.clone());
            let app = app.clone();
            if current.as_ref() == Some(&choice) {
                // A re-click unchecked the current choice: check it again.
                std::thread::spawn(move || rebuild_tray_menu(&app));
                return;
            }
            tauri::async_runtime::spawn(async move {
                let Some(svc) = app.try_state::<LocalAgentService>() else { return };
                if let Err(e) = svc.set_model(choice).await {
                    tlog(&format!("choosing the local agents' model failed: {e}"));
                    // The check item flipped itself; put it back.
                    std::thread::spawn(move || rebuild_tray_menu(&app));
                }
            });
        }
        _ if id.starts_with(LOCAL_AGENT_WORKER) => {
            let Ok(worker) = crate::local_agent::workers::Worker::parse(&id[LOCAL_AGENT_WORKER.len()..]) else {
                return;
            };
            let allowed = LOCAL_AGENTS
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|v| v.l4.workers.contains(&(worker, true)));
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let Some(svc) = app.try_state::<LocalAgentService>() else { return };
                if let Err(e) = svc.allow_worker(worker, !allowed).await {
                    tlog(&format!("allowing a coding agent failed: {e}"));
                    // The check item flipped itself; put it back.
                    std::thread::spawn(move || rebuild_tray_menu(&app));
                }
            });
        }
        _ if id.starts_with(LOCAL_AGENT_STOP) => {
            let job_id = id.strip_prefix(LOCAL_AGENT_STOP).unwrap_or("").to_string();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let Some(svc) = app.try_state::<LocalAgentService>() else { return };
                if let Err(e) = svc.stop(job_id).await {
                    tlog(&format!("stopping a local agent failed: {e}"));
                }
            });
        }
        _ => {}
    }
}

// MARK: - Helpers

/// A local wall-clock time as a `DateTime`, without panicking on a DST
/// change: an ambiguous time takes the earlier instant, and a skipped one
/// (midnight in zones that change at 00:00) the hour after it.
fn local_datetime(dt: chrono::NaiveDateTime) -> Option<DateTime<Local>> {
    Local
        .from_local_datetime(&dt)
        .earliest()
        .or_else(|| Local.from_local_datetime(&(dt + chrono::Duration::hours(1))).earliest())
}

fn parse_iso8601(s: &str) -> Option<DateTime<Local>> {
    // Try parsing with timezone info first
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.with_timezone(&Local));
    }
    // Try ISO8601 with fractional seconds
    if let Ok(dt) = chrono::DateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.fZ") {
        return Some(dt.with_timezone(&Local));
    }
    // Try UTC without timezone
    if let Ok(dt) = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
        return Some(Local.from_utc_datetime(&dt));
    }
    // Try date-only (all-day events)
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        return d
            .and_hms_opt(0, 0, 0)
            .and_then(local_datetime);
    }
    None
}

fn find_next_meeting(events: &[CalendarEvent]) -> Option<&CalendarEvent> {
    let now = Local::now();

    // First look for in-progress meeting
    let in_progress = events.iter().find(|e| {
        if let (Some(start), Some(end)) = (parse_iso8601(&e.start), parse_iso8601(&e.end)) {
            start <= now && end > now
        } else {
            false
        }
    });

    if in_progress.is_some() {
        return in_progress;
    }

    // Then look for next upcoming
    events.iter().find(|e| {
        if let Some(start) = parse_iso8601(&e.start) {
            start > now
        } else {
            false
        }
    })
}

/// Format countdown text matching the native app's StatusBarController.statusBarTimeText
fn format_countdown(event: &CalendarEvent) -> String {
    let now = Local::now();

    let Some(start) = parse_iso8601(&event.start) else {
        return String::new();
    };
    let Some(end) = parse_iso8601(&event.end) else {
        return String::new();
    };

    let interval = start.signed_duration_since(now).num_seconds();

    if interval < 0 {
        // In progress — show time remaining until end
        let remaining = end.signed_duration_since(now).num_seconds();
        if remaining < 60 {
            return "ending".to_string();
        }
        let mins = remaining / 60;
        if mins >= 60 {
            let hours = mins / 60;
            let rem_mins = mins % 60;
            if rem_mins > 0 {
                return format!("{}h {}m left", hours, rem_mins);
            }
            return format!("{}h left", hours);
        }
        return format!("{}m left", mins);
    } else if interval < 60 {
        return "now".to_string();
    } else if interval < 3600 {
        let minutes = interval / 60;
        return format!("in {}m", minutes);
    } else {
        let hours = interval / 3600;
        let minutes = (interval % 3600) / 60;
        if minutes > 0 {
            return format!("in {}h {}m", hours, minutes);
        }
        return format!("in {}h", hours);
    }
}

fn truncate_title(title: &str, max_len: usize) -> String {
    if title.chars().count() <= max_len {
        title.to_string()
    } else {
        let truncated: String = title.chars().take(max_len - 1).collect();
        format!("{}\u{2026}", truncated)
    }
}

/// Windows: open the installer's THIRD_PARTY_NOTICES.txt in the default
/// text viewer (off the main thread: the opener waits on the shell).
#[cfg(target_os = "windows")]
fn open_licenses(app: &AppHandle) {
    use tauri_plugin_opener::OpenerExt;
    let notices = app.path().resource_dir().map(|d| d.join("Licenses").join("THIRD_PARTY_NOTICES.txt"));
    let app = app.clone();
    std::thread::spawn(move || {
        let opened = notices
            .map_err(|e| e.to_string())
            .and_then(|path| app.opener().open_path(path.to_string_lossy(), None::<&str>).map_err(|e| e.to_string()));
        if let Err(e) = opened {
            tlog(&format!("open source licenses: {e}"));
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_ids_carry_this_launchs_prefix_and_strip_back() {
        let prefix = native_prefix();
        assert!(prefix.starts_with('n') && prefix.ends_with(':') && prefix.len() == 34, "{prefix}");
        // Stable for the launch: every item and the handler agree.
        assert_eq!(native_prefix(), prefix);
        for base in [QUIT, LOCAL_AGENTS_TOGGLE, "local-agent-worker:claude-code", "local-agent-stop-abc"] {
            let id = native_id(base);
            assert_eq!(id.strip_prefix(native_prefix()), Some(base));
        }
    }

    #[test]
    fn a_forged_id_without_the_prefix_never_reaches_a_native_action() {
        // What a menu built elsewhere (hostile web JS, if core:menu ever came
        // back) would carry: the bare base ids, or a guessed prefix.
        for forged in [
            "quit",
            "local-agents-toggle",
            "local-agent-worker:claude-code",
            "local-agent-model:relay",
            "local-agent-stop-abc",
            "n00000000000000000000000000000000:local-agent-worker:codex",
        ] {
            assert_eq!(forged.strip_prefix(native_prefix()), None, "{forged}");
        }
    }

    fn job(label: &str, state: TrayJobState) -> TrayJob {
        TrayJob {
            id: format!("id-{label}"),
            label: label.into(),
            state,
        }
    }

    #[test]
    fn the_title_says_a_local_agent_is_working_only_while_its_turn_runs() {
        assert_eq!(local_agents_title(&[], false), None);
        for idle in [TrayJobState::Waiting, TrayJobState::Asking, TrayJobState::Stopping] {
            assert_eq!(local_agents_title(&[job("site", idle)], false), None, "{idle:?}");
        }
        let one = [
            job("dial8-website", TrayJobState::Working),
            job("other", TrayJobState::Waiting),
        ];
        assert_eq!(
            local_agents_title(&one, false).as_deref(),
            Some("Working in dial8-website")
        );
        // Shorter beside a meeting's countdown.
        assert_eq!(
            local_agents_title(&one, true).as_deref(),
            Some("Working in dial8-websi\u{2026}")
        );
        let long = [job("a-very-long-folder-name-indeed", TrayJobState::Working)];
        assert_eq!(
            local_agents_title(&long, false).as_deref(),
            Some("Working in a-very-long-folder-\u{2026}")
        );
        let two = [job("a", TrayJobState::Working), job("b", TrayJobState::Working)];
        assert_eq!(local_agents_title(&two, true).as_deref(), Some("2 agents working"));
    }

    #[test]
    fn the_title_keeps_the_meeting_and_recording_parts_as_they_were() {
        let meeting = || Some(("Standup".to_string(), "in 5m".to_string()));
        let agents = || Some("Working in site".to_string());
        // Unchanged without a local agent.
        assert_eq!(
            compose_title(MicUse::Off, meeting(), None).as_deref(),
            Some(" Standup \u{00B7} in 5m")
        );
        assert_eq!(
            compose_title(MicUse::Capture, meeting(), None).as_deref(),
            Some(" \u{25CF} Rec Standup \u{00B7} in 5m")
        );
        assert_eq!(compose_title(MicUse::Capture, None, None).as_deref(), Some(" \u{25CF} Rec"));
        assert_eq!(compose_title(MicUse::Off, None, None), None);
        // With one, after the rest.
        assert_eq!(
            compose_title(MicUse::Off, meeting(), agents()).as_deref(),
            Some(" Standup \u{00B7} in 5m \u{00B7} Working in site")
        );
        assert_eq!(
            compose_title(MicUse::Capture, None, agents()).as_deref(),
            Some(" \u{25CF} Rec \u{00B7} Working in site")
        );
        assert_eq!(
            compose_title(MicUse::Off, None, agents()).as_deref(),
            Some(" Working in site")
        );
    }

    #[test]
    fn the_title_says_the_mic_is_on_for_a_voice_session_too() {
        let meeting = || Some(("Standup".to_string(), "in 5m".to_string()));
        assert_eq!(compose_title(MicUse::Voice, None, None).as_deref(), Some(" \u{25CF} Mic"));
        assert_eq!(
            compose_title(MicUse::Voice, meeting(), None).as_deref(),
            Some(" \u{25CF} Mic Standup \u{00B7} in 5m")
        );
        assert_eq!(
            compose_title(MicUse::Voice, None, Some("Working in site".into())).as_deref(),
            Some(" \u{25CF} Mic \u{00B7} Working in site")
        );
    }
}

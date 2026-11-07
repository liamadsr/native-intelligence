use tauri::{AppHandle, State, Webview};

use crate::state::AppState;

fn tlog(msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = crate::open_log(&crate::side_log_path("dial8-tray.log")) {
        let _ = writeln!(f, "[{}] {}", chrono::Local::now().format("%H:%M:%S"), msg);
    }
    eprintln!("[tray] {}", msg);
}

/// Receive the Supabase access token from the frontend.
/// Called whenever the auth state changes (login, token refresh, logout).
/// Sets a flag so the polling thread triggers an immediate calendar refresh.
#[tauri::command]
pub fn set_auth_token(app: AppHandle, webview: Webview, state: State<'_, AppState>, token: String) {
    let is_new_token = !token.is_empty();
    let token_len = token.len();
    let before = {
        let mut auth = state.auth_token.lock().unwrap();
        std::mem::replace(&mut *auth, if is_new_token { Some(token) } else { None })
    };
    // The cloud browser's Mac exit serves the signed-in account only: a sign-out or another account
    // stops it. The main window's session decides (a pop-out's passing sign-out never does).
    if webview.label() == "main" {
        let after = state.auth_token.lock().unwrap().clone();
        crate::browser_exit::on_session_change(&app, before.as_deref(), after.as_deref());
    }
    if is_new_token {
        *state.auth_token_changed.lock().unwrap() = true;
    }
    tlog(&format!(
        "auth token {} (len={})",
        if is_new_token { "SET" } else { "CLEARED" },
        token_len
    ));
}

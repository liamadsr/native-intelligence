/**
 * Raw HTML route handler for the meeting detection HUD.
 * Returns a self-contained HTML page that completely bypasses Next.js layouts,
 * providers, and React rendering. This prevents the HUD window from
 * ever loading the full app UI or being affected by navigation in the main window.
 *
 * Uses window.__TAURI__ (requires withGlobalTauri: true in tauri.conf.json).
 */

export async function GET() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Meeting HUD</title>
<script>
  try {
    var theme = localStorage.getItem('theme')
    if (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
      document.documentElement.classList.add('dark')
    }
  } catch(e) {}
</script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: transparent !important; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; -webkit-user-select: none; user-select: none; cursor: default; }

  /* Childless drag surface under the card content: this HUD window is
     decorations(false), so without a data-tauri-drag-region it cannot be
     moved at all. Buttons sit above it (positioned, later in DOM / higher z);
     the passive info text lets the drag layer take the mousedown. */
  .drag-layer { position: absolute; inset: 0; }

  :root {
    --bg: #ffffff;
    --fg: #0a0a0a;
    --muted: #737373;
    --border: #e5e5e5;
    --surface: #f5f5f5;
    --accent-bg: #f0f0f0;
    --popover-bg: #ffffff;
    --progress-bg: #e5e5e5;
    --progress-fill: #3b82f6;
    --progress-fill-auto: #ef4444;
  }
  .dark {
    --bg: #0a0a0a;
    --fg: #fafafa;
    --muted: #a3a3a3;
    --border: #262626;
    --surface: #171717;
    --accent-bg: #262626;
    --popover-bg: #171717;
    --progress-bg: #262626;
    --progress-fill: #3b82f6;
    --progress-fill-auto: #ef4444;
  }

  .hud-card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 16px;
    box-shadow: 0 2px 8px rgba(0,0,0,0.06);
    position: relative;
    overflow: hidden;
  }
  .hud-inner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
  }
  .info { flex: 1; min-width: 0; }
  .info-title { font-size: 14px; font-weight: 600; color: var(--fg); }
  .info-sub { font-size: 12px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .info-event {
    font-size: 11px; color: var(--muted); white-space: nowrap;
    overflow: hidden; text-overflow: ellipsis; margin-top: 1px;
  }

  .progress-bar {
    height: 3px; background: var(--progress-bg);
  }
  .progress-fill {
    height: 100%; width: 100%;
    background: var(--progress-fill);
    transition: width 0.1s linear;
  }
  .progress-fill.auto { background: var(--progress-fill-auto); }

  .dismiss {
    position: absolute; left: -6px; top: -6px; z-index: 10;
    width: 18px; height: 18px; border-radius: 50%;
    background: rgba(107,114,128,0.8); border: none; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    opacity: 0; pointer-events: none; transition: opacity 0.15s;
    color: white; padding: 0; line-height: 1;
  }
  .dismiss svg { width: 12px; height: 12px; }
  #cardWrapper:hover .dismiss { opacity: 1; pointer-events: auto; }
  .dismiss:hover { background: rgba(75,85,99,1); }

  .btn-group {
    display: flex; align-items: center; border-radius: 12px;
    border: 1px solid var(--border); background: var(--surface);
    overflow: hidden; flex-shrink: 0;
  }
  .btn-capture {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 14px; border: none; background: transparent;
    font-size: 14px; font-weight: 600; color: var(--fg);
    cursor: pointer; white-space: nowrap;
  }
  .btn-capture:hover { background: var(--accent-bg); }
  .btn-capture svg { width: 16px; height: 16px; }
  .btn-chevron {
    display: flex; align-items: center; padding: 8px;
    border: none; border-left: 1px solid var(--border);
    background: transparent; color: var(--muted); cursor: pointer;
  }
  .btn-chevron:hover { background: var(--accent-bg); color: var(--fg); }
  .btn-chevron svg { width: 14px; height: 14px; }

  .rec-dot {
    position: relative; display: inline-flex; width: 8px; height: 8px;
  }
  .rec-dot .ping {
    position: absolute; width: 100%; height: 100%; border-radius: 50%;
    background: #f87171; opacity: 0.75;
    animation: ping 1s cubic-bezier(0,0,0.2,1) infinite;
  }
  .rec-dot .dot {
    position: relative; width: 8px; height: 8px; border-radius: 50%;
    background: #ef4444;
  }
  @keyframes ping { 75%, 100% { transform: scale(2); opacity: 0; } }

  .dropdown {
    position: fixed; z-index: 20;
    margin-top: 6px; width: 256px; border-radius: 12px;
    border: 1px solid var(--border); background: var(--popover-bg);
    box-shadow: 0 2px 8px rgba(0,0,0,0.08); overflow: hidden;
    display: none;
  }
  .dropdown.open { display: block; }
  .dropdown-header {
    padding: 6px 10px; font-size: 11px; font-weight: 500;
    text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted);
  }
  .dropdown-scroll { max-height: 140px; overflow-y: auto; }
  .dropdown-item {
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 8px 10px; border: none; background: transparent;
    text-align: left; font-size: 12px; color: var(--fg); cursor: pointer;
  }
  .dropdown-item:hover { background: var(--accent-bg); }
  .dropdown-item.selected { background: var(--accent-bg); }
  .dropdown-item svg { width: 12px; height: 12px; color: var(--muted); flex-shrink: 0; }
  .dropdown-item .evt-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dropdown-item .evt-time { flex-shrink: 0; color: var(--muted); }
  .dropdown-footer {
    padding: 6px 10px; border-top: 1px solid var(--border);
    font-size: 11px; color: var(--muted);
  }
  .dropdown-empty {
    padding: 12px 10px; text-align: center; font-size: 12px; color: var(--muted);
  }
  .hidden { display: none; }
</style>
</head>
<body>
  <div id="hud" class="hidden">
    <div style="position:relative; margin: 8px;" id="cardWrapper">
      <button class="dismiss" id="dismissBtn" title="Dismiss">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    <div class="hud-card" id="card">
      <div class="drag-layer" data-tauri-drag-region></div>
      <div class="hud-inner">
        <div class="info">
          <div class="info-title">Meeting detected</div>
          <div class="info-sub" id="appName"></div>
          <div class="info-event hidden" id="eventName"></div>
        </div>
        <div style="position:relative" id="btnContainer">
          <div class="btn-group">
            <button class="btn-capture" id="captureBtn">
              <svg viewBox="0 0 34 34" fill="currentColor">
                <path d="M19.598 18.5C18.7696 19.9349 16.9348 20.4265 15.4999 19.5981C14.065 18.7696 13.5734 16.9349 14.4018 15.5C15.2303 14.0651 17.065 13.5735 18.4999 14.4019C19.9348 15.2303 20.4264 17.0651 19.598 18.5Z"/>
                <path d="M23.232 10.2058C22.6797 11.1623 21.4565 11.4901 20.4999 10.9378C19.5433 10.3855 19.2156 9.16235 19.7679 8.20576C20.3201 7.24918 21.5433 6.92143 22.4999 7.47371C23.4565 8.026 23.7842 9.24918 23.232 10.2058Z"/>
                <path d="M19.7679 25.7944C19.2156 24.8378 19.5433 23.6146 20.4999 23.0623C21.4565 22.51 22.6797 22.8378 23.232 23.7944C23.7843 24.7509 23.4565 25.9741 22.4999 26.5264C21.5433 27.0787 20.3202 26.7509 19.7679 25.7944Z"/>
                <path d="M25.9999 19.0001C24.8953 19.0001 23.9999 18.1047 23.9999 17.0001C23.9999 15.8956 24.8953 15.0001 25.9999 15.0001C27.1045 15.0001 27.9999 15.8956 27.9999 17.0001C27.9999 18.1047 27.1045 19.0001 25.9999 19.0001Z"/>
                <path d="M14.232 25.7942C13.6797 26.7508 12.4565 27.0786 11.4999 26.5263C10.5433 25.974 10.2156 24.7508 10.7679 23.7942C11.3201 22.8376 12.5433 22.5099 13.4999 23.0622C14.4565 23.6145 14.7842 24.8376 14.232 25.7942Z"/>
                <path d="M10.7679 10.2059C10.2157 9.24936 10.5434 8.02618 11.5 7.4739C12.4566 6.92161 13.6798 7.24936 14.232 8.20595C14.7843 9.16253 14.4566 10.3857 13.5 10.938C12.5434 11.4903 11.3202 11.1625 10.7679 10.2059Z"/>
                <path d="M7.99999 19.0002C6.89542 19.0002 5.99999 18.1047 5.99999 17.0002C5.99999 15.8956 6.89542 15.0002 7.99999 15.0002C9.10456 15.0002 9.99999 15.8956 9.99999 17.0002C9.99999 18.1047 9.10456 19.0002 7.99999 19.0002Z"/>
                <path d="M25.8659 3.64359C25.5898 4.12188 24.9782 4.28575 24.4999 4.00961C24.0216 3.73347 23.8577 3.12188 24.1339 2.64359C24.41 2.16529 25.0216 2.00142 25.4999 2.27756C25.9782 2.5537 26.1421 3.16529 25.8659 3.64359Z"/>
                <path d="M33.0001 18.0002C32.4478 18.0002 32.0001 17.5524 32.0001 17.0002C32.0001 16.4479 32.4478 16.0002 33.0001 16.0002C33.5523 16.0002 34.0001 16.4479 34.0001 17.0002C34.0001 17.5524 33.5523 18.0002 33.0001 18.0002Z"/>
                <path d="M31.3561 9.86594C30.8778 10.1421 30.2663 9.97821 29.9901 9.49992C29.714 9.02162 29.8778 8.41003 30.3561 8.13389C30.8344 7.85775 31.446 8.02162 31.7222 8.49992C31.9983 8.97821 31.8344 9.5898 31.3561 9.86594Z"/>
                <path d="M30.3563 25.866C29.878 25.5899 29.7141 24.9783 29.9903 24.5C30.2664 24.0217 30.878 23.8578 31.3563 24.134C31.8346 24.4101 31.9985 25.0217 31.7223 25.5C31.4462 25.9783 30.8346 26.1422 30.3563 25.866Z"/>
                <path d="M16.0001 33.0001C16.0001 32.4478 16.4478 32.0001 17.0001 32.0001C17.5524 32.0001 18.0001 32.4478 18.0001 33.0001C18.0001 33.5524 17.5524 34.0001 17.0001 34.0001C16.4478 34.0001 16.0001 33.5524 16.0001 33.0001Z"/>
                <path d="M24.134 31.3566C23.8579 30.8783 24.0218 30.2667 24.5001 29.9905C24.9784 29.7144 25.59 29.8783 25.8661 30.3566C26.1422 30.8349 25.9784 31.4464 25.5001 31.7226C25.0218 31.9987 24.4102 31.8349 24.134 31.3566Z"/>
                <path d="M9.86593 31.3564C9.58978 31.8347 8.97819 31.9986 8.4999 31.7224C8.02161 31.4463 7.85773 30.8347 8.13388 30.3564C8.41002 29.8781 9.02161 29.7142 9.4999 29.9904C9.97819 30.2665 10.1421 30.8781 9.86593 31.3564Z"/>
                <path d="M1 18.0001C0.447715 18.0001 -3.44684e-08 17.5524 0 17.0001C3.44684e-08 16.4478 0.447715 16.0001 1 16.0001C1.55228 16.0001 2 16.4478 2 17.0001C2 17.5524 1.55228 18.0001 1 18.0001Z"/>
                <path d="M3.64329 25.866C3.16499 26.1422 2.5534 25.9783 2.27726 25.5C2.00112 25.0217 2.16499 24.4101 2.64329 24.134C3.12158 23.8578 3.73317 24.0217 4.00931 24.5C4.28545 24.9783 4.12158 25.5899 3.64329 25.866Z"/>
                <path d="M2.6435 9.86602C2.1652 9.58987 2.00133 8.97828 2.27747 8.49999C2.55361 8.0217 3.1652 7.85782 3.6435 8.13397C4.12179 8.41011 4.28566 9.0217 4.00952 9.49999C3.73338 9.97828 3.12179 10.1422 2.6435 9.86602Z"/>
                <path d="M16.0001 1C16.0001 0.447715 16.4478 -4.87226e-08 17.0001 0C17.5524 4.87226e-08 18.0001 0.447715 18.0001 1C18.0001 1.55228 17.5524 2 17.0001 2C16.4478 2 16.0001 1.55228 16.0001 1Z"/>
                <path d="M8.13398 3.64371C7.85783 3.16542 8.02171 2.55383 8.5 2.27768C8.97829 2.00154 9.58988 2.16542 9.86603 2.64371C10.1422 3.122 9.97829 3.73359 9.5 4.00973C9.02171 4.28588 8.41012 4.122 8.13398 3.64371Z"/>
              </svg>
              <span id="captureLabel">Capture</span>
            </button>
            <button class="btn-chevron" id="chevronBtn">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
            </button>
          </div>
          <div class="dropdown" id="dropdown">
            <div class="dropdown-header">Link to event</div>
            <div class="dropdown-scroll" id="eventList"></div>
            <div class="dropdown-footer hidden" id="linkedInfo"></div>
          </div>
        </div>
      </div>
      <div class="progress-bar" id="progressBar">
        <div class="progress-fill" id="progressFill"></div>
      </div>
    </div>
    </div>
  </div>

  <script>
    // Wait for Tauri to inject __TAURI__ globals
    function waitForTauri(cb) {
      if (window.__TAURI__) { cb(); return; }
      var attempts = 0;
      var interval = setInterval(function() {
        attempts++;
        if (window.__TAURI__ || attempts > 50) {
          clearInterval(interval);
          if (window.__TAURI__) cb();
        }
      }, 100);
    }

    waitForTauri(function() {
      var invoke = window.__TAURI__.core.invoke;
      var listen = window.__TAURI__.event.listen;

      var hudData = null;
      var events = [];
      var selectedEvent = null;
      var dropdownOpen = false;
      var captureStarted = false;

      // Timer state
      var AUTO_RECORD_DURATION = 10; // seconds
      var MANUAL_DURATION = 20; // seconds
      var TICK_INTERVAL = 50; // ms — smooth progress bar
      var timerElapsed = 0; // ms elapsed
      var timerDuration = 0; // ms total
      var timerInterval = null;
      var timerPaused = false;
      var timerStarted = false;
      var timerCompleted = false;

      var hud = document.getElementById('hud');
      var card = document.getElementById('card');
      var appName = document.getElementById('appName');
      var eventName = document.getElementById('eventName');
      var captureBtn = document.getElementById('captureBtn');
      var captureLabel = document.getElementById('captureLabel');
      var chevronBtn = document.getElementById('chevronBtn');
      var dropdown = document.getElementById('dropdown');
      var eventList = document.getElementById('eventList');
      var linkedInfo = document.getElementById('linkedInfo');
      var dismissBtn = document.getElementById('dismissBtn');
      var progressBar = document.getElementById('progressBar');
      var progressFill = document.getElementById('progressFill');

      // Pause timer when cursor is over the HUD window.
      // Transparent Tauri windows don't receive mouse events without focus,
      // so we poll a Rust command that checks cursor position vs window bounds.
      setInterval(function() {
        if (!timerStarted || timerCompleted || captureStarted) return;
        invoke('is_cursor_over_hud').then(function(over) {
          timerPaused = over;
        }).catch(function() {});
      }, 200);

      function startTimer() {
        if (timerStarted || timerCompleted || captureStarted) return;
        timerStarted = true;
        timerElapsed = 0;
        timerDuration = (hudData && hudData.isAutoRecord ? AUTO_RECORD_DURATION : MANUAL_DURATION) * 1000;
        progressFill.classList.toggle('auto', !!(hudData && hudData.isAutoRecord));
        updateProgressBar();

        timerInterval = setInterval(function() {
          if (timerPaused || dropdownOpen) return;
          timerElapsed += TICK_INTERVAL;
          updateProgressBar();

          if (timerElapsed >= timerDuration) {
            clearInterval(timerInterval);
            timerInterval = null;
            timerCompleted = true;
            onTimerComplete();
          }
        }, TICK_INTERVAL);
      }

      function stopTimer() {
        if (timerInterval) {
          clearInterval(timerInterval);
          timerInterval = null;
        }
      }

      function updateProgressBar() {
        var pct = Math.max(0, 100 - (timerElapsed / timerDuration) * 100);
        progressFill.style.width = pct + '%';
      }

      function onTimerComplete() {
        if (captureStarted) return;
        if (hudData && hudData.isAutoRecord) {
          // Auto-record: start capture
          captureStarted = true;
          invoke('request_capture_from_hud', { event: selectedEvent || null });
          // Show capturing state briefly then hide
          render();
          setTimeout(function() {
            invoke('hide_meeting_hud').catch(function() {});
          }, 800);
        } else {
          // Manual: dismiss without capturing
          invoke('dismiss_meeting_detection').catch(function() {});
          invoke('hide_meeting_hud').catch(function() {});
        }
      }

      function formatTime(iso) {
        return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      }

      function render() {
        if (!hudData) { hud.classList.add('hidden'); return; }
        hud.classList.remove('hidden');
        appName.textContent = hudData.displayName;

        // Show linked event name
        if (selectedEvent) {
          eventName.textContent = selectedEvent.title;
          eventName.classList.remove('hidden');
        } else {
          eventName.classList.add('hidden');
        }

        if (captureStarted) {
          // Already capturing — show recording indicator
          captureLabel.innerHTML = '<span class="rec-dot"><span class="ping"></span><span class="dot"></span></span> Capturing';
          captureLabel.style.display = 'flex';
          captureLabel.style.alignItems = 'center';
          captureLabel.style.gap = '6px';
          progressBar.style.display = 'none';
        } else if (hudData.isAutoRecord) {
          // Auto-record countdown
          var secsLeft = Math.ceil((timerDuration - timerElapsed) / 1000);
          captureLabel.textContent = 'Starting in ' + secsLeft + 's';
          captureLabel.style.display = '';
          progressBar.style.display = '';
        } else {
          // Manual — show capture button
          captureLabel.textContent = 'Capture';
          captureLabel.style.display = '';
          progressBar.style.display = '';
        }

        renderDropdown();
      }

      function calendarSvg() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
      }

      function renderDropdown() {
        dropdown.classList.toggle('open', dropdownOpen);
        if (!dropdownOpen) return;

        // Position the fixed dropdown below the button container
        var btnRect = document.getElementById('btnContainer').getBoundingClientRect();
        dropdown.style.top = (btnRect.bottom + 6) + 'px';
        dropdown.style.right = (window.innerWidth - btnRect.right) + 'px';

        eventList.innerHTML = '';
        if (events.length === 0) {
          eventList.innerHTML = '<div class="dropdown-empty">No events today</div>';
        } else {
          var noEvt = document.createElement('button');
          noEvt.className = 'dropdown-item' + (!selectedEvent ? ' selected' : '');
          noEvt.innerHTML = calendarSvg() + '<span>No event</span>';
          noEvt.onclick = function() {
            selectedEvent = null; dropdownOpen = false;
            resizeHud(false);
            if (captureStarted) invoke('hud_link_event', { event: null }).catch(function() {});
            render();
          };
          eventList.appendChild(noEvt);

          events.forEach(function(evt) {
            var btn = document.createElement('button');
            btn.className = 'dropdown-item' + (selectedEvent && selectedEvent.id === evt.id ? ' selected' : '');
            btn.innerHTML = calendarSvg() + '<span class="evt-title">' + escapeHtml(evt.title) + '</span><span class="evt-time">' + formatTime(evt.start) + '</span>';
            btn.onclick = function() {
              selectedEvent = evt; dropdownOpen = false;
              resizeHud(false);
              if (captureStarted) invoke('hud_link_event', { event: evt }).catch(function() {});
              render();
            };
            eventList.appendChild(btn);
          });
        }

        if (selectedEvent) {
          linkedInfo.classList.remove('hidden');
          linkedInfo.textContent = 'Linked: ' + selectedEvent.title;
        } else {
          linkedInfo.classList.add('hidden');
        }
      }

      function escapeHtml(str) {
        var div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
      }

      captureBtn.onclick = function() {
        if (captureStarted) return;
        // Both auto-record and manual: clicking the button starts capture immediately
        stopTimer();
        captureStarted = true;
        invoke('request_capture_from_hud', { event: selectedEvent || null });
        render();
        setTimeout(function() {
          invoke('hide_meeting_hud').catch(function() {});
        }, 800);
      };

      dismissBtn.onclick = function() {
        stopTimer();
        invoke('dismiss_meeting_detection').catch(function() {});
        invoke('hide_meeting_hud').catch(function() {});
      };

      var HUD_COLLAPSED_HEIGHT = 86;
      var HUD_EXPANDED_HEIGHT = 310;
      var HUD_WIDTH = 380;

      function resizeHud(expanded) {
        var h = expanded ? HUD_EXPANDED_HEIGHT : HUD_COLLAPSED_HEIGHT;
        invoke('resize_meeting_hud', { width: HUD_WIDTH, height: h }).catch(function() {});
      }

      chevronBtn.onclick = function(e) {
        e.stopPropagation();
        dropdownOpen = !dropdownOpen;
        resizeHud(dropdownOpen);
        render();
      };

      // pointerdown, not mousedown: Tauri's drag script swallows mousedown when
      // a drag starts on the drag-layer, which would leave the dropdown open
      // while the HUD is being moved.
      document.addEventListener('pointerdown', function(e) {
        if (dropdownOpen && !document.getElementById('btnContainer').contains(e.target)) {
          dropdownOpen = false;
          resizeHud(false);
          render();
        }
      });

      var eventsLoaded = false;

      // Update countdown label every second while timer is running
      setInterval(function() {
        if (timerStarted && !timerCompleted && !captureStarted && hudData && hudData.isAutoRecord) {
          var secsLeft = Math.ceil((timerDuration - timerElapsed) / 1000);
          captureLabel.textContent = 'Starting in ' + secsLeft + 's';
        }
      }, 250);

      function initHud() {
        if (!hudData || !eventsLoaded) return;
        if (timerStarted) return; // already initialized
        render();
        startTimer();
      }

      // Page-lifetime listeners (never unlistened). Guard the promises: if the
      // event plugin isn't granted to this window, listen() rejects; surface
      // it instead of an unhandled rejection (same as the agent HUD).
      Promise.resolve(listen('meeting-hud-data', function(e) {
        hudData = e.payload;
        initHud();
        render();
      })).catch(function(err) { console.error('[meeting-hud] failed to subscribe to meeting-hud-data', err); });

      Promise.resolve(listen('meeting-ended', function() {
        stopTimer();
        invoke('hide_meeting_hud').catch(function() {});
      })).catch(function(err) { console.error('[meeting-hud] failed to subscribe to meeting-ended', err); });

      // Fetch calendar events FIRST so timer can start with the right event selected
      invoke('get_cached_calendar_events').then(function(evts) {
        var now = new Date();
        events = evts.filter(function(e) { return !e.isAllDay && new Date(e.end) > now; });
        var current = events.find(function(e) { return new Date(e.start) <= now && new Date(e.end) > now; });
        if (current) selectedEvent = current;
        eventsLoaded = true;
        render();

        // Now fetch meeting detection state — events are ready
        return invoke('get_meeting_detection_state');
      }).then(function(state) {
        if (state && state.detectedApp && (state.state === 'detected' || state.state === 'recording')) {
          hudData = {
            displayName: state.detectedApp.displayName,
            bundleId: state.detectedApp.bundleId,
            isAutoRecord: state.isAutoRecord,
          };
          initHud();
          render();
        }
      }).catch(function() {
        // Even if calendar fetch fails, mark as loaded and proceed
        eventsLoaded = true;
        invoke('get_meeting_detection_state').then(function(state) {
          if (state && state.detectedApp && (state.state === 'detected' || state.state === 'recording')) {
            hudData = {
              displayName: state.detectedApp.displayName,
              bundleId: state.detectedApp.bundleId,
              isAutoRecord: state.isAutoRecord,
            };
            initHud();
            render();
          }
        }).catch(function() {});
      });
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

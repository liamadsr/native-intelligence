//! `voice_replay auto`: Auto (noise design WP7) against the quiet room, on
//! the synthetic scenes (cold and warm) and on debug captures (closed loop),
//! with every `--vary auto.k=a,b` variant in one run.
//!
//! Per scene: when Auto switched to the noisy room (or `-`), how often it
//! switched, false cuts before and after the switch (the quiet room's for
//! reference), the user's words it lost against the quiet room, false turns,
//! and whether its actions are the quiet room's (a quiet scene should be).
//! Per capture: the switch, and every barge-in with the level of its run (the
//! user near S, a TV well under it), against the quiet room's barge-ins.

use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

use super::closed::{self, ClosedRun, ClosedSetup};
use super::{arg_value, metrics, real_dsp, run_scene, scene_set, set_tuning, sim, tuning_arg, CaptureData};
use crate::voice::events::NoiseMode;
use crate::voice::profile::Tuning;
use crate::voice::trace::Input;
use crate::voice::turn::Action;

/// `base` and every combination of the `--vary key=a,b,c` values.
pub fn variants(base: Tuning, args: &[String]) -> Result<Vec<(String, Tuning)>, String> {
    let mut variants: Vec<(String, Tuning)> = vec![(String::new(), base)];
    for (i, a) in args.iter().enumerate() {
        if a != "--vary" {
            continue;
        }
        let kv = args.get(i + 1).ok_or("--vary key=a,b,c")?;
        let (k, vs) = kv.split_once('=').ok_or(format!("--vary {kv}: key=a,b,c"))?;
        let mut next = Vec::new();
        for (name, t) in &variants {
            for v in vs.split(',') {
                let mut t = *t;
                set_tuning(&mut t, k, v)?;
                let short = k.rsplit('.').next().unwrap_or(k);
                next.push((format!("{name}{}{short}={v}", if name.is_empty() { "" } else { " " }), t));
            }
        }
        variants = next;
    }
    Ok(variants)
}

fn s(ms: u64) -> String {
    format!("{:.1}", ms as f64 / 1000.0)
}

/// The run's switches, as `12.3→noisy 140.0→quiet`.
fn switches(actions: &[(u64, Action)]) -> Vec<(u64, NoiseMode)> {
    actions.iter().filter_map(|(w, a)| if let Action::NoiseMode { mode, .. } = a { Some((*w, *mode)) } else { None }).collect()
}

fn switch_text(sw: &[(u64, NoiseMode)]) -> String {
    if sw.is_empty() {
        return "-".into();
    }
    sw.iter().map(|(w, m)| format!("{}→{}", s(*w), if *m == NoiseMode::Noisy { "noisy" } else { "quiet" })).collect::<Vec<_>>().join(" ")
}

/// The loudest VAD level in a barge-in's run (its onset to the fire).
fn barge_level(run: &ClosedRun, wall: u64, onset: u64) -> Option<f32> {
    run.inputs
        .iter()
        .filter(|(w, _)| *w <= wall)
        .filter_map(|(_, i)| match i {
            Input::Vad { start, level_db, .. } if *start >= onset => Some(*level_db),
            _ => None,
        })
        .fold(None, |m: Option<f32>, l| Some(m.map_or(l, |m| m.max(l))))
}

/// Turns (a dictation's text counts as one) and their words.
fn words(actions: &[(u64, Action)]) -> (usize, usize) {
    let turns: Vec<&String> = actions
        .iter()
        .filter_map(|(_, a)| match a {
            Action::Turn { text, .. } | Action::End { text: Some(text), .. } => Some(text),
            _ => None,
        })
        .collect();
    (turns.len(), turns.iter().map(|t| t.split_whitespace().count()).sum())
}

/// One capture, closed loop: the quiet room, then each variant from each
/// hint. Lines to print.
fn capture_lines(dir: &str, variants: &[(String, Tuning)], hints: &[closed::Hint], verbose: bool) -> Result<Vec<String>, String> {
    let data = CaptureData::load(Path::new(dir))?;
    let name = Path::new(dir).file_name().map_or(dir.to_string(), |f| f.to_string_lossy().to_string());
    let run_from = |t: &Tuning, hint: Option<f32>| -> Result<ClosedRun, String> {
        let (canceller, vad) = real_dsp().ok_or("no ONNX Runtime for Silero")?;
        closed::replay_closed(&data, canceller, true, vad, ClosedSetup { tuning: *t, speech_hint: hint, extend_cut_ms: 4_000 })
    };
    let quiet = run_from(&Tuning::QUIET, None)?;
    let describe = |run: &ClosedRun, switch_at: Option<u64>| -> String {
        run.barge_ins
            .iter()
            .map(|(w, onset)| {
                let side = match switch_at {
                    Some(at) if *w >= at => "after",
                    Some(_) => "before",
                    None => "",
                };
                let lvl = barge_level(run, *w, *onset).map_or("?".into(), |l| format!("{l:.0}"));
                format!("{}@{lvl}dB{}{side}", s(*w), if side.is_empty() { "" } else { " " })
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let (qt, qw) = words(&quiet.actions);
    let mut out = vec![format!("{name}"), format!("  quiet     turns {qt} ({qw} words) | barge-ins [{}]", describe(&quiet, None))];
    for (vname, t) in variants {
        let mut cold_end = None;
        for &h in hints {
            let hint = match h {
                closed::Hint::Cold => None,
                closed::Hint::Db(db) => Some(db),
                closed::Hint::Remember => {
                    if cold_end.is_none() {
                        cold_end = Some(run_from(t, None)?.speech_end.filter(|s| s.1).map(|s| s.0));
                    }
                    cold_end.flatten()
                }
            };
            let run = run_from(t, hint)?;
            if h == closed::Hint::Cold {
                cold_end = Some(run.speech_end.filter(|s| s.1).map(|s| s.0));
            }
            let sw = switches(&run.actions);
            let at = sw.iter().find(|x| x.1 == NoiseMode::Noisy).map(|x| x.0);
            let (tn, wn) = words(&run.actions);
            out.push(format!(
                "  {:<9} switch {} | turns {tn} ({wn} words, {:+} vs quiet) | barge-ins [{}] | S end {}{}",
                match (h, hint) {
                    (closed::Hint::Cold, _) => "cold".to_string(),
                    (_, Some(db)) => format!("{db:.1}"),
                    (_, None) => "mem -".to_string(),
                },
                switch_text(&sw),
                wn as i64 - qw as i64,
                describe(&run, at),
                run.speech_end.map_or("-".into(), |(db, m)| format!("{db:.1}{}", if m { "" } else { " (unmeasured)" })),
                if vname.is_empty() { String::new() } else { format!(" | {vname}") }
            ));
            if verbose {
                for (w, a) in &run.actions {
                    if let Action::NoiseMode { reason, .. } = a {
                        out.push(format!("            {}: {reason}", s(*w)));
                    }
                }
            }
        }
    }
    Ok(out)
}

/// `voice_replay auto [--long] [--masked] [--scene NAME] [--set auto.k=v]...
/// [--vary auto.k=a,b]... [--capture DIR]... [--capture-hint cold,remember]
/// [--no-scenes]`.
pub fn cli_auto(args: &[String]) -> Result<(), String> {
    let mut auto_args = args.to_vec();
    auto_args.extend(["--profile".to_string(), "auto".to_string()]);
    let base = tuning_arg(&auto_args)?;
    let variants = variants(base, args)?;
    let hints = closed::Hint::parse_list(&arg_value(args, "--capture-hint").unwrap_or_else(|| "cold,remember".into()))?;
    let captures: Vec<String> =
        args.iter().enumerate().filter(|(_, a)| a.as_str() == "--capture").filter_map(|(i, _)| args.get(i + 1).cloned()).collect();
    let verbose = args.iter().any(|a| a == "--why");
    if !captures.is_empty() {
        println!("captures, closed loop (barge-ins: wall s @ the loudest level of the run; before/after the switch)");
        let lines: Vec<Result<Vec<String>, String>> = std::thread::scope(|sc| {
            let hs: Vec<_> = captures.iter().map(|c| sc.spawn(|| capture_lines(c, &variants, &hints, verbose))).collect();
            hs.into_iter().map(|h| h.join().unwrap_or_else(|_| Err("a capture panicked".into()))).collect()
        });
        for (c, l) in captures.iter().zip(lines) {
            match l {
                Ok(l) => l.iter().for_each(|l| println!("{l}")),
                Err(e) => println!("{c}: skipped: {e}"),
            }
        }
    }
    if args.iter().any(|a| a == "--no-scenes") {
        return Ok(());
    }

    // The scenes cold and warm; the quiet room once (it has no S).
    let cold_args: Vec<String> = args.iter().filter(|a| a.as_str() != "--warm").cloned().collect();
    let (cold, bench) = scene_set(&cold_args)?;
    let warm: Vec<sim::SceneSpec> = cold.iter().map(|s| sim::SceneSpec { warm: true, ..s.clone() }).collect();
    let n = cold.len();
    // Jobs: (tuning index: 0 = quiet, 1.. = variants; warm; scene).
    let mut jobs: Vec<(usize, bool, usize)> = (0..n).map(|sc| (0, false, sc)).collect();
    for v in 0..variants.len() {
        for w in [false, true] {
            jobs.extend((0..n).map(|sc| (v + 1, w, sc)));
        }
    }
    let tunings: Vec<Tuning> = std::iter::once(Tuning::QUIET).chain(variants.iter().map(|v| v.1)).collect();
    let next = AtomicUsize::new(0);
    type Out = Result<(metrics::Metrics, Vec<(u64, Action)>), String>;
    let results: Mutex<Vec<Option<Out>>> = Mutex::new((0..jobs.len()).map(|_| None).collect());
    let workers = std::thread::available_parallelism().map_or(8, |n| n.get());
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| loop {
                let j = next.fetch_add(1, Ordering::Relaxed);
                let Some(&(t, w, sc)) = jobs.get(j) else { break };
                let spec = if w { &warm[sc] } else { &cold[sc] };
                let r = run_scene(spec, &bench, &tunings[t]).map(|(mix, run)| (metrics::measure(&mix, &run), run.actions));
                results.lock().unwrap()[j] = Some(r);
            });
        }
    });
    let results: Vec<(metrics::Metrics, Vec<(u64, Action)>)> =
        results.into_inner().unwrap().into_iter().map(|r| r.expect("every job ran")).collect::<Result<_, _>>()?;
    let quiet = &results[..n];
    println!("\nscenes: switch (s) | false switches | false cuts before/after the switch (quiet) | user words lost vs quiet | false turns (quiet) | true barges (quiet) | same actions as quiet");
    for (v, (vname, t)) in variants.iter().enumerate() {
        println!("\n{} ({}){}", t.profile.name(), t.label, if vname.is_empty() { String::new() } else { format!(" {vname}") });
        let (mut false_switches, mut tv_switch, mut lost, mut cuts_before, mut cuts_after) = (0usize, Vec::new(), 0i64, 0usize, 0usize);
        for (wi, w) in [false, true].iter().enumerate() {
            for sc in 0..n {
                let (m, actions) = &results[n + v * 2 * n + wi * n + sc];
                let (q, q_actions) = &quiet[sc];
                let spec = &cold[sc];
                let tv = spec.tv_rel_db.is_some();
                let sw = &m.noise_switches;
                if !tv && sw.iter().any(|x| x.1 == NoiseMode::Noisy) {
                    false_switches += 1;
                }
                if tv {
                    tv_switch.push(m.switched_at().map_or("-".into(), s));
                }
                let (b, a) = m.false_cuts_split();
                cuts_before += b;
                cuts_after += a;
                let d = m.clipped_words as i64 - q.clipped_words as i64;
                lost += d;
                println!(
                    "  {:<26} {:<4} switch {:<22} | cuts {b}/{a} ({}) | words lost {:+} ({} vs {}) | false turns {} ({}) | true barges {}/{} ({}/{}) | {}",
                    spec.name,
                    if *w { "warm" } else { "cold" },
                    switch_text(sw.as_slice()),
                    q.false_cuts,
                    d,
                    m.clipped_words,
                    q.clipped_words,
                    m.false_turns,
                    q.false_turns,
                    m.true_barges_detected,
                    m.true_barge_chances,
                    q.true_barges_detected,
                    q.true_barge_chances,
                    if actions == q_actions { "same" } else { "differs" }
                );
            }
        }
        println!(
            "  summary: false switches {false_switches} | TV switch at [{}] | false cuts before/after {cuts_before}/{cuts_after} | user words lost vs quiet {lost:+}",
            tv_switch.join(" ")
        );
    }
    Ok(())
}

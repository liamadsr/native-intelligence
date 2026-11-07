#!/usr/bin/env python3
"""Edge cases for the dial8-local-tts sidecar, over protocol v1 (bench.sh runs it).

  edge.py --sidecar .out/bin/dial8-local-tts --models DIR [--voice aba] [--json OUT.json]

Checks, in one session:
  long      a 120-word sentence with no commas: split into pieces, spoken at a
            normal pace (3.3-4.6 words per second of audio; this prose reads
            at ~3.6), not truncated. Unsplit, it hits the engine's 40 s cap.
  numbers   a sentence with 15 amounts, as the host's normalizer spells them out
  oversized a frame over 1 MiB: error text_too_long for its id (not fatal), and
            the sidecar keeps working; text over 12,000 bytes: text_too_long
  quotes    text the engine reduces to nothing: done with 0 s, not an error
  tiny      the shortest text the engine does speak: done with audio (no
            audio for speakable text is an engine failure, synthesis_failed)
  nul       a \\u0000 in the text is dropped, not the rest of the text
  cancel    cancel around the boundary between two pieces: stops within 100 ms,
            no audio after `cancelled`, the queued speak dropped too
Standard library only; prints PASS/FAIL per check and exits 1 on any FAIL.
"""
import argparse
import json
import statistics
import sys
import time

from drive import KIND_JSON, Sidecar, assets, frame

LONG = ("The quarterly planning review covered the new onboarding flow and the changes the design team made "
        "after the last round of customer interviews and the engineering team walked through the migration "
        "plan for the billing service while the sales leads described what they heard from the three largest "
        "accounts in the pilot and everyone agreed that the launch date should hold as long as the support "
        "team gets the updated help articles and the training videos two weeks before the public announcement "
        "goes out to the mailing list and the partners hear about it first from their account managers during "
        "the regular monthly check in calls that already sit on the shared team calendar for the whole of next month")

ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
        "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]


def say(n):
    """English words for 0 <= n < 10**9, the way the host spells amounts out."""
    if n < 20:
        return ONES[n]
    if n < 100:
        return TENS[n // 10] + ("" if n % 10 == 0 else " " + ONES[n % 10])
    if n < 1000:
        return ONES[n // 100] + " hundred" + ("" if n % 100 == 0 else " " + say(n % 100))
    for size, name in ((10**6, "million"), (1000, "thousand")):
        if n >= size:
            return say(n // size) + " " + name + ("" if n % size == 0 else " " + say(n % size))


AMOUNTS = [1234567, 2345678, 12345678, 987654, 45210, 3999999, 150075, 7250300, 64128, 810446, 5555555, 2020202,
           333019, 71850, 9100001]
NUMBERS = ("Revenue went from " + " then to ".join(say(a) + " dollars" for a in AMOUNTS)
           + " by the end of September two thousand twenty six.")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sidecar", required=True)
    ap.add_argument("--models", required=True)
    ap.add_argument("--voice")
    ap.add_argument("--threads", type=int, default=2)
    ap.add_argument("--lsd-steps", type=int, default=8)
    ap.add_argument("--json")
    ap.add_argument("--show-log", action="store_true")
    args = ap.parse_args()

    sc = Sidecar(args.sidecar)
    sc.wait_json("hello")
    sc.send({"type": "configure", "assets": assets(args.models), "threads": args.threads, "lsdSteps": args.lsd_steps})
    i = sc.wait_for(lambda e: e[1] == "json" and e[2].get("type") in ("ready", "error"))
    if sc.events[i][2]["type"] != "ready":
        sys.exit(f"sidecar failed: {sc.events[i][2]}")
    voice = args.voice or sc.events[i][2]["voices"][0]

    results, ok = {}, True

    def check(name, passed, detail):
        nonlocal ok
        ok &= bool(passed)
        results[name] = {"pass": bool(passed), "detail": detail}
        print(f"  {'PASS' if passed else 'FAIL'}  {name}: {detail}", file=sys.stderr)

    def speak(sid, text, timeout=180):
        """Speak and wait: (the done/error message, audio events, t_send)."""
        start = len(sc.events)
        t = sc.send({"type": "speak", "id": sid, "text": text, "voice": voice})
        end = sc.wait_for(lambda e: e[1] == "json" and e[2].get("id") == sid and e[2].get("type") in ("done", "error"),
                          start, timeout)
        started = [e for e in sc.events[start:end] if e[1] == "json" and e[2].get("type") == "started"]
        audio = [e for e in sc.events[start:end] if e[1] == "audio"]
        return sc.events[end][2], audio, t, len(started)

    def pieces(sid):
        for line in sc.log:
            if line.startswith(f"{sid}: ") and " pieces " in line:
                return int(line.split()[1])
        return 1

    # long: one sentence, 120 words, no commas.
    words = len(LONG.split())
    msg, audio, _, nstarted = speak("long", LONG)
    secs = msg.get("audioSeconds", 0)
    wps = words / secs if secs else 0
    check("long", msg["type"] == "done" and not msg.get("truncated") and nstarted == 1 and pieces("long") >= 4
          and 3.3 <= wps <= 4.6 and abs(sum(e[2] for e in audio) / 24000 - secs) < 0.01,
          f"{words} words → {pieces('long')} pieces, {secs:.2f}s ({wps:.2f} words/s), one started, "
          f"truncated {msg.get('truncated', False)}")

    # numbers: 15 spelled-out amounts in one sentence.
    words = len(NUMBERS.split())
    msg, audio, _, _ = speak("numbers", NUMBERS)
    secs = msg.get("audioSeconds", 0)
    wps = words / secs if secs else 0
    check("numbers", msg["type"] == "done" and not msg.get("truncated") and 2.5 <= wps <= 5,
          f"{words} words ({len(NUMBERS)} bytes) → {pieces('numbers')} pieces, {secs:.2f}s ({wps:.2f} words/s), "
          f"truncated {msg.get('truncated', False)}")

    # oversized: a frame over 1 MiB, then text over 12,000 bytes; both leave the session running.
    start = len(sc.events)
    big = json.dumps({"id": "huge", "text": "word " * 220000, "type": "speak", "voice": voice}).encode()
    sc.proc.stdin.write(frame(KIND_JSON, big))
    sc.proc.stdin.flush()
    err = sc.events[sc.wait_json("error", start, id="huge")][2]
    msg, _, _, _ = speak("too-long", "word " * 2500)
    after, _, _, _ = speak("after-huge", "Still here.")
    check("oversized", err["code"] == "text_too_long" and err["fatal"] is False and msg.get("code") == "text_too_long"
          and after["type"] == "done" and after["audioSeconds"] > 0 and sc.proc.poll() is None,
          f"{len(big)}-byte frame → {err['code']} (fatal {err['fatal']}); 12.5 KB → {msg.get('code')}; "
          f"then done {after.get('audioSeconds', 0):.2f}s")

    # quotes: nothing speakable → done 0 s.
    replies = {t: speak(f"q{n}", t)[0] for n, t in enumerate(['"', "“”", "''", "``", "‘ ’ ` “'”", "‘ ' ’"])}
    check("quotes", all(m["type"] == "done" and m["audioSeconds"] == 0 for m in replies.values()),
          ", ".join(f"{t!r} → {m['type']} {m.get('audioSeconds', m.get('code'))}" for t, m in replies.items()))
    # tiny: anything the engine does speak yields audio, so it is done with
    # audio, never the synthesis_failed kept for an engine that gives none.
    tiny = {t: speak(f"t{n}", t)[0] for n, t in enumerate([" Hello...", ".", "a", "'x'", "...", "—"])}
    check("tiny", all(m["type"] == "done" and m["audioSeconds"] > 0 for m in tiny.values()),
          ", ".join(f"{t!r} → {m['type']} {m.get('audioSeconds', m.get('code'))}" for t, m in tiny.items()))

    # nul: the text after a NUL is still spoken.
    tail = " how are you today, this part must not be lost?"
    clean, _, _, _ = speak("clean", "Hello there" + tail)
    nul, _, _, _ = speak("nul", "Hello there\u0000" + tail)
    lead, _, _, _ = speak("nul-lead", "\u0000Hello there.")
    ratio = nul.get("audioSeconds", 0) / clean["audioSeconds"]
    check("nul", nul["type"] == "done" and 0.7 <= ratio <= 1.4 and lead["type"] == "done" and lead["audioSeconds"] > 0,
          f"with NUL {nul.get('audioSeconds', 0):.2f}s vs {clean['audioSeconds']:.2f}s without; "
          f"leading NUL → {lead['type']} {lead.get('audioSeconds', 0):.2f}s")

    # cancel between pieces: find where the second piece starts (its first
    # 80 ms frame), then cancel around that moment.
    text = " ".join(LONG.split()[:40]) + "."
    _, audio, t0, _ = speak("probe", text)
    starts = [e[0] - t0 for e in audio if e[2] == 1920]
    boundary = starts[1] if len(starts) > 1 else None
    stops, late_total, dropped_ok = [], 0, True
    for n, offset_ms in enumerate([-30, -15, -8, -4, -2, 0, 2, 5, 10]):
        if boundary is None:
            break
        sid = f"cut{n}"
        start = len(sc.events)
        t_send = sc.send({"type": "speak", "id": sid, "text": text, "voice": voice})
        sc.send({"type": "speak", "id": f"{sid}-queued", "text": "This must never be spoken.", "voice": voice})
        delay = t_send + boundary + offset_ms / 1000 - time.perf_counter()
        if delay > 0:
            time.sleep(delay)
        t_cancel = sc.send({"type": "cancel"})
        k = sc.wait_json("cancelled", start)
        stops.append(1000 * (sc.events[k][0] - t_cancel))
        dropped_ok &= f"{sid}-queued" in sc.events[k][2]["ids"]
        time.sleep(0.2)
        late_total += sum(1 for e in sc.events[k + 1:] if e[1] == "audio" or
                          (e[1] == "json" and e[2].get("id") in (sid, f"{sid}-queued")))
    check("cancel", boundary is not None and stops and max(stops) < 100 and late_total == 0 and dropped_ok,
          f"second piece starts {1000 * (boundary or 0):.0f} ms in; stops median "
          f"{statistics.median(stops) if stops else 0:.1f} ms, max {max(stops) if stops else 0:.1f} ms; "
          f"{late_total} late events; queued dropped {dropped_ok}")

    msg, _, _, _ = speak("final", "All done.")
    check("still working", msg["type"] == "done" and msg["audioSeconds"] > 0, f"done {msg.get('audioSeconds', 0):.2f}s")

    sc.proc.stdin.close()
    code = sc.proc.wait(timeout=10)
    check("exit", code == 0, f"exit {code} after stdin EOF")
    if args.show_log:
        for line in sc.log:
            print("  log:", line, file=sys.stderr)
    if args.json:
        with open(args.json, "w") as f:
            json.dump(results, f, indent=1)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()

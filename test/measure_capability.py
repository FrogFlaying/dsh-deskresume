"""Measure what the collector can actually observe on this machine.

Runs the collector, then reports coverage per channel so the capability report
is based on numbers rather than impressions. Read-only: it only invokes the
collector and reads its output.
"""

import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(r"D:\DeepSeek\harness\DeskResume")
PS = Path(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe")


def run_collector(extra=None):
    args = [str(PS), "-NoProfile", "-ExecutionPolicy", "Bypass",
            "-File", str(ROOT / "collector" / "collect.ps1"), "-Reason", "manual"]
    if extra:
        args += extra
    proc = subprocess.run(args, capture_output=True, text=True,
                          encoding="utf-8", errors="replace")
    lines = [l for l in proc.stdout.splitlines() if l.strip().startswith("{")]
    if not lines:
        print("collector produced no summary")
        print(proc.stdout[-2000:])
        print(proc.stderr[-2000:])
        sys.exit(1)
    summary = json.loads(lines[-1])
    doc = json.loads(Path(summary["outFile"]).read_text(encoding="utf-8"))
    return summary, doc


def pct(a, b):
    return f"{a}/{b} ({100*a/b:.0f}%)" if b else f"{a}/0"


def report(label, summary, doc):
    s = summary["stats"]
    print(f"\n===== {label}")
    print(f"  duration                : {doc.get('durationMs')} ms")
    print(f"  raw enumerated windows  : {s['rawEnumerated']}")
    print(f"  kept windows            : {s['windows']}")
    print(f"    skipped (no title)    : {s['skippedNoTitle']}")
    print(f"    skipped (cloaked)     : {s['skippedCloaked']}")
    print(f"    skipped (invisible)   : {s['skippedInvisible']}")
    print(f"  distinct processes      : {s['distinctProcesses']}")
    print(f"  with exe path           : {pct(s['withExePath'], s['windows'])}")
    print(f"  with command line       : {pct(s['withCommandLine'], s['windows'])}")
    print(f"  with args               : {pct(s['withArgs'], s['windows'])}")
    print(f"  with terminal cwd       : {pct(s['withTerminalCwd'], s['windows'])}")
    print(f"  explorer windows        : {s['explorerWindows']}")
    print(f"  screens                 : {s['screens']}")
    print(f"  window states           : minimized={s['minimized']} maximized={s['maximized']}")
    print(f"  channels                : {doc['channels']}")

    # Which apps can be relaunched with their documents?
    with_docs = [w for w in doc["windows"] if w.get("args")]
    print(f"\n  windows with replayable args ({len(with_docs)}):")
    for w in with_docs[:12]:
        print(f"    {w['name']:<22} {str(w['args'])[:90]}")

    classes = Counter(w.get("class") or "(none)" for w in doc["windows"])
    print(f"\n  top window classes: {classes.most_common(8)}")

    monitors = Counter(w.get("monitor") or "(none)" for w in doc["windows"])
    print(f"  windows per monitor: {dict(monitors)}")

    # Anything that got a cwd attached is a terminal we can restore into place.
    cwds = [(w["name"], w["cwd"]) for w in doc["windows"] if w.get("cwd")]
    print(f"\n  windows with a working directory ({len(cwds)}):")
    for n, c in cwds[:10]:
        print(f"    {n:<22} {c}")


def main():
    summary, doc = run_collector(["-IncludeTerminalCwd"])
    report("with -IncludeTerminalCwd", summary, doc)

    summary2, doc2 = run_collector()
    report("without -IncludeTerminalCwd (default)", summary2, doc2)

    print("\n===== verdict")
    s = summary["stats"]
    print(f"  window enumeration      : {s['windows']} usable windows out of {s['rawEnumerated']} enumerated")
    print(f"  launch info coverage    : {pct(s['withExePath'], s['windows'])} have an exe path")
    print(f"  document coverage       : {pct(s['withArgs'], s['windows'])} have replayable arguments")
    print(f"  explorer coverage       : {s['explorerWindows']} folder window(s)")
    print(f"  cost of a full capture  : {doc.get('durationMs')} ms")


main()

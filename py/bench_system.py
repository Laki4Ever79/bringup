"""The system bench checker (docs/system.md): judges each board's USB output during the link test against the
system's bench-plan.json, the same way the QEMU link test judges it (src/system/linktest.ts).

Live, with every board on USB running the esp32c3_linktest_usb build:
    .venv/bin/python py/bench_system.py bench-plan.json --port logger=/dev/ttyACM0 --port beacon=/dev/ttyACM1
On saved output (one text file per board):
    .venv/bin/python py/bench_system.py bench-plan.json --log beacon=beacon.txt
Prints a table; exits 0 when every check passes, 1 otherwise.
"""
import argparse
import json
import re
import sys
import threading
import time

FIELD = re.compile(r"\b(\w+)=(-?\d+(?:\.\d+)?)\b")
UNKNOWN = "a frame with an unknown definition"


def wrong_fields(line, expected):
    """The fields whose value isn't the expected one; printed with two decimals, so equal within 0.005."""
    got = {k: float(v) for k, v in FIELD.findall(line)}
    return [k for k, v in expected.items() if k not in got or abs(got[k] - v) > 0.005]


def judge(plan, logs):
    """One result per expected message, plus one per board that dropped a frame from another definition.
    logs: board name -> everything read from its USB port."""
    need = plan.get("minLines", 3)
    results = []
    for e in plan["expect"]:
        check = f"{e['board']}: {e['link']} {e['message']} from {e['from']}"
        if e["board"] not in logs:
            results.append({"check": check, "status": "not listened", "detail": f"no output from {e['board']}: give --port or --log for it"})
            continue
        lines = [l for l in logs[e["board"]].splitlines() if l.startswith(e["prefix"])]
        good = [l for l in lines if not wrong_fields(l, e["fields"])]
        if len(good) >= need:
            results.append({"check": check, "status": "pass", "detail": f"{len(good)} lines with the known values"})
        elif lines and not good:
            results.append({"check": check, "status": "FAIL", "detail": f"arrived with {', '.join(wrong_fields(lines[-1], e['fields']))} wrong: {lines[-1].strip()}"})
        else:
            results.append({"check": check, "status": "FAIL", "detail": f"{len(good)} of {need} lines arrived with the known values"})
    for board, text in logs.items():
        dropped = [l for l in text.splitlines() if UNKNOWN in l]
        if dropped:
            results.append({"check": f"{board}: frame definitions", "status": "FAIL", "detail": f"{len(dropped)} frames with an unknown definition: the boards were built from different message definitions"})
    return results


def passed(results):
    return bool(results) and all(r["status"] == "pass" for r in results)


def table(results):
    rows = ["| Check | Result | Detail |", "|---|---|---|"]
    rows += [f"| {r['check']} | {r['status']} | {r['detail']} |" for r in results]
    return "\n".join(rows)


def listen(ports, seconds):
    """Reads every board's USB port at once for `seconds`; returns board -> text."""
    import serial  # pyserial, in .venv; only needed live

    logs = {name: "" for name in ports}

    def read(name, device):
        with serial.Serial(device, 115200, timeout=0.2) as s:
            end = time.time() + seconds
            while time.time() < end:
                logs[name] += s.read(4096).decode("utf-8", "replace")

    threads = [threading.Thread(target=read, args=item) for item in ports.items()]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return logs


def pairs(items, flag):
    out = {}
    for item in items or []:
        name, sep, value = item.partition("=")
        if not sep or not name or not value:
            sys.exit(f"{flag} wants board=value, got {item!r}")
        out[name] = value
    return out


def main(argv=None):
    p = argparse.ArgumentParser(description="Judge a system's link test on the bench against bench-plan.json.")
    p.add_argument("plan")
    p.add_argument("--port", action="append", help="board=serial device, live")
    p.add_argument("--log", action="append", help="board=text file, saved output")
    p.add_argument("--seconds", type=float, help="how long to listen (default: the plan's)")
    a = p.parse_args(argv)
    with open(a.plan) as f:
        plan = json.load(f)
    logs = {}
    for name, path in pairs(a.log, "--log").items():
        with open(path, encoding="utf-8", errors="replace") as f:
            logs[name] = f.read()
    ports = pairs(a.port, "--port")
    if ports:
        print(f"listening to {', '.join(ports)} for {a.seconds or plan.get('seconds', 15):g} s…", file=sys.stderr)
        logs.update(listen(ports, a.seconds or plan.get("seconds", 15)))
    results = judge(plan, logs)
    print(table(results))
    return 0 if passed(results) else 1


if __name__ == "__main__":
    sys.exit(main())

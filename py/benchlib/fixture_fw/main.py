# RP2350 fixture entry point (MicroPython). Deploy with: bench fixture deploy
# Talks newline-delimited JSON over USB CDC (stdin/stdout). Ctrl-C drops to the REPL.

import sys
import select
import time

from core import FixtureCore
from hal_rp2 import HalRP2

core = FixtureCore(HalRP2())
poll = select.poll()
poll.register(sys.stdin, select.POLLIN)
buf = ""

while True:
    while poll.poll(0):
        ch = sys.stdin.read(1)
        if ch == "\n":
            core.handle_line(buf)
            buf = ""
        elif ch != "\r":
            buf += ch
            if len(buf) > 2048:
                buf = ""
    core.tick()
    for line in core.drain():
        sys.stdout.write(line + "\n")
    time.sleep_ms(1)

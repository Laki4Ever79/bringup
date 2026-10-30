# Fixture logic shared by the RP2350 MicroPython firmware and the host-side mock.
#
# Keep this file MicroPython compatible: no typing, dataclasses, walrus, or CPython-only
# modules. All hardware access goes through a HAL object (see hal_rp2.py / host mock).
#
# Protocol: newline-delimited JSON. Requests carry "id" and "cmd"; responses echo "id" with
# "ok": true/false. Unsolicited lines (stream samples, fault events) carry "event".

import json

PROTOCOL_VERSION = 1
FW_VERSION = "0.1.0"

DEFAULT_CONFIG = {
    "relay_pins": {"1": 6, "2": 7, "3": 8, "4": 9},
    "relay_active_low": True,
    "power_relay": "1",
    "max_current_a": 0.45,
    "overcurrent_ms": 50,
}


class FixtureCore:
    def __init__(self, hal, config=None):
        self.hal = hal
        cfg = dict(DEFAULT_CONFIG)
        if config:
            cfg.update(config)
        self.cfg = cfg
        self.relays = {}
        for ch in cfg["relay_pins"]:
            self._set_relay(str(ch), False)
        self.heartbeat_ms = 0
        self.last_host_ms = hal.time_ms()
        self.oc_since = None
        self.stream = None
        self.out = []

    # ---- outputs -------------------------------------------------------------
    def _emit(self, obj):
        self.out.append(json.dumps(obj))

    def _fault(self, err, detail=None):
        self._all_off()
        ev = {"event": "fault", "err": err, "t_ms": self.hal.time_ms()}
        if detail:
            ev["detail"] = detail
        self._emit(ev)

    # ---- relays --------------------------------------------------------------
    def _set_relay(self, ch, on):
        pin = self.cfg["relay_pins"][ch]
        level = (0 if on else 1) if self.cfg["relay_active_low"] else (1 if on else 0)
        self.hal.set_pin(pin, level, "pp")
        self.relays[ch] = on

    def _all_off(self):
        for ch in self.relays:
            self._set_relay(ch, False)
        self.oc_since = None

    def _any_on(self):
        for ch in self.relays:
            if self.relays[ch]:
                return True
        return False

    # ---- request handling ----------------------------------------------------
    def handle_line(self, line):
        self.last_host_ms = self.hal.time_ms()
        line = line.strip()
        if not line:
            return
        try:
            req = json.loads(line)
        except Exception:
            self._emit({"ok": False, "err": "bad_json"})
            return
        rid = req.get("id")
        cmd = req.get("cmd", "")
        handler = getattr(self, "cmd_" + cmd.replace(".", "_"), None)
        if handler is None:
            self._emit({"id": rid, "ok": False, "err": "unknown_cmd", "cmd": cmd})
            return
        try:
            result = handler(req)
        except Exception as e:  # report, never crash the loop
            self._emit({"id": rid, "ok": False, "err": "exception", "detail": str(e)})
            return
        if result is None:
            result = {}
        if "ok" not in result:
            result["ok"] = True
        result["id"] = rid
        self._emit(result)

    def cmd_hello(self, req):
        return {"proto": PROTOCOL_VERSION, "fw": FW_VERSION, "relays": self.relays}

    def cmd_ping(self, req):
        return {}

    def cmd_relay(self, req):
        ch = str(req["ch"])
        if ch not in self.relays:
            return {"ok": False, "err": "bad_channel"}
        on = bool(req.get("on"))
        if on and self.hal.estop_pressed():
            return {"ok": False, "err": "estop_pressed"}
        self._set_relay(ch, on)
        return {"ch": ch, "on": on}

    def cmd_relay_get(self, req):
        return {"relays": self.relays}

    def cmd_ina226_read(self, req):
        return self.hal.ina226_read()

    def cmd_gpio_set(self, req):
        self.hal.set_pin(int(req["pin"]), int(req["value"]), req.get("mode", "pp"))
        return {}

    def cmd_gpio_read(self, req):
        return {"value": self.hal.read_pin(int(req["pin"]), req.get("pull"))}

    def cmd_temp_read(self, req):
        return {"temps_c": self.hal.temp_read()}

    def cmd_estop(self, req):
        return {"pressed": self.hal.estop_pressed()}

    def cmd_arm(self, req):
        # Heartbeat watchdog: if armed and the host is silent too long, everything turns off.
        self.heartbeat_ms = int(req.get("heartbeat_ms", 1000))
        return {"heartbeat_ms": self.heartbeat_ms}

    def cmd_disarm(self, req):
        self.heartbeat_ms = 0
        return {}

    def cmd_limits_set(self, req):
        for k in ("max_current_a", "overcurrent_ms"):
            if k in req:
                self.cfg[k] = req[k]
        return {"max_current_a": self.cfg["max_current_a"], "overcurrent_ms": self.cfg["overcurrent_ms"]}

    def cmd_stream(self, req):
        hz = float(req.get("hz", 10))
        self.stream = {
            "what": req.get("what", ["ina226"]),
            "period_ms": max(1, int(1000 / hz)),
            "next_ms": self.hal.time_ms(),
        }
        return {"period_ms": self.stream["period_ms"]}

    def cmd_stream_stop(self, req):
        self.stream = None
        return {}

    # ---- periodic work -------------------------------------------------------
    def tick(self):
        now = self.hal.time_ms()

        if self._any_on() and self.hal.estop_pressed():
            self._fault("estop")

        if self.heartbeat_ms and self._any_on() and now - self.last_host_ms > self.heartbeat_ms:
            self._fault("heartbeat", {"silent_ms": now - self.last_host_ms})

        if self.relays.get(self.cfg["power_relay"]):
            m = self.hal.ina226_read()
            if m["current_a"] > self.cfg["max_current_a"]:
                if self.oc_since is None:
                    self.oc_since = now
                elif now - self.oc_since >= self.cfg["overcurrent_ms"]:
                    self._fault("overcurrent", {"current_a": m["current_a"], "limit_a": self.cfg["max_current_a"]})
            else:
                self.oc_since = None

        if self.stream and now >= self.stream["next_ms"]:
            self.stream["next_ms"] = now + self.stream["period_ms"]
            sample = {"event": "sample", "t_ms": now}
            for what in self.stream["what"]:
                if what == "ina226":
                    sample["ina226"] = self.hal.ina226_read()
                elif what == "temp":
                    sample["temps_c"] = self.hal.temp_read()
                elif what == "estop":
                    sample["estop"] = self.hal.estop_pressed()
            self._emit(sample)

    def drain(self):
        out = self.out
        self.out = []
        return out

# Live hardware bench (design, not built yet)

**Goal.** Bring-up becomes the final stage of a run. After the design settles, a plain-code `bench` participant
builds the run's firmware for the ESP32-S3 on the desk and flashes it over USB. It turns the board's telemetry into
Mozaik events and writes the **measured** average current back into the contract. The brief reviewer then judges
battery life from a measurement, not from a guess.

**Status on 30 Oct.** Nothing is plugged in yet (`/dev/serial/by-id` is empty). The user is **not in
`dialout`**, so they will need one `sudo usermod -aG dialout $USER` or hw_agent's `udev/99-bench.rules`. PlatformIO
has the Xtensa toolchain but not the S3 Arduino libraries: run the first S3 build tonight. hw_agent's rule applies:
**ask the human before the first power-on of new wiring.**

## 1. Wiring (minimal)

The **RP2350 fixture reads the INA226**, not the DUT. Reasons:
- **Deep sleep:** a sleeping DUT can't sample its own current, and deep sleep is the phase we most need to measure.
- **Independence:** the firmware under test must not grade itself, and a crash must not blank the meter.
- **Recovery:** the fixture also drives EN/BOOT, which is the only way to flash a board that is in deep sleep.
- **Reuse:** hw_agent already has the fixture firmware, the INA226 driver, a JSON protocol and a mock.

| From | To | Note |
|---|---|---|
| Pico VBUS (pin 40: the laptop's USB 5 V) | INA226 VIN+ | High side. No bench supply: everything runs from the laptop's USB (`docs/bench-wiring.md`, tier 2). Tier 1 skips the meter: the S3 on a normal USB cable. |
| INA226 VIN− | S3 `5V` pin | The S3's only power path. |
| S3 native "USB" port | PC | Flash only, through a **VBUS-cut cable** (how-to in `docs/bench-wiring.md`). Otherwise USB powers the board around the shunt. |
| Fixture GP4/GP5 (I2C0) | INA226 SDA/SCL, addr 0x40 | INA226 VCC = fixture 3V3. |
| Fixture GP10 / GP11 (open-drain) | S3 `EN` / `GPIO0` | Reset and download mode (hw_agent v0 map). |
| Fixture GP12, through 1 kΩ | S3 GPIO4 = `BENCH_MODE` | High = duty-cycle mode, low = live mode. Read at every boot and wake. |
| S3 GPIO8 / GPIO9 | MPU-6050 SDA/SCL (0x68) | **Contract I2C pins 1:1.** GY-521 VCC = S3 3V3, so its current is measured. |
| S3 GPIO10 → 330 Ω → LED → GND | | **Contract `STATUS_LED` 1:1** (anode on GPIO, HIGH = on). |
| S3 native "USB" port | PC | **Telemetry by default** (USB CDC, the same cable that flashes; the bridge releases the port while esptool runs). GPIO17 (UART1 TX) → an optional CP2102 RXD also carries it, and survives deep sleep. |
| All GND | Common | PSU−, INA226, fixture, S3, CP2102. |

The contract's GPIOs 8, 9 and 10 are free on the S3: they are not strapping pins (0, 3, 45, 46), not PSRAM (35–37)
and not USB (19/20). Bench pins 4 and 17 are outside the contract. The bench refuses to flash if a contract pin
collides with them, and says which pin. The SHT40 has no stand-in on the desk. The bench firmware reads the
MPU-6050's die temperature instead, and the dashboard labels it **substitute**. Relay, DS18B20 and logic analyzer
are not in the minimal build.

## 2. Firmware target

**Build environment.** `templates/fw/platformio.ini` gains `[env:esp32s3_bench]`, next to `esp32c3`:
- `board = esp32-s3-devkitc-1`, `board_build.arduino.memory_type = qio_opi`, `board_upload.flash_size = 16MB`
  (copied from hw_agent `firmware/blink_pwm`).
- `-DBENCH=1`.
- It uses the same `pins.h` and `main.cpp`. A generated `behavior.h` (§4) holds blink and tilt settings.
- The firmware agent's C3 build is unchanged; the bench builds its own environment.

**Telemetry.** JSON lines on UART1 at 115200. Every line carries `rev`, so a stale image is caught.
```
{"k":"boot","rev":14,"reset":"deepsleep","mode":"duty"}
{"k":"s","rev":14,"ms":5312,"ax":0.21,"ay":-0.03,"az":0.97,"tilt":12.4,"tC":24.6,"led":1}
{"k":"cycle","rev":14,"n":7,"awakeMs":183}
{"k":"err","rev":14,"what":"imu","detail":"no ACK at 0x68"}
```

**Modes.**
- **Live mode (GPIO4 low):** awake, a 20 Hz `s` line, the LED following `behavior.h`.
- **Duty-cycle mode (GPIO4 high), one cycle:**
  1. Wake.
  2. Read the IMU once.
  3. Blink once.
  4. Write one `s` line and one `cycle` line.
  5. `Serial1.flush()`.
  6. Put the MPU-6050 to sleep (PWR_MGMT_1).
  7. `esp_deep_sleep(BENCH_PERIOD_S)`.

  `BENCH_PERIOD_S = 3` compresses the contract's 300 s period, so a 60 s window holds about 15 cycles. The quantity
  we measure is the **charge per wake**, which does not depend on the period. The bench rescales it to the contract's
  period (§4). The measured awake time includes the boot from deep sleep, which the paper estimate leaves out. That is
  the point of measuring.

**INA226.** Copy hw_agent's driver with one constant changed: **shunt-only continuous**, VSHCT 1.1 ms, AVG 16, so a
new averaged value every 17.6 ms with no gaps. hw_agent's `stream` command polls it at 60 Hz, faster than the
conversion rate, so every conversion is read. Resolution is 25 µA with the 0.1 Ω shunt. That is fine for a 40–80 mA awake phase. It is too coarse for µA
sleep currents, which is why the sleep floor comes from the design rather than the bench (§4).

## 3. Flashing

**Port detection.** Scan `/dev/serial/by-id` (systemd creates it; no custom udev rules needed):
- `*Espressif*USB_JTAG*` (303a:1001) is the DUT.
- `*MicroPython*` (2e8a:0005) is the fixture.
- `*Silicon_Labs_CP2102*` is telemetry.

**Upload.** `pio run -d <run fw dir> -e esp32s3_bench -t upload --upload-port <dut>`, with the build included. The
bench parses esptool's `Writing at 0x… (NN %)` into progress.

| Failure | Bench action |
|---|---|
| DUT port missing (asleep in duty mode) | Fixture holds GPIO0 low, pulses EN; wait 3 s for 303a:1001; upload. |
| `No serial data received` / wrong boot mode | Same recovery, once, then `bench.flashed {ok:false}`. |
| `Permission denied` | Fail with the one-line `dialout` fix. Never retried. |
| Build error | `bench.flashed {ok:false, stage:"build"}` with the compiler tail (the C3 build may still be fine). |
| No `boot` line with the flashed `rev` within 10 s | `ok:false, stage:"boot"`. The board is running something else. |
| Upload takes over 60 s | Kill pio, recover once, then fail. |

**Wi-Fi (optional, not on stage).** ArduinoOTA (`upload_protocol = espota`) plus UDP JSON lines to the laptop over a
phone hotspot. **Cable is the default on stage**, because:
- the logger brief puts Wi-Fi out of scope;
- the radio's ~100 mA bursts pollute the very current we measure;
- OTA can't reach a board in deep sleep;
- venue 2.4 GHz and hotspot client isolation are risks we can't rehearse away.

## 3b. Bridge protocol (`py/bench.py` ↔ Node), agreed by af and 7a

`py/bench.py` owns every port. `src/agents/bench.ts` owns the events and the measurement math.

**Invocation.** `.venv/bin/python py/bench.py --source real|fake|replay [--replay FILE] [--out DIR] [--fake-speed X] [--no-meter]`
- `--fake-factory` (fake only): the S3 still runs its shipped demo, so the first flash sends `instruct boot-reset`, and
  after it `instruct reset`; answer with `fake.press`. This is what the real board did on 30 Oct.
- `--no-imu` (fake only) is an S3 with no MPU-6050: `s` lines carry ax=ay=az=0, tilt 0, `tC: null`, `tSrc: "none"`,
  plus `{"k":"err","what":"imu","detail":"no ACK at 0x68"}` about once a second, as the firmware does. With
  `--no-meter` it is the bare S3.
- `--no-meter` (fake only) is a tier-1 bench: `hello.meter` is false, `ports.fixture` is null, no `i` lines, and
  `mode`/`recover`/`reset` ack `ok:false` "no fixture", exactly like a real bench without the Pico.
- Long-lived; it exits on `quit` or when stdin closes.
- stdout carries JSON lines and stderr carries free text.
- Every stdout line has `k` and `at` (host epoch ms).

**stdout**

| Line | When |
|---|---|
| `{"k":"hello","source","ports":{"dut","fixture","telemetry"},"meter":bool}` | Once, first. `meter:false` means no fixture or INA226. |
| `{"k":"boot"\|"s"\|"cycle"\|"err",...}` | DUT UART1 lines, passed through unchanged with `at` added (§2). |
| `{"k":"text","text"}` | Non-JSON serial text from the DUT. |
| `{"k":"i","mA"}` | One per meter sample, about 60 Hz. |
| `{"k":"flashing","id","stage":"build"\|"connect"\|"write","pct"}` | During `flash`: on stage changes and in ≥10 % steps of the app image. |
| `{"k":"ack","id","ok","error"?,...}` | One per command. |
| `{"k":"error","where":"fixture"\|"telemetry","error"}` | Non-fatal, e.g. a port vanished. |
| `{"k":"instruct","id","action":"boot-reset"\|"reset","text"}` | The bench needs the person at the desk. Show `text` prominently. Sent during a `flash` with no fixture when the S3 can't be reset from the laptop (factory firmware: "hold BOOT, tap RST, release BOOT"), or when the new firmware stays silent for 8 s after the upload ("tap RST"). |
| `{"k":"instruct","id","action","done":bool}` | The person did it (`true`), or nobody did within 180 s (`false`). Hide the instruction. |
| `{"k":"bye"}` | On exit. |

**stdin**

| Command | Ack |
|---|---|
| `{"id","cmd":"flash","dir","env"?}` | After pio exits **and** the new firmware has spoken (or an `instruct` was answered or timed out), with `booted`: the flashed rev, or null if it never spoke. Before that: `ms`, plus `stage` on failure (`build`\|`connect`\|`write`\|`permission`\|`timeout`). Recovery (BOOT+EN, retry once) happens inside. Node then waits up to 10 s for a `boot` line with the flashed rev; the "boot" stage is Node's. |
| `{"id","cmd":"recover"}` | The fixture holds GPIO0 low and pulses EN. Ok once 303a:1001 appears; ok:false after 3 s. |
| `{"id","cmd":"reset"}` | Pulses EN with GPIO0 released. |
| `{"id","cmd":"mode","mode":"live"\|"duty"}` | Sets fixture GP12, then resets. |
| `{"id","cmd":"fake.press","buttons":"boot+rst"\|"rst"}` | `--source fake` only: the simulated person presses the S3's buttons. Answered at once, even while a `flash` waits. |
| `{"id","cmd":"ports"}` | Rescans. The ack carries `ports`. |
| `{"id","cmd":"quit"}` | Ack, then `bye`, then exit. |

**Files.** `--out DIR` writes two files:
- `bench.jsonl`: every stdout line except acks. It is also the **replay format**.
- `power.csv`: `at,mA`.

**Sources.**
- **fake:** the DUT and the meter are simulated.
  - A flash takes about 4 s.
  - The DUT then boots with `BRINGUP_REVISION` from `<dir>/include/pins.h`, and the LED period comes from
    `behavior.h`.
  - It follows `mode`. Live mode: tilt follows a slow sine. Duty mode: about 60 mA for about 180 ms every 3 s, over a
    6 mA floor.
- **replay:** plays `bench.jsonl` in real time and loops it. `fixtures/bench/synthetic.jsonl` is a 47 s `--source fake`
  session to develop against: flash rev 15, live with tilt, then duty cycle. It is **synthetic**; the rehearsal
  recording replaces it Saturday morning. A `flash` acks `{ok:true, simulated:true}`; recorded
  acks and `flashing` lines are not replayed, because their ids belong to the old session. The recorded `rev` is kept,
  never rewritten.

## 4. Events, contract, settling

**Events.**

| Event | Payload | Reacts |
|---|---|---|
| `bench.flashing` | `{revision, stage: build\|connect\|write\|boot, pct}` (stage changes and 10 % steps) | dashboard |
| `bench.flashed` | `{revision, ok, stage?, ms, error?}` | dashboard; firmware agent on `ok:false` (stretch) |
| `bench.telemetry` | `{revision, samples:[{at, mA?, tilt?, ax, ay, az, tC?, led?}]}`, batched every 250 ms | dashboard only (chart, 3D tilt) |
| `bench.measured` | `{revision, rail, cycles, awakeMs, chargeUc, floorMa, averageMa, estimateMa, source: real\|replay}` | bench proposes `rails` (below); dashboard |
| `bench.verdict` | `{revision, pass, checks:[{name, pass, detail}]}` | dashboard pill; report.md "Bring-up" section |

`bench.verdict` checks:
- boots with the right `rev`;
- the IMU answers;
- the LED toggles;
- measured battery life ≥ target.

The full-rate streams go to `out/<run>/bench/{telemetry.jsonl,power.csv}`; Mozaik only sees the batches.

**The measurement.**
- **Floor:** the median current while asleep. This is the dev board's floor (LED, LDO, USB bridge), not the design's.
  It is shown, then excluded.
- **Charge per cycle:** `Q = Σ (I − floor)·Δt` over each awake window. The bench takes the median over at least 5
  cycles.
- **Average:** `averageMa = Q / dutyCycle.periodS + dutyCycle.sleepUa / 1000`. The period and the sleep current come
  from the contract.
- The current entering the 5 V pin is roughly the 3V3 load current (linear LDO), so the measurement maps onto the rail
  that feeds the MCU.
- If more than one rail could be that one, the bench reports the measurement and proposes nothing.
- The caveat is shown, not hidden: the measurement is the **S3 on the desk** standing in for the C3 design.

**Who owns `rails`?** The architect. The bench is a new role and proposes through change control, like any other
non-owner:
- **The proposal:** `rails` with that rail's `averageMa` replaced and two new optional fields,
  `averageSource: "measured"` and `measuredRevision`.
- **What the bench may change:** plain code rejects any bench proposal that touches other keys.
- **When it proposes:** at most once per firmware revision, and only if the change is over 10 %.
- **Approval:** the architect approves or rejects, which shows as a pull-request card.
- **What follows:**
  1. `power.ts` labels the line "(measured on bench, rev N)".
  2. The contract change un-settles the design.
  3. The brief reviewer re-judges at the next `design.ready`.
- **No loop:** `rails` wakes neither the firmware build nor the bench.

**Settling.** Bring-up **does not block `design.settled`**: hardware is optional, tests must stay deterministic, and
"settled" means "consistent". It is a **post-settle phase with its own verdict**:
1. `--bench` keeps the run alive after the first settle until Ctrl-C. It keeps watching change requests and
   rewrites the report on every settle (today `run.ts` exits at the first settle).
2. The first flash waits for `design.settled`.
3. After that, every firmware `artifact.ready` reflashes at once. This is the hot loop that makes ~20 s possible
   without waiting for a review round.
4. The verdict is keyed to the revision it ran on.

**Behaviour from the change bar.** The template has no "blink faster" knob, so it gets one. A new optional contract
field `behavior {blinkMs, tiltBlinkMs, tiltDeg}`, owned by the firmware agent, becomes `include/behavior.h`.
"Blink faster when tilted" makes the firmware agent propose `tiltBlinkMs: 100, tiltDeg: 20`. No LLM writes C++.

## 5. Dashboard (7a's page; one **Bench** panel plus a 4th pill)

- **Flash bar:** stages build → connect → write % → boot rev N, from `bench.flashing`. It ends green on a matching
  `boot` line.
- **Live chart:** canvas, 30 s window. The current trace has awake windows shaded and the floor dashed; tilt is a
  second trace. A **REPLAY** badge shows whenever `source` is `replay`.
- **3D tilts with the board:** `scene3d.setOrientation(pitch, roll)`, where `roll = atan2(ay, az)` and
  `pitch = atan2(−ax, √(ay²+az²))`, low-pass filtered. Yaw is not shown (no gyro integration).
- **Measured vs estimated:** two bars on the battery gauge, each with days vs target, and the arithmetic in a tooltip.
- **Bench pill** next to Consistency / Grounding / Review: checks pass/fail, keyed to a revision.

## 6. Act 3 (60 s)

| t | Presenter | On screen |
|---|---|---|
| 0 | "This board on my desk runs the firmware the agents just wrote." Tilts it. | 3D board tilts in sync; live chart; LED at 1 Hz on the camera. |
| 8 | Types **"blink faster when tilted"** in the change bar. | Firmware lane wakes and writes `behavior v1` (tiltBlinkMs 100, tiltDeg 20). The firmware agent owns `behavior`, so no PR card: the change shows on the firmware lane and in the request toast. |
| 20 | — | Flash bar build → write 37…100 % → boot rev 15 ✓. |
| 32 | Tilts the board. | LED blinks fast; tilt trace crosses 20°; Bench pill ✓ rev 15. |
| 38 | "Now: does it really last six months?" | Fixture switches to duty mode; current spikes every 3 s over the dashed floor. |
| 53 | — | `bench.measured`: measured vs estimated bars; PR card `rails 3V3 averageMa (measured)` → reviewer verdict on battery life. |
| 60 | "Judged by measurement, not by a guess." | |

## 7. Risks and fallbacks

| Risk | Fallback |
|---|---|
| No board, or it dies on stage | `--bench` auto-falls back to **replay**: a rehearsal session recorded Sat morning to `fixtures/bench/`, plus recorded flash timings. Clearly badged. **Replay never proposes to the contract.** Before a recording exists: a synthetic stream from hw_agent's `FakeHal`. |
| Fixture MicroPython never ran on real silicon | Live mode, flashing and the IMU still work. Only `bench.measured` is missing (pill "no meter"). |
| USB back-powers the board | The measured floor is ~0 and the awake current is implausibly low. The bench refuses to propose ("supply bypasses shunt"). |
| Change → reflash over 30 s | Pre-build the S3 environment once at settle, so only `main.cpp` recompiles; rehearse the number. |
| S3 ≠ C3 current | Stated on screen. A C3 dev board is the obvious next purchase. |

**Reuse from hw_agent (copy, don't import).**
- `src/bench/fixture_fw/*` → `py/benchlib/fixture_fw/`, deployed with `.venv/bin/mpremote` (pip into `.venv`).
  The INA226 now runs shunt-only.
- `drivers/transport.py` → `py/benchlib/`: pyserial is already in `.venv`, and `MockTransport`/`FakeHal` run the
  fake bench. hw_agent's `FixtureClient` is replaced by a threaded `FixtureLink`, because replies and a 60 Hz stream
  share one port. The bridge is `py/bench.py` (§3b).
- The S3 flags from `firmware/blink_pwm/platformio.ini`.
- The udev rules, as the documented permissions fix.
- The safety rules (PLAN §7: current limit set, ask before first power-on).
- **Not copied:** the typer CLI, `bench.yaml`/pydantic config, `run.py` (our `out/<run>/` is the record), sigrok.

**Effort, split across 3 sessions, all done by Sat 15:00.**

| Session | Pieces | Hours |
|---|---|---|
| **A: hardware + firmware** | Wiring with the user (1). `esp32s3_bench` environment, telemetry, live/duty modes, MPU-6050, `behavior.h` (2). Fixture deploy + INA226 change (1). Record the replay session (0.5). | 4.5 |
| **B: host + Mozaik** | `py/bench.py` bridge (1). Bench participant: ports, flash, progress, recovery, verdict (1.5). Measurement + `bench.measured` + rails proposal + change-control guard + `power.ts` label (1.5). `behavior` field + firmware agent (1). `--bench` stay-alive + replay (0.5). | 5.5 |
| **C: dashboard** | Bench panel: flash bar, chart, gauge, pill (2). `scene3d.setOrientation` (0.5). Event fixtures for UI work without hardware (0.5). | 3 |

B and C can start tonight against `FakeHal` and replay. A needs the user at the desk for wiring and the first power-on.

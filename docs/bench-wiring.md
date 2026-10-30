# Bench wiring guide (print me)

Everything runs from the laptop's USB ports: **no bench power supply**. There are two tiers:
- **Tier 1, pocket.** The ESP32-S3, an MPU-6050 and an LED on **one USB cable**. Flashing, telemetry (over that same
  cable), tilt and the "blink faster when tilted" change all work. There is no current measurement; the dashboard
  says "no meter".
- **Tier 2, meter.** Add the RP2350 Pico (the fixture), the INA226 and one VBUS-cut cable. The S3 is then powered
  through the INA226, so the bench measures its real average current. The Pico can also reset the S3 and switch its
  mode.

Start with tier 1. Tick each box as you go. **Tell agent-mesh-af "go" before the first power-on.**

## 0. What you need

| Tier | Qty | Part | Notes |
|---|---|---|---|
| 1 | 1 | YD-ESP32-S3 N16R8 | Two USB-C ports: **"USB"** (native, for flashing) and "COM" (not used). |
| 1 | 1 | MPU-6050 (GY-521) | Tilt and temperature. |
| 1 | 1 | LED + 330 Ω resistor | The status LED. |
| 1 | — | Breadboard, Dupont wires, 1 normal USB cable | |
| opt. | 1 | CP2102 USB-UART | Not needed. If you have one: S3 `GPIO17` → CP2102 RXD, GND → GND, and the bench uses it for telemetry. |
| 2 | 1 | RP2350 Pico board | The fixture. Normal USB cable. |
| 2 | 1 | INA226 module (CJMCU-226, 0.1 Ω shunt `R100`) | The current meter. A0/A1 at GND = address 0x40. |
| 2 | 1 | 1 kΩ resistor | In series on the mode wire. |
| 2 | 1 | **VBUS-cut USB-A → USB-C cable** | §3. Replaces tier 1's normal cable on the S3. |
| 2 | — | A multimeter | For the §4 checks. |

## 1. Tier 1 wires (S3 powered by its own USB cable)

- [ ] **T1.** S3 **`3V3`** → MPU-6050 **VCC**
- [ ] **T2.** S3 **`GND`** → MPU-6050 **GND**
- [ ] **T3.** S3 **`GPIO8`** → MPU-6050 **SDA**
- [ ] **T4.** S3 **`GPIO9`** → MPU-6050 **SCL**
- [ ] **T5.** MPU-6050 **AD0** → **GND** (address 0x68). Leave INT, XDA and XCL unconnected.
- [ ] **T6.** S3 **`GPIO10`** → LED **long leg**. LED **short leg** → **330 Ω** → **GND**.
Plug in **one normal USB cable**: PC → S3 **"USB"** port. It powers the board, flashes it and carries the telemetry.

```
PC ──USB──► S3 "USB" port   (power + flashing + telemetry)
S3 3V3 / GND / GPIO8 / GPIO9 ── MPU VCC / GND / SDA / SCL   (AD0 → GND)
S3 GPIO10 ── LED ── 330 Ω ── GND
```

## 2. Tier 2 wires (add the meter)

The S3's 5 V now comes from the **Pico's VBUS pin** (the laptop's USB 5 V) **through the INA226**.

- [ ] **M1.** Pico **VBUS** (physical pin 40) → INA226 **IN+** (also labelled VIN+)
- [ ] **M2.** INA226 **IN−** → S3 **`5V`** pin (also labelled 5Vin). If the module has a **VBS** pin, also connect it to
  IN−.
- [ ] **M3.** Pico **3V3(OUT)** (pin 36) → INA226 **VCC**
- [ ] **M4.** Pico **GND** (pin 38) → INA226 **GND** → S3 **GND**: one common ground
- [ ] **M5.** Pico **GP4** (pin 6) → INA226 **SDA**
- [ ] **M6.** Pico **GP5** (pin 7) → INA226 **SCL**
- [ ] **M7.** Pico **GP10** (pin 14) → S3 **`EN`** (also labelled RST)
- [ ] **M8.** Pico **GP11** (pin 15) → S3 **`GPIO0`**
- [ ] **M9.** Pico **GP12** (pin 16) → **1 kΩ** → S3 **`GPIO4`**
- [ ] **M10.** **Swap** the S3's USB cable for the **VBUS-cut** cable (§3).

The pin numbers are for a standard Pico layout. **Check your clone's silkscreen:** the GP and VBUS labels are what
count.

```
PC ──USB──► Pico ── VBUS(40) ──► INA226 IN+ ;  IN− ──► S3 5V
                    GP4/GP5 ──► INA226 SDA/SCL ;  3V3(36) ──► INA226 VCC
                    GP10 ──► S3 EN ;  GP11 ──► S3 GPIO0 ;  GP12 ──1kΩ──► S3 GPIO4
PC ──VBUS-cut cable (data + telemetry, no power)──► S3 "USB" port
all GNDs joined
```

During the sleep-cycle measurement the S3 switches its USB off while it sleeps, so its per-wake lines only arrive with
the optional CP2102. The INA226's current trace, which is the measurement, comes through the Pico and is unaffected.

## 3. The VBUS-cut cable (tier 2 only, 5 min, a knife)

**Why.** In tier 2 the S3 must take its power only through the INA226. A normal cable feeds 5 V into the board
around the shunt, so the meter reads nothing.

- [ ] 1. Take a spare **USB-A → USB-C** data cable. Check it shows the S3 on the PC before you cut it.
- [ ] 2. In the middle of the cable, slit about 3 cm of the jacket. Peel the shield back; **don't cut the shield**.
- [ ] 3. **Cut only the red wire** (VBUS). Leave black, green and white intact. Insulate the two red ends separately.
- [ ] 4. Tape it closed and label it **"NO 5V"**.
- [ ] 5. **Test it:** plug only this cable, PC → S3, with nothing else connected. The S3's power LED must stay
  **off**.

A USB "power blocker" adapter does the same job; run the same test.

## 4. Checks before power (tier 2, multimeter, everything unplugged)

- [ ] **C1.** Pico VBUS to GND: **no short**.
- [ ] **C2.** INA226 IN+ to IN− ≈ **0.1 Ω**; IN− to the S3 `5V` pin = **0 Ω**.
- [ ] **C3.** Every GND beeps against every other.
- [ ] **C4.** Nothing on the 5 V side touches a 3V3 pin, SDA/SCL or a GP pin.

There's no bench supply current limit any more. The laptop's USB port protection is the backstop, which is why C1
matters.

## 5. First power-on: tell agent-mesh-af "go" first

**Tier 1:**
1. PC → S3 (normal cable). The S3's power LED should light.

**Tier 2:**
1. PC → Pico. The S3's power LED should now light, powered through the INA226.
2. PC → S3 with the **VBUS-cut** cable.

The agent then checks the ports (`ls /dev/serial/by-id`). In tier 2 it installs the fixture firmware on the Pico (the
MicroPython UF2 is in `tools/micropython/`; to load it, hold BOOTSEL while plugging the Pico in). Then
`py/bench.py --source real` must print `hello` with `"meter": true`.

## 6. If something is off

| Symptom | Likely cause |
|---|---|
| Tier 2: the S3 is lit with the Pico unplugged | The S3 cable isn't VBUS-cut. |
| Tier 2: the meter reads about 0 mA while the board runs | USB is powering the S3 around the shunt, or IN+ and IN− are both on the same side. |
| `meter: false` | INA226 SDA/SCL swapped, VCC missing, or the address pins aren't at GND. |
| The MPU answers nothing (`err imu`) | GPIO8/GPIO9 swapped, or AD0 floating. |
| No telemetry lines | Use the S3 socket labelled **USB**, not COM. With the optional CP2102: its RXD (not TXD) and GND must be wired. |
| `permission denied` | Log out and back in once (the `dialout` group was added on 30 Oct). |

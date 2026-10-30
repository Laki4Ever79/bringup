# Bench wiring guide (print me)

This is the minimal bench from `docs/design/bench.md`.
- **The board under test:** an ESP32-S3 (the "DUT", device under test) runs the run's firmware.
- **The fixture:** an RP2350 Pico. It reads the current through an INA226 and can reset the S3 or put it into
  download mode.
- **Telemetry:** a CP2102 carries the S3's telemetry to the PC.

Tick each box as you go. **Don't power anything until section 5.**

## 0. What you need

| Qty | Part | Notes |
|---|---|---|
| 1 | YD-ESP32-S3 N16R8 | The DUT. Two USB-C ports: **"USB"** (native, used for flashing) and "COM" (not used). |
| 1 | RP2350 Pico board | The fixture. Plugged into the PC with a normal USB cable. |
| 1 | INA226 module (CJMCU-226, 0.1 Ω shunt `R100`) | The current meter. Address pins A0/A1 left at GND = 0x40. |
| 1 | MPU-6050 (GY-521) | Tilt and temperature, on the DUT's I2C. |
| 1 | CP2102 USB-UART | Telemetry. Plugged into the PC. |
| 1 | LED + 330 Ω resistor | The status LED. |
| 1 | 1 kΩ resistor | In series on the mode wire. |
| 1 | TTi PL601 | The S3's only power source. |
| 1 | **VBUS-cut USB-A → USB-C cable** | Section 1. **Mandatory.** |
| — | Breadboard, Dupont wires, a multimeter | |

The relay module, DS18B20, logic analyzer and E-stop are **not** part of this build.

## 1. Make the VBUS-cut cable (10 min)

**Why.** The S3 must take power only through the INA226; otherwise the meter measures nothing. A normal cable feeds
the PC's 5 V into the board, around the shunt. It can also fight the PL601: two 5 V sources tied together, one of
them the PC's USB port.

- [ ] 1. Take a spare **USB-A → USB-C** data cable (not C → C). Check that it carries data: the S3 must show up on
  the PC with it before you cut.
- [ ] 2. In the middle of the cable, slit about 3 cm of the outer jacket lengthwise. Peel back the braid or foil
  shield. **Don't cut the shield.**
- [ ] 3. Inside there are four wires: **red = VBUS (+5 V)**, black = GND, green = D+, white = D−. **Cut only the
  red one.** Then pull its two ends apart and insulate each end separately (heat-shrink or tape).
- [ ] 4. Tape the jacket closed. Label the cable **"NO 5V"** at both ends.
- [ ] 5. **Verify:**
  - Plug only this cable between the PC and the S3's "USB" port. Nothing else is connected and the PL601 is off.
  - The S3's power LED must stay **off**, and its `5V` pin must read **0 V** to GND on the multimeter.
  - If the LED lights, the red wire isn't cut (or the cable has two red wires); fix it before going on.

A USB "power blocker" adapter, if you have one, does the same job: run the same check.

## 2. Wire list

Use the standard Pico pinout for the RP2350 board: physical pin 1 is top-left with the USB connector up. **Check your
clone's silkscreen:** the GP numbers are what matter, not the pin positions.

**Power path**

- [ ] **W1.** PL601 **+** → INA226 **IN+** (also labelled VIN+)
- [ ] **W2.** INA226 **IN−** (also labelled VIN−) → S3 **`5V`** pin (also labelled 5Vin)
- [ ] **W3.** PL601 **−** → common **GND** rail
- [ ] **W4.** If your INA226 module has a separate **VBS / VBUS** pin: connect it → INA226 **IN−**

**Fixture ↔ meter** (I2C0)

- [ ] **W5.** Fixture **3V3(OUT)** (pin 36) → INA226 **VCC**
- [ ] **W6.** Fixture **GND** (pin 38) → common **GND** rail, and INA226 **GND** → common **GND** rail
- [ ] **W7.** Fixture **GP4** (pin 6) → INA226 **SDA**
- [ ] **W8.** Fixture **GP5** (pin 7) → INA226 **SCL**

**Fixture → DUT control**

- [ ] **W9.** Fixture **GP10** (pin 14) → S3 **`EN`** (also labelled RST): reset
- [ ] **W10.** Fixture **GP11** (pin 15) → S3 **`GPIO0`** (labelled 0; the BOOT button's pin): download mode
- [ ] **W11.** Fixture **GP12** (pin 16) → **1 kΩ** → S3 **`GPIO4`**: BENCH_MODE (high = duty-cycle mode)

**DUT peripherals.** These are the design contract's pins, 1:1.

- [ ] **W12.** S3 **`3V3`** → MPU-6050 **VCC**
- [ ] **W13.** S3 **`GND`** → common **GND** rail, and MPU-6050 **GND** → common **GND** rail
- [ ] **W14.** S3 **`GPIO8`** → MPU-6050 **SDA** (contract `I2C_SDA`)
- [ ] **W15.** S3 **`GPIO9`** → MPU-6050 **SCL** (contract `I2C_SCL`)
- [ ] **W16.** MPU-6050 **AD0** → **GND**, so its address is 0x68. Leave INT, XDA and XCL unconnected.
- [ ] **W17.** S3 **`GPIO10`** → LED **anode** (long leg). LED **cathode** → **330 Ω** → **GND**. This is contract
  `STATUS_LED`: HIGH = on.

**Telemetry**

- [ ] **W18.** S3 **`GPIO17`** → CP2102 **RXD**
- [ ] **W19.** CP2102 **GND** → common **GND** rail
- [ ] **W20.** Leave CP2102 **TXD**, **3V3**, **5V** and **DTR** **unconnected**. Nothing may drive or power the S3
  from here.

**USB to the PC (in section 5, not now):**
- the fixture: normal cable;
- the CP2102: normal or direct;
- the S3's **"USB"** port: the **VBUS-cut cable**;
- the S3's "COM" port: nothing.

## 3. Pin summary, by device

| Device | Pin → where |
|---|---|
| **ESP32-S3** | `5V` ← INA226 IN− · `GND` → rail · `3V3` → MPU VCC · `EN` ← fixture GP10 · `GPIO0` ← fixture GP11 · `GPIO4` ← 1 kΩ ← fixture GP12 · `GPIO8` ↔ MPU SDA · `GPIO9` → MPU SCL · `GPIO10` → LED → 330 Ω → GND · `GPIO17` → CP2102 RXD · "USB" port → PC via the VBUS-cut cable |
| **RP2350 fixture** | GP4 ↔ INA226 SDA · GP5 → INA226 SCL · GP10 → S3 EN · GP11 → S3 GPIO0 · GP12 → 1 kΩ → S3 GPIO4 · 3V3(OUT) → INA226 VCC · GND → rail · USB → PC |
| **INA226** | IN+ ← PL601 + · IN− → S3 5V (and VBS, if present) · VCC ← fixture 3V3 · GND → rail · SDA/SCL ↔ fixture GP4/GP5 · A0/A1 = GND |
| **MPU-6050** | VCC ← S3 3V3 · GND → rail · SDA/SCL ↔ S3 GPIO8/GPIO9 · AD0 → GND |
| **CP2102** | RXD ← S3 GPIO17 · GND → rail · USB → PC · everything else unconnected |
| **PL601** | + → INA226 IN+ · − → rail · **5.00 V, current limit 0.30 A** |

None of the S3 pins used here (4, 8, 9, 10, 17) is a strapping pin (0, 3, 45, 46), a PSRAM pin (35–37) or a USB pin
(19/20). GPIO0 and EN are driven only by the fixture.

## 4. Checks before any power (multimeter, everything unplugged)

- [ ] **C1. No short:** PL601 + to GND, measured at INA226 IN+, must **not** read as a short. Expect a few kΩ or more
  (the S3's input capacitors charging up is normal).
- [ ] **C2. The shunt is in the path:** INA226 IN+ to IN− is about **0.1 Ω**. INA226 IN− to the S3 `5V` pin is
  **0 Ω**.
- [ ] **C3. One ground:** every GND (PL601 −, INA226, fixture, S3, MPU, CP2102) beeps against every other.
- [ ] **C4. 3.3 V stays at 3.3 V:** nothing from the 5 V side touches any 3V3 pin, SDA/SCL, or GP pins.
- [ ] **C5. PL601 setting:** set **5.00 V, current limit 0.30 A** with the output **off**.

## 5. First power-on: ask first

hw_agent's safety rule: **the first power-on of new wiring needs your go.** Tell the agent-mesh-af window "wired, go"
**before** step P2. It will walk you through the steps and watch the numbers.

- [ ] **P1.** Plug the **fixture** into the PC. It's powered by the PC's USB; the S3 is still unpowered.
- [ ] **P2.** PL601 output **on**. Expect about **40–100 mA** on the PL601 display (the S3 runs whatever firmware it
  shipped with) and the S3's power LED **on**. **If the PL601 hits the 0.3 A limit (CC light): turn the output off
  at once.**
- [ ] **P3.** Plug in the **VBUS-cut cable**, PC → S3 "USB". The PL601 current must **not drop**: if it drops, USB is
  powering the board. Off, then go back to section 1.
- [ ] **P4.** Plug the **CP2102** into the PC.

The agent then installs the fixture firmware, scans the ports and runs the first flash. You don't need to type any of
it; it's here for reference:
1. `ls /dev/serial/by-id`. Expect `*Espressif*` (the S3), `*MicroPython*` (the fixture) and `*Silicon_Labs*` (the
   CP2102).
2. If the RP2350 doesn't yet run MicroPython: hold BOOTSEL while plugging it in, then copy the RPI_PICO2 MicroPython
   `.uf2` onto the `RP2350` drive that appears.
3. `.venv/bin/mpremote connect <fixture port> cp py/benchlib/fixture_fw/{core,hal_rp2,ina226,main}.py : + reset`
4. `.venv/bin/python py/bench.py --source real` prints `hello` with the three ports and `"meter": true`.

## 6. If something is off

| Symptom | Likely cause |
|---|---|
| The S3 LED is on with the PL601 off | USB is powering it: the cable isn't VBUS-cut. |
| `meter: false` | INA226 SDA/SCL swapped, VCC missing, or the address pins aren't at GND. |
| The meter reads about 0 mA while the board runs | The shunt is bypassed: USB power, or IN+ and IN− are both on the same side. |
| The MPU answers nothing (`err imu`) | GPIO8 and GPIO9 swapped, or AD0 floating (address 0x69). |
| No telemetry lines | The wire is on CP2102 TXD instead of RXD, or GND (W19) is missing. |
| Flash says `permission denied` | Log out and back in after `usermod -aG dialout` (already done on 30 Oct). |

# MCUs: one layer for every vendor

Bringup designs boards around any MCU it has a **profile** for. A profile is data, not code: every chip-specific fact
the pipeline uses (pins, pads, which signals each pin can carry, peripherals, what is reserved, programming,
currents, firmware target, simulator) lives in `catalog/mcu/<id>.json`. Agents, the board generator, the firmware
generator, the simulator and the checks read the profile, so an STM32 design runs the same pipeline as an ESP32 one,
and adding a vendor means adding profiles, not editing agents.

| Chip | Vendor | Board | Firmware | Simulation | Notes |
|---|---|---|---|---|---|
| ESP32-C3-MINI-1 | Espressif | yes (module) | espressif32 Arduino | Espressif QEMU | BLE + Wi-Fi, FCC modular grant |
| STM32G031K8T6 | ST | yes (LQFP32) | ststm32 Arduino (STM32duino) | Renode `stm32g0` | cheapest buildable STM32 here |
| STM32L031K6T6 | ST | yes (LQFP32) | ststm32 Arduino | none (Renode has L071/L072 only) | lowest sleep current (0.6 µA) |
| STM32F103C8T6 | ST | yes (LQFP48, 8 MHz crystal) | ststm32 Arduino | Renode `stm32f103` | native USB (1.5k D+ pull-up placed) |
| STM32WB55CGU6 | ST | not yet: RF design, SMPS, 32 MHz crystal | ststm32 Arduino (+ STM32duinoBLE) | none | BLE, no modular grant |
| RP2040 | Raspberry Pi | not yet: QSPI flash | raspberrypi (Arduino mbed core): builds | none | sleeps in SLEEP (RTC alarm) |
| nRF52840 (MDBT50Q-1MV2) | Nordic | not yet: module land pattern | nordicnrf52 (Adafruit core): builds, BLE via Bluefruit | Renode `nrf52840`: boots to the banner | BLE, FCC modular grant |
| STM32F411CEU6 | ST | yes (UFQFPN48, 4.7 µF VCAP) | ststm32 Arduino (genericSTM32F411CE): builds (product, 34 KB) | none (Renode has F407/F412) | motion: grblHAL; the Black Pill's chip |
| STM32F446RET6 | ST | yes (LQFP64, 4.7 µF VCAP) | ststm32 Arduino (genericSTM32F446RE): builds (product, 37 KB) | none | motion: grblHAL; 180 MHz, 2 CAN |
| ESP32-WROOM-32E | Espressif | not yet: module land pattern, USB-UART bridge | not yet: the template's ESP32 path is the C3's | none | motion: FluidNC, grblHAL; BLE + Wi-Fi, FCC modular grant; GPIO34–39 input only |
| RP2350A | Raspberry Pi | not yet: QSPI flash, core regulator | not yet: needs the arduino-pico core | none | motion: grblHAL, FluidNC |

## Profiles

`src/mcu/profile.ts` types them. Where a vendor publishes machine-readable chip data, the profile is generated from it:
STM32 profiles come from ST's [STM32_open_pin_data](https://github.com/STMicroelectronics/STM32_open_pin_data)
(BSD-3-Clause, the subset of the CubeMX database ST publishes) by `scripts/mcu/import-stm32.ts`, merged with a curated
overlay in `catalog/mcu/overlays/<id>.json` for what ST's data doesn't hold: currents, support parts, firmware and
simulator targets, LCSC number and price, each with its datasheet source. The others are written by hand from their
datasheets. Every profile carries its `sources`.

```bash
npx tsx scripts/mcu/import-stm32.ts      # regenerate STM32 profiles (needs tools/vendor/STM32_open_pin_data)
npx tsx scripts/mcu/catalog.ts           # refresh catalog/parts.json's MCU lines from the buildable profiles
```

## Motion controllers

A CNC or plotter controller needs a chip that runs motion firmware: grblHAL (configured at compile time, STM32F4,
RP2350, ESP32 and more) or FluidNC (runtime YAML, made for the classic ESP32). `profile.motion` says which runs on the
chip upstream, whether it has a hardware FPU, and the source. `compare_mcus` with `motion` (any, grblhal, fluidnc)
fits only those chips; the others (ESP32-C3, STM32G031, L031, F103, RP2040, nRF52840, WB55) can be helper boards
(pendant, I/O expander) beside the controller. Bringup doesn't build motion firmware itself.

## Pin index

The contract stores `pins[].gpio` as an **index the profile defines**, so every contract made before profiles still
means what it meant:

| Vendor | Index | Example |
|---|---|---|
| ESP32, RP2040 | GPIO number | GPIO4 = 4 |
| STM32 | port × 16 + number | PA5 = 5, PB7 = 23, PC13 = 45 |
| nRF | port × 32 + number | P0.13 = 13, P1.04 = 36 |

Everything that names a pin asks `src/mcu/pins.ts` (`pinName`, `pinIndex`, `mcuPinName`): the board's traces, the
consistency check's nets, the grounding check, test-kit steps, reports, pins.h. A part with no profile is the
ESP32-C3. The adopt reader (`src/adopt/`) numbers pins globally (STM32 1000 + index, nRF 4000 + index);
`toAdoptPin`/`fromAdoptPin` convert at that boundary.

## Pins and peripherals: the solver

`src/mcu/solver.ts` `solvePins(profile, needs)` assigns pins and peripheral instances the way CubeMX does for ST,
from the profile alone: an I2C bus's SDA and SCL land on one instance's pins; a UART's TX and RX likewise; ADC needs get
an analog pin; wake needs a wake-capable pin. Reserved pins (SWD, reset, oscillator, console) are never handed out;
soft ones (ESP32 strapping pins, USB) only last. An input-only pin (`inputOnly`, the classic ESP32's GPIO34–39) takes
only inputs (ADC, wake, UART RX, SPI MISO), never a plain GPIO. A failure names the shortfall: "needs 2 UART, the STM32G031K8T6 has 1
(USART1); LPUART1 has no free pins, USART2 is the console". A pin matrix (ESP32, nRF) is `"*"` in a pin's signals.

The link budget (`src/contract/links.ts`) counts free peripherals and GPIOs from the design's own chip.

## Choosing a chip

`src/mcu/select.ts` `rankMcus` puts every profile through the same tests (does the solver fit the design's needs, does
it have the radio, can Bringup build its board) and one score from the same figures for each (sleep current on a
battery, price at 100, stock, a simulator); every term is listed with its number. The parts agent calls it as
`compare_mcus`; no prompt names a default chip. Weights are in `WEIGHTS`, documented there.

## Board

For a bare chip (`kind: "chip"`), `src/mcu/board.ts` labels the package's pads from the profile, joins its supply and
ground pads to the rails and adds the profile's `support` list (decoupling per supply pad, bulk, the reset pin's
capacitor, a BOOT0 pull-down), each placed beside its pad. The package footprint is the profile's (LQFP dimensions
match KiCad's LQFP-32/48 7×7 and LQFP-64 10×10 land patterns). An STM32F4's core regulator gets its 4.7 µF on VCAP_1. A chip whose profile names a crystal (`clock.crystal`) gets it placed
beside its oscillator pads (SMD3225-4P, KiCad's land pattern) with two load capacitors sized C = 2 × (CL − 3 pF).
Native USB is wired from the profile's `usb` pins. An STM32 board is
flashed over SWD (PA13/PA14); the ESP32 recovery pads, download strap and USB wake apply only where the profile has
those pins.

## Firmware

One template (`templates/fw`) for every chip, over `include/hal.h` (console, key-value store, reading history, sleep,
retained RAM, unique id, random), selected by the core's `ARDUINO_ARCH_*`. pins.h spells pins the core's way
(`#define PIN_I2C_SDA PB7` on STM32, numbers on ESP32/RP2040) and `parsePinsHeader` reads either back as indexes. The
PlatformIO env for a non-ESP32 chip is generated from its profile (`src/mcu/firmware.ts`). History storage follows the
profile: LittleFS on ESP32/RP2040/nRF52, the core's EEPROM (emulation) on STM32.

**Zephyr** is the vendor-neutral firmware target: `src/mcu/zephyr.ts` writes the design's pins as a devicetree overlay
(hal_stm32 pinctrl labels on STM32, NRF_PSEL groups on nRF, `<name>-gpios` under `zephyr,user`), checked by reading
it back with the adopt devicetree reader.

## Simulation

`src/mcu/sim.ts` `simBackendFor` reads the profile's simulator and what is installed: Espressif QEMU for the ESP32-C3,
**Renode** (`tools/renode`, MIT) for STM32 and nRF52. A chip nothing models is a stated skip, not a failed boot.
`src/tools/renode.ts` boots the ELF on the profile's Renode platform, reads its console UART, and can put several
boards on one UART hub on a shared virtual clock (two boards' link test).

What each backend models, so nobody reads more into a pass than is there:

| Backend | Models | Doesn't |
|---|---|---|
| Espressif QEMU (esp32c3) | CPU, GPIO, UART, timers, TWAI | radio, I2C, I2S |
| Renode stm32g0 | CPU, GPIO, USART, I2C, SPI, timers, EXTI, DMA | LPUART (the console is a USART for that reason) |
| Renode stm32f103 | CPU, GPIO, USART, I2C, timers, EXTI, DMA | SPI, ADC |
| Renode nrf52840 | CPU, GPIO, UARTE, timers, radio medium | TWIM (EasyDMA I2C: the core's Wire hangs), FICR (device id reads 0), the SoftDevice |

## Setup

```bash
npm run setup -- --renode     # Renode 1.17.0 portable into tools/renode
npm run setup -- --vendors    # PlatformIO ststm32 19.6.0 (its STM32duino 2.12 framework; 20.0.0 wants a newer one), raspberrypi 1.20.0, nordicnrf52 11.0.0 + ST pin data
```

## Adding a vendor

1. Write (or generate) profiles in `catalog/mcu/`: pins with index, pads and signals; power pads; peripherals;
   console; programming; boot; support; currents with sources; firmware; simulator.
2. Teach `src/mcu/pins.ts` the vendor's spelling if it is new.
3. Add the arch's branch to `templates/fw/include/hal.h`.
4. If a simulator models it, add the backend to `src/mcu/sim.ts`.
5. `npx tsx scripts/mcu/catalog.ts` once its board is buildable.

## Not done

- RP2040 needs its external QSPI flash placed (its 12 MHz crystal is in the profile and would be placed).
- Decoupling on bare MCUs is bounded at 20 mm by tscircuit's rule, which counts the ground return; with no ground pour
  that return routes the long way (16 mm on the F103's pad-48 cap). A ground pour would fix the cause.
- Flash wear on STM32 EEPROM emulation: journalled in retained RAM, one page erase per ~24 readings (≈2.3 years at
  5 min on a 10k-cycle page); a power loss drops the readings since the last erase.
- STM32 factory-test, data-collection and model-check firmware: their drivers are ESP32-only, so only the product and
  link-test envs are generated for STM32.
- RP2040 and nRF52840 firmware build; neither is tried on hardware. The nRF52840 boots in Renode to its banner, then
  waits forever at the first I2C transfer: Renode's twi0 doesn't model TWIM (EasyDMA). Its BLE (Bluefruit: the same
  GATT service and BTHome as the ESP32) is untested in simulation (the S140 SoftDevice isn't loaded). RP2040 sleep
  current is an estimate. Their link-test envs are generated but not built.
- The nRF52840 module's land pattern isn't entered.
- RF design for bare radio chips (matching, antenna) is out of scope: use certified modules.
- Firmware flash/RAM budgets (model-fit checks) are measured for the ESP32-C3 only.
- Zephyr builds need the Zephyr SDK (several GB), not installed; the overlay is generated and checked by reading back.
- No Renode model for STM32L031, STM32WB55, RP2040, RP2350, STM32F411 or STM32F446 (Renode's stm32f412 platform is
  close to the F411 but untried).
- STM32F411 and F446 run on the HSI (STM32duino's generic clock), so their USB isn't wired: USB needs a crystal-based
  clock (25 MHz on the Black Pill). Their product firmware builds (not tried on hardware). On F4 the EEPROM emulation erases a whole 128 KB
  sector per write-back, so its wear is worse than on the G0/F1.
- The ESP32-WROOM-32E needs its land pattern, a USB-UART bridge with auto-reset for flashing, and a firmware path for
  the classic ESP32 (hal.h's ESP32 console is the C3's USB Serial/JTAG; the C3's envs are hand-written).
- The RP2350A needs its QSPI flash, its switching core regulator and the exposed ground pad on the board, and hal.h
  support for the arduino-pico core (PlatformIO's raspberrypi platform has no RP2350).
- Motion firmware (grblHAL, FluidNC) isn't generated or built; profiles only say which chips run it.
- A pin's direction isn't in the contract, so the consistency check can't refuse an output on an input-only pin; only
  the solver avoids it.
- The dashboard still writes pins as GPIO numbers (it doesn't load profiles).

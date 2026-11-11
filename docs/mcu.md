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
| RP2040 | Raspberry Pi | not yet: QSPI flash | raspberrypi Arduino | none | |
| nRF52840 (MDBT50Q-1MV2) | Nordic | not yet: module land pattern | nordicnrf52 Arduino (Adafruit) | Renode `nrf52840` | BLE, FCC modular grant |

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
soft ones (ESP32 strapping pins, USB) only last. A failure names the shortfall: "needs 2 UART, the STM32G031K8T6 has 1
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
match KiCad's LQFP-32/48 7×7 land patterns). A chip whose profile names a crystal (`clock.crystal`) gets it placed
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
| Renode nrf52840 | CPU, GPIO, UART, I2C, SPI, timers, radio medium | SoftDevice behaviour untested |

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
- RP2040 and nRF52 HAL branches are stubs (#error): their toolchains are installed, the firmware port is not done.
- The nRF52840 module's land pattern isn't entered.
- RF design for bare radio chips (matching, antenna) is out of scope: use certified modules.
- Firmware flash/RAM budgets (model-fit checks) are measured for the ESP32-C3 only.
- Zephyr builds need the Zephyr SDK (several GB), not installed; the overlay is generated and checked by reading back.
- No Renode model for STM32L031, STM32WB55 or RP2040.
- The dashboard still writes pins as GPIO numbers (it doesn't load profiles).

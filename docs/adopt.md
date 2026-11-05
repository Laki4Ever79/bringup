# adopt: Bringup on a hardware repo it didn't make

`adopt` reads an existing hardware repo (KiCad boards, firmware, case files) and checks that the domains agree,
without a model and without writing anything into the repo. It can then agree on the design as a Bringup contract
and check every later change against it, locally or on each pull request.

```bash
npx tsx src/adopt/cli.ts <repo>                          # report: every firmware pin against every board
npx tsx src/adopt/cli.ts <repo> --contract <dir>         # agree: write the contract the repo implies
npx tsx src/adopt/cli.ts <repo> --check <dir>            # check: the repo now against the agreed contract (exit 1 if broken)
#   --variant <env>   pin the firmware build    --json out.json    --markdown summary.md
```

## What it reads

- **Boards:** KiCad 5 to 10. Pads without pin names get them from the project's schematics: the KiCad 5 symbol
  cache, or the symbols each KiCad 6+ `.kicad_sch` embeds.
- **The MCU:** the part with the most GPIO pads (ESP32 and RP2040 `IO5`/`GPIO5`, STM32 `PC13`, AVR `PB5`, nRF `P0.13`). A dev board on
  headers (XIAO, Feather, QT Py, S2 mini) counts too: its pad names (`D6`, `TX/D6`) map to GPIOs through arduino-esp32's
  variant headers (`scripts/adopt-boards.ts` regenerates `src/adopt/boards.json`).
- **Firmware:** PlatformIO envs (`extends`, `${sec.key}`, `build_src_filter`), CMake compile definitions,
  C/C++ pin defines and constants, STM32CubeMX `.ioc` files and `main.h` `_Pin`/`_GPIO_Port` pairs, Arduino pin
  numbers and `A0` (resolved through ArduinoCore-avr's tables on AVR), and Zephyr devicetree (`NRF_PSEL` in pinctrl,
  `<name>-gpios`). Each revision overlay is a build of its own; disabled nodes, and RTS/CTS without
  `hw-flow-control`, are unused.
  `#if` branches are evaluated per build: the env's `-D` flags, its chip family, and macros the sources agree on.
- **Case:** an STL's bounding box, for a rough "does the board fit" check.

## What the report says, per firmware pin

| Mark | Meaning |
|---|---|
| ✓ | The pad's net, or what it reaches (an LED behind a resistor, a button, the peer's RXD), agrees with the name |
| ≠ | Both sides have names and they disagree (a DC/RST swap): a person should look |
| · | The net has no name; shown with what it reaches |
| ✗ | Unconnected pad, a rail, a GPIO the module already uses, or a clock mode that doesn't suit the board |
| ? | Not on any pad, or broken only under an `#if` adopt can't decide |
| – | Not used in this build |

Each board is paired with the firmware build that explains most of it; `--variant` overrides the choice. A board no
build fits is reported as unpaired, and its broken pins become questions. Across a build, adopt also flags one pin
given two jobs, a devicetree sleep state that moves a line, and a console UART whose pins go nowhere.

## The model on the device

When the firmware deploys an ML model, adopt reads the model and checks it against the firmware and each board:

- **Finds the model:** an Edge Impulse export (`model_metadata.h`: sensor, sample rate, window, axes, arena, data
  type; weights from its compiled arrays), or TFLite Micro models (each `.tflite` or model C array, the
  `kTensorArenaSize` the firmware gives the interpreter). Each model belongs to the program that builds it: the nearest
  folder above it with a `platformio.ini`, `CMakeLists.txt` or `.ino` (a library's own build files don't count).
- **Against the firmware:** the number of values the firmware hands the classifier, against the model's input. Its
  constants are evaluated with C's integer division: a 1650 ms window at 74 Hz is 122 samples, not 125. It also
  checks the rate the firmware samples at, against the rate the model was trained at. Third-party libraries (a folder
  with `library.json` or `library.properties`) are not the firmware.
- **Against the board:** a sensor of the kind the model reads (microphone, IMU, camera). On a socketed dev board it
  may be on the dev board, so a missing one is a question there. Also the tensor arena against the chip's RAM, and the
  weights against its flash. These come from datasheet figures built in, plus ESP32 module codes (`-N8R2`: 8 MB flash,
  2 MB PSRAM). An unknown chip is a question, never a guess.

## The contract and the check

`--contract` writes, per board with an MCU, `contract.json` (outline, edge connectors, the MCU and the parts its GPIOs
reach, the pin map), written through `DesignContract` so it is exactly what Bringup accepts. Next to it is
`links.json`: the firmware build, the firmware name for each signal, and notes on what a board file can't say.
Rails, requirements and behavior are left out, because a board file has no current ratings or product intent.
Connector cutout heights are estimates.

`--check` reads the repo now into Bringup artifacts and runs Bringup's own `checkConsistency` against the agreed
contract (outline, nets, firmware pins). It adds a field-by-field diff of what moved, and names firmware left behind
when the board moves a pin.

## On pull requests

`adopt/action.yml` is a GitHub Action that runs `adopt/check.sh`. That script can also be run locally with the same
variables. `adopt/example-workflow.yml` shows the setup:

1. Agree once: `--contract .bringup/adopt`, then commit the folder.
2. Every pull request is checked against it. A broken contract fails the job. The design changes and the per-pin
   report go to the job summary.
3. To accept a deliberate change, re-run `--contract` in the pull request. The `contract.json` diff is the reviewed
   design change.

## Limits

- One MCU per contract (the board's first). Other MCUs are still checked by the report.
- Pin numbers for ESP32/ESP8266/RP2040 GPIOs, STM32-style ports, AVR (ATmega328P/2560/32U4 and the Arduino boards on
  them) and nRF52/nRF54 port pins. Not yet ATtiny, ZMK's `&pro_micro` references, or Python and MicroPython firmware.
- Connector positions come from the footprint origin and pad extent, not the courtyard.
- The case check is a bounding box, not cutouts.

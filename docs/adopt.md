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

- **Boards:** KiCad 5 to 10. KiCad 5 pin names come from the project's schematic and symbol cache.
- **The MCU:** the part with the most GPIO pads (ESP32 and RP2040 `IO5`/`GPIO5`, STM32 `PC13`). A dev board on
  headers (XIAO, Feather, QT Py, S2 mini) counts too: its pad names (`D6`, `TX/D6`) map to GPIOs through arduino-esp32's
  variant headers (`scripts/adopt-boards.ts` regenerates `src/adopt/boards.json`).
- **Firmware:** PlatformIO envs (`extends`, `${sec.key}`, `build_src_filter`), CMake compile definitions,
  C/C++ pin defines and constants, STM32CubeMX `.ioc` files and `main.h` `_Pin`/`_GPIO_Port` pairs.
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

Each board is paired with the firmware build that explains most of it; `--variant` overrides the choice.

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
- Pin numbers only for ESP32/ESP8266/RP2040 GPIOs and STM32-style ports. Not yet nRF52 `P0.13`, AVR `PB5`
  (it reads as an STM32 port), or Python and MicroPython firmware.
- Connector positions come from the footprint origin and pad extent, not the courtyard.
- The case check is a bounding box, not cutouts.

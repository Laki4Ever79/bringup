# Changelog

## 0.2.3 (27 Nov 2026)

**Works on Linux, macOS and Windows.** Every release is now installed fresh from its npm package on all three systems
by the [OS smoke test](https://github.com/Laki4Ever79/bringup/actions/workflows/os-smoke.yml), and taken through a
newcomer's whole path over the MCP: install the tools, design a board, read the summary, get the pictures, export the
package.

### For Claude Code and other MCP clients
- The server tells the AI how to use it before the first call: the order of calls, that mock runs are free, that paid
  runs need an approved plan, that installs need your yes.
- `get_pictures`: the board comes back as an image Claude Code shows inline; with the case tools, pictures of the board
  in its case (exploded, top, side) or of a robot's assembly.
- `plan_design` / `approve_plan`: a real-model run starts only from a plan you approved, with its estimated time and
  cost. The CLI asks before a paid run (`--yes` or `--plan <id>` without a terminal).
- `continue_design` (and `bringup continue <run> [--rev N]`): keep changing a finished design, or branch from any
  revision.
- `npx bringup-mcp setup` lists each tool set (installed or not, size, what it gives) and the exact install command;
  `--help` prints the commands instead of waiting silently.

### The package you download
- A board in a case now ships its case and lid (STL and STEP), pictures of the board in it, and assembly steps.
- Only what a person needs (20 files for the logger, was 906): the build folder stays in the run.
- A free mock design packages without forcing, under a plain banner: the review is scripted, check before ordering.

### Designs
- A robot arm: printed links, servos, its power board, a reach sweep; settles with 0 open problems. Pick-and-place
  checked in simulation.
- CNC: emergency stop, limit switches, spindle switch with current sense and a stall stop, grblHAL configuration that
  builds and passes 7 checks in Renode; a FluidNC option on the ESP32-WROOM-32E, now a buildable board chip with its
  USB bridge and auto-reset added by code.
- Radio boards keep a clear band beside the antenna, free of parts and ground copper.
- Boards go to 4 layers when the routing needs it.

### Fixes
- Windows: the MCP server starts; tool installs, builds and pictures work (path, shell and line-ending fixes).
- Classic ESP32 firmware compiles (it no longer uses a USB console the chip lacks).
- Freerouting containers no longer outlive their run.

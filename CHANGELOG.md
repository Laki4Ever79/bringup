# Changelog

## 0.2.4 (unreleased)

**See the design move, and see what a change did.** A robot's simulation, an arm's pick-and-place and a CNC's toolpath
now come back as pictures and a GIF; one call shows the whole design in one image, another the design before and after
a change. Tested from the npm package on Linux, macOS and Windows, simulation included.

### For Claude Code and other MCP clients
- `npx bringup-mcp add <claude-desktop|cursor|vscode|windsurf>` writes the server into that app's config (your other
  servers kept, the old file saved as `.bak`, a file with comments left alone and the snippet printed; on Windows the
  `cmd /c npx` form). Each client's file and entry are in docs/mcp.md.
- `get_pictures` returns each simulation's verdict, and with `drive: true` pictures of it moving: a rover on its course
  (from above with its path, frames following it, a GIF), an arm picking and placing cubes (pick, carry, drop, where each
  cube landed, a GIF), a CNC's toolpath (on a millimetre grid with the bed, from the side, a GIF).
- `get_pictures` with `overview: true`: the board, the assembly and the motion side by side in one image, the motion
  labelled with its verdict.
- `get_pictures` with `compare: true`: the design before and after the last change request (or any two revisions), the
  panels that changed framed, and one line of what changed ("board 36×25 → 60×25 mm; U2 swapped; drive pass → pass").
- `run_summary` lists each change request's outcome; one that changed nothing says **not done** and why.

### Tools
- `npx bringup-mcp setup sim`: MuJoCo and Espressif's QEMU for your system, pinned and checksum-checked, so a robot's own
  firmware drives its physics model. On Linux and macOS QEMU needs a few system libraries; `setup sim` names them.

### Designs and changes
- A change request that can't be met is stated, never silent: the reason the design refused it is in the report and
  the run summary (a rover already at its brief's width, asked for 2 cm wider).
- The simulated CNC now runs a short program after its checks and records the toolpath, its length checked against the
  step pulses counted at the pins.
- Boards: a layout that leaves connections unconnected is never kept (4 layers are tried, else the run says so); without
  Freerouting no time is spent on its layouts, and a board that needed it says so with the fix; a thermal pad joins its
  chip's ground; 4-layer rails ride their own power-plane regions; generated footprint outlines no longer cross pads.
- A run waits for a build still running at its time limit instead of cutting it off.

### Fixes
- Windows: the simulated robots boot (Espressif's Windows QEMU raised a stack-guard interrupt with nothing tripped; the
  simulation firmware masks it).
- A streamed run's last changes all reach the hosted page, not only the first 8 MB.

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

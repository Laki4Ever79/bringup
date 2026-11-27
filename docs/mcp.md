# Bringup as an MCP server

Use Bringup from a coding agent (Claude Code, Claude Desktop, Cursor, or any MCP client). Describe a device or a robot,
let the agents design it, change one thing, and read what every check said. The server speaks MCP over stdio.

## Install

Claude Code:

```bash
claude mcp add bringup -- npx -y bringup-mcp
```

Claude Desktop, Cursor, VS Code and Windsurf (from 0.2.4), one command writes it into that client's config (the
servers already there are kept, the old file saved beside it as `.bak`; `--print` only shows it):

```bash
npx -y bringup-mcp add claude-desktop   # or: cursor, vscode, windsurf
```

Or by hand. Restart the app (VS Code: "MCP: List Servers") afterwards.

| Client | Config file | Entry |
|---|---|---|
| Claude Desktop | macOS `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows `%APPDATA%\Claude\claude_desktop_config.json` | `mcpServers` |
| Cursor | `~/.cursor/mcp.json` | `mcpServers` |
| VS Code | macOS `~/Library/Application Support/Code/User/mcp.json`, Windows `%APPDATA%\Code\User\mcp.json`, Linux `~/.config/Code/User/mcp.json` (or `code --add-mcp`) | `servers`, with `"type": "stdio"` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |

```json
{
  "mcpServers": {
    "bringup": { "command": "npx", "args": ["-y", "bringup-mcp"] }
  }
}
```

VS Code's `mcp.json`:

```json
{
  "servers": {
    "bringup": { "type": "stdio", "command": "npx", "args": ["-y", "bringup-mcp"] }
  }
}
```

On Windows, Claude Desktop, Cursor and Windsurf start it through `cmd` (they start programs without a shell, and npx is
`npx.cmd` there): `"command": "cmd", "args": ["/c", "npx", "-y", "bringup-mcp"]`; `add` writes that for you.

How these are checked: `add` for each client into a temp home, then the server started from each written entry exactly
as the client starts it (command and args, no shell), answering the MCP handshake and listing its tools. Done by hand
on Linux from the npm tarball (27 Nov 2026), and in the OS smoke test's packed job on Linux, macOS and Windows (the
Windows `cmd /c` form included). VS Code's own `code --add-mcp` writes the same entry. Claude Code connected end to end
(`claude mcp list`: Connected). The apps themselves (Claude Desktop, Cursor, Windsurf) weren't
opened: their files and entries follow each app's documented format.

Needs Node 22 or later (tested on 22 and 24; the full toolchain below needs Node 24). The first `npx` call downloads the
package and its dependencies, about 183 MB in npm's cache, most of it the model SDKs Mozaik uses; on a clean Node 24
container that took 15-17 s (26 Nov 2026).

What a run builds depends on the machine (`hardware`, `auto` by default):
- **Docker, nothing else installed:** the builds run in Bringup's toolchain image (`docker/toolchain/Dockerfile`:
  tscircuit + bun, Python with build123d and MuJoCo, PlatformIO with the ESP32-C3 and ESP32-S3 toolchains) and KiCad's
  `kicad/kicad:10.0`. The first run builds the one and pulls the other: about 2.7 GB to download, an estimate from the
  compressed images (1.86 GB + 0.81 GB), and 5.2 GB on disk for the toolchain image. Every run after that finds both.
  The start result says so (`hardware: "built in Docker: this machine lacks …"`). Measured with the logger brief in an
  empty folder (25 Nov 2026, a loaded 16-core laptop):

  | | Builds | Wall time |
  |---|---|---|
  | Before (stubbed) | 0 of 6: no routed board, case or firmware | 76 s |
  | First run (image built) | 6 of 6, 0 failed | 854 s (500 s of it the image) |
  | Later runs | 6 of 6, 0 failed | 123 s |

  The first run's 500 s built the image before its trim, with KiCad's image already on the machine (its pull is extra).
  Set `BRINGUP_TOOLCHAIN=local` to never use the image.
- **Neither the tools nor Docker:** the agents design the contract (parts, pins, outline, mechanics) and every check
  runs on it; what the machine has is built and the rest is stubbed. The start result names, per domain, what one
  command would add and how big it is. Install a domain once, into `~/.bringup`:

  ```bash
  npx -y bringup-mcp setup board      # tscircuit and bun: about 923 MB, ~30 s. Routed boards and their pictures
  npx -y bringup-mcp setup case       # Python and build123d: about 945 MB, ~75 s. Cases, chassis, printed parts
  npx -y bringup-mcp setup firmware   # PlatformIO: about 125 MB, then the chip's compiler on the first build (~1 GB)
  npx -y bringup-mcp setup sim        # robots: MuJoCo and Espressif's QEMU, the firmware driving the physics model (from 0.2.4)
  npx -y bringup-mcp setup            # lists them, installs nothing
  ```

  Or let the client install it: `start_design` with `installTools: true`, which a client should only pass after its
  user agreed to the download. Measured on a clean Node 24 container with no Docker (26 Nov 2026): after `setup board`
  the logger brief settled in 45 s with a routed board, a 3D `board.png` and the PCB and schematic as SVGs (drawn by
  tscircuit; KiCad isn't needed for them). The fab files still need KiCad. The case's CAD kernel needs the system's
  OpenGL library (`sudo apt install libgl1` on a minimal Linux; a desktop has it).
- **The full toolchain** (`git clone`, then `npm run setup`; see the [README](../README.md)): real boards, cases,
  chassis, firmware, simulation and ROS. From a clone, register the server with
  `claude mcp add bringup -- node "$PWD/bin/bringup-mcp.js"`. Local tools always come first.
- `hardware: "build"` asks for the real builds anyway. On a machine without the tools the start result says so, the
  run ends unsettled, and `run_summary` names the missing tools. `hardware: "stub"` stubs them even where they are installed.

Runs go to `~/.bringup/runs`, or to `out/` in a git clone. Set `BRINGUP_OUT` to choose another folder.

Connect the machine to Bringup Studio, and every run the MCP starts streams there ([docs/studio.md](studio.md)):
`npx -y bringup-mcp login --url https://<studio address>`; `npx -y bringup-mcp logout` disconnects it.

## Safe by default

- **Every run is a mock run unless you ask otherwise.** Mock runs use scripted agents, cost nothing and need no key.
- **A real-model run needs two things:** `mock: false` **and** `realModels: true`, plus a provider in the server's
  environment (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `BRINGUP_PROVIDER=claude-code` for this machine's Claude Code
  login). Without all of them the server refuses, and nothing is started.
- Nothing is ordered or published. `export_package` writes files to the run's folder and nowhere else.
- Reads stay inside the runs folder. A run id is letters, digits, `_` and `-` only.

## Tools

| Tool | What it does |
|---|---|
| `list_starters` | The shipped example devices and robots, multi-board systems and briefs |
| `start_design` | Start a design from a brief (`mock` by default; `stay: true` keeps it up to take changes; `hardware` as above). Returns a `runId` at once |
| `plan_design` | Before a paid (real-model) run: the plan to show your user (what will be designed, what the brief leaves open and the agents would assume, the estimated time and cost) and its `planId`. Free, no model call |
| `approve_plan` | Approve a plan, only after your user said yes. A real-model `start_design` or `start_system` (`mock: false, realModels: true`) needs an approved `planId` for that exact brief or system |
| `start_system` | Start a multi-board system: a robot's boards on one chassis, a sensor board on a cable, a Pi with its HAT. Takes a shipped system's name or a spec |
| `design_status` | Running, settled, unsettled or failed, with the revision, the open violations and event counts. A system run gives one block per board |
| `run_summary` | One screen: the status, the open violations, and each artifact's own verdict (board DRC, the case's print check, the chassis' interference, the simulated drive, the ROS test), with the files to open |
| `read_contract` | The live design contract: outline, connectors, rails, parts, pins, mechanics |
| `get_report` | The run's consistency report, written when it ends |
| `list_events` | The trace: every proposal, decision, check and build |
| `list_part_refs` | The printed features a change can name: each opening, hole, tab and standoff of the case; each standoff, motor mount, rail and bracket of the chassis. Each one comes with its place and the line of code that makes it |
| `request_change` | Change one thing in a running design ("make it 50 mm wide"). `ref` names the printed feature the change is about; `board` picks a system's board |
| `stop_design` | End a run that stays up |
| `get_pictures` | Pictures to show the user: the newest board's 3D picture (as an image) with its PCB and schematic SVGs, the case's STL, and with `stills: true` a robot's or arm's 3D assembly stills (rendered into `<run>/pictures`, about 20 s with the case tools). A robot's simulation comes back as its verdict: a rover's drive (pass or fail per segment, top speed), an arm's pick-and-place (cubes landed, worst miss), a CNC's machine checks (grblHAL in Renode). With `drive: true` also as pictures of it moving, the key ones as images: the rover on the course (from above with its path, at its farthest) and `drive.gif`; the arm's pick, carry and drop, every landing from above and `arm.gif`; the CNC's toolpath from above on a millimetre grid with the bed, from the front left and `cnc.gif` (2-90 s; needs the case tools, and the simulations themselves `setup firmware sim`, from 0.2.4; a CNC's needs grblHAL on an STM32F4 and Renode). Each kind's folder holds `pictures.json` naming the revision it shows. `overview: true` returns the whole design as one image: the board, the assembly and the motion side by side, the motion labelled with its verdict (`pictures/overview.png`); every file is listed by path |
| `continue_design` | Continue a design whose run has ended: a new run starts from its contract (the latest, or `revision` to branch from an earlier one), settles as it was, then takes `request_change`. Mock by default; a real-model continue needs `realModels` and an approved plan, like `start_design` |
| `export_package` | Write the manufacturing package (fabrication files, BOM, firmware, printed parts: a case and lid, or a robot's or arm's parts, with assembly pictures). Refused for an unfinished design unless `force` is set. One board of a system at a time (`board`). Needs the toolchain |

For a system run, `read_contract`, `get_report`, `list_events`, `list_part_refs`, `request_change` and `export_package`
take `board` (default `main`); `design_status` names the boards.

A typical session:

1. `list_starters`.
2. `start_system` with `"rover-pi"`.
3. Poll `design_status` until it settles.
4. `run_summary`.
5. Start the design again with `stay: true`, then `request_change` with `ref: "chassis#battery-rails"` and the text
   "make them 1 mm taller".

## Publishing (maintainers)

The npm package is `bringup-mcp`. Its registry name is `io.github.Laki4Ever79/bringup`: `mcpName` in `package.json` and
`name` in `server.json` must stay equal, and so must the two versions.

The order:
1. `npm publish`.
2. `mcp-publisher login github`.
3. `mcp-publisher publish`.

Both registries publish under the maintainer's own accounts.

## Continuing a design

A design's run ends when it settles (unless it was started with `stay`), and an ended run takes no changes. To change it
later, continue it: `continue_design` (MCP), `npx bringup continue <runDir> [--rev N]` (CLI), or
`POST /api/runs/<id>/continue {mock, hardware, revision?}` (the dashboard hub).

- A continued design gets a **new run folder** with `continued-from.json` (`{from, revision}`) pointing back. The ended
  run is never written to, so its history stays as it was, and every run folder is still one run with one trace.
- It starts from the ended run's `contract.json`, or from `contracts/rev-N.json` with `--rev N`/`revision` ("branch
  from revision N").
- No agent drafts it again. The builders rebuild the board, case and firmware from that contract, the checks run, and
  the design settles at the same revision before it takes change requests. The rebuild costs one build of each part;
  the ended run's files are not reused yet.
- It stays up for `request_change` until `stop_design` (or Ctrl-C), unless the CLI got scripted `--change` requests.


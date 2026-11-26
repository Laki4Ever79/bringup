# Bringup as an MCP server

Use Bringup from a coding agent (Claude Code, Claude Desktop, Cursor, or any MCP client). Describe a device or a robot,
let the agents design it, change one thing, and read what every check said. The server speaks MCP over stdio.

## Install

Claude Code:

```bash
claude mcp add bringup -- npx -y bringup-mcp
```

Claude Desktop, Cursor and other clients take the same command in their MCP settings:

```json
{
  "mcpServers": {
    "bringup": { "command": "npx", "args": ["-y", "bringup-mcp"] }
  }
}
```

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
| `start_system` | Start a multi-board system: a robot's boards on one chassis, a sensor board on a cable, a Pi with its HAT. Takes a shipped system's name or a spec |
| `design_status` | Running, settled, unsettled or failed, with the revision, the open violations and event counts. A system run gives one block per board |
| `run_summary` | One screen: the status, the open violations, and each artifact's own verdict (board DRC, the case's print check, the chassis' interference, the simulated drive, the ROS test), with the files to open |
| `read_contract` | The live design contract: outline, connectors, rails, parts, pins, mechanics |
| `get_report` | The run's consistency report, written when it ends |
| `list_events` | The trace: every proposal, decision, check and build |
| `list_part_refs` | The printed features a change can name: each opening, hole, tab and standoff of the case; each standoff, motor mount, rail and bracket of the chassis. Each one comes with its place and the line of code that makes it |
| `request_change` | Change one thing in a running design ("make it 50 mm wide"). `ref` names the printed feature the change is about; `board` picks a system's board |
| `stop_design` | End a run that stays up |
| `export_package` | Write the manufacturing package (fabrication files, BOM, firmware, printed parts). Refused for an unfinished design unless `force` is set. One board of a system at a time (`board`). Needs the toolchain |

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

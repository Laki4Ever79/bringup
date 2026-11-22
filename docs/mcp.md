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

Needs Node 24 or later. The first `npx` call downloads the package (about 3 MB).

What a run builds depends on the machine (`hardware`, `auto` by default):
- **Nothing else installed:** the agents design the contract (parts, pins, outline, mechanics) and every check runs on
  it. The board, case, chassis and firmware builds are stubbed, so the design settles in seconds. The start result
  names the missing tools (`hardware: "stubbed: this machine lacks …"`).
- **The full toolchain** (`git clone`, then `npm run setup`; see the [README](../README.md)): real boards, cases,
  chassis, firmware, simulation and ROS. From a clone, register the server with
  `claude mcp add bringup -- node "$PWD/bin/bringup-mcp.js"`.
- `hardware: "build"` asks for the real builds anyway. On a machine without the tools the run then ends unsettled,
  and `run_summary` names the missing tools. `hardware: "stub"` stubs them even where they are installed.

Runs go to `~/.bringup/runs`, or to `out/` in a git clone. Set `BRINGUP_OUT` to choose another folder.

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
| `design_status` | Running, settled, unsettled or failed, with the revision, the open violations and event counts |
| `run_summary` | One screen: the status, the open violations, and each artifact's own verdict (board DRC, the case's print check, the chassis' interference, the simulated drive, the ROS test), with the files to open |
| `read_contract` | The live design contract: outline, connectors, rails, parts, pins, mechanics |
| `get_report` | The run's consistency report, written when it ends |
| `list_events` | The trace: every proposal, decision, check and build |
| `list_part_refs` | The printed features a change can name: each opening, hole, tab and standoff of the case; each standoff, motor mount, rail and bracket of the chassis. Each one comes with its place and the line of code that makes it |
| `request_change` | Change one thing in a running design ("make it 50 mm wide"). `ref` names the printed feature the change is about; `board` picks a system's board |
| `stop_design` | End a run that stays up |
| `export_package` | Write the manufacturing package (fabrication files, BOM, firmware, printed parts). Refused for an unfinished design unless `force` is set. Needs the toolchain |

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

# Research: concurrent hardware co-design (30 Oct 2026)

Two research agents opened the pages they cite. Items marked (unverified) come from marketing pages or listings.

## Prior art: is it new?

**"A brief becomes schematic + PCB + enclosure + firmware" is not new in 2026.** Nothing related to hardware exists at
JigJoy (none of the 40 gallery entries, none of the 12 jigjoy-ai repos), so it is fresh for this jury.

| Project | What it does | Multi-agent? |
|---|---|---|
| [Odem](https://www.producthunt.com/posts/1263017) | "Cursor for hardware": parts, schematic, KiCad PCB routing, enclosure fit checks, firmware with tests, exports | One agent (unverified) |
| [MeshCue Forge](https://github.com/meshcue/meshcue-forge) | An MCP server. Its MHDL spec is the single source of truth, and it generates Wokwi, Arduino firmware, an OpenSCAD/CadQuery enclosure and a SKiDL/KiCad PCB. **Its DRC covers pin conflicts, I2C address collisions, power budget, enclosure cutouts and mounting holes.** | Linear pipeline |
| [Copperhead](https://github.com/copperheadhq/copperhead) | A KiCad agent with 8 gated stages; documentation drifting from the schematic counts as a build failure | One agent |
| [iOrchestra](https://www.producthunt.com/products/vibe-engineer-by-iorchestra/launches/iorchestra-ai-hardware-engineers) | Commercial "AI hardware engineers" covering PCB, mechanical, BOM and simulation | Claimed (unverified) |
| [Engineering Studio AI](https://lablab.ai/ai-hackathons/nativebuilder-build-without-limits/x-dark-x/engineering-studio-ai-multi-agent-design-system) | A hackathon entry from Aug 2026: 11 parallel agents, plus agents that reconcile disagreements between disciplines | Yes |
| [Ohm](https://lablab.ai/submissions/m882viq4qr7wd56pxlr60vc9) | A hackathon entry from Jun 2026: 12 agents for BOM, code, wiring and an OpenSCAD enclosure, with no PCB | Yes |
| [arXiv 2504.14681](https://arxiv.org/abs/2504.14681) | Multi-agent mechatronics design (structure, electronics, control, software), applied to a real boat | Yes |
| [DRCY](https://arxiv.org/abs/2603.15672) | 5 agents review a schematic pin by pin against datasheets, with multi-run consensus, in production CI | Yes, single domain |
| [schematic-mcp](https://glama.ai/mcp/servers/vonpanda/schematic-mcp/tools/validate_pinmap) | `validate_pinmap`: checks firmware GPIO assignments against the KiCad netlist | – |
| [Flux Copilot](https://docs.flux.ai/reference/copilot), [Quilter](https://quilter.ai/product), [Diode](https://www.diode.computer/), [JITX](https://jitx.com/), [Zoo Zookeeper](https://zoo.dev/zookeeper), Embedder | Tools that each cover one domain: schematic, layout, boards as code, CAD and firmware | – |

**Our ideas, checked against what exists:**
1. A DRC across domains is **already done** (MeshCue, schematic-mcp, Odem). It is only new if the checks run live while
   concurrent agents are editing.
2. A critic grounded in datasheets is **already done** (DRCY). Treat it as table stakes.
3. Exploring alternatives in parallel, as whole competing designs that get scored: **not found anywhere.** This is
   the best angle.
4. A companion for existing projects: **partly done** (Copperhead, schematic-mcp, DRCY).

**Most original angles:**
- A live design contract on a shared board: agents lease contract fields, every violation is an event, and the
  affected agents re-plan immediately.
- A tournament of whole design branches that share research.
- Multiple people and laptops, one discipline per engineer.
- Change requests in the middle of a run that ripple across domains.

## Toolchain (headless, Linux)

The toolchain is in flux right now:
- **KiCad 10 is current** (10.0.0 came out in Mar 2026). Its SWIG `pcbnew` Python API is going away in KiCad 11.
- The IPC API needs the GUI to be running in 10.x.
- atopile is in the middle of a rewrite, so we should not use it.

| Step | Pick | Command | Pitfall |
|---|---|---|---|
| Circuit as code | **tscircuit** (TypeScript, fits Mozaik) | `tsci build board.circuit.tsx --kicad-project`; `tsci export -f gerbers / step / kicad_pcb / spice / readable-netlist` | Auto-placement is unfinished, it releases daily (pin the version), and its `.kicad_pcb` has crashed kicad-cli DRC once |
| Fallback | SKiDL → kinet2pcb | `generate_netlist()`, then `kinet2pcb -i x.net` | Footprints come out unplaced |
| Checks and exports | kicad-cli 10 | `pcb drc --format json --exit-code-violations`, `sch erc`, `pcb export gerbers/step`, `pcb render` | Exit code 5 means violations. `render` may need Xvfb. |
| Autorouting | tscircuit built-in; Freerouting | `java -jar freerouting.jar -de b.dsn -do b.ses --gui.enabled=false` | Importing the SES back into KiCad may need a display |
| Enclosure | build123d | `import_step` → shell → cutouts at contract coordinates → `export_step/stl` | Cut openings from the contract's coordinates, not by booleans against the board mesh |
| Firmware | PlatformIO | `pio run -e esp32c3` | The first run downloads about 1 GB, so pre-warm it |
| MCU simulation | Wokwi CLI | `wokwi-cli . --expect-text "OK"` | **Needs a token. The free tier allows 50 simulation-minutes per 30 days.** Renode has no proper ESP32/RP2040 support. |
| SPICE | ngspice in batch mode | `ngspice -b ldo.cir` | Avoid PySpice |
| Part grounding | [jlcsearch API](https://github.com/tscircuit/jlcsearch) + parsing `.kicad_sym` | `curl jlcsearch.tscircuit.com/...` | The full jlcparts database is about 11 GB |

**Minimal end-to-end demo board:** ESP32-C3-MINI module, an I2C sensor, USB-C and an LDO on a 2-layer, 50×30 mm board.
1. The contract is written.
2. These run concurrently: tscircuit schematic and PCB → gerbers/STEP, the build123d case, PlatformIO firmware, and
   ngspice on the LDO.
3. Then KiCad DRC, Wokwi with a diagram generated from the contract, and the consistency diff.

**Risks:** routing and the round trip into KiCad; Wokwi's quota and token; version churn (pin every version).

## Installed on this machine (30 Oct)
- `.venv/`: PlatformIO 6.2.0, build123d 0.13.0, SKiDL, PySpice
- Docker: `kicad/kicad:9.0` and `kicad/kicad:10.0`
- `tools/freerouting-2.5.0.jar` (runs on Java 21)
- `tools/node`: tscircuit
- Blender 5.2.2 was already installed
- Not installed yet: ngspice, Wokwi CLI (needs a token)

**Smoke test (30 Oct, `../spikes/hw/`):** a 3-part board in tscircuit 0.0.3042 went through `tsci build --kicad-project`
and was autorouted, with JLCPCB part numbers matched automatically. Then `kicad-cli` 10.0.7 in Docker ran DRC (9
violations, 0 unconnected), ERC, a STEP export and a PNG render, all headless with no Xvfb. The cause of the violations:
tscircuit routes 0.15 mm tracks while KiCad's default minimum is 0.2 mm, and its footprint library isn't registered in
KiCad. Both are configuration, not blockers. tscircuit needs `bun` (installed in `tools/node`), so run it with
`PATH=tools/node/node_modules/.bin:$PATH`.

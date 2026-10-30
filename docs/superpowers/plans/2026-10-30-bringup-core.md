# Bringup Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run bringup -- briefs/logger.md` turns a product brief into a hardware design that agrees across domains. The design is a contract, a routed board, an enclosure and compiled firmware, and the run ends with zero consistency violations. Agents run concurrently and coordinate only through events and one shared design contract.

**Architecture:** Bringup is event-driven end to end, as Mozaik intends:
- **No orchestrator.** No agent calls or awaits another agent.
- **One source of truth.** Every fact lives in the `DesignContract` on Mozaik's `RuntimeState`.
- **Changes are events.** Every change is a `contract.changed` event. Each participant has `SituationSpecification`s that decide which events wake it, so the specifications are the dependency graph between domains.
- **Builds run in parallel.** Long tool runs (tscircuit, KiCad in Docker, build123d, PlatformIO) are async and run concurrently.
- **Agents own their fields.** A non-owner's change request is held by an `InterceptionHandler` until the owning agent approves it. That is change control.
- **Plain code checks consistency.** A consistency participant checks artifacts against the contract after every change.
- **The run ends itself.** It settles when every artifact is built against the latest contract revision and there are no violations.

**Tech Stack:**
- TypeScript (ESM, tsx) and `@mozaik-ai/core` **4.1.0** (exact)
- `node:test` via `tsx --test`
- tscircuit (`tools/node`, needs bun)
- kicad-cli 10 (Docker `kicad/kicad:10.0`)
- build123d and PlatformIO (`.venv`)
- jlcsearch HTTP API

**Spec:** Plan doc https://claude.ai/artifact/GpFMaa2NAE81hn9BSHajQj (sections "The idea", "How it works", "How it uses Mozaik", "Scope"), plus `CLAUDE.md` and `RESEARCH-HW.md`.

## Global Constraints

- `@mozaik-ai/core` stays pinned at exactly `4.1.0`. Never upgrade it.
- Tools are self-contained in the repo:
  - Python tools: `.venv/bin/...`
  - Node tools: `tools/node/node_modules/.bin` (prepend it to `PATH` for child processes)
  - KiCad: Docker image `kicad/kicad:10.0`, run with `-u $(id -u):$(id -g) -e HOME=/tmp`
- Never print or commit `.env`. Every run must also work with `--mock` and no API key at all.
- Never return `nextStateId: "idle"` from an interception, because of Mozaik bug #113.
- Send every custom event through the `Outbox` (Task 3), never through `sendEvent` directly, because of #115.
- Wrap every `runLoop` call with `safeRunLoop` (Task 3), because of #114.
- Each run writes all of its output under `out/<runId>/`, and `out/` is gitignored.
- Spikes stay in `../spikes/`. Don't copy spike code into the repo; rewrite it.

## Review Focus

1. **Two agents propose changes to the same field at the same moment.** Expected: exactly one applies. The other gets `stale` and re-reads the contract. Test in Task 1.
2. **A build is in flight when its inputs change again.** Expected: the build finishes, exactly one more rebuild runs against the newest revision, and there are no parallel builds of the same artifact. Test in Task 5 (`Rebuilder`).
3. **The owner never answers a held change request.** Expected: after `APPROVAL_TIMEOUT_MS` (default 120 000, 200 in tests), it is rejected with reason "timeout", the requesting loop continues, and nothing hangs. Test in Task 4.
4. **An external tool is missing or Docker is down.** Expected: `artifact.failed` is emitted with a clear message, the run ends with a report naming the missing tool, and there is no crash. Test in Task 5 (`detectEnvironment`) and Task 10.
5. **The design never settles because violations keep coming back.** Expected: the run stops after `MAX_REVISIONS` (default 25), writes the report with its remaining violations, and exits with code 2. Test in Task 10.

---

### Task 1: Design contract

**Files:**
- Modify: `package.json` (scripts `"test": "tsx --test test/*.test.ts"`, `"bringup": "tsx src/main.ts"`), `.gitignore` (`out/`)
- Create: `src/contract/types.ts`, `src/contract/contract.ts`
- Test: `test/contract.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  - `type AgentRole = "architect" | "parts" | "board" | "enclosure" | "firmware" | "consistency"`
  - `type FieldName = "requirements" | "outline" | "connectors" | "rails" | "parts" | "pins"`
  - `const OWNERS: Record<FieldName, AgentRole>`: `parts` → `"parts"`; every other field → `"architect"`
  - `interface Requirements { summary: string; peripherals: string[]; batteryLifeDays: number | null }`
  - `interface Outline { widthMm: number; heightMm: number; thicknessMm: number }`
  - `interface Connector { ref: string; kind: "usb-c" | "header" | "button"; edge: "left" | "right" | "top" | "bottom"; offsetMm: number; widthMm: number; heightMm: number }`
  - `interface Rail { name: string; voltageV: number; regulatorMaxMa: number; loadMa: number }`
  - `interface Part { ref: string; role: string; mpn: string; lcsc: string | null; footprint: string; pins: string[] }`
  - `interface PinAssignment { signal: string; gpio: number; partRef: string; partPin: string }`
  - `type ContractValues = { requirements: Requirements; outline: Outline; connectors: Connector[]; rails: Rail[]; parts: Part[]; pins: PinAssignment[] }`
  - `interface ContractSnapshot { revision: number; values: Partial<ContractValues>; versions: Record<FieldName, number> }`
  - `type ProposalResult = { status: "applied"; version: number; revision: number } | { status: "stale"; current: number } | { status: "not-owner"; owner: AgentRole }`
- Produces (`contract.ts`): `class DesignContract`
  - `get<F extends FieldName>(f: F): ContractValues[F] | undefined`
  - `version(f: FieldName): number`
  - `revision: number` (getter)
  - `snapshot(): ContractSnapshot` (a deep copy)
  - `propose(p: { field: FieldName; value: ContractValues[FieldName]; by: AgentRole; baseVersion: number; approvedBy?: AgentRole }): ProposalResult`

- [ ] **Step 1: Write the failing tests** in `test/contract.test.ts`:
  - `owner write applies`: `propose({field:"outline", value:{widthMm:50,heightMm:30,thicknessMm:1.6}, by:"architect", baseVersion:0})` returns `{status:"applied", version:1, revision:1}`, and `get("outline").widthMm === 50`.
  - `stale base is refused`: two owner proposals, both with `baseVersion:0`. The second returns `{status:"stale", current:1}`, and the value stays the first one.
  - `non-owner refused without approval`: `by:"firmware"` on `pins` returns `{status:"not-owner", owner:"architect"}`.
  - `non-owner applies with owner approval`: the same proposal with `approvedBy:"architect"` returns `applied`.
  - `snapshot is a copy`: mutating `snapshot().values.outline.widthMm` does not change `get("outline")`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `types.ts` and `DesignContract`. Values are stored as `structuredClone`s, and `revision` is incremented on every applied change.
- [ ] **Step 4: Run** `npm test`. Expected: 5 passing.
- [ ] **Step 5: Commit** `feat: design contract with ownership and versions`

### Task 2: Consistency checker (pure)

**Files:**
- Create: `src/contract/consistency.ts`
- Test: `test/consistency.test.ts`

**Interfaces:**
- Consumes: `ContractSnapshot`, plus the field types from Task 1.
- Produces:
  - `interface BoardArtifact { revision: number; dir: string; pcbPath: string; stepPath: string | null; renderPath: string | null; widthMm: number; heightMm: number; nets: Record<string, string[]> }`. `nets` maps a net name to `"REF.pinName"` entries.
  - `interface EnclosureArtifact { revision: number; stlPath: string; stepPath: string; cutouts: { ref: string; edge: Connector["edge"]; offsetMm: number; widthMm: number; heightMm: number }[] }`
  - `interface FirmwareArtifact { revision: number; ok: boolean; pins: Record<string, number>; log: string }`
  - `interface Artifacts { board?: BoardArtifact; enclosure?: EnclosureArtifact; firmware?: FirmwareArtifact }`
  - `type ViolationKind = "outline-mismatch" | "net-missing" | "pin-mismatch" | "cutout-missing" | "cutout-misaligned" | "rail-overload" | "firmware-build-failed"`
  - `interface Violation { kind: ViolationKind; message: string; fields: FieldName[]; affects: AgentRole[] }`
  - `function checkConsistency(c: ContractSnapshot, a: Artifacts): Violation[]`

The rules. Each rule runs only when its inputs exist.

| Kind | Rule | `affects` |
|---|---|---|
| `outline-mismatch` | board W/H differ from `outline` by more than 0.1 mm | `["board"]` |
| `net-missing` | for each pin assignment, `nets[signal]` must contain `${mcuRef}.GPIO${gpio}` and `${partRef}.${partPin}`, where `mcuRef` is the ref of the part whose `role === "mcu"` | `["board"]` |
| `pin-mismatch` | `firmware.pins[signal] !== gpio` | `["firmware"]` |
| `cutout-missing` / `cutout-misaligned` | each connector needs a cutout with the same ref and edge, an offset within 0.5 mm, and a width and height ≥ the connector's | `["enclosure"]` |
| `rail-overload` | `loadMa > regulatorMaxMa` | `["architect", "parts"]` |
| `firmware-build-failed` | `firmware.ok === false` | `["firmware"]` |

- [ ] **Step 1: Write the failing tests.**
  - One test per kind, built from a shared `fixture()`: the ESP32-C3 logger contract (outline 50×30, USB-C on edge `left`, offset 15, 9×3.5; I²C SDA=GPIO8 and SCL=GPIO9 to `U2.SDA`/`U2.SCL`; rail 3V3, max 500 mA, load 120 mA) plus consistent artifacts.
  - `consistent fixture has no violations`: expects `[]`.
  - Each kind's test perturbs one value and expects exactly one violation of that kind with the `affects` from the table.
- [ ] **Step 2: Run** `npm test`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement** `checkConsistency`.
- [ ] **Step 4: Run** `npm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat: cross-domain consistency checker`

### Task 3: Runtime, events, outbox, trace, safe loops

**Files:**
- Create: `src/runtime.ts`, `src/events.ts`, `src/outbox.ts`
- Test: `test/outbox.test.ts`

**Interfaces:**
- Produces (`events.ts`): the event type constants and payload types:
  - `"contract.changed"` `{ field: FieldName; version: number; revision: number; by: AgentRole }`
  - `"change.proposed"` `{ proposalId: string; field: FieldName; by: AgentRole; reason: string }`
  - `"change.decided"` `{ proposalId: string; approved: boolean; by: AgentRole; reason: string }`
  - `"artifact.ready"` `{ kind: "board" | "enclosure" | "firmware"; revision: number }`
  - `"artifact.failed"` `{ kind: "board" | "enclosure" | "firmware"; revision: number; error: string }`
  - `"consistency.checked"` `{ revision: number; violations: Violation[] }`
  - `"design.settled"` `{ revision: number }`
  - `"agent.halted"` `{ agentId: string; error: string }`
  - `function makeEvent<T extends EventType>(type: T, producerId: string, payload: Payloads[T]): SemanticEvent`
- Produces (`runtime.ts`):
  - `class BringupState extends RuntimeState { contract: DesignContract; artifacts: Artifacts; roles: Map<string, AgentRole>; outDir: string }`
  - The `defineRuntime<BringupState>()` exports, as in `NOTES.md`.
  - `roleOf(participantId: string): AgentRole | undefined`
- Produces (`outbox.ts`):
  - `class Outbox { constructor(send: (e: SemanticEvent, senderId: string) => void, tracePath: string | null); emit(e: SemanticEvent, senderId: string): void }`. Events are delivered one at a time in FIFO order. An `emit` made while delivery is in progress is queued, and is not re-entrant. Each event is appended to `trace.jsonl` as `{seq, at, type, producerId, payload}`.
  - `function safeRunLoop(runLoop: typeof import("./runtime").runLoop, outbox: Outbox, agentId: string, message: string, input: InferenceInput, handler?: InterceptionHandler): void`. It calls `runLoop` inside try/catch and registers a one-time `process.on("unhandledRejection")` reporter that emits `agent.halted`.
  - `const outbox: Outbox`, a module singleton created by `main.ts` through `initOutbox(tracePath)`.

- [ ] **Step 1: Write failing tests.**
  - `outbox delivers in order without re-entrancy`: a fake `send` handler that emits a second event during delivery of the first. The recorded order is `[A, B]`, and B's delivery starts only after A's returns.
  - `outbox writes trace lines`: emit 3 events to a temp file. It has 3 JSON lines with seq `0, 1, 2`.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat: runtime state, typed events, ordered outbox with trace`

### Task 4: Scripted runner, contract tools, change-control interception

**Files:**
- Create: `src/inference/scripted-runner.ts`, `src/inference/models.ts`, `src/agents/contract-tools.ts`, `src/change-control.ts`
- Test: `test/change-control.test.ts`

**Interfaces:**
- Produces (`scripted-runner.ts`):
  - `type Script = (items: ContextItem[]) => InferenceItem[]`
  - `class ScriptedRunner implements InferenceRunner { constructor(scripts: Record<string, Script>) }`. It routes on `input.model`, which is `mock-<role>` per agent. An unknown model throws `Error("no script for <model>")`.
  - `toolCall(name: string, args: object): FunctionCallItem`, using `FunctionCallItem.rehydrate({ callId: randomUUID(), name, args: JSON.stringify(args) })`.
- Produces (`models.ts`):
  - `function modelFor(role: AgentRole, mock: boolean): string`. Mock mode gives `mock-<role>`. Otherwise `architect` gets `"gpt-5.4"` and everything else gets `"gpt-5.4-mini"`.
  - `function inferenceConfig(mock: boolean, scripts?: Record<string, Script>): InferenceRunnerConfig`. The mock specs copy the shape in `../mozaik-examples/custom-inference-runner/src/main.ts`, with `supportsFunctionCalling: true`.
- Produces (`contract-tools.ts`):
  - `function contractTools(role: AgentRole): Tool[]`, which returns three tools:
    - `read_contract`: no args, returns the snapshot JSON.
    - `propose_contract_change`: args `{ field, value, baseVersion, reason, approvalId? }`. It calls `contract.propose`. When `approvalId` resolves to an approval by the owner, it passes `approvedBy`. On `applied`, it emits `contract.changed` through the outbox. It returns the `ProposalResult` JSON.
    - `decide_change`: args `{ proposalId, approve: boolean, reason }`. It emits `change.decided`.
- Produces (`change-control.ts`):
  - `class ApprovalRegistry { open(field: FieldName, by: AgentRole): string; wait(id: string, timeoutMs: number): Promise<{ approved: boolean; reason: string; by: AgentRole }>; resolve(id: string, d: { approved: boolean; reason: string; by: AgentRole }): void; approverOf(id: string): AgentRole | undefined }`
  - `class ChangeControl implements InterceptionHandler { constructor(agentId: string, registry: ApprovalRegistry, timeoutMs: number) }`
  - `const APPROVAL_TIMEOUT_MS = 120_000`
  - `isSatisfiedBy`: the transition is `function_call`, `call.name === "propose_contract_change"`, and `OWNERS[args.field] !== roleOf(agentId)`.
  - `handle`:
    1. Open a proposal and emit `change.proposed`.
    2. Await the decision.
    3. If approved: return the transition with `call` replaced by `FunctionCallItem.rehydrate({...call, args: JSON.stringify({...args, approvalId})})`.
    4. If rejected or timed out: add `[call, FunctionCallOutputItem.create(call.callId, "rejected: " + reason)]` to `inferenceInput.context` and return `{ nextStateId: "inference", input: inferenceInput }`. This follows `../mozaik-examples/human-in-the-loop/src/participants/transfer-agent/interception/approval.ts`.
  - A situation in the same file, `changeDecidedHandler`, resolves the registry when `change.decided` arrives. Join it on a `createHuman` named `change-desk`.

- [ ] **Step 1: Write failing tests.** Each test uses a real runtime, `ScriptedRunner`, and two agents: firmware (non-owner) and architect (owner, with a script that calls `decide_change`).
  - `owner change applies without interception`: the architect's script calls `propose_contract_change` on `pins`. A `contract.changed` event is traced, and `pins` version is 1.
  - `non-owner change is held then applied on approval`: the firmware script proposes `pins`. The trace order is `change.proposed`, then `change.decided(approved)`, then `contract.changed (by firmware)`.
  - `rejected change returns output to the model`: the architect's script rejects. The firmware loop's next inference input contains a `FunctionCallOutputItem` whose text starts with `rejected:`, and `pins` is unchanged.
  - `timeout rejects`: the architect never decides, with `timeoutMs` 200. The output contains `rejected: timeout`, and the test finishes in under 2 s.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat: change control via Mozaik interception`

### Task 5: Tool backends, environment detection, rebuild coalescing

**Files:**
- Create: `src/tools/exec.ts`, `src/tools/env.ts`, `src/tools/rebuilder.ts`
- Test: `test/rebuilder.test.ts`, `test/env.test.ts`

**Interfaces:**
- Produces:
  - `run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs: number; env?: Record<string, string> }): Promise<{ code: number; stdout: string; stderr: string; ms: number }>`. It never throws on a non-zero exit. A timeout gives `code: -1`.
  - `interface Env { tsci: string | null; kicad: "docker" | "local" | null; python: string | null; pio: string | null }`
  - `detectEnvironment(root: string): Promise<Env>`. It checks `tools/node/node_modules/.bin/tsci`, `docker image inspect kicad/kicad:10.0`, `kicad-cli` on `PATH`, `.venv/bin/python` and `.venv/bin/pio`.
  - `kicadCli(env: Env, args: string[], cwd: string, timeoutMs: number)`: Docker or local, chosen by `env.kicad`.
  - `class Rebuilder { constructor(build: (revision: number) => Promise<void>); request(revision: number): void }`. At most one build runs at a time. Requests that arrive during a build collapse into a single follow-up at the highest requested revision.
- [ ] **Step 1: Write failing tests.**
  - `rebuilder coalesces`: request revisions 1, 2, 3 while build(1) is pending. The builds run are exactly `[1, 3]`.
  - `rebuilder never overlaps`: a counter of concurrent builds never exceeds 1.
  - `env detects missing tools`: run `detectEnvironment` against a temp root. `tsci`, `python` and `pio` are null.
- [ ] **Step 2: Run** `npm test`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: pass.
- [ ] **Step 5: Commit** `feat: tool exec, environment detection, rebuild coalescing`

### Task 6: Board agent (contract → tscircuit → KiCad)

**Files:**
- Create: `src/codegen/circuit.ts`, `src/tools/board.ts`, `src/agents/board.ts`, `catalog/parts.json`
- Test: `test/circuit-codegen.test.ts`, `test/board.int.test.ts` (skipped when `env.tsci` or `env.kicad` is null)

**Interfaces:**
- Consumes: `DesignContract`, `Rebuilder`, `run`, `kicadCli`, `Outbox`, `BoardArtifact`.
- Produces:
  - `circuitFromContract(s: ContractSnapshot): string`, the source of `board.circuit.tsx`:
    - `<board width height>` from `outline`
    - one `<chip>` per part, with `pinLabels` built from `part.pins` and `footprint` from `part.footprint`
    - one `<net name={signal}>` per pin assignment, joining `.${mcuRef} > .GPIO${gpio}` and `.${partRef} > .${partPin}`
    - every `<trace>` with a `name` (this silences tscircuit's warning)
    - connectors placed at the board edge given by `connector.edge` / `offsetMm`
  - `buildBoard(env: Env, dir: string, source: string, revision: number): Promise<BoardArtifact>`, which runs these steps:
    1. Write the source.
    2. Run `tsci build board.circuit.tsx --kicad-project`.
    3. Read `dist/board/circuit.json`.
    4. Compute `nets` from `source_trace`/`source_net`/`source_port` (look at `../spikes/hw/dist/board/circuit.json` for the shape first).
    5. Run `kicad-cli pcb export step` and `pcb render`.
    6. Return paths and W/H from `pcb_board`.

    A non-zero exit throws an `Error` that carries the last 40 lines of stderr.
  - `createBoardAgent(): Agent`. Its situation fires on `contract.changed` where `field ∈ {parts, pins, outline, connectors}`. Its processor calls `rebuilder.request(revision)`. The build stores `state.artifacts.board` and emits `artifact.ready` or `artifact.failed`.
  - `catalog/parts.json`: the vetted parts, with `{role, mpn, lcsc, footprint, pins[]}` and the exact pin labels tscircuit accepts. At minimum it holds ESP32-C3-MINI-1, an SHT40 sensor, a USB-C receptacle, the AP2112K-3.3 LDO, a 0402 resistor and a 0402 capacitor.
- [ ] **Step 1: Spike (time-box 45 min, outside the repo in `../spikes/hw/`).** Get a `<chip>` with custom `pinLabels`, plus a USB-C part, building and routing on a 50×30 board. Record the working footprint strings and pin names in `catalog/parts.json`. If a footprint can't be found, use a generic footprint string such as `qfn32` with the module's pin labels, and note it in `catalog/README.md`.
- [ ] **Step 2: Write failing tests.**
  - `codegen emits board size and nets`: the output for the Task 2 fixture contains `width="50mm"` and `name="I2C_SDA"`, plus one `<net` per pin assignment.
  - Integration test `board builds and passes consistency`: build the fixture into a temp dir, then run `checkConsistency(snapshot, {board})`. Expect no `net-missing` and no `outline-mismatch`.
- [ ] **Step 3: Run** `npm test`. Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Run** `npm test`. Expected: pass (or the integration test is skipped and reported as such).
- [ ] **Step 6: Commit** `feat: board agent builds PCB from the contract`

### Task 7: Enclosure agent (build123d)

**Files:**
- Create: `py/enclosure.py`, `src/tools/enclosure.ts`, `src/agents/enclosure.ts`
- Test: `test/enclosure.int.test.ts` (skipped when `env.python` is null)

**Interfaces:**
- Consumes: `Outline`, `Connector[]`, `BoardArtifact.stepPath` (optional).
- Produces:
  - `py/enclosure.py`, usage `enclosure.py <spec.json> <outdir>`. The spec is `{outline, connectors, wallMm: 2, clearanceMm: 2, heightMm: 12}`. It writes `case.step`, `case.stl` and `cutouts.json`. Each cutout is placed from contract coordinates; never use booleans against the board mesh.
  - `buildEnclosure(env: Env, dir: string, s: ContractSnapshot, revision: number): Promise<EnclosureArtifact>`
  - `createEnclosureAgent()`: wakes on `contract.changed` for `outline` or `connectors`, and coalesces builds through a `Rebuilder`.
- [ ] **Step 1: Write a failing integration test.** `enclosure cutouts match connectors`: `checkConsistency` returns no cutout violations for the fixture, and `case.stl` exists.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Port the shell and slot approach from `../spikes/hw/case.py`.
- [ ] **Step 4: Run.** Expected: pass.
- [ ] **Step 5: Commit** `feat: enclosure agent`

### Task 8: Firmware agent (PlatformIO)

**Files:**
- Create: `src/codegen/firmware.ts`, `templates/fw/platformio.ini`, `templates/fw/src/main.cpp`, `src/tools/firmware.ts`, `src/agents/firmware.ts`
- Test: `test/firmware-codegen.test.ts`, `test/firmware.int.test.ts` (skipped when `env.pio` is null)

**Interfaces:**
- Produces:
  - `pinsHeader(s: ContractSnapshot): string`: one `#define PIN_<SIGNAL> <gpio>` per assignment, plus `#define BRINGUP_REVISION <n>`.
  - `buildFirmware(env: Env, dir: string, s: ContractSnapshot, revision: number): Promise<FirmwareArtifact>`. It copies the template, writes `include/pins.h` and runs `pio run`. It parses `pins` back out of the generated header it compiled, so the check runs against what was actually built.
  - `createFirmwareAgent()`: wakes on `contract.changed` for `pins` or `parts`, and coalesces builds.
  - The firmware agent is also the **LLM** side of the interception demo. It wakes on `consistency.checked` when a violation `affects` includes `"firmware"`, or when `requirements.peripherals` names a bus with no pins. It then runs `safeRunLoop` with `contractTools("firmware")` and `ChangeControl`, so any pin change it wants goes to the architect for approval.
- [ ] **Step 1: Write failing tests.**
  - `pins header`: the fixture produces `#define PIN_I2C_SDA 8`.
  - Integration test: a build of the fixture gives `ok: true` and `pins.I2C_SDA === 8`.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Template board `esp32-c3-devkitm-1`, framework arduino.
- [ ] **Step 4: Run.** Expected: pass. The first build can take about 6 min, so use test timeout 600 000.
- [ ] **Step 5: Commit** `feat: firmware agent`

### Task 9: Architect and part-selector agents (LLM)

**Files:**
- Create: `src/agents/architect.ts`, `src/agents/parts.ts`, `src/tools/parts-search.ts`, `src/inference/scripts.ts`, `briefs/logger.md`, `briefs/blinky.md`
- Test: `test/agents-scripted.test.ts`

**Interfaces:**
- Produces:
  - `createArchitectAgent()`:
    - Wakes on `message.sent` (the brief, sent by the `engineer` human).
    - Also wakes on `change.proposed` for fields it owns, and answers with `decide_change`.
    - Also wakes on `consistency.checked` when a violation affects `"architect"`.
    - Its instruction: write `requirements`, `outline`, `connectors`, `rails` and `pins` through `propose_contract_change`, and use only pins on the MCU chosen from `catalog/parts.json`.
  - `createPartsAgent()`:
    - Wakes on `contract.changed` for `requirements` or `rails`.
    - Tools: `contractTools("parts")` plus `search_parts({role})`, which returns catalog entries enriched with live stock and price from `GET https://jlcsearch.tscircuit.com/...` by LCSC number. The free-text endpoint returned irrelevant results, so look up by number.
    - It writes `parts`.
  - `scripts.ts`: `mockScripts(): Record<string, Script>`, deterministic scripts for every role that reproduce the logger fixture from Task 2. With them, `--mock` produces a full, consistent design with no key. The firmware script asks once to add a `STATUS_LED` pin (GPIO 10, `D1.A`), and the architect script approves it. This is the held change that the e2e test in Task 10 expects.
- [ ] **Step 1: Write a failing test.** `scripted architect and parts populate the contract concurrently`: send the brief. Within 5 s, every field has version ≥ 1. The trace shows the parts agent's `contract.changed(parts)` landing after `contract.changed(requirements)`, and before the architect's last write, which proves they overlap.
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: pass.
- [ ] **Step 5: Commit** `feat: architect and part-selector agents`

### Task 10: Consistency participant, settling, CLI and README

**Files:**
- Create: `src/agents/consistency.ts`, `src/main.ts` (replaces the skeleton), `src/report.ts`, `README.md`
- Test: `test/e2e.mock.test.ts` (skipped unless all tools are detected)

**Interfaces:**
- Produces:
  - `createConsistencyParticipant()`: a `createHuman` (plain code, no LLM).
    - Wakes on `artifact.ready`, `artifact.failed` and `contract.changed`.
    - Runs `checkConsistency` and emits `consistency.checked`.
    - Emits `design.settled` when every artifact's `revision === contract.revision`, no build is pending, and there are no violations.
    - Once `contract.revision > MAX_REVISIONS` (25), it emits `design.settled` anyway and the report marks the design unsettled.
  - `main.ts` CLI: `npm run bringup -- <brief.md> [--mock] [--out out/<runId>]`. It:
    1. detects the environment and prints the backend table
    2. initializes the runtime, outbox and trace
    3. joins all participants
    4. sends the brief from the `engineer` human
    5. waits for `design.settled` (overall timeout 30 min)
    6. writes the report and exits

    Exit codes: 0 when settled with no violations, 2 when unsettled, 1 on an environment error.
  - `writeReport(outDir: string, state: BringupState, env: Env): string`. It writes `report.md` with the contract summary, the artifact paths, the violations, and counts of changes proposed, held, approved, rejected and violations caught.
  - `README.md` covers what it is, the architecture (link to the plan doc's diagram), how Mozaik is used (situations, `runLoop`, `RuntimeState`, interception), install (`.venv`, `tools/node`, Docker image), running `--mock` and with a key, and prior art credits.
- [ ] **Step 1: Write a failing e2e test.** `npm run bringup -- briefs/logger.md --mock --out <tmp>` exits 0. `report.md` says "Violations: 0". The trace contains `artifact.ready` for board, enclosure and firmware, and at least one held change (`change.proposed`, then `change.decided`).
- [ ] **Step 2: Run.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: pass. Then run once without `--mock` (real key) and record the result in `NOTES.md`.
- [ ] **Step 5: Commit** `feat: end-to-end bringup run with report and README`

---

## Follow-on plans (not in this one)

These are written once the core is green:
- the design tournament (2 branches, scoreboard)
- mid-run change requests from the `engineer` human
- a datasheet critic
- ngspice and Wokwi/QEMU simulation
- a dashboard, and engineers joining from a second laptop

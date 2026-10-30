# Mozaik 4.1.0 cheat sheet

Read from `../mozaik-examples/{history-simulation,custom-inference-runner}/src` and the installed
`node_modules/@mozaik-ai/core/dist` (4.1.0). Reference for the event, not project code.

**30 Oct:** `@mozaik-ai/core` 4.2.0 went stable on 29 Oct (19:13 UTC) and is now npm `latest`; the examples were
bumped to it at 21:09 UTC. Its `dist/index.d.ts` and `dist/index.mjs` are identical to 4.1.0, so everything below holds
for both. The 4.2 rewrite (Agent/Loop/Directive, `src/network`) is still only on GitHub master.

## Runtime
```ts
import { defineRuntime, RuntimeState } from "@mozaik-ai/core"

export class EnvironmentState extends RuntimeState {
	constructor(public readonly board: Board) { super() }   // shared state = fields on your subclass
}

export const { initializeRuntime, resolveRuntime, resolveParticipant, join, leave, sendMessage, sendEvent, runLoop } =
	defineRuntime<EnvironmentState>()

initializeRuntime({ state: new EnvironmentState(Board.init()) })   // optional: inferenceRunnerConfig
```
- `initializeRuntime` throws "Runtime already initialized" on a second call **to the same `defineRuntime()` result**.
  The guard lives in that closure, not globally, so two `defineRuntime()` calls give two independent runtimes in one
  process (untested; handy for a two-"laptop" test in one process).
- `resolveRuntime().state` is the shared state. Every participant sees the same object (single-threaded, no locks
  needed inside one process; check-then-act is safe only if there is no `await` between check and act).

## Participants
```ts
const builder = createAgent({ name: "Builder 1", capabilities: [], instruction: "...", tools: [], handlers: [h1, h2] })
const human   = createHuman({ name: "Planner input", capabilities: [], handlers: [] })
join(builder)            // leave(builder) to remove
```
- `Agent`: `getId()`, `getManifest()` (`{id, name, role, capabilities}`), `getTools()`, `getMemory().getContext()`.
- Memory is per agent and is not filled automatically: `own-answer.ts` adds the answer back with
  `agent.getMemory().getContext().addContextItem(answer)`.

## Reacting to events (situations)
```ts
class TaskPosted extends SituationSpecification {
	isSatisfiedBy({ event, participant }: SituationContext) {
		return event.type === "task.posted" && event.producerId !== participant.getId()
	}
}
class ClaimAndBuild implements SituationProcessor {
	apply({ event, participant }: SituationContext) { /* ... */ runLoop(participant.getId(), msg, input) }
}
export const taskPostedHandler: SituationHandler = { specification: new TaskPosted(), processor: new ClaimAndBuild() }
```
- Specifications compose: `.and()`, `.or()`, `.not()`.
- Dispatch (`EventProcessor.process`): `publish` walks **every participant**, and each one walks its handlers.
  `apply()` is called **without await**, so an async processor's rejection is unhandled. Wrap it in try/catch.
- Every handler sees every event, its own included. Filter on `producerId`.

## Agent turns
```ts
runLoop(agent.getId(), message, { model: "gpt-5.4", context: agent.getMemory().getContext(), tools: agent.getTools() },
        interceptionHandler?)
```
- Fire-and-forget: it returns at once and the loop runs in the background. Calling it for 3 agents = 3 concurrent
  turns. That is the concurrency the judges want to see.
- Loop states: `message_received → inference → (function_call → inference)* → model_message → idle`.
- Events published during a loop (producer = the agent): `message_received.started|completed`,
  `inference.started|completed` (or `inference.stream`), `function_call.started|completed`,
  `interception.started|finished`, **`model.answer`** (payload `{ answer: ModelMessageItem }`, text in
  `answer.content.text`).
- Other built-in types: `message.sent` (payload `{ message }`, from `sendMessage`), `participant.joined|left`.
- A turn budget pattern: `history-simulation/src/runtime.ts` `Conversation` (startTurn/endTurn/inFlight/tryClose).
  Reuse it as a cap on concurrent builders.

## Custom events
```ts
sendEvent(SemanticEvent.create("finding.posted", agent.getId(), { topic, text, sources }), agent.getId())
```
- `senderId` must be a joined participant, otherwise it throws.
- `SemanticEvent` = `{ type, producerId, occurredAt: Date, payload }`. To serialize, send `occurredAt` as an ISO
  string and rebuild with `new SemanticEvent(type, producerId, new Date(at), payload)`.

## Tools
`{ type: "function", name, description, parameters: <JSON schema>, strict, invoke: async (args) => result }`.

## Interception (Separation's "airlock" from the last edition used this)
```ts
const airlock: InterceptionHandler = {
	isSatisfiedBy: (t) => t.nextStateId === "function_call" && t.input.call.name === "edit_file",
	handle: async (t) => { await admitIntent(t); return t /* or a rewritten transition */ },
}
runLoop(id, msg, input, airlock)
```
- `handle` can hold a transition (await) while other agents keep running, or rewrite it. In 4.1.0 there is no
  `TurnScheduler`/`VersionedCell`; Separation built those itself (verify in their repo).

## Models and keys
- The provider is picked from the model name. Built-in names include `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.4-nano`,
  `gpt-5.5`, `claude-sonnet-5-5`, `claude-haiku-4-5`, `gemini-3.5-flash`, `gemini-3.5-flash-lite`,
  `deepseek-v4-flash` (full list: `grep -oE 'name: "[a-z0-9.\-]+"' node_modules/@mozaik-ai/core/dist/index.mjs`).
- Keys come from the environment: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`.

## Mock runner (free, no key)
Copy `../mozaik-examples/custom-inference-runner/src/runner.ts` (`MockInferenceRunner implements InferenceRunner`:
`run()` returns `{ items: [ModelMessageItem.rehydrate({ text })], tokenUsage: undefined, rowResponse }`, and `stream()`
yields one `inference.output`). Register it with a fake model spec:
```ts
initializeRuntime({ state, inferenceRunnerConfig: { supportedModels: [{ endpoint: new OpenAIChatCompletions(),
	specification: { name: "mock", provider: "openai", /* see example main.ts */ } }], runner: new MockInferenceRunner() } })
```
For tests of coordination logic, make the mock's reply depend on the input (e.g. return a scripted tool call) and add a
random delay, so the turns really overlap.

## Mozaik Cloud
- `@mozaik-ai/cloud-sdk` 0.1.3 comes in as a dependency of core. `npx @mozaik-ai/cloud-sdk pair` caches the key in
  `~/.mozaik/credentials.json`; alternatively set `MOZAIK_API_KEY` in `.env`.
- The cloud client is created **per `runLoop`** (inside `EventPublisherLoopVisitor`), so:
  - the "telemetry disabled" warning appears only once an agent runs a loop. The bare skeleton's `npm start` never
    prints it, so use an example to check pairing;
  - only loop events are sent, not custom `sendEvent` events, and each loop gets its own `sessionId`.
- The payload includes the agent's whole memory and tools. `MOZAIK_REDACTION=content|all` hides it.

## Bridge spike (29 Oct, `../spikes/bridge/`, mock runner): works
Relay (`ws`, ~25 lines) gives each event a `seq`, appends it to an in-memory log, broadcasts it, and replays from
`?since=<seq>` on reconnect. Each node = one runtime + a `bridge` human participant + an agent + a printer.
Node A sent `message.sent`, B's agent answered, and A received B's `model.answer` as a remote event. After pairing,
B's loop showed up in Mozaik Cloud.

Gotchas:
- **Echo loop:** the relay broadcasts back to the sender. Tag each event with an `eventId` + `origin`, and keep a
  `WeakSet` of rehydrated remote events so the bridge's catch-all handler doesn't send them out again.
- Inbound: `sendEvent(e, bridge.getId())` (keeps the original `producerId`) or `resolveRuntime().publish(e)`. Either
  way `resolveParticipant(e.producerId)` **throws for remote producers**: keep a directory of remote participants
  (names from `participant.joined`) and never call `resolveParticipant` on an event's producer.
- Rebuild the `Date`: `new SemanticEvent(type, producerId, new Date(occurredAt), payload)`.
- `model.answer` payload `answer` is a `ModelMessageItem`; after JSON it's a plain object (`answer.content.text`
  still works, but `instanceof` and its methods don't). Rehydrate before adding it to an agent's memory.
- Forward an allowlist of types (`message.sent`, `model.answer`, custom `finding.*`/`intent.*`/`task.*`), not the
  chatty loop internals.
- `publish` is synchronous and re-entrant (issue #115): a handler that sends causes nested dispatch. Plan an outbox.
- With the built-in telemetry each `runLoop` is its own cloud session (a new "watching live" URL per turn). For one
  shared view across laptops, use `createCloudExporter` from `@mozaik-ai/cloud-sdk/exporter` with a shared
  `sessionId` (see RESEARCH.md §E).

## Firmware emulation: Espressif QEMU (`tools/qemu`)

`src/tools/emulator.ts` boots `buildFirmware` output headless on `qemu-system-riscv32 -machine esp32c3`.
Install the prebuilt fork user-level (no sudo) into the main checkout's gitignored `tools/`:

```bash
cd tools
curl -LO https://github.com/espressif/qemu/releases/download/esp-develop-9.2.2-20260417/qemu-riscv32-softmmu-esp_develop_9.2.2_20260417-x86_64-linux-gnu.tar.xz
tar xf qemu-riscv32-softmmu-*.tar.xz   # unpacks to tools/qemu/bin/qemu-system-riscv32
rm qemu-riscv32-softmmu-*.tar.xz
# The binary links libslirp, which Ubuntu doesn't install by default. Fetch it user-level, without sudo:
d=$(mktemp -d) && (cd $d && apt download libslirp0 && dpkg -x libslirp0_*.deb x) \
  && mkdir -p qemu/lib && cp -a $d/x/usr/lib/x86_64-linux-gnu/libslirp.so.0* qemu/lib/ && rm -rf $d
LD_LIBRARY_PATH=$PWD/qemu/lib qemu/bin/qemu-system-riscv32 -machine help | grep esp32c3
```

`bootFirmware` puts `tools/qemu/lib` on `LD_LIBRARY_PATH` itself. Verified on 30 Oct 2026: QEMU 9.2.2
(esp_develop_9.2.2_20260417) boots the fixture firmware to `bringup rev 6`, then `SENSOR FAIL` every 2 s.
It took two fixes:
- `templates/fw/platformio.ini` sets `board_build.flash_mode = dio`. With the board's default QIO, the image asserts in
  `init_flash` ("Failed to set QIE bit"), because QEMU's flash model can't enable QIO.
- QEMU runs with `-nographic`. With `-display none -serial stdio`, UART0 never reaches stdout.

- The flash image is merged with PlatformIO's bundled esptool (`~/.platformio/packages/tool-esptool/esptool merge-bin`,
  padded to 4 MB): bootloader `0x0`, partitions `0x8000`, `boot_app0` `0xe000`, app `0x10000`.
- No SHT40 in emulation, so `SENSOR FAIL` is expected; a boot counts when `bringup rev N` appears on serial.
- Wokwi CLI is the alternative backend (it can simulate the SHT40) but needs `WOKWI_CLI_TOKEN`.
- `test/emulator.int.test.ts` skips while `tools/qemu` is missing.

# Research: Agent Mesh (29 Oct 2026)

Five parallel research agents, one per area. Each opened the pages it cites. Findings are what's useful to us, not
a survey.

## A. Software factories (spec → software)

- **Anthropic's 16-agent C compiler is the closest match.** It had no orchestrator: agents claimed tasks by writing
  a lock file in `current_tasks/`, and the losing agent picked another task. Each agent worked in its own container,
  then merged and pushed. Its lesson: "the task verifier is nearly perfect, otherwise Claude will solve the wrong
  problem." Pitfall: when every agent hit the same bug, they overwrote each other's fixes.
  [building-c-compiler](https://www.anthropic.com/engineering/building-c-compiler)
- **A verifier is the biggest single improvement, but most verifiers are shallow.** MAST studied 7 frameworks and
  found failure rates of 41–86.7%. Among the top failure modes: step repetition 15.7%, not knowing when to stop
  12.4%, disobeying the spec 11.8%, missing verification 9.1%. Adding a check against the high-level objective
  raised ChatDev's success by 15.6%. [MAST](https://arxiv.org/html/2503.13657v3)
- **Structured artifacts and pub/sub beat chat, and retries need a cap.** MetaGPT's roles are PM → Architect (files,
  interfaces) → task list per file → Engineer (3 debug retries) → QA. It scored 3.9 on executability vs ChatDev's
  2.1, at about 541 s per project. ChatDev's biggest failures: unimplemented methods (35% of review issues) and
  ModuleNotFound (46% of test errors). [MetaGPT](https://arxiv.org/html/2308.00352) ·
  [ChatDev](https://arxiv.org/html/2307.07924)
- **A fixed acceptance list with a `passes` flag stops agents declaring "done" too early.** Coding agents may only
  flip `passes`, and end-to-end checks helped most.
  [effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- **Parallel writers drift apart.** Cognition's Flappy Bird example ended with a mismatched background and bird,
  because "actions carry implicit decisions." Claude Code agent teams recommend 3–5 agents, disjoint files, and
  hooks that reject a "done" without proof. [Cognition](https://cognition.com/blog/dont-build-multi-agents) ·
  [agent teams](https://code.claude.com/docs/en/agent-teams)

## B. Coordination between concurrent agents

- **Agents declare intents; deterministic code decides whether to admit them.** In
  [Claim Plane](https://arxiv.org/abs/2607.21909), workers submit versioned ChangeIntents (paths, line ranges,
  symbols). A deterministic control plane admits compatible intents, serializes overlaps, rejects anything
  ambiguous, and re-checks at the first write. Pitfall: agents declare their scope badly before they've explored
  the code.
- **A lease needs a TTL and a fencing token.** A slow holder, such as an agent waiting 60 s on an LLM call, can
  outlive its lease. The fix is a monotonic token on each grant, with stale writes rejected.
  [Kleppmann](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) ·
  [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) (advisory reservations with `ttl_seconds`)
- **A worktree per agent prevents clobbering, but it only postpones conflicts.** 41.7% of concurrent PRs from
  different agents conflicted, and about 42% of those conflicts were structural.
  [AIDev-pop](https://arxiv.org/abs/2607.04697)
- **Task boards with atomic claims work; status drift is what kills them.** Agents forget to mark tasks done, and
  dependents stay blocked. [agent teams](https://code.claude.com/docs/en/agent-teams)
- **Remove duplicate research in layers: in-flight first, then exact hash, then embedding similarity.** A semantic
  cache can't catch concurrent duplicates, because the first answer hasn't landed yet. A similarity threshold of
  ~0.92 is suggested (~0.85 risks wrong reuse). The model to follow is Go's
  [singleflight](https://pkg.go.dev/golang.org/x/sync/singleflight).
  **The agent found no production system that merges semantically similar in-flight requests, so this is novel and
  makes a good demo hook.**
  [request coalescing](https://tianpan.co/blog/2026-04-12-request-coalescing-real-time-llm-cost-optimization)

## C. Shared memory across machines and people

- **mem0 works as a findings index, not as the log.** The TS SDK is `mem0ai`, and the free tier is plenty for 2 days.
  - `add` is async by default, so a finding isn't searchable right away. With `infer=false` it stores the text
    verbatim and synchronously.
  - `infer=true` rewrites the text and loses who wrote it.
  - Scope the team pool with one `app_id` per session.

  [add API](https://docs.mem0.ai/api-reference/memory/add-memories) ·
  [scoping](https://docs.mem0.ai/platform/features/entity-scoped-memory) · [pricing](https://mem0.ai/pricing)
- **A2A is overkill.** It is point-to-point delegation with no broadcast and no shared state.
  [A2A concepts](https://a2a-protocol.org/latest/topics/key-concepts/)
- **MCP memory servers are single-user.** [OpenMemory MCP](https://mem0.ai/blog/introducing-openmemory-mcp) is
  local-only.
- **PostHog's multiplayer-AI lessons:** keep one source of truth, and fill it automatically. Hand-written context
  files failed: 64 users created one in 90 days and 14 edited it. Record verified outcomes and link to sources.
  ([mirror of their email](https://www.sequenzy.com/email-examples/brands/posthog/emails/we-re-building-multiplayer-ai-here-s-what-we-ve-learned-so-far))
- **Transport:** a plain WebSocket relay with an append-only log is right for 2 days.
  [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream) is the fallback if the relay gets complicated.
  Venue Wi-Fi often blocks traffic between laptops, so host the relay off the LAN (Render, ngrok, Tailscale).

## D. Last edition's winners (Build 2026)

[Winners](https://build.jigjoy.ai/editions/build-2026/winners): 1 Separation, 2 Metamorph, 3 Watchtower, 4 Butterfly,
5 Hive. The jury published no rationale. Parallel Fix Swarm and ConcurProof did not place.

- **Separation won by making a concurrency hazard the product.** Two controller agents each issue an order that is
  safe alone but unsafe combined. An "airlock" `InterceptionHandler` holds both in-flight calls and rewrites one
  instead of vetoing it. State is versioned cells with CAS writes. It ran a controlled experiment: 600 runs,
  100 failures per control arm vs 0 with the interlock.
  [page](https://build.jigjoy.ai/editions/build-2026/gallery/separation-c7ef86) ·
  [repo](https://github.com/OoJae/separation)
- **Metamorph (2nd) is the closest to a factory.** It migrates codebases using workers and reviewers capped at 3+3, a
  coordinator with no LLM, integration behind a lock, and a shadow workspace that is only applied at the end.
  [page](https://build.jigjoy.ai/editions/build-2026/gallery/metamorph-602b9d) ·
  [repo](https://github.com/yohanvillarp/metamorph)
- **Every top-4 entry shipped a proof command.** Examples are Watchtower's `pnpm proof`, which prints peak concurrent
  inferences, and Butterfly's `npm run prove-concurrency`. Each used event-triggered `runLoop`s with no scheduler.
  [Watchtower](https://build.jigjoy.ai/editions/build-2026/gallery/watchtower-225889) ·
  [Butterfly](https://build.jigjoy.ai/editions/build-2026/gallery/butterfly-a2a414)
- **Hive (5th) made the shared room visible; the UI subscribes to the agents' own event stream.**
  [page](https://build.jigjoy.ai/editions/build-2026/gallery/hive-1271cd)
- **The entries that didn't place were shallow fan-outs or fake concurrency.** One entry's cards lit up "on a staged
  timer". Overused themes were incident war rooms (~10 entries), security, approval gates, and bounty verification.
  **No entry ran agents across machines or shared research between teammates.**

## E. Mozaik and baro

- **Corrections to CLAUDE.md:**
  - The "one runtime" limit applies per `defineRuntime()` closure, not per process.
  - Events are `SemanticEvent` instances, and `occurredAt` is a `Date`, so rebuild it on arrival.
  - The docs name events `context_update.*`, but 4.1.0 emits `message_received.*`. Trust the source.
  ([define-runtime.ts](https://github.com/jigjoy-ai/mozaik/blob/v4.1.0/src/define-runtime.ts))
- **Build the bridge as an observer participant.** JigJoy's own cloud exporter is a `createHuman` participant whose
  handler matches every event. 4.1.0 has no other transport hook.
- **Stay on 4.1.0.** 4.2 replaces `defineRuntime`, situations and `RuntimeState`, and npm `latest` is the beta, so
  keep the exact pin. Master has a new `src/network` WebSocket client plus a
  [mozaik-network](https://github.com/jigjoy-ai/mozaik-network) server, but neither is on npm. It is the direction
  Mozaik is heading, so pitch the bridge as an early version of it.
- **Open bugs in 4.1.0:**
  - [#115](https://github.com/jigjoy-ai/mozaik/issues/115): `publish` is synchronous and re-entrant, so participants
    can see events in different orders, and handler exceptions reach the sender. Fix: an outbox queue.
  - [#114](https://github.com/jigjoy-ai/mozaik/issues/114): `runLoop` swallows errors, so a crashed agent looks idle.
    Fix: an `agent.halted` event.
  - [#113](https://github.com/jigjoy-ai/mozaik/issues/113): an interception handler that returns `idle` crashes the
    process.
- **Cloud view:** the built-in telemetry opens a new session for every `runLoop` and sends only loop events.
  `createCloudExporter` from `@mozaik-ai/cloud-sdk/exporter` with one `sessionId` shared across laptops gives a
  single live view of the whole mesh, custom events included. Give its key a different variable name, or every
  event is reported twice.
- **[baro](https://github.com/jigjoy-ai/baro) (the judge's orchestrator, on Mozaik 3.12):**
  - An Architect writes a contract, which becomes a DAG of stories with declared, non-overlapping write sets.
  - The Conductor is event-driven and leases work through a `LeaseBroker`.
  - Each story gets its own worktree.
  - Observers: Librarian (shared findings), Sentry (edit overlaps), Critic (gate), Surgeon (replan), Auditor
    (JSONL log).
  - The Critic gates completion: missing evidence means the story fails.
  - What the author values: verified output, fail-closed checks, typed events, replayable logs, and "compose by
    reaction, not orchestration". ([OBSERVERS.md](https://github.com/jigjoy-ai/baro/blob/main/packages/baro-orchestrator/src/execution/OBSERVERS.md))

## What this changes in our plan

1. **Lead with what nobody did last year:** agents on several laptops sharing live research, including waiting on
   research a teammate's agent has in flight. Edit-conflict prevention is valued but not new: Separation won with
   it, and baro has a Sentry.
2. **The planner's first step runs alone** and writes a contract: scaffold, shared types and interfaces, a test
   command, and a task list. Each task gets its file ownership and executable acceptance checks. Builders fan out
   only after that commit.
3. **Edit intents become leases.** Deterministic code on the relay (the single sequencer) grants or refuses them,
   with a TTL, heartbeat and fencing token (the log `seq`). Same symbol = conflict; same file, different symbol =
   warning. Use Mozaik's `InterceptionHandler` on the edit tool as the airlock.
4. **The reviewer is a gate, not an advisor.** Only the reviewer marks a task done, and only with captured
   build/test evidence. Failures go back to the builder with a 3-retry cap, then the task moves to `blocked`.
5. **Research dedup in layers:** in-flight match first, then exact hash, then embedding ≥ ~0.9. The score shows in
   the UI. Waiters need a timeout and a path for when the researcher dies.
6. **Budgets and a clock:** cap concurrent builders (3, like Metamorph), cap tokens per task, and switch to
   "stabilize and integrate" about 30 minutes before 20:00.
7. **Ship `npm run proof`:** it prints overlapping turns and peak concurrency, and runs an A/B against a no-mesh
   baseline (tokens saved, conflicts avoided). Add a demo video. The non-placing entries had no proof and no demo.
8. **Infrastructure:**
   - Pin to 4.1.0.
   - Use an outbox queue for #115 and `agent.halted` for #114.
   - Use one shared `createCloudExporter` session across laptops.
   - Use mem0 (`infer=false`) as the search index over the log, with a local embedding fallback behind one
     interface.
   - Host the relay off the LAN.

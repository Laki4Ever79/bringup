# Hand-off: lead session (agent-mesh-14 → agent-mesh-32), Fri 30 Oct, late night

Read `CLAUDE.md` first, then this file. The plan doc (Claude Docs, project 8011e230-9378-4f1a-ad10-179ff9e4f190, link
https://claude.ai/artifact/GpFMaa2NAE81hn9BSHajQj) is the user-facing source of truth; keep it updated.

## Deadline and rules
- Submissions close **Sat 31 Oct 20:00 CET**. Track: **Freestyle** (30 useful+original, 30 Mozaik use, 25 runs from
  README, 15 README).
- Repo is public at github.com/Laki4Ever79/bringup. Local branch `bringup-core` is pushed as `main`
  (`git push origin bringup-core:main`). Never push secrets. `.env` holds the OpenAI key and the event's Claude
  gateway key. Never print them.
- The user's standing preferences:
  - be honest about what's real versus scripted, and never overclaim
  - flag prior art before building on an idea (memory: check-ideas-against-prior-art)
  - commit through TDD
  - keep the presentation focused on one clear point

## Where things are
- 480 tests pass (`npm test`, about 4–6 min with tools; QEMU, Docker KiCad, tscircuit, PlatformIO and build123d are
  all installed under `.venv/` and `tools/`).
- Ledger of the core plan: `.superpowers/sdd/2026-10-30-bringup-core/progress.md`.
- Docs:
  - `docs/submission.md`, `docs/video.md` (the one-line, three-act draft)
  - `docs/design/dashboard.md`
  - `docs/design/bench.md`, `docs/bench-wiring.md`
  - `RESEARCH-HW.md` (prior art)
- Real-model runs 1–10: `out/real-*`. Runs 2 and 4 settled. None of 6–10 passed the final brief review; the plan doc's
  runs table explains each.
- Dashboard hub: `node_modules/.bin/tsx src/dashboard/cli.ts` (port 4317; this session started one, so restart it if
  stale). `npm run demo` for a one-command demo.
- Live bench: the user's ESP32-S3 (with an MPU-6050) was flashed and ran our firmware tonight. **The user is
  unplugging it to sleep.** Use `--bench fake` / `replay` only until they say otherwise. Never flash or power real
  hardware without their explicit go.

## Helper sessions (each in its own worktree; the lead merges)
- **agent-mesh-7a**: dashboard + host side (worktree `../wt-board`, branch `wt/board`).
- **agent-mesh-af**: bench hardware, firmware, bridge (`py/bench.py`), enclosure (`../wt-enclosure`, `wt/enclosure`).
- **agent-mesh-5b**: power, catalog, reviewer, docs (`../wt-firmware`, `wt/firmware`).

Protocol: give a narrow, test-first brief; they reset their worktree to `bringup-core`, commit, and report "tagged".
You merge into `bringup-core` in the main checkout, run `npm test`, and push. They know this protocol.

## What the user asked for just now (your mission)
The user feels the project has **an identity crisis**: many good pieces, no single winning point. Their words: "We need
to make a strong point for the win. Even if it means big changes to our concept here, like introducing new features,
pivoting, fixing the WebUI with an actually useful and modern skill, not this outdated one and whatever else. We need
a strong point."

They also answered that last year's winner (Separation, which won on a controlled experiment) probably wasn't an open
category, so we can't simply copy that recipe.

My honest assessment, to start from (challenge it, don't just execute it):
- Today's identity: *"Hardware disciplines working at the same time without breaking each other's work: every
  change goes through its owner, every claim is checked by someone who didn't make it, down to the real board."*
  Parallel AND consistent.
- Mozaik use:
  - Strong: situations as the dependency graph, interception as change control, RuntimeState as the contract, humans
    and the real board as participants.
  - Weaker: the heavy parallel work is plain code (the builders); the LLM agents mostly take turns; the review gate
    serializes the end; no real run passed the final review.
- One candidate for the missing proof: a saboteur/fault-injection A/B experiment (inject pin drift, cutout misalignment,
  invented pins, impossible battery claims; N trials with the checks off versus on; show which layer caught what) plus
  a parallel-vs-sequential wall-clock number. Cheap to run on scripted models plus the real checkers.
- The user is open to bigger changes. Brainstorm with them first (superpowers:brainstorming), propose 2–3 sharp
  directions with a recommendation, and research prior art before committing.
- The "WebUI with an actually useful and modern skill": the user may mean using a proper frontend/design skill or
  approach for the dashboard. Ask what they mean and look at which design skills are available in the session.

## Do-not-break list
- `npm run bringup -- briefs/logger.md --mock --no-hardware` must keep working (it's the judge path, about 3 s).
- Keep the scripted mode honest (it always builds the logger, and the UI says so).
- Mozaik is pinned at exactly 4.1.0.

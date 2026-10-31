# Public demo (`cli.ts --public`)

`npx tsx src/dashboard/cli.ts --public` serves the hub on `$PORT` (default 4317, every interface) for a public
deployment. `render.yaml` describes one Render web service: Node 24, `npm ci`, that start command. Nothing is
deployed yet.

- **Read-only replays.** The recorded runs in `docs/runs` (`PUBLIC_RUNS` in `src/dashboard/public.ts`) are copied
  into a tmp out root and served like any run. They carry their traces, contracts and change logs, not their build
  files, so their board and case views say "recorded run: … files not in the public demo".
- **Every POST is 403 "read-only demo"**: requests, decisions, drift, ask and stop. The order zip (GET) is refused
  too. Cross-site POSTs are refused.
- **Try it** (`POST /api/runs`, the body is ignored): a scripted (`--mock`), stubbed (`--no-hardware`,
  `--no-review`) run of `briefs/beacon.md` that stays up for **one** change from the scripted set ("add a
  temperature/humidity sensor", "make it N mm wide", "blink faster [when tilted]").
  - At most one live run for everyone (409), 5 runs per IP per hour (429, from the first `X-Forwarded-For` hop).
  - A run is killed after 3 min, and its out dir is deleted 10 min after it ends.
  - Its views say "stubbed run: no PCB / 3D case (hardware tools off)".
- **No secrets.** At start the server deletes every `*_API_KEY`, `ANTHROPIC_BASE_URL`, `WOKWI_CLI_TOKEN` and
  `BRINGUP_NTFY_*` from its environment, and points Mozaik's credentials at `/dev/null`. There is no Ask, bench,
  ntfy, ordering or file sync.
- **The banner** "Public demo: recorded runs used the real tools (KiCad, build123d, PlatformIO); live runs here are
  stubbed." is fixed at the bottom-left of every page.

Tests: `test/public.test.ts` covers the gate's limits, the 403s, the banner, Try it's fixed flags, the one change,
the timeout and the clean-up.

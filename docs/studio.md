# Bringup Studio

Bringup Studio is the hosted web page for your runs: watch a design build live, open it in 3D, follow the build guide,
and (on a paid plan) edit, simulate and debug it. The engine, the MCP server, the CLI and every file a run writes stay
free and on your machine; Studio only shows what your machine sends it.

## Connect this machine

```bash
npx -y bringup-mcp login --url https://<studio address>     # from npm; or set BRINGUP_STUDIO_URL
npm run bringup -- login --url https://<studio address>     # the same from a clone
```

It prints a code and opens the approval page in your browser; approve it while signed in to Studio. The token is saved
in `~/.bringup/studio.json` (readable only by you, mode 0600) and is never printed. `npx -y bringup-mcp logout` (or
`npm run bringup -- logout`) removes it. Runs started through the MCP server (Claude Code, Cursor) stream too.

## What streams

While you're logged in, every run streams to Studio as it happens: the trace, the contract on each revision, the
reports, and the built files (board, case, printed parts, pictures). Build caches and large files stay local: a
firmware build's `.pio` folder, `node_modules`, a package's `.work`, linker outputs (`*.elf`), firmware images over 4 MB
and anything over 32 MB. A growing file such as `trace.jsonl` is sent as its new lines only.

What you do in Studio comes back as lines in the run's own files, exactly as the CLI writes them: change requests
(`requests.jsonl`), decisions on held changes (`decisions.jsonl`), pause and resume (`steer.jsonl`), drift actions
(`drift-actions.jsonl`) and a system's requests (`system-requests.jsonl`). Nothing else on your machine is written, and
nothing listens on your machine: the connector only makes outgoing HTTPS requests.

## Keep a run local

```bash
npm run bringup -- briefs/logger.md --mock --offline
```

`--offline` keeps that run off Studio. Without a token nothing is sent at all.

## When Studio is unreachable

The run goes on. The connector says once that Studio is unreachable, retries with a growing wait (up to 30 s), and when
Studio is back it sends whatever changed meanwhile, from the run folder itself.

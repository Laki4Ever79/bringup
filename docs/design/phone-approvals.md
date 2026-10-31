# Approvals on your phone (opt-in)

With `--engineer-approval`, interception holds pin and connector changes until the engineer decides. The hub can push
each held change to a phone through [ntfy](https://ntfy.sh), with **Approve** and **Reject** buttons that call the
hub's own decision route (`POST /api/runs/<id>/decisions`).

```bash
export BRINGUP_NTFY_TOPIC=bringup-$(head -c 15 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9')   # unguessable
npx tsx src/dashboard/cli.ts out/<runId> 4317 --lan    # subscribe to the topic in the ntfy app
```

- **Off by default.** Nothing is sent unless `BRINGUP_NTFY_TOPIC` is set. `BRINGUP_NTFY_SERVER` points at a
  self-hosted ntfy instead of ntfy.sh.
- **ntfy.sh is public.** Anyone who knows a topic name can read it and post to it, so the topic must be unguessable.
  A push carries only the field and a short summary of the agent's reason (at most 100 characters), never the brief
  or contract values.
- **`--lan`** makes the hub listen on the network so the phone can reach it, and prints the LAN URL and a random token.
  From another host, only the decision route answers, and only with that token (`X-Bringup-Token`, which the buttons
  carry). The page, starting runs and change requests stay loopback-only. Without `--lan` the hub listens on
  127.0.0.1 only, as before. `BRINGUP_HUB_URL` overrides the URL the buttons call (e.g. through a tunnel).
- A push goes out once per held change, only for changes held now (a replayed old trace sends nothing), and a failed
  push never stops the hub: the change stays held and the dashboard can still decide it.

Code: `src/dashboard/notify.ts`, the hub's `lan`/`notify` options in `src/dashboard/server.ts`, tests in
`test/notify.test.ts` and `test/hub.test.ts` (an injected fetch; no network).

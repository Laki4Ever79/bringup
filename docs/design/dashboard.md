# Dashboard redesign

The dashboard is what judges and the 17:00 audience watch. They should see the hardware being designed: the board,
its parts and the 3D model are the centerpiece, and the agents' work is visible around them. The look is the
Vercel/Apple school: calm, dark, precise, one accent colour per agent, motion only where something is happening.

## Layout (16:9, readable on a projector at 1440×900 and 1920×1080; no page scroll at 1920×1080)

```
┌ top bar ─────────────────────────────────────────────────────────────────────────────────────────┐
│ ● Bringup   "BLE temperature logger"   [LIVE · rev 12 ▲]   02:41   ✓ Consistency ✓ Grounding ⟳ Review   Cloud ↗ │
├──────────────────────────────────────────────────────────┬──────────────────────────────────────┤
│  STAGE (≈62% width)                                      │  3D  (case + board, drag, explode)   │
│  [ PCB ▾ | Render | 3D ]   50.0 × 30.0 mm · 2 layers      │                                      │
│                                                          ├──────────────────────────────────────┤
│        live vector PCB (pads, traces by net,             │  PARTS  (BOM)          total $5.18   │
│        parts hoverable; changed parts glow)              │  U1 ESP32-C3-MINI-1  C2838502 ✓ 22k  │
│                                                          │  U2 SHT40 …          ✓   $1.75       │
│  ─ revision scrubber: ● ● ● ● ●  (dot per revision,      │  hover a row = highlight on PCB + 3D │
│    coloured by who changed what; drag to replay)         │                                      │
├──────────────────────────────────────────────────────────┴──────────────────────────────────────┤
│  AGENTS: one card each, in a row: Architect · Parts · Firmware · Reviewer · Board · Case · Build · Grounding │
│  avatar dot + status ring (pulses while active) · current task in one line · last result · mini activity bars │
├──────────────────────────────────────────────────────────────────────────────────────────────────┤
│  CHANGE CONTROL: "pull request" cards: firmware → architect · pins · +STATUS_LED · approved ✓ "GPIO10 is free" │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Clever elements we want:
- **The hovered part lights up everywhere.** Hovering a parts row or a part on the PCB highlights it in the BOM, on the
  PCB and in 3D at the same time.
- **"What just changed" glow.** When a revision lands, the parts and nets that changed glow for about 2 s on the PCB.
  The field that changed gets a short pill on the stage: `pins v4 · firmware`.
- **Revision scrubber.** Every contract revision is a dot, coloured by its author's agent colour. Clicking a dot shows
  that revision's board, from `board/rev-N/`.
- **Pull-request cards for held changes.** They show the requester and owner avatars, the field, a compact before→after
  diff (e.g. `+ STATUS_LED → GPIO10`), then the approved/rejected badge with the owner's reason.
- **The checks as three status pills in the top bar.** A pill turns amber or red with a count; clicking it opens a
  popover listing the findings.
- **Battery-life gauge** on the stage: "Estimated 225 days vs 180 target", from report.md/contract power fields.

## Visual tokens (use these exact values in both modules)

| Token | Value |
|---|---|
| Background | `#0a0a0a`; panels `#111113`; raised `#16161a` |
| Border | `1px solid #232327`; hover `#2e2e35` |
| Text | primary `#ededed`, secondary `#a1a1aa`, tertiary `#6b6b76` |
| Font | `ui-sans-serif, -apple-system, "SF Pro Display", "Inter", "Segoe UI", system-ui, sans-serif`; mono `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace`. No web-font downloads |
| Sizes | 13 / 15 / 18 / 24 / 32 px; numbers use `font-variant-numeric: tabular-nums` |
| Radius | 12 px panels, 8 px cards, 999 px pills |
| Motion | 160 ms `cubic-bezier(.2,.8,.2,1)`; active status ring pulses at 1.6 s; respect `prefers-reduced-motion` |
| Agent colours | architect `#3b82f6` blue · parts `#a855f7` violet · firmware reviewer `#14b8a6` teal · brief reviewer `#f59e0b` amber · board `#22c55e` green · enclosure `#ec4899` pink · firmware build `#06b6d4` cyan · grounding `#eab308` yellow · consistency `#f97316` orange · engineer `#e5e7eb` |
| Status | ok `#22c55e`, warn `#f59e0b`, error `#ef4444`, info `#3b82f6` |
| PCB | board `#0f2a1d` with a `#1f4d36` edge; top copper `#d4a24c`; bottom copper `#4c8ed4` at 70 %; pads `#e8c27a`; silkscreen `#e5e7eb` at 80 %; nets: GND `#64748b`, power (V3V3/VBUS/VBAT) `#ef4444`, signals cycle through the agent colours |
| Glass | panels may use `backdrop-filter: blur(12px)` over a faint radial gradient (`#1e293b` at 6 % top-left) |

## Data the page can read (all under `/files/`)

| File | Written by | Contents |
|---|---|---|
| `trace.jsonl` | outbox | Every event, including `agent.activity` |
| `contract.json` | consistency participant | Snapshot `{revision, values, versions}` |
| `board/circuit.json` | board builder (latest) | tscircuit circuit JSON: `pcb_board`, `pcb_component`, `pcb_smtpad`, `pcb_trace`, `source_*` |
| `board/rev-N/dist/board/circuit.json` | board builder | Per revision, for the scrubber |
| `board/board.png`, `board/rev-N/board.png` | board builder | KiCad renders |
| `enclosure/rev-N/case.stl` | enclosure builder | Case mesh |
| `bom.json` | parts/BOM participant | `[{ref, role, mpn, lcsc, footprint, stock, priceUsd, inStock, grounded, finding?}]` plus a `totalUsd` |
| `report.md`, `requests.jsonl`, `cloud.jsonl` | run | As today |

## Module interfaces (plain ES modules served from a whitelist, no frameworks, no CDN)

```ts
// src/dashboard/pcb-view.js
export function mountPcb(el: HTMLElement, opts?: { onHover?(ref: string | null): void; colors?: object }):
  { update(circuit: any[], changedRefs?: string[]): void; highlight(ref: string | null): void; setView(v: "top" | "bottom" | "both"): void }

// src/dashboard/scene3d.js
export function mountScene(el: HTMLElement, opts?: { onHover?(ref: string | null): void }):
  { update(input: { caseStl?: ArrayBuffer | null; circuit?: any[] | null }): void; setExplode(t: number): void; highlight(ref: string | null): void }
```

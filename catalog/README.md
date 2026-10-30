# Parts catalog

`parts.json` lists the parts the agents may pick. Each entry is `{ref?, role, mpn, lcsc, footprint, pins[]}`.
`footprint` is a tscircuit footprinter string, and `pins` are the labels given to `pinLabels` in order
(`pins[0]` → `pin1`). Every footprint here was built and autorouted with tscircuit 0.0.3042 on a 50×30 mm board
(30 Oct 2026).

Generic footprints, not the real land pattern:

| Part | Footprint used | Real package |
|---|---|---|
| ESP32-C3-MINI-1 | `qfn32` | 53-pad LGA module, 13.2×16.6 mm |
| SHT40 | `dfn4` | 1.5×1.5 mm DFN-4 (pitch differs) |

`usbcmidmount` is tscircuit's 16-pin mid-mount USB-C receptacle. Its pins are `pin1`..`pin16` (shell pads not
labelled), so `pins` is empty until the VBUS/CC/D± pad order is mapped. In codegen it is emitted as a `<connector>`,
not a `<chip>`, which avoids tscircuit's `J`-prefix warning.

The LCSC numbers were not re-checked against live stock during the event.

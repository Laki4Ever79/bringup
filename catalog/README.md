# Parts catalog

`parts.json` lists the parts the agents may pick. Each entry is `{ref?, role, mpn, lcsc, footprint, pins[]}`.
`footprint` is a tscircuit footprinter string, and `pins` are the labels given to `pinLabels` in order
(`pins[0]` → `pin1`). Every footprint here was built and autorouted with tscircuit 0.0.3042 on a 50×30 mm board
(30 Oct 2026).

Generic footprints, not the real land pattern:

| Part | Footprint used | Real package |
|---|---|---|
| SHT40 | `dfn4` | 1.5×1.5 mm DFN-4 (pitch differs) |

**ESP32-C3-MINI-1** uses `esp32_c3_mini_1`. This isn't a footprinter string: `src/codegen/circuit.ts` emits an
inline `<footprint>` for it. It follows the module datasheet (v2.2, Table 3-1 and Figure 11-1):
- a 13.2 × 16.6 mm body, the top 5.4 mm of which is the antenna area, drawn on silkscreen
- 53 pads, with the datasheet's numbering and sides: 1–11 down the left, 12–24 along the bottom, 25–35 up the right,
  36–48 a GND row under the antenna, 49 the thermal pad, 50–53 the corner pads
- 0.4 × 0.8 mm edge pads on a 0.8 mm pitch, and 0.7 mm corner pads

The contract's pin names map to the datasheet's pin numbers: GPIO8 → pin 22, GPIO9 → 23, GPIO10 → 16, 3V3 → 3,
GND → 1, and so on. Pad *offsets* are reconstructed from the figure's dimensions and are approximate, to roughly
0.5 mm. The 5.4 mm thermal-pad size is our best reading of the figure. Only pad 1 is wired to GND; the other GND pads
(2, 11, 14, 36–53) are left unconnected. Check against Espressif's land-pattern source files before ordering boards.

**Placement** (`placeParts` in `src/codegen/circuit.ts`) is deterministic. Connectors go to their contract
edge and offset. The MCU goes near the board centre, its whole body reserved and its antenna turned away from USB-C.
The LDO goes between USB-C and the MCU. The sensor goes to the far edge, in the corner away from the MCU, to keep it
away from heat. The LED and its resistor go by the USB-C edge. Other passives go around the MCU. Each part takes the
free spot nearest its target, on a 0.5 mm grid, with a 1.5 mm gap to every other part and 0.5 mm to the board edge.
Part sizes come from pad bounding boxes measured in tscircuit 0.0.3042. A part with no room left is handed to
tscircuit's packer.

`usbcmidmount` is tscircuit's 16-pin mid-mount USB-C receptacle. Its pins are `pin1`..`pin16` (shell pads not
labelled), so `pins` is empty until the VBUS/CC/D± pad order is mapped. In codegen it is emitted as a `<connector>`,
not a `<chip>`, which avoids tscircuit's `J`-prefix warning.

Power pads of `usbcmidmount`, as wired by `src/codegen/circuit.ts`. These were read from the footprinter source
(`@tscircuit/footprinter`, `usbcmidmount.ts`), not from a datasheet. `pin1`..`pin4` are the shell tabs, and
`pin5`..`pin16` are the 12 contact pads from left to right. The outer two pads on each side are the wide merged power
pads, which on a 16-pin USB-C receptacle are GND (outermost) and VBUS:

| Pads | Net | Wired |
|---|---|---|
| `pin5`, `pin16` | GND | yes |
| `pin6`, `pin15` | VBUS → LDO VIN and EN | yes, when the contract has an `ldo` part |
| `pin7`..`pin14` | SBU, CC1/CC2, D+/D− | **no** |
| `pin1`..`pin4` | shell | no (left floating) |

Still missing for a working USB-C sink: 5.1 kΩ pull-downs from CC1 and CC2 to GND (without them, a C-to-C charger
supplies no VBUS), and D+/D− to the ESP32-C3's GPIO18/GPIO19 for flashing. Both need the inner pad order checked
against the TYPE-C-31-M-12 datasheet first.

The LED gets a series resistor to GND. Codegen uses the contract's 1 kΩ `resistor` (LCSC C11702) if it has one, then
any other `resistor` in the contract, and otherwise adds a 1 kΩ 0402 `<resistor>` (`R1`, or the next free ref). That
added resistor is on the board but not in the contract's BOM; the parts agent can avoid that by picking C11702.
The catalog's 1 kΩ is `0402WGF1001TCE` (C11702), a JLCPCB basic part. jlcsearch's exact lookup on 30 Oct 2026 showed
21,651,885 in stock at $0.0013.

The LCSC numbers were not re-checked against live stock during the event.

## Live stock and price

`searchParts(role)` in `src/tools/parts-search.ts` returns this catalog's entries for a role, enriched with live
`stock`, `priceUsd` (unit price at quantity 1) and `inStock` from jlcsearch:

```
GET https://jlcsearch.tscircuit.com/api/search?q=C2838502&limit=1
→ {"components":[{"lcsc":2838502,"mfr":"ESP32-C3-MINI-1-N4","stock":22598,"price":3.0547,"stock_checked_at":"…",…}]}
```

`q=C<number>` is an exact LCSC lookup and keeps parts with zero or unknown stock. Upstream test:
`tests/lib/search-lcsc-prefix.test.ts` in tscircuit/jlcsearch. Free text on the same route ranks loosely; `SHT40`
returns a Zener diode and a buck converter. That is why the agents only look up parts already in this catalog.
`/components/list.json?search=C<number>` also matches exactly, but its `price` is a tier string from an older snapshot.

Any network error, non-2xx response or 5 s timeout gives `null`s instead of an error, so offline runs still work.
Successful lookups are cached for the process.

Checked live on 30 Oct 2026: every part is in stock. `SHT40-AD1B-R2` used to be listed as `C2758054`, a number LCSC
does not have. JLCPCB's parts search and jlcsearch both give `C2909890` (DFN-4 1.5×1.5, 16 939 in stock), so the
catalog now uses that.

## Pin grounding

`groundParts` in `src/contract/grounding.ts` checks every contract part's pins, and every pin assignment, against
ground truth. It looks in this catalog first, then in KiCad 10's official symbol library (`/usr/share/kicad/symbols`
in the `kicad/kicad:10.0` image, read by `src/tools/kicad-symbols.ts` and cached in `out/.cache/kicad-symbols/`).
An MPN matches a KiCad symbol by exact name, by name prefix (`AP2112K-3.3` for `AP2112K-3.3TRG1`), by the `x` wildcard
(`SHT4x`), or by a `ki_keywords` entry (`SHT40`). Symbols that `extends` another symbol take that symbol's pins.

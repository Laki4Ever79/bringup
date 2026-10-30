# Parts catalog

`parts.json` lists the parts the agents may pick. Each entry is `{ref?, role, mpn, lcsc, footprint, pins[]}`.
`footprint` is a tscircuit footprinter string, and `pins` are the labels given to `pinLabels` in order
(`pins[0]` → `pin1`). Every footprint here was built and autorouted with tscircuit 0.0.3042 on a 50×30 mm board
(30 Oct 2026).

Generic footprints, not the real land pattern:

| Part | Footprint used | Real package |
|---|---|---|
| SHT40 | `dfn4` | 1.5×1.5 mm DFN-4 (pitch differs) |
| TS-1187A-B-A-B | `pushbutton` | 5.1×5.1 mm SMD tactile switch |

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

`usbcmidmount` is tscircuit's 16-pin mid-mount USB-C receptacle, used for TYPE-C-31-M-12. Its catalog pins are named
(`VBUS, GND, CC1, CC2, DP, DN`), but codegen never labels its pads. It addresses them directly (`USBC_PADS` in
`src/codegen/circuit.ts`), because the pin order isn't the pad order. `pin1`..`pin4` are the shell tabs. `pin5`..`pin16`
sit at the same x positions as the contact pads of KiCad's `USB_C_Receptacle_HRO_TYPE-C-31-M-12` footprint (KiCad 10
library, both top view), which name them, left to right:

| Pads | KiCad pads | Signal | Wired to |
|---|---|---|---|
| `pin5`, `pin16` | A1/B12, B1/A12 | GND | GND |
| `pin6`, `pin15` | A4/B9, B4/A9 | VBUS | charger VCC, or LDO VIN and EN when there is no charger |
| `pin8`, `pin14` | A5, B5 | CC1, CC2 | each to GND through 5.1 kΩ (C25905), so a C-to-C charger supplies 5 V |
| `pin10`, `pin12` | A6, B6 | D+ | ESP32-C3 GPIO19 (native USB), when the MCU lists GPIO18/19 and the contract doesn't use them |
| `pin9`, `pin11` | B7, A7 | D− | ESP32-C3 GPIO18 |
| `pin7`, `pin13` | B8, A8 | SBU2, SBU1 | not connected (not used by USB 2.0) |
| `pin1`..`pin4` | SH | shell | not connected |

The mapping relies on both footprints being top views with the pad row on the same side. tscircuit's footprint is
symmetric, so if it were mirrored, only D+ and D− would swap. Check D± in KiCad before ordering.

## Support parts

Codegen gives every board the passives it needs to work. Each one takes a contract part with the same LCSC number if
there is one, else codegen adds it to the board. Added parts appear in `bom.csv`, but not in the contract.
`boardParts()` lists both. Assignment order: LED, CC1, CC2, PROG, I2C pull-ups, bypass caps.

| Job | Part | LCSC |
|---|---|---|
| LED series resistor, cathode → GND | 1 kΩ 0402 `0402WGF1001TCE` | C11702 |
| USB-C CC1, CC2 → GND | 5.1 kΩ 0402 `0402WGF5101TCE` | C25905 |
| Charger PROG → GND (sets the charge current, about 1000 V / R ≈ 210 mA) | 4.7 kΩ 0402 `0402WGF4701TCE` | C25900 |
| I2C SDA, SCL pull-ups → 3V3 | 10 kΩ 0402 `0402WGF1002TCE` | C25744 |
| Charger input (VBUS), LDO input (VBAT, or VBUS without a charger) | 1 µF 0402 `CL05A105KA5NQNC` | C52923 |
| LDO output (3V3) | 10 µF 0603 `CL10A106KP8NNNC` | C19702 |

## Power path

USB-C VBUS → charger (TP4054, C32574) VCC; charger BAT → VBAT → battery connector (JST S2B-PH-K, C173752) and the
LDO's VIN and EN; LDO VOUT → 3V3. Without a charger, VBUS feeds the LDO directly, as before. The ESP32-C3's EN is tied
straight to 3V3. Espressif recommends a 10 kΩ / 1 µF RC delay there; it's not fitted yet.

- **TP4054-42-SOT25R** (C32574, JLC preferred part, 44,864 in stock): pins in the order `CHRG, GND, BAT, VCC,
  PROG`, as in KiCad's symbol for the pin-compatible LTC4054ES5-4.2. Not checked against TP4054's own datasheet (the
  LCSC PDF link only returns an HTML page). `CHRG` (open-drain charge status) is left unconnected.
- **S2B-PH-K-S(LF)(SN)** (C173752, 198,123 in stock): through-hole, right angle, footprint `jst2_ph` (2 mm pitch).
  Pins `VBAT` (pad 1) and `GND` (pad 2). **JST-PH battery packs don't agree on polarity. Check the pack's wiring
  against pad 1 = + before plugging in.** Pin names can't contain `+` (tscircuit rejects `BAT+` as a pin label).
- **TS-1187A-B-A-B** (C318884, basic) tactile switch, role `button`, pins `A` and `B`. tscircuit's `pushbutton`
  footprint connects pads 1–2 and 3–4 internally, so `A` is pad 1 and `B` is pad 3, on opposite sides. Sequential
  labels would have put both wires on the same side and shorted the GPIO to GND. A pin assignment wires one side to its
  GPIO, and codegen ties the other side to GND. The `pushbutton` footprint is a 6 × 6 mm THT stand-in for the
  5.1 × 5.1 mm SMD switch.

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

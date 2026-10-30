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

The LED gets a series resistor to GND: the contract's `resistor` part if it has one, otherwise codegen adds a 1 kΩ 0402
`<resistor>` (`R1`, or the next free ref). That added resistor is on the board but not in the contract's BOM. The
catalog's resistor is 10 kΩ (`0402WGF1002TCE`), so a real 1 kΩ LCSC part still has to be added.

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

Checked live on 30 Oct 2026: every part was in stock except `SHT40-AD1B-R2` (`C2758054`), which jlcsearch does not
list at all, whether looked up by LCSC number or by MPN, so its fields stay `null`.

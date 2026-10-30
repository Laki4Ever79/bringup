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

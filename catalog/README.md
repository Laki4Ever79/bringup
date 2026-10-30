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

Checked live on 30 Oct 2026: every part was in stock except `SHT40-AD1B-R2` (`C2758054`), which jlcsearch does not
list at all, whether looked up by LCSC number or by MPN, so its fields stay `null`.

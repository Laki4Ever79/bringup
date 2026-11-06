# Case editing: ask for the case you want, and the board follows only if you agree

Type a request about the case in the change box ("add wall-mount tabs", "engrave "BRINGUP" on the lid", "add a cable
gland", "thicker walls", "make the case 50 mm wide"). A case designer agent owns the case. It meets the request by
changing one contract field, `case`. The case is rebuilt, and the 3D view shows the result.

## What a request can change

| Request | What changes | Printing |
| --- | --- | --- |
| Walls, height ("3 mm walls", "taller", "20 mm tall") | `case.wallMm` (1.2–4 mm), `case.heightMm` (8–40 mm) | walls stay at least three 0.4 mm perimeters |
| Wall-mount tabs | two flat tabs, flush with the floor, on the pair of walls without a connector; a 4.5 mm screw hole in each (M4 or a #8 wood screw) | flat on the bed, no support |
| Lanyard / key-ring loop | a flat tab at a corner, on a wall without a connector, with a 3.5 mm hole | flat on the bed |
| Lettering | engraved 0.6 mm into the lid's top, centred, 3–8 mm letters sized to fit, kept 1 mm clear of the sensor vents | on the bed face of the lid; letter ceilings are short bridges |
| A hole for a cable or a cable gland | a round hole through a wall, halfway up the wall's free height (6 mm for a cable; 12.2 mm for an M12 gland, a typical figure: check the gland's datasheet); the body grows if the hole needs more wall | teardrop roof at 45°: prints without support |
| The case's outer size ("make the case 50 mm wide") | the board outline: see below | |

Every feature is measured back from the built solid (`features.json`). If a feature can't be built (lettering too
long for the lid), the build says why, and the case designer gets that reason.

## What keeps the case and the board in step

These checks are plain code, like the rest of the contract. Each one wakes the case designer:

- `case-too-low`: the body is too low for the connectors' cutouts below the lid's lip. The violation gives the lowest
  height that works.
- `case-feature-collision`: one of these:
  - a hole runs into a connector's cutout or another hole (1.2 mm of wall between them)
  - a hole is too big for its wall's free height
  - a hole runs off its wall
  - two tabs share a stretch of wall
- `case-feature-missing`: the built case is missing a feature the field asks for, or a feature could not be built.
  This is checked only against a case built from the current features, so a rebuild still under way is not a fault.

When the board changes, the case follows. For example, "make it 40 mm wide" can push a hole off its wall, and the
case designer moves the hole along the wall.

## When a case change would change the PCB, you confirm it first

The case's outer size is the board plus 2 mm clearance and a wall on each side. A case that must be a given size
therefore needs a different board: "make the case 50 mm wide" with 2 mm walls needs a 42 mm board. The same goes for
moving a connector to make room for a hole.

The case designer never edits the board itself. It proposes the change to the field's owner, the architect, through
change control. A change from the case designer to any field the board is built from (outline, connectors, parts,
pins, test) also waits for **your** confirmation, whether or not engineer approval is on for the run:

- The dashboard's change card shows a red warning, for example "This case change changes the PCB: the board outline
  50×30 → 42×30 mm. The board is placed and routed again, and what follows it (firmware, test kit) rebuilds. It goes
  ahead only if you confirm." Under it are **Approve** and **Reject**.
- With phone notifications on, the same warning arrives with Approve and Reject buttons.
- The change applies only when both the architect and you approve it. If you reject it, or don't answer within
  10 minutes, the board stays as it is, the case keeps its size, and the design settles.

The rule is in `src/contract/case.ts` (`boardChangeWarning`, `BOARD_FIELDS`; a test keeps `BOARD_FIELDS` equal to
the board build's inputs) and is applied in `src/change-control.ts` for agents and for plain-code participants alike.

## Measured (6 Nov 2026)

These are logger runs with scripted agents and the real tools: tscircuit with KiCad, build123d, PlatformIO.

| Step | Result |
| --- | --- |
| "add wall-mount tabs, a cable gland, and engrave "BRINGUP" on the lid" | The case designer wrote the case field; the body grew to 19 mm for the 12.2 mm gland, which went on the right wall (J1 is on the left). The case rebuilt in about 4 s. All three features were measured on the solid, the print check passed, and there were 0 violations. 3 of 13 agents acted. |
| "make the case 50 mm wide" | The case designer proposed a 42 mm board. The change card opened by itself with the PCB warning; nothing changed until Approve. Approved by the architect and the engineer, the board was placed and routed at 42 mm (KiCad DRC: 0 errors, 0 unconnected), and the case followed. Consistent in 1 min 19 s, 4 of 13 agents acted. |
| The same, rejected | The board stays 50 mm, the case keeps its size, and the design settles (test/case.test.ts, stubbed tools). |

## Not done yet

- Overall shape changes, such as rounded corners or a slanted front, are not supported. Neither is editing a case
  you imported from your own CAD.
- No feature is placed by clicking in the 3D view. A hole goes where the request says ("on the right") or on the
  first wall without a connector.
- The tab and hole sizes are typical values, not tested on a printed part. The lettering uses the machine's default
  font (fontconfig), so its width can differ between machines. Each build measures and reports what it got.
- The scripted case designer understands the phrasings above. A real model gets the same field description and
  checks.

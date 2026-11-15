# Backlog

Work we know is needed and haven't done, in priority order inside each section. The compliance checklist each
firmware build writes (`compliance.md`) marks the security items as "open" until they are done.

## 1. Prove the flow works end to end

The checks and agents are tested piece by piece with scripted agents. What hasn't happened yet:

- [ ] A real-model run that passes the final brief review under the space, case, connectivity and security rules
      added 6–7 Nov. Three runs on 7 Nov (below) reach every output and a consistent design, but not a pass yet.
- [ ] Order one generated board and bring it up: flash, the factory test, a Bluetooth read with the passkey, BTHome in
      Home Assistant. Nothing from the IoT work has run on hardware.
- [ ] Measure on that board: deep-sleep current, the radio's peak against the RT9080 (rail droop at transmit), and a
      Wi-Fi upload's energy (today a 3 s × 120 mA estimate).

### What the real-model runs on 7 Nov showed (logger brief, then "show the readings in Home Assistant")

| Run | Result | General cause found | Fixed |
| --- | --- | --- | --- |
| 1 | stopped at the 25-revision cap, never consistent | agents typed catalog pin names by hand; each fix rewrote the whole parts list and dropped the sensor, button or battery connector | the contract takes a catalog part's pins from the catalog (6c62f9e) |
| 2 | consistent, every output built, the change rippled in 70 s; failed review 7 times | the case facts said "features: none", hiding the automatic USB-C opening; a true size reason still raised as major | 004a25f |
| 3 | consistent through review; failed review on real design questions | a button connector left with no part, no pin and no wiring; the reviewer guessed the charger's current (no catalog facts) | connector check, TP4054 facts |
| 4 | consistent, 0 DRC errors, 270 of 180 days; the Home Assistant change rippled in 75 s; failed review on one blocker, repeated all 10 rounds | reflashing a sleeping, assembled unit needed the case open, against the brief's "USB-C for flashing, no special cable" | USB wake (below) |

Decisions from run 3, agreed with the engineer on 8 Nov and built:

- [x] **Recovery flashing:** the product firmware deep-sleeps, and the ESP32-C3's USB is off in deep sleep. The board
      generator now puts two bare pads on the bottom of every deep-sleeping design: BOOT on the MCU's boot strapping pin
      (catalog `bootPin`, GPIO9) and GND. To reflash: open the case, unplug USB and the battery, short the pads while
      reconnecting the battery, plug in USB; the ROM downloader works even when the firmware doesn't boot. An I2C line
      (pulled up) may share the pin; any other signal there, or no room for the pads, is a `boot-pin-taken` violation.
      A BOOT button was tried first and dropped: its 7×9 mm footprint made the logger's smallest board 27% bigger.
- [x] **Phone use in the battery budget:** counted as an assumption of one full-length connection a day
      (`PHONE_CONNECTIONS_PER_DAY`: 30 s at 86 mA, about 0.03 mA on average), on any design a phone reads over GATT.
- [x] **The charger's own drain:** the TP4054's 6 µA typ (10 µA max) with USB unplugged is counted beside the
      regulator's quiescent current (catalog `batteryDrainUa`).
- [x] **Review convergence:** the reviewer now sees its own earlier verdicts and findings, re-checks those first, and
      treats anything unchanged it didn't raise before as minor unless a must-have can't be met.

Decision from run 4, agreed with the engineer on 9 Nov and built:

- [x] **USB wake:** a 68k/100k divider from VBUS to the first free deep-sleep wake pin (GPIO0, 1, 3, 4, 5; GPIO2 is a
      strapping pin) wakes a sleeping board when USB is plugged in, and the firmware stays awake while it is, so the
      cable alone reflashes it. Nothing from the battery (the divider hangs off VBUS). `requirements.usbWake: false`
      turns it off; no free wake pin is a `usb-wake-pin-taken` violation. The recovery pads stay for a firmware that
      doesn't boot. Still to prove on the first board: esptool's switch into download mode over the running chip's USB.
- [x] **Added for you:** the engineer asked to be told what Bringup adds unasked and how it shows. The report has an
      "Added for you" table (what, how you'll notice it, why, cost, how to change it), the run prints the list at the
      end, and the agents and the reviewer get the same lines in their design facts (`src/contract/added.ts`).
- [x] **Who houses the board** (9 Nov): `requirements.enclosure` is "case" (default: Bringup designs and prints one),
      "none" (a bare board: no case built or checked; the report warns of a loose battery, exposed parts and static, and
      the FCC label moves to the silkscreen) or "own" (the engineer's own housing: `interface.md`/`.json` with the
      outline, mounting holes, openings, buttons, lights, vents, antenna keep-out, underside pads and label, plus
      board.step). A case nobody asked for is listed in "Added for you". `briefs/logger-bare.md` exercises "none".
- [x] **Run 5 fixes:** a button inside our case with no opening is a `button-unreachable` violation (run 5 passed review
      with one sealed in); the test kit's awake limit comes from the board's own rails, not a battery rail's rating
      (run 5 said "500 mA awake" against 170 mA on 3V3).
- [ ] **Phone use as a contract value:** the one-connection-a-day assumption is a constant; the "Added for you" table
      says so. Making it `requirements` data would let the brief set it.

## 2. Security (needed before selling under the EU Cyber Resilience Act; vulnerability reporting from 11 Sep 2026, everything else from 11 Dec 2027)

A stock Arduino build can't do the first three. They need an ESP-IDF build (or Arduino as an ESP-IDF component), which
is a change to the firmware toolchain, not just the code.

- [ ] **Signed firmware updates and Secure Boot v2:** the chip only runs images signed with the product's key. Needs a
      key-handling process (who holds it, where it's stored) and eFuse burning on the factory line, which can't be
      undone.
- [ ] **Flash encryption:** the stored readings and the passkey in NVS are readable today by anyone with the board and a
      USB cable.
- [ ] **Signed update images checked before install**, on top of HTTPS (comes with Secure Boot).
- [ ] **Factory reset:** a button hold that erases the reading history, the settings and the pairing bonds.
- [ ] **BTHome encryption:** a per-device key (AES-CCM, BTHome v2), made on the factory line like the passkey and
      printed on the label; today anyone nearby reads the temperature and humidity.
- [ ] **Provisioning on a finished device:** set Wi-Fi and broker credentials over Bluetooth or a setup page, instead
      of compiling them in.
- [ ] **Vulnerability handling:** the manufacturer's contact, a disclosure policy, and ENISA reporting within 24 h.
      This is the company's process; the design can only point to it.

## 3. Hardware robustness

- [ ] **Check: can Bringup design a 3D-printer / CNC controller board, Duet-like, from a prompt?** (the user, 15 Nov:
      "can I simply ask bringup to create CNC board optimized for 3D printing work and get something resembling what
      Duet 3D is/was"). A feasibility check first, then a plan. Borrow the product idea only, never Duet's design files
      or text. What exists: MCU profiles that run motion firmware (STM32F411/F446 and RP2350 for grblHAL, ESP32-WROOM
      for FluidNC; `compare_mcus` with `motion`, docs/mcu.md), the board pipeline (parts, layout, routing, DRC, fab
      files), test pads, the case and the checks. Missing, to list and size: stepper drivers (e.g. TMC2209 over UART,
      TMC5160 over SPI) with their sense resistors and heat; heater and fan MOSFETs with flyback and fuses; thermistor
      inputs (ADC with the pull-up and filter); endstop and probe inputs; a 12/24 V input with reverse-polarity
      protection, fusing and a buck to 5 V/3.3 V; high-current traces and copper (the router's 0.15 mm tracks won't
      carry heater current: trace width per net current, wider than tscircuit routes today, maybe a 4-layer board);
      thermal checks; the firmware side (generate the grblHAL/FluidNC, Klipper or RepRapFirmware configuration from the
      contract's pin map, and build it); the checks that make it ours (driver current vs motor rating, heater power vs
      MOSFET and trace, thermistor curve, every motor/heater/sensor wired and named in the firmware config). Output of
      the check: what Bringup can make today, what each missing piece costs, and the smallest board worth building
      first (e.g. 4 axes + 1 heater + bed).

- [ ] **Board and chassis disagree on how a board mounts** (found 15 Nov): the board has M2 holes (2.2 mm,
      `MOUNTING_HOLE`, 3.0 mm in from each corner, `src/codegen/circuit.ts`), the printed chassis has M2.5 standoff holes
      (2.7 mm, `py/chassis.py`) at 3.5 mm in (`BOARD_HOLE_INSET_MM`, `src/tools/chassis.ts`): the standoffs are 0.5 mm
      off on each axis, and an M2.5 screw doesn't pass a 2.2 mm hole. No check compares them. Fix: the chassis takes each
      board's holes from the board itself (mountingHoles, including corners a connector took), one screw size for both,
      and a check that every board hole has a standoff and a screw that fits (goes with the hardware list below).
- [ ] **CAN as a link between boards, when the user asks for it** (the user, 15 Nov: "allow for user insisting on using
      CAN communication for robot if they want"). Today: the MCU profiles know which chips have a CAN controller
      (ESP32-C3 / WROOM TWAI, STM32F103, STM32F446), but `src/contract/link-kinds.ts` has no CAN kind and the catalog
      no transceiver. Needs: a `can` link kind; a 3.3 V transceiver part with sources (e.g. SN65HVD230 / TJA1051T/3);
      120 Ω termination at the two bus ends; the connector; firmware for TWAI and bxCAN; checks (bus length against
      bit rate, termination at both ends and only there, every board on the bus has a controller and a transceiver,
      one bit rate per bus); tests: host codec and compile (QEMU has no TWAI), bench with two boards. A brief or a
      system spec that names CAN gets it; the architect never swaps it for UART.
- [ ] **Open standards by default** (the user, 15 Nov, asked whether we insist on them; recommended yes). Today open
      where it was the obvious choice (KiCad, STEP/STL, PlatformIO/Arduino, BTHome v2, CycloneDX) but not a rule, and
      some interfaces are ours or one vendor's: the board-to-board message framing (`templates/fw/include/linkframe.h`,
      our own sync + hash + XOR), the TC2030 debug cable (its maker's product; the footprint is free), JST connectors
      (industry, not open). Do: a rule that each interface uses an open standard where one fits; a report section that
      lists every vendor-locked or home-made interface with its open alternative; first move, the link messages onto an
      open protocol (Cyphal or CANopen once CAN exists; COBS-framed CBOR or similar on UART).

- [ ] **Every bought mechanical part in the parts list** (the user, 15 Nov: "nuts, bolts, bearings, threaded inserts,
      metal rods,... whatever can't be printed or ordered by the PCB provider"). Today the robot parts list
      (`src/tools/robot-parts.ts`, bom.json `robot`) has the motors, wheels, caster, battery and distance sensor only.
      Missing: the screws that hold each board (case.ts: M2 self-tapping into 5 mm posts) and the plate (standoffs,
      estimates.ts `standoffMm`), motor bracket screws and nuts, threaded inserts where a printed part takes a machine
      screw, bearings, shafts and rods, cables and their crimp housings, battery holder or strap, spacers. Each with a
      quantity worked out from the design (holes × screws, one insert per screw boss), a size (M2 × length from the stack
      height), a shop link and live price where the shop states one, like the rest. Then a check: every hole, boss and
      bracket in the printed parts has its fastener in the list, and every fastener in the list has a hole to go in.

- [x] **Bring-up test pads on every design, on by default** (built 13 Nov, 54e83ec; the nets a learned part adds come
      with learned-part wiring) (the user, 13 Nov: "we should be adding test points as well
      to our designs"). Today pads come only with a production test ("add a production test fixture"), which probes
      every net and builds a fixture. The default would be a small set on the underside, using the same placement
      (`testPoints`): GND, every power rail (3V3, VBAT; VBUS stays optional), the debug UART's TX and RX, each signal
      of a cable link between boards, and the nets a learned part adds (an amplifier's input and outputs). A pad that
      has no room is dropped (`test-unplaced`), never grows the board, so compact-by-default holds. A brief can turn
      them off ("no test pads"); asking for a production test still widens them to every net and adds the fixture.
      Recommended on by default because the bench is where a board first fails, and a rail or a bus with no pad
      means probing a 0.4 mm pin.

- [ ] **Tighter part spacing, proven by the router** (engineer, 13 Nov: "each component in optimal space and yet keeping
      proper distance"). The placer keeps 1.5 mm between every two parts, so even a compact board is only about half
      covered. Real builds at each design's compact size, 13 Nov (0 DRC errors = routed):

      | Board | 1.5 mm everywhere (today) | 1.0 mm everywhere | 1.0 mm between small parts only |
      | --- | --- | --- | --- |
      | Logger | 33×25 routes | 31×25 routes | 33×25 routes |
      | Beacon | 37×25 routes | 33×25 routes | 37×25 routes |
      | STM32 logger | 37×21 fails, 39×21 routes | 33×19 routes | 32×20 fails |
      | Rover | 42×29 routes | 37×26, 39×26, 39×28 fail (USB-C pins unrouted) | 41×27 fails (USB-C) |

      No one gap wins: the autorouter's outcome swings with small layout changes. Kept at 1.5 mm. Next: place tight
      first and, when the build doesn't route, retry the same size with the wider gap before the board grows, so a
      board only gets the room its routing needed (one more build per failure, about 50 s).

- [ ] **STM32 logger "unique PCB port" routing failure:** the scripted STM32 logger fails at 50×30 and 37×20 with
      tscircuit's "Routes contain a junction or endpoint that cannot select a unique PCB port", with or without the
      debug footprint; 39×21 routes (`npm run board`, 13 Nov). Belongs with the routing-aware retry above.
- [ ] **Antenna keep-out:** Espressif recommends 15 mm clear around the module's antenna; the case leaves 2 mm. No
      ground copper is kept away from it yet either.
- [ ] **RT9080 lifecycle:** one LCSC page flagged it "not recommended for new designs". Confirm with Richtek or a
      distributor, and name a second source.
- [x] **EN reset delay:** done 13 Nov (049027a): 10 kΩ to 3V3 and 1 µF to GND on MCU_EN, under "Added for you". A
      reset button on EN is still open.
- [x] **Standard debug footprint:** done 13 Nov (e541ae2): Tag-Connect TC2030-NL on the underside, SWD pinout or
      ESP32 UART download, its spot reserved in placement (the logger's smallest board 850 → 858 mm²), left off (and
      said so) when a board won't route or check clean with it. Not enforced: the drawing's 0.020" track clearance
      around each pad (tscircuit has no per-pad rule).
- [x] **Board page, step 1 (why every part is there):** done 13 Nov. /board?run=<id>: the board full window, a list of
      every part, a card per part with why it is there and where that comes from (recorded when chosen, Added for
      you, datasheet or standard, generator rule, or "no reason recorded"), its nets and its catalog facts; live during
      a run (placement at once, the routed board when built).
- [x] **Board page, step 2 (swap a part from its card):** done 14 Nov. A chosen part's card lists the catalog's other
      parts for its role, with what each swap changes (footprint, pins, firmware driver, I2C address, quiescent current),
      stock and price when bom.json has them; "Request this swap" sends one fixed sentence through requests.jsonl, the
      same path as a typed request (the owners decide, the checks run), and the board follows live. Only for a run
      that is up; a stopped run shows the request to send. Not offered for the MCU (a change in words) or resistors and
      capacitors (their value comes from a datasheet or rule). The list tags a new part number "swapped", not "moved".
- [x] **Board page, step 3 (move a part):** done 14 Nov. Drag the chosen part on the board, type its centre, nudge
      it, or put a connector on any edge with a slider. Each move is checked in plain code on the server (the run's own
      consistency checks in a quick mode without the smallest-board search, about 0.1 s): a move that doesn't fit is
      refused with what is in the way and never joins the draft. The draft lists each move with how far it reaches
      (board / case / system) and what follows it (case opening, vent, a support part's longer trace, the parts the
      layout moves around it), and is sent as one change request; the agents write it and the run's checks and review
      see it once. A placed part is Part.at (its centre, mm from the bottom-left corner): the layout puts it exactly
      there first and never moves it; one that no longer fits is part-pinned-blocked (to parts), not a bigger board,
      and the board can't be compacted past it. Robot direction: a cable connector off the edge the system runs its
      cable from is link-edge (a system change, refused on the page). Not done: moving the radio module (it follows
      the USB-C edge) or the generated passives and underside pads (they follow their parts).
- [x] **Board page: turn a part, undo a sent batch:** done 14 Nov. A part turns in 90° steps (Part.at.rotationDeg,
      "turned 90°" in the request); the capacitors on its pins turn with it, and a part goes only where they fit
      beside their pads. A refused move's values stay on the card, so a spot that only works turned is reached in two
      checked steps (Esc drops them). "Undo the moves you sent" puts the opposite moves in a new draft, worked out on the
      server from the revision the batch was sent against: a part the layout had placed goes back to the layout's
      choice. Routed builds prove it: the rover with its motor driver turned 90°, 180° and 270° routes with VINT and VCP
      within 5 mm, after two layout fixes the builds found (a capacitor between two pads of one part faces them in
      order; one pointing away from its pad is turned toward it). The undo of the last batch sent stays on offer.
- [x] **Router vias too near the board edge** (done 15 Nov): after routing, a via nearer the edge than the fab's 0.3 mm
      moves straight inward with its own net's trace ends (src/tools/via-edge.ts); KiCad's DRC checks the result. The
      saved 42×29 rover with U5 turned 180° now routes with DRC 0 and keeps its debug footprint
      (test/board-rotate.int.test.ts). A via whose inward move lands on something else still shows in DRC.
- [ ] **Bulk capacitance for Wi-Fi bursts:** the board has 10 µF on the 3V3 rail. Check against the rail droop measured
      above before adding more.

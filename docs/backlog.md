# Backlog

Work we know is needed and haven't done, in priority order inside each section. The compliance checklist each
firmware build writes (`compliance.md`) marks the security items as "open" until they are done.

## 1. Prove the flow works end to end

The checks and agents are tested piece by piece with scripted agents. What hasn't happened yet:

- [ ] A real-model run that passes the final brief review under the space, case, connectivity and security rules
      added 6–7 Nov. Three runs on 7 Nov (below) reach every output and a consistent design, but not a pass yet.
      Audit 17 Nov (bringup-system): robots pass it (cc-rover-8 rev 32, cc-rover-9 rev 24, real-rover-6); no real-model
      logger run (case, connectivity, security) has passed yet.
- [ ] Order one generated board and bring it up: flash, the factory test, a Bluetooth read with the passkey, BTHome in
      Home Assistant. Nothing from the IoT work has run on hardware.
      Audit 17 Nov (bringup-system): still open: no board ordered (ordering is the user's call).
- [ ] Measure on that board: deep-sleep current, the radio's peak against the RT9080 (rail droop at transmit), and a
      Wi-Fi upload's energy (today a 3 s × 120 mA estimate).
      Audit 17 Nov (bringup-system): still open: needs the board above.

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
      Audit 17 Nov (bringup-system): still open: still a constant (no requirements field reads it).

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
      Audit 17 Nov (bringup-system): none of the seven security items above is in the firmware yet (no Secure Boot,
      flash encryption, signed images, factory reset, BTHome key or provisioning); src/contract/compliance.ts lists them
      as open in each report.

## 3. Hardware robustness

- [x] **Copper too near the edge that isn't a via** (15 Nov; fixed: via-edge.ts moves a trace corner too near the edge
      inward, joints kept, ends on a pad left alone; the 64×25 rover keeps its footprint, DRC 0): the subscription run's 64×25 mm rover (test/fixtures/
      cc-rover-64x25-rev19.json) routes clean but leaves its debug footprint off: 3 copper_edge_clearance errors with
      it, 0.2488 mm against 0.3. Not a router via (via-edge.ts moves those): find which copper (a pad, a trace, a test
      pad) and fix it the general way.

- [x] **The router doesn't avoid drawn capacitor traces** (16 Nov 2026, real rover run 9 rev 23 at 58×22 mm, fixture
      cc-rover9-58x22-rev23.json): the drawCaps retry draws U5's capacitor traces (pcbPath), but tscircuit's autorouter
      routes other nets as if they weren't there: by hand at 678b509 a via landed on VM's drawn trace and BISEN/GND and
      MOT_BIN1 passed 0.04-0.09 mm from it. Tried and rejected: keepouts along the drawn segments (tscircuit flags the
      pads, courtyards and the drawn traces themselves) and pcbRouteHints (ignored by the autorouter: 14.59 mm as
      without). The run recovered by growing the board (rev 24). Fix to build: a post-route repair in the via-edge.ts
      pattern that moves the router's vias and corners off a drawn trace's clearance, then a routed proof on this fixture.
      Tried 16 Nov (branch drawn-clearance, unmerged): keepout strips beside each drawn run (allowPlacements, trimmed
      1 mm at the pads, one middle strip between neighbouring runs). The router stays off the drawn traces (the via on
      VM is gone), but the 58×22 board then fails elsewhere: 6 clearance errors drawn-only → 7 with strips (8 without
      the debug footprint), 0.02-0.09 mm near-misses around U3/U4/J1/R5 the plain build doesn't have. A via-edge-style
      KiCad repair can't reach it (tscircuit exits 1 first, and the errors are spread over the board). Agreed with
      bringup-lead: (a) make the fallback cheap: a drawCaps retry failing on trace length goes straight to the
      no-footprint stage, and there the architect is told to grow the board one step (done, branch length-fallback);
      (c) next experiment: reserve a routing channel around the capacitor group in placement; (b) Freerouting (tools/,
      unused) is a several-day option for the user to decide.
      (c) measured 16 Nov (branch cap-channel, unmerged): other parts kept 1 mm off the capacitor group's outer sides
      (opt-in capChannelMm): no effect. Layouts tried, before → after: run 9's 58×22 5 → 5, the 60×21 rover 7 → 7, run 6's
      44×29 rev 21 2 → 2; the debug footprint outcome and DRC 0 unchanged on all three. The room the drawn traces need is
      taken by other nets' traces passing through, not by parts, so spacing parts doesn't help. Left: (b) Freerouting.
      Done 17 Nov by (b): Freerouting (src/tools/freerouting.ts) routes this fixture clean, so the via-edge-style repair
      isn't built (it couldn't reach these boards anyway: tscircuit exits 1 before KiCad sees them). Run 9's 58×22 rev 23:
      tscircuit first, Freerouting after 2 unclean layouts: 3 layouts / 115 s / DRC 0 (debug footprint kept);
      Freerouting first: 1 layout / 51 s / DRC 0 (bringup-board's 12-board sweep).

- [x] **Narrow boards the router can't route around the motor driver** (15 Nov, revised: reserving the capacitors' boxes
      was tried and changed nothing: on the 60×21 board C3 and C4 already sit in their spots beside U5's pins; the
      traces fail on congestion, 8-9 mm against 5. Today's working path: the build reports the too-long trace and the
      architect grows the board for routing; the run's 64×25 revision routes. Open: a routing-aware smallest board (the
      space rule's minimum from what has routed, not from placement alone), so the architect doesn't shrink there first.)
      Cause found 15 Nov (bringup-board, a kept 60×21 build): the too-long trace is C4's second end, U5.VM to C4.pin2
      (8.4 mm; VCP's own trace is 2.3 mm). C4 is wired between two neighbouring pins; standing out from the pin row its
      far end's trace must loop round the capacitor, and at 60×21 other parts (C6 1.6 mm past C3) leave it no room, so it
      detours through vias. Along the pins (capsAlong) C3 and C4 collide (1.86 mm bodies, 0.65 mm pin pitch) and C4 lands
      2.5 mm off: 9.1 mm. At 64×25 the same caps have free room beside them and route. Decision (the user, 15 Nov, chose
      "Both" of the offered fixes): (1) placement keeps clear the room a capacitor's far end needs to loop round it when
      both its ends go to one part, so the smallest board grows where routing would fail; (2) a size that failed to route
      is recorded and the smallest board never offers it, or anything smaller, again.
      Original entry: **The smallest board reserves the room a chip's pin capacitors need** (agreed with d9610c, 15 Nov, after the real
      subscription rover run: the architect shrank the board to 60×21 mm under the space rule, and there U5's VCP and
      VINT capacitors couldn't route within their 5 mm bound, 8-9 mm, since other parts took the room beside its pins).
      The bound stays (the datasheet's decoupling intent). Fix: once a part is placed, the boxes its pin capacitors need
      beside its pads (capBoxes) are kept free of every other part, so a board too small for them doesn't place all its
      parts, the space rule's minimum grows to fit, and the architect never shrinks below a routable size. Prove with
      routed builds of every scripted board and the run's 60×21 contract.
      Audit 17 Nov (bringup-system): done 15 Nov in e22ac78 (both fixes the user chose: a capacitor wired between two
      pins of one part gets its traces drawn, and a size that failed to route is never offered again;
      test/cap-paths.test.ts, test/board-errors.test.ts), with 1c06f0d (a placement refusal or unrouted traces count as
      a size failure).

- [x] **Check: can Bringup design a 3D-printer / CNC controller board, Duet-like, from a prompt?** (the user, 15 Nov:
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
      Feasibility check done 15 Nov (bringup-board, docs/cnc-board.md): not today. The core exists (motion-capable MCUs,
      the board pipeline, case, checks); missing are stepper drivers, a 12/24 V input, heater/fan outputs, thermistor
      and endstop inputs, current-sized copper and thermal checks, and the firmware config (about 2-3 weeks, estimate).
      Two risks to test first: copper width per net in tscircuit's autorouter, and routing a ~100x80 mm board with 20+
      connectors on 2 layers. First board: 3 drivers, hotend, 2 fans, 3 endstops, 24 V in, the bed switched off-board.
      Audit 17 Nov (bringup-system): the check is done (c0c523e, docs/cnc-board.md: not today, about 2-3 weeks, an
      estimate). Building it is a separate decision, not started.

- [x] **Board and chassis disagree on how a board mounts** (found 15 Nov; fixed 15 Nov: chassisSpec takes each board's
      holes and the case's M2 screw, py/chassis.py cuts them, board-mount-mismatch checks the built chassis): the board has M2 holes (2.2 mm,
      `MOUNTING_HOLE`, 3.0 mm in from each corner, `src/codegen/circuit.ts`), the printed chassis has M2.5 standoff holes
      (2.7 mm, `py/chassis.py`) at 3.5 mm in (`BOARD_HOLE_INSET_MM`, `src/tools/chassis.ts`): the standoffs are 0.5 mm
      off on each axis, and an M2.5 screw doesn't pass a 2.2 mm hole. No check compares them. Fix: the chassis takes each
      board's holes from the board itself (mountingHoles, including corners a connector took), one screw size for both,
      and a check that every board hole has a standoff and a screw that fits (goes with the hardware list below).
- [ ] **CAN simulation gaps (known limits, 16 Nov 2026, bringup-system):** Renode 1.17 models no CAN on the STM32F103
      (its stm32f103.repl has no CAN) and has no F446 platform (the two-node CAN test runs F446 firmware on its F407 as an
      approximation); QEMU's ESP32-C3 models no TWAI. Those sides are proven only by compiling until the bench test
      (docs/bench-can.md) runs on real boards. STM32 bxCAN firmware itself is done (e7fb5e0).
      Audit 17 Nov (bringup-system): still open: until docs/bench-can.md runs on real boards.
- [ ] **Encoder count direction, on the real robot.** With both channels wired (the ESP32-S3, f620338, 17 Nov) the
      firmware learns each wheel's count sign from the first drive that moves it 16 counts (templates/fw-rover/src/
      rover_quad.h quad_forward): an encoder's phase against its motor's terminals, and how the board wires the motor,
      aren't known before the bench. Check on the real robot: drive forward 1 m, both counts must rise by about
      1000 mm / ROVER_MM_PER_COUNT; then back, both must fall. A wheel that counts the wrong way, or a first drive that
      starts backwards with the sign still unlearned, shows here. Host tests cover the decode and the learning only;
      the drive simulation doesn't run the S3's firmware (Xtensa QEMU not installed).
- [ ] **Skid-steer turn slip, on the bench.** A skid-steer rover's encoder-closed turn counts on the effective track
      B·(1+(L/B)²), derived from Coulomb slip (1.5 B for the rover-4wd). The simulation slips more (2.2 B: planned 135°,
      turned 92°, still clear of walls by 145 mm); real tyres measure 1.2–2 B in the literature. Measure the ratio on a
      real floor (turn a counted amount, read the heading) and put it in the catalog per wheel/floor, or close the turn
      on a gyro.
      Tried 16 Nov (branch stm-can 0100d6f, unmerged, capped at a debug build and one fix attempt): two F446 link-test
      firmwares on Renode's stm32f4 (F407) platform with a CAN hub. (1) Both nodes stall in halWireBegin() (the SHT40's
      I2C) on the F407 model, before any CAN code; with it skipped they reach the CAN setup. (2) There PCLK1 reads
      45 MHz and the timing is right (18 tq, prescaler 5 at 500 kbit/s), but HAL_CAN_Init returns HAL_ERROR with
      ErrorCode 0x20000 (HAL_CAN_ERROR_TIMEOUT) and MSR 0xC00: Renode's STMCAN never sets MSR.INAK when the HAL requests
      init mode (MCR.INRQ), so the controller never starts and every send finds no free mailbox. A Renode model limit:
      we don't patch Renode, so bxCAN stays proven by compiling and by the bench test (docs/bench-can.md).
      Audit 17 Nov (bringup-system): still open: needs a real floor.
- [x] **CAN as a link between boards, when the user asks for it** (the user, 15 Nov: "allow for user insisting on using
      CAN communication for robot if they want"). Today: the MCU profiles know which chips have a CAN controller
      (ESP32-C3 / WROOM TWAI, STM32F103, STM32F446), but `src/contract/link-kinds.ts` has no CAN kind and the catalog
      no transceiver. Needs: a `can` link kind; a 3.3 V transceiver part with sources (e.g. SN65HVD230 / TJA1051T/3);
      120 Ω termination at the two bus ends; the connector; firmware for TWAI and bxCAN; checks (bus length against
      bit rate, termination at both ends and only there, every board on the bus has a controller and a transceiver,
      one bit rate per bus); tests: host codec and compile (QEMU has no TWAI), bench with two boards. A brief or a
      system spec that names CAN gets it; the architect never swaps it for UART.
      (built 15 Nov, see above)
      Audit 17 Nov (bringup-system): done: 64642ff (the can link kind, each board's side, the checks;
      test/can-link.test.ts), buses of three or more boards d6824ca (test/can-bus.test.ts), merged into adopt with
      d14d856.
- [ ] **Open standards by default** (the user, 15 Nov, asked whether we insist on them; recommended yes). Today open
      where it was the obvious choice (KiCad, STEP/STL, PlatformIO/Arduino, BTHome v2, CycloneDX) but not a rule, and
      some interfaces are ours or one vendor's: the board-to-board message framing (`templates/fw/include/linkframe.h`,
      our own sync + hash + XOR), the TC2030 debug cable (its maker's product; the footprint is free), JST connectors
      (industry, not open). Do: a rule that each interface uses an open standard where one fits; a report section that
      lists every vendor-locked or home-made interface with its open alternative; first move, the link messages onto an
      open protocol (Cyphal or CANopen once CAN exists; COBS-framed CBOR or similar on UART).
      Done 16 Nov (bringup-board): UART/I2C frames are COBS + CRC-16/CCITT (linkframe.h); the payload stays a packed
      struct (open alternative CBOR, RFC 8949); CAN frames keep the hash as identifier (Cyphal/CANopen left).
      Done 17 Nov (bringup-board): UART/I2C payloads are CBOR (linkcbor.h); CAN messages are Cyphal/CAN v1.0 single-frame
      transfers (linkcyphal.h: subject-ID from the definition hash, node-ID per bus, DSDL files beside the firmware).
      CANopen not done: it needs an object dictionary and NMT, and Cyphal already makes the bus open.
      Step 1 done 15 Nov (bringup-board, branch open-standards): src/contract/standards.ts lists every interface a
      design has with its standard and whether it is open, one vendor's or ours; the report's "Interfaces and
      standards" section shows the table and each non-open one's open alternative (the link frame → COBS + CBOR or
      MAVLink v2; the TC2030 → ARM's 10-pin Cortex Debug; our GATT layout → ESS). Left: the rule for the agents (pick
      the open one where it fits), CAN's rows once the can branch is in, and moving the link messages onto an open
      protocol.
      Audit 17 Nov (bringup-system): left: only the agents' rule (pick the open standard where one fits); CAN's rows
      (d6824ca) and the open link protocols (COBS+CBOR, Cyphal) are done.

- [ ] **Power transmission and motion parts in the parts list, each checked against its mate** (the user, 15 Nov, via
      d9610c: "yeah along with fasteners we should add gears, belts, chains and all other mechanical pieces to the list
      as well"). Gears, belts and pulleys, chains and sprockets, bearings, shafts and rods, couplers, springs, linear rails
      and carriages, lead screws and nuts: each with a quantity from the design and a source per number. Checks that
      each has its mating part and fits it: a belt's pitch and length against its pulleys and their centre distance
      (and tension travel); a gear pair's module, tooth counts and centre distance; a chain's pitch against its
      sprockets; a bearing's bore against its shaft and its outer diameter against the printed seat; a coupler's two
      bores against the motor shaft and the driven shaft; a lead screw's pitch against its nut; load and speed against
      the part's rating. Today's rover has none beyond fasteners and the caster, so: the data model (a `mechanical`
      design field or the mechanics' drive train) and the checks first, catalog entries as designs need them.
      Step 1 done 15 Nov (bringup-board, branch drivetrain): `mechanics.driveTrain` (src/mechanics/drivetrain.ts):
      shafts, gears and their meshes, pulleys and belts, sprockets and chains, bearings, couplers, lead screws and nuts,
      each naming its mate; the contract checks its shape; `mech-mate` checks every bore against its shaft, a mesh's
      module and centre distance, a belt's or chain's pitch and the centre its length sits at against the tension
      travel, an even chain link count, a bearing's printed seat (0–0.2 mm over, estimate), rpm and load against a
      bearing's rating, a coupler's two bores, a lead screw against its nut. Left: catalog entries with a source per
      number (as a design needs them), the parts-list quantities, and the mechanics agent choosing them.
      Step 2 done 16 Nov: catalog/mechanics.json driveTrain with sourced entries (Adafruit 1251 GT2 pulley 20T 5 mm
      bore; goBILDA 3423-0006-0088 GT2 belt 44T closed, 6 mm); a part named by its mpn must carry the catalog's numbers
      (mech-mate); the mechanics agent's instruction says to take drive-train parts from that list. Left: more entries
      (bearings, couplers, lead screws, gears) as designs need them, and parts-list lines for them.
      Audit 17 Nov (bringup-system): left: more sourced catalog entries (bearings, couplers, lead screws, gears) and
      their parts-list lines, as designs need them.
- [ ] **Every bought mechanical part in the parts list** (started 15 Nov: catalog/mechanics.json `hardware` with a source
      per number; the rover's board screws (M2x8 self-tapping, one per board hole) and caster screws and nuts (M4x10,
      M4, one per caster hole) counted from chassisSpec; hardware-misfit checks each fits its hole; the parts list and
      report name what isn't fastened yet: the sensor bracket, the motor cradles, the battery, the cables. Left: those,
      threaded inserts, bearings and rods when a design has them, cables and crimp housings) (the user, 15 Nov: "nuts, bolts, bearings, threaded inserts,
      metal rods,... whatever can't be printed or ordered by the PCB provider"). Today the robot parts list
      (`src/tools/robot-parts.ts`, bom.json `robot`) has the motors, wheels, caster, battery and distance sensor only.
      Missing: the screws that hold each board (case.ts: M2 self-tapping into 5 mm posts) and the plate (standoffs,
      estimates.ts `standoffMm`), motor bracket screws and nuts, threaded inserts where a printed part takes a machine
      screw, bearings, shafts and rods, cables and their crimp housings, battery holder or strap, spacers. Each with a
      quantity worked out from the design (holes × screws, one insert per screw boss), a size (M2 × length from the stack
      height), a shop link and live price where the shop states one, like the rest. Then a check: every hole, boss and
      bracket in the printed parts has its fastener in the list, and every fastener in the list has a hole to go in.
      Audit 17 Nov (bringup-system): the battery strap is done (a82d20f, its two screws in the parts list); left: crimp
      housings for bare motor terminals and the 2S pack's XT60 lead.

      Step 15 Nov (bringup-board, branch fasteners): the sensor breakout is screwed to its bracket. The catalog's
      breakout was 21 × 18 mm (Adafruit's product page, the pre-2020 board); its fab print says 25.4 × 17.8 mm with four
      M2.5 holes at 20.32 × 12.7 mm: fixed, sourced. The bracket gets Ø2.7 holes where they land above the plate
      (chassis.ts sensorHoles; the built chassis measures them back), and the parts list an M2.5×8 screw and nut per
      hole (ISO 7045 / DIN 934, sourced). The e2e rover: 0 → 4 screws and 4 nuts, notes of unfastened parts 4 → 3.
      Step 16 Nov (bringup-board, branch motor-mounts, agreed with bringup-lead): each motor is held. Pololu's #989
      bracket (sourced from its page and measured from its STEP: axle 5.0 mm from the mounting face, holes 18.0 mm apart
      across the motor) when the motor is a micro metal gearmotor and the design's axle sits 5.0 ± 0.5 mm under the plate:
      no cradle, two holes through the plate, one bracket per motor in the parts list. Else the printed cradle with a
      printed clamp (motor-clamp.stl) on two M2 self-tapping screws into bosses. Else a hardware-misfit says nothing holds
      it there. Found on the way: the cradle needs 2 mm of wall above the motor, so every real subscription rover (5.0 mm
      asked) was built at 7.0 mm without a word; brackets now hold them at 5.0. The plate height is never changed.
      Step 16 Nov (branch cables): the robot's cables, measured along the chassis from the board's plug plus 40 mm slack
      (chassis.ts robotCables): the sensor's STEMMA QT cable (Adafruit 50/100/200/300/400 mm, shortest that reaches) and
      each motor's JST PH 2-pin leads (Adafruit 261, 100 mm; Artekit 300 mm, 24 AWG). The rovers: 0 → 1 sensor cable +
      2 motor leads; unfastened notes 2 → 1 (the battery strap: its shops refused automated reads, open). A run no
      catalog cable reaches, or a motor with no plug, is said in the notes. Left: battery strap, crimp housings for
      bare motor terminals (soldered leads assumed), a 2S pack's XT60 lead.
      Measured for the next step: Pololu's motor bracket pair #989 (two Ø2.3 mm holes 18.0 mm apart in a 1.4 mm base,
      #2-56 screws and nuts included; from Pololu's STEP). Left: motor clamps, battery strap, cables and crimp housings.
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
      Audit 17 Nov (bringup-system): still open: no tight-first retry yet (bringup-board's min-place work is on the
      space model).
      17 Nov (bringup-board): the gap is a build option now (PlacementOptions.gapMm, default 1.5: all 39 fixtures' layouts
      unchanged); at 1.0 the logger places on 30×25 (1.5 needs more than 33×25 today). Left, needing routed builds: the
      tight-first order in board.ts (1.0, then 1.5 at the same size, then Freerouting), and the space model judging the
      minimum at 1.0 so the architect asks for the tight size (min-place: the minimum must be what the build places).
      Measured 18 Nov (bringup-board, branch tight-first, dropped): at each tight minimum, 6 of 8 boards route DRC 0
      (logger 32×25, beacon 34×25, STM32 logger 50×14, rover 39×27, run 9 57×19 on the first layout; rover 6 41×29 via
      Freerouting), 2 fail (scripted Eurobot 56×39; run 19b rev 39 49×25, which routes at its 1.5 mm minimum 52×25).
      Judging the minimum at 1.0 mm offers sizes the build can't always make. gapMm stays as an option.
      A tighter pass may only follow a routed proof (try 1.0 mm at a smaller size after settle, keep it only if it routes DRC 0).

      | Board | 1.5 mm everywhere (today) | 1.0 mm everywhere | 1.0 mm between small parts only |
      | --- | --- | --- | --- |
      | Logger | 33×25 routes | 31×25 routes | 33×25 routes |
      | Beacon | 37×25 routes | 33×25 routes | 37×25 routes |
      | STM32 logger | 37×21 fails, 39×21 routes | 33×19 routes | 32×20 fails |
      | Rover | 42×29 routes | 37×26, 39×26, 39×28 fail (USB-C pins unrouted) | 41×27 fails (USB-C) |

      No one gap wins: the autorouter's outcome swings with small layout changes. Kept at 1.5 mm. Next: place tight
      first and, when the build doesn't route, retry the same size with the wider gap before the board grows, so a
      board only gets the room its routing needed (one more build per failure, about 50 s).

- [x] **STM32 logger "unique PCB port" routing failure:** the scripted STM32 logger fails at 50×30 and 37×20 with
      tscircuit's "Routes contain a junction or endpoint that cannot select a unique PCB port", with or without the
      debug footprint; 39×21 routes (`npm run board`, 13 Nov). Belongs with the routing-aware retry above.
      Audit 17 Nov (bringup-system): not re-run since the Freerouting fallback (746afdd), which may route it: one npm
      run board at 37x20 would tell.
      Done 17 Nov (bringup-board, adopt a4af9d5): 50×30 routes on tscircuit's first layout, DRC 0, 0 unconnected, 31 s.
      37×20 no longer places (the logger has gained parts: "no room for C5"); at its smallest by placement today, 47×16,
      it routes via Freerouting: 3 layouts, 88 s, DRC 0, 0 unconnected.
- [ ] **Antenna keep-out:** Espressif recommends 15 mm clear around the module's antenna; the case leaves 2 mm. No
      ground copper is kept away from it yet either.
      Audit 17 Nov (bringup-system): the report names parts within 15 mm (b95dfb3, advisory); left: the layout, the case
      and ground copper keeping clear.
- [ ] **RT9080 lifecycle:** one LCSC page flagged it "not recommended for new designs". Confirm with Richtek or a
      distributor, and name a second source.
      Audit 17 Nov (bringup-system): still open: needs Richtek or a distributor; the robots' power tree uses it too.
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
      Audit 17 Nov (bringup-system): still open: needs the measured droop (no board yet).

## Compute boards and the Rover with a Pi (merged into adopt 1d6f68d, 15 Nov)
User, 15 Nov: "sure, for now, until we think of a better solution for that one" (buy the brain, design the body);
"We should handle every relevant one so stop caring which comes first"; mini PCs/NUCs: "We should be able to handle
them as well, although it might not be the focus here".
- [x] **Fork Rover + climate doesn't settle (already broken on adopt 7c2fa2b, not from compute):** Done 15 Nov
      (4164770: the brief's plate limit on every layout before motion is written, an over-wide row centred, the plate
      re-fitted when a board's live limit changes); the box was left open. Re-checked 17 Nov on adopt 4234327: the fork
      settles with 0 findings in 183 s (plate 150 × 96 mm), and BRINGUP_SLOW=1 test/starters.int.test.ts passes.
      Was:
      test/starters.int.test.ts (slow). The starter has no assembly, so the system lays one out with plateFor's
      150 × 110 floor and no brief limit (src/system/assembly.ts plateFor/withOutlines, run.ts:111 passes no maxSizeMm):
      plate 156 × 110, then main's mech-fit says the wheels rub it and "Size with wheels 156 × 120 > 150 × 120". Fix:
      pass the brief's plate limit (plateLimitMm) on every relayout, or save the assembly in the starter seed.
- [x] **The Pi HAT's 5 V isn't wired into header pins 2/4 on the PCB** (only in the contract): the board generator wires
      power by part role and pin label, and the header's pins are labelled 1–40. No 5 A input connector either.
      Done (d886638): a part's pin→rail map (Part.nets) is wired by the generator; the HAT's 5 V input is a KF301 screw
      terminal (J2). test/supply-wiring.test.ts: 5 V on J1.2, J1.4 and J2.VIN; ground on pins 6/9/14/20/25/30/34/39.
- [x] **ADAFRUIT-2223 stacking header:** no LCSC number; an 8.5 mm socket + 10 mm pins against the 16 mm spacer stack
      needs a fit check (09741c's hardware list). Pi holes are M2.5 (Ø2.7) but the chassis' boardScrew pilot is the M2
      self-tapping one: a per-board screw is needed.
      Audit 17 Nov (bringup-system): done in d47325b: each board's screw follows its own holes (the Pi's Ø2.7 take M2.5
      into a 2.1 mm pilot) and the HAT's stacking header is checked against the 16 mm stack. No LCSC number: it is an
      Adafruit part, bought from Adafruit.
- [x] **Charger vs pack:** main still carries the 1S TP4054 charger and plug on the rover-pi's 2S pack; no check
      compares them. Done: the charger-pack and pack-voltage checks (d886638), and since 17 Nov (af18628) a robot's
      power tree is decided in code from its pack: a 1-cell charger on a multi-cell pack is dropped with its passives
      and the step-down and Schottkys added, on every parts or pack write.
- [x] **Runtime leaves out the Pi:** a bought board's contract has no power rails.
      Done 15 Nov in d886638, box left open (found 17 Nov, bringup-system): the robot's runtime and pack current add
      each bought computer's typical draw through the 5 V regulator (boughtComputeA, from its module record), and the
      system's compute-power check judges its peak (rpi-5: 5.0 A) against the pack and the regulator (powerBudget). On
      examples/rover-pi: the Pi is 0.69 A of the 0.91 A cruise current, runtime 123 min (without it about 509 min).
      Tests: test/compute-runtime.test.ts, test/compute-checks.test.ts (15/15).
- [x] **Simulation ~10 % faster than planned**: measured 15 Nov on the test rover, the reference rover and Rover with a
      Pi at duty 0.4 and 0.8, the simulated cruise is -1.6 % to +0.4 % of the load line's speed (adding Crr in MuJoCo
      made it 3-5 % slow: its contacts and the caster's friction already cost that). The gap predated the caster
      friction fix and the one load-line model. Guarded by py/tests/test_mech_speed.py (within 3 %).
- [x] **Turn closed on heading**: the 100 mm turn clearance was measured on one design; turning by time stays open-loop.
      Needs an IMU on the robot's board (a hardware choice for the user).
      Audit 17 Nov (bringup-system): turns close on the wheel encoders' counts since 16 Nov (rover_enc.h,
      ROVER_TURN_COUNTS), quadrature on the S3 since f620338; left: a heading sensor (IMU) for wheel slip. Next for
      bringup-system.
      Done 17 Nov (bringup-system): the user, asked which robots get an IMU: "Every robot". The LSM6DS3TR-C (LCSC
      C967633, ST DocID030071 Rev 3) is added in code to every robot's parts (contract/imu-auto.ts) and wired on the I2C
      bus at 0x6A with 100 nF on VDD and VDDIO (its LGA-14 lands from Figure 17, the outward extension an estimate);
      the firmware's turn ends on the gyro's heading (hw_heading_rad, bias taken over 1 s at rest; rover_enc turnRad),
      encoder counts as before without one. Driver host tests 4/4, native 18/18, test/imu.test.ts; esp32c3 and sim
      builds pass; scripted Eurobot mock settled rev 13, 0 violations. Not proven on hardware: the bench (the drive
      simulation has no gyro).
- [x] **examples/rover is stale** (saved 11 Nov, before the 150 × 120 brief and the current axle/wheelbase); re-save
      from a mock run. examples/rover-pi has no still.png.
      Audit 17 Nov (bringup-system): done 15 Nov in 282b51f: the reference rover re-saved from a settled mock build, and
      Rover with a Pi got its still.png.
- [ ] **Null values in module records:** Jetson hole positions, ROCK 5B absolute holes, heights.
      17 Nov (bringup-system): the ROCK 5B's holes (five Ø3.5 mm) and height (16.35 mm) from Radxa's v1.42 STEP, agreeing
      with the V1.41 drawing's spacings within 0.2 mm. Its Ø3.5 holes showed two screw choosers disagreeing (the
      chassis M2.5, the parts list M3, which the catalog lacks): the parts list and the fit check now use the chassis'
      boardScrew (test/board-screws.test.ts). Left, with no public source found: the Pi 5, Zero 2 W and CM5 IO heights
      (no vendor STEP; the drawings have no heights), the Jetson Orin Nano kit's holes (NVIDIA's devkit STEP needs a
      developer login). The other nulls are values vendors don't publish (typical currents, the NUC's VESA bracket).
- [x] **Eurobot starter** (16 Nov, bringup-system): examples/eurobot, saved from a settled mock build of briefs/eurobot-base.md (rev 11, 0 violations, 0 failed builds, the simulated drive passes, 7 of 7 Eurobot rule figures within limits). Before: the brief got the beacon design (unsettled, 9 violations).
  - [x] **Fork evidence** (16 Nov, bringup-system): each run's module evidence now names its design and, for a fork, the
        starter it came from (src/modules/library.ts runSource reads the dashboard's lineage, plans/starters/*/forks.jsonl);
        `bringup modules` counts forks per starter. A system's board runs are labelled <system>/<board>: before, every
        system's main was "scripted main" (72 of the VL53L0X's 131 records on this machine, one "run"). Old records keep
        their label.
  - [x] **E-stop module** (16 Nov, bringup-system): `safety-estop-a22e`. An Omron A22E-M-01 (Ø40 mm red, 1 NC), every
        number from Omron's datasheet. Its NC contact sits in the motors' supply (board plug JE1, JST XH: VBAT → MOTOR_VM →
        the driver's VM), not on a logic line: the contact's minimum load is 10 mA at 5 V and a 3.3 V/10 kΩ sense line
        carries 0.3 mA. Checked in mechanics/safety.ts: breaking current (both motors stalled at full charge against the
        contact's DC13 1.5 A rating; the reference rover's two POLOLU-2367 draw 0.94 A at 4.2 V), pack voltage within 24 V, the plug, and the
        mount (the 54.7 mm body must clear the plate, so the button needs a deck at least 111 mm up on the reference rover).
  - [x] **Pull-cord start module** (16 Nov, bringup-system): `start-pullcord`. A 2-pin header (PZ254V-11-02P) whose START
        the cord's wire loop holds low, pulled up 10 kOhm on the board; mechanics.safety.start {connector, cordMm,
        matchS}. Firmware templates/fw-rover/src/match.h: arms only after seeing the cord in (a robot powered up without
        it never starts), starts after 50 ms out, stops the motors MATCH_MS later for good (host tests test_match). The
        simulation pulls the cord at its first tick.
  - [x] **Rule-check module** (16 Nov, bringup-system): `rules-eurobot-2026`. catalog/rules/eurobot-2026.json: each limit
        cited to its clause and page of the General Rules 1.2. motion.rules opts a design in (the brief check asks the
        architect when the brief names Eurobot). Checked: start perimeter (convex shell, 1200 mm), height (350 mm, an
        estimate from below), e-stop red, at least 20 mm, top at most 375 mm and at most 25 mm over the robot, 48 V, cord
        at least 500 mm, stop at 100 s, opponent sensor. Found: the A22E's head is 32 mm proud of its deck, so the deck
        needs a 7 mm collar (mechanics.safety.estop.collarMm). Not checked (listed in the report): beacon support, the
        100 × 70 mm sticker face, the deployed perimeter, lithium battery conditions.
  - [x] **Eurobot: model the beacon support mast and the sticker face** (F.6), then check them.
        Measured first (16 Nov, bringup-system): on the Eurobot base as saved (the reference rover's 150 x 96 mm plate,
        317 g), the opponent's 400 g beacon at 430 mm (F.6: it must hold 400 g) on an 80 mm printed mast (about 323 g of
        PLA, an estimate) makes it about 1040 g with its centre of mass at 274 mm: braking at the floor's estimate moves
        it 96 mm forward (22 mm today), far past the wheels-and-caster triangle. The small base can't carry the beacon:
        the Eurobot base needs a wider, heavier, lower base (the 290 mm square allows a ~270 mm track) or a much lighter
        mast, before the mast is modelled. The design choice (bigger base vs light mast) is open.
        Audit 17 Nov (bringup-system): done: 9862c02 (mechanics.beacon: the printed mast and its 400 g in the mass
        model, so the tipping check carries them; F.6's limits checked), a518398 and 6e97c62 (the 100 × 70 mm sticker
        panel, boards kept clear of it); examples/eurobot re-saved on it (0c11d6c: mock rev 12, 0 violations, so the
        saved base passes the tipping check with the mast and its load aboard).
  - [x] **Eurobot starter: encoder motors and odometry** (16 Nov, done: Pololu 5139, channel A on GPIO0/1, rover_enc.*
        built in only with ROVER_TURN_COUNTS, back-off of 100 mm before turning). Open: the encoder's direction and the
        hold gain (0.001 duty/count, an estimate) on the bench. Channel B: since 17 Nov (f620338) a robot asking for
        encoders moves up to the ESP32-S3 when the C3 can't carry both channels on pins free at reset, and the S3
        counts quadrature in its PCNT; the C3 alone keeps channel A (no free GPIO).
    Was: The scripted Eurobot base builds as a robot (was the
        beacon design) with 1 open problem: the simulated drive clips a side wall. Its timed turn ends at 144° (target
        135°) and its heading then drifts 0.29 rad over 7 s at equal duties until it meets the wall; without the e-stop's
        56 g the same course passes, so the course is marginal for an open-loop drive. The brief already asks for
        "encoders on both drive wheels": encoder gearmotors in the catalog and odometry in the rover firmware close the
        turn and the straight run on the wheels (no IMU needed). Then save examples/eurobot.
  - [x] **The e-stop's printed deck** (16 Nov): py/chassis.py prints it (two walls, the 2 mm panel with the cutout, the
        collar), its PLA counts in the mass; examples/eurobot re-saved with it. Open: the 3D view draws the deck, not the
        button itself.
  - [x] **Motor output traces stay 0.15 mm** (done 16 Nov: IPC-2221 width for the stall current when over the default) (MOTOR_A1…B2 have no width rule; only rails get IPC-2221 widths). a 6 V
        N20 stalls at 0.67 A (more at 2S): check against IPC-2221 and widen.

## Retrofit and reverse engineering existing hardware (decided 17 Nov 2026: "something we will definitely cover")
The user, 17 Nov 2026: "can you tell me whether HW hacking is part oof bringup and should it be? Like will we able to
reverse-engineer air-purifier's HW and replace it with custom board and firmware?" and then "I want to take this much
further than stupid air purifiers, hopefully you get that. You should put this in backlog as something we will
definitely cover."
- [ ] **Retrofit mode: a host device as hard constraints.** The contract gets a host device: its enclosure, mounting
      holes, connector positions and pinouts, supply voltages and the protocols on its cables. Bringup designs the drop-in
      replacement for the control electronics (board, firmware, any printed adapter parts) against them, the same way it
      checks board/case/firmware today with the constraints given instead of chosen. Scope is any product, not one class:
      appliances, robots, vehicles' and machines' control boards, instruments. Safety rule in code: never redesign a
      mains or high-energy power stage; the certified power side stays, Bringup replaces the low-voltage control side.
- [ ] **Capture: from a device on the bench to the constraints.** Photos and measurements of the original board (outline,
      holes, connectors), a continuity/pinout map, voltages per pin, protocol captures (UART/I2C/SPI via a logic
      analyser; the existing bench harness and test pads are the start), the MCU and sensors identified. First version
      entered by hand; then assisted (the bench companion probes and records).
- [ ] **Compliance for a retrofit board**: pre-certified radio modules only (as the ESP32 modules today); no vendor
      firmware redistributed; the report says what the owner may and may not do with it.

## Verified builds and complete kits (the user, 17 Nov 2026)
The user: "Maybe we have verify builds option where we build it ourselves and send it or just to make sure it works...
Or we can offer sending them the full package with all elements, mechanical or 3D printed or whatever."
- [ ] **Verified build:** we build the design ourselves (board assembled, firmware flashed, the factory test and the
      bench test pads run, the mechanics assembled), then either ship it to the customer or just certify it works and
      hand over the evidence (test report, measurements, photos) so they build with confidence.
- [ ] **Full kit:** ship everything the design needs in one box: the assembled board(s), 3D-printed and other
      mechanical parts, bought parts (motors, wheels, battery, fasteners, cables), from the build package Bringup already
      generates (bringup package: BOM with shops, printed STLs, assembly steps and pictures).
- [ ] **Business shape (proposed 17 Nov, to decide):** free to design, pay to build (fab package / verified build / kit);
      private projects and team seats paid; a compliance pack (EU CRA docs, CE/FCC pre-compliance) for companies;
      competition rules packs per season; retrofit kits as a marketplace with revenue share; real-model runs as credits.
      Rule kept in every tier: the checks are never gated (correct designs for everyone).

## Setup on a new machine (the user, 17 Nov 2026)

- [ ] **Streamline setup:** the user, verbatim: "add to backlog streamlinging setup process. Like it should be as simple as
      possible to setup on a new machine and this should be added to readme as waell". Today: `npm run setup` installs the
      repo-local toolchain (about 14 min the first time), `npm run doctor` reports what each tool will use (README,
      "Install & run"). Do: measure a fresh-clone setup on a clean machine (or container) step by step, remove every manual
      step that can be automated (prerequisite checks with the exact fix, one command end to end, a quick-look mode that
      needs no toolchain), and keep the README's "Install & run" section to that one path, tested on each release.

## Lessons from text-to-CAD tools (the user, 19 Nov 2026: "proceed with implementation")

A read-only study (bringup-cad, 19 Nov) of text-to-cad (earthtojake, MIT, v0.11.13), cadsmith (JonFermin, MIT) and
the aradotso text-to-cad-harness skill (a rewrite of an older text-to-cad, nothing original). They check one part
well; nothing re-checks the case when the board changes, which is what our contract does. Six ideas to borrow, in
order (effort as estimated in the study):

- [x] 1. Exact interference between the chassis, case, board, motors and wheels as a contract check (~1 day). Built
      19 Nov (py/chassis.py interference, part-interference): every pair among the chassis, boards, pack, motors,
      wheels, sensor and e-stop. The case isn't in it (a rover has no case; a case's own checks cover its features).
      Found: the pack ran into the sensor's bracket on 3 of 4 example robots and both scripted mock robots, now a fit
      check too. Follow-up: a thin pack under a board meets the board's standoffs; the 2D fit check allows it, so only
      this check sees it, and the solver can't avoid it until the fit check knows the boards' holes (chassisSpec's).
- [ ] 2. Real inertias in the URDF from the built parts' mass properties (today boxes and cylinders marked ESTIMATES),
      and `check_urdf` as a violation (~1 day).
- [ ] 3. Click-to-reference editing: a pick in the 3D view names a feature and the code that made it, and the case
      designer edits that (1–2 days).
- [ ] 4. A motor, bearing and fastener library with named frames and ISO 286 fits, from cadsmith's data with its MIT
      notice kept (~1 day).
- [ ] 5. Print-DFM as named violations: overhang, minimum wall, bed size (~0.5 day).
- [ ] 6. A one-screen run summary with the change from the previous run and exit codes (~0.5 day).

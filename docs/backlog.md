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

- [ ] **Antenna keep-out:** Espressif recommends 15 mm clear around the module's antenna; the case leaves 2 mm. No
      ground copper is kept away from it yet either.
- [ ] **RT9080 lifecycle:** one LCSC page flagged it "not recommended for new designs". Confirm with Richtek or a
      distributor, and name a second source.
- [ ] **EN reset delay:** the generator ties the ESP32-C3's EN straight to 3V3; Espressif's reference design puts an
      RC delay there (10 kΩ, 1 µF). A reset button on EN would also make recovery possible without unplugging the
      battery.
- [ ] **Bulk capacitance for Wi-Fi bursts:** the board has 10 µF on the 3V3 rail. Check against the rail droop measured
      above before adding more.

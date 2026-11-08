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

- [ ] **Antenna keep-out:** Espressif recommends 15 mm clear around the module's antenna; the case leaves 2 mm. No
      ground copper is kept away from it yet either.
- [ ] **RT9080 lifecycle:** one LCSC page flagged it "not recommended for new designs". Confirm with Richtek or a
      distributor, and name a second source.
- [ ] **EN reset delay:** the generator ties the ESP32-C3's EN straight to 3V3; Espressif's reference design puts an
      RC delay there (10 kΩ, 1 µF). A reset button on EN would also make recovery possible without unplugging the
      battery.
- [ ] **Bulk capacitance for Wi-Fi bursts:** the board has 10 µF on the 3V3 rail. Check against the rail droop measured
      above before adding more.

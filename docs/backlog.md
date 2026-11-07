# Backlog

Work we know is needed and haven't done, in priority order inside each section. The compliance checklist each
firmware build writes (`compliance.md`) marks the security items as "open" until they are done.

## 1. Prove the flow works end to end

The checks and agents are tested piece by piece with scripted agents. What hasn't happened yet:

- [ ] A real-model run from a brief to all outputs (board, case, firmware, report) under the space, case,
      connectivity and security rules added 6–7 Nov. No real-model run has used them yet.
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

Open from run 3, decisions for the engineer:

- [ ] **Recovery flashing:** the product firmware deep-sleeps, and the ESP32-C3's USB is off in deep sleep, so a
      board can't be reflashed unless it is awake. The reviewer asked for GPIO9 (boot) access. Options: a boot button,
      boot and reset test pads, or firmware that stays awake a few seconds after power-up.
- [ ] **Phone use in the battery budget:** a phone connection keeps the device awake up to 30 s at about 86 mA, and the
      battery check doesn't count it. The reviewer flagged it every round. It needs a stated assumption (for example,
      one connection a day) counted like the Wi-Fi uploads.
- [ ] **The charger's own drain:** with USB unplugged the TP4054 draws 6 µA typ, 10 µA max from the battery; the power
      budget counts the regulator's quiescent current but not this.
- [ ] **Review convergence:** each review starts fresh and finds new things, so four fix rounds can end on a
      different blocker each time. Consider giving the reviewer its earlier findings.

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
- [ ] **Bulk capacitance for Wi-Fi bursts:** the board has 10 µF on the 3V3 rail. Check against the rail droop measured
      above before adding more.

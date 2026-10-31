# Wokwi: the add-sensor flow, simulated with the sensor answering

A mock run of `briefs/beacon.md` with the real tools and one engineer change,
`--change "add a temperature/humidity sensor"`, from wt/firmware ed7abbf. The change rippled (`ripples.json`: fields
requirements, parts, pins; woke 7 of 9; consistent again 209.7 s after the request; settled at rev 10). Then:

```bash
npm run bringup -- simulate out/wokwi-add-sensor     # WOKWI_CLI_TOKEN in .env, tools/wokwi-cli (NOTES.md)
```

simulated the newest firmware (rev 10) in Wokwi, with the circuit generated from the contract (`diagram.json`: the
ESP32-C3 and the SHT40 the agents added, on the contract's I2C pins GPIO8/GPIO9; `wokwi.toml`). Wokwi has no SHT40, so
the sensor is a custom chip (`templates/wokwi/chips/sht40.chip.c`) that answers the SHT40's measure command 0xFD with
a fixed 21.50 °C / 48.0 %RH and CRCs. The serial output (`simulation.json`):

```
bringup rev 10
SENSOR OK 21.50 C 48.0 %RH
E (56) esp_littlefs: … Corrupted dir pair at {0x0, 0x1}      (a blank flash: LittleFS formats it on first mount)
HISTORY slot 0
TEST PASSED.
BLE Bringup-1001 advertising 300 ms
```

One session, 30 s of simulation at most (the free plan: 50 min per 30 days). `simulation-skipped.json` is the same
command on a machine without a token: `not run (no WOKWI_CLI_TOKEN in .env; optional, see NOTES.md)`.
Tests: `test/wokwi.test.ts` (generation, chip bytes, skip reasons, report line) and `test/wokwi.int.test.ts` (one
Wokwi session; skipped without a token).

What to say: the firmware the agents generated reads the sensor the agents chose, on the pins they assigned, in a
simulator, and stores the reading. What not to say: that it read a real sensor (the value is a fixed stand-in), that
BLE was tested (Wokwi printed the advertising line; no phone connected), or that every build is simulated (it runs on
demand, to save the free plan's minutes).

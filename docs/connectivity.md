# Connectivity: how the device reaches its owner, and what that costs the rest of the design

A connectivity engineer agent owns one contract field, `connectivity`: the radio, how readings leave the device, and
whether its firmware can be updated in the field. It is consumer first: Home Assistant and a phone before gateways
and fleets. Changing it ripples like any other change. The radio's transmit peak is checked against the rail and the
regulator, Wi-Fi uploads against the battery target, and an update slot against the flash a model needs. The firmware
then rebuilds with the right radio code.

```
connectivity: { radio: "ble" | "wifi", report: ["gatt" | "bthome" | "mqtt"], uploadPeriodS (Wi-Fi), updates: "none" | "ota" }
```

Without the field, the device is what it always was: Bluetooth LE with its GATT service, and no field updates.

## The consumer paths

| Request | What the device does | Who reads it |
| --- | --- | --- |
| "show the readings in Home Assistant" | Bluetooth LE, `report: ["gatt", "bthome"]`: each reading is also broadcast as BTHome v2 service data (UUID 0xFCD2: packet id, temperature 0.01 °C, humidity 0.01 %, ascending object ids) | Home Assistant's built-in BTHome integration, through its own Bluetooth or an ESPHome Bluetooth proxy. No app, no hub |
| "send the readings over Wi-Fi every hour" | Wi-Fi, `report: ["mqtt"]`: a reading every wake, an upload every `uploadPeriodS`. Home Assistant MQTT discovery config (retained), the latest reading as the state, and the readings since the last upload as a batch | Home Assistant with an MQTT broker |
| "add firmware updates" | `updates: "ota"`: after each upload the device asks `OTA_URL` for a newer image (HTTP update, the revision sent as `x-ESP32-version`) | An update server you run |

The BTHome encoder is checked byte for byte against the examples on bthome.io/format: the firmware's own header,
compiled on the host (`test/bthome.test.ts`). With BTHome and GATT together, the advertisement holds the flags,
the BTHome data and the name (30 of the 31 bytes). The GATT service's UUID moves to the scan response.

Wi-Fi and MQTT credentials never enter a generated folder (a linked folder is a git repo that commits it). Write
your own `secrets.h` (`WIFI_SSID`, `WIFI_PASS`, `MQTT_HOST`, `MQTT_PORT`, optional `MQTT_USER`, `MQTT_PASS`,
`OTA_URL`) and set `BRINGUP_SECRETS` to its path. The compiler force-includes it from there. Without it, the firmware
builds and reports that it isn't provisioned.

## One data format, the firmware and the reader made from it

The record layout, the GATT UUIDs and the MQTT topics live in one place (`src/codegen/data-format.ts`). Each firmware
build writes `include/dataformat.h`, which the firmware reads, and `reader/bringup_reader.py`, a small Python
reader for that design:

- `decode_record`
- `decode_history`, for a GATT history read
- `decode_mqtt_batch`, for the MQTT history batch, with each reading's age
- `read_history(address)`, which reads every stored reading over Bluetooth LE (needs `pip install bleak`)

A test packs readings with the firmware's own record code, compiled on the host, and decodes them with the generated
reader. Before, the format lived only in `main.cpp`, so a reader had to copy it by hand.

## What the radio costs the rest of the design

From the ESP32-C3-MINI-1 & MINI-1U datasheet v2.2 (2026-05-06), now in the parts catalog:

| Figure | Value | Where |
| --- | --- | --- |
| Bluetooth LE transmit, 0 dBm | 170 mA peak | Table 6-5 |
| Bluetooth LE receive | 86 mA | Table 6-5 |
| Wi-Fi transmit (802.11b, 20.5 dBm) | 350 mA | Table 6-4 |
| External supply | at least 0.5 A | Table 6-2 |

The checks that follow from it:

- `rail-underrated`: the 3V3 rail's peak must cover the radio's transmit peak: 170 mA on Bluetooth LE, 350 mA on
  Wi-Fi. Before, it was checked against the 84 mA receive current, because the chip datasheet gave no Bluetooth figure.
  The logger's rail is corrected from 120 to 200 mA.
- `supply-underrated`: the regulator must be rated for the module's 0.5 A, whatever the radio. The catalog now
  carries each regulator's rating with its source (AP2112K 600 mA, Diodes DS39724; XC6206 200 mA, LCSC and Arrow
  listings).
- `regulator-overclaimed`: a rail's stated regulator rating can't exceed the part's own. Before, the rail's rating
  was the architect's number and nothing compared it with the part.
- **Battery:** each Wi-Fi upload costs an **estimate** of 3 s at 120 mA = 360 mC. Community measurements of ESP32
  joins from deep sleep run 1-4 s at 70-150 mA; Espressif publishes no figure. It is counted on top of the rails, the
  way the model's listening is, and a target it breaks wakes both the architect and the connectivity engineer. On the
  logger (500 mAh, 180 days), hourly uploads fall short and every 8 hours fits. The scripted engineer stretches the
  period until it holds.

## Flash: field updates take a second firmware slot

The update choice picks Arduino-ESP32's stock 4 MB partition table, and the flash left for a model follows.
Measured with `pio run` on the logger (6 Nov 2026):

| Connectivity | Table | Firmware / slot | Left for a model |
| --- | --- | --- | --- |
| None (as before) | default.csv | 818,177 / 1,310,720 | 480 KB |
| Bluetooth LE, GATT + BTHome | no_ota.csv | 818,569 / 2,097,152 | 1.2 MB |
| Wi-Fi, MQTT | no_ota.csv | 1,086,059 / 2,097,152 | 987 KB |
| Wi-Fi, MQTT, updates | default.csv | 1,188,320 / 1,310,720 | **119 KB** |

A model that doesn't fit beside two slots, but would fit in one, is a `model-flash` violation for both the ML
engineer and the connectivity engineer, which says so.

## Not done yet

- **Nothing here has run on hardware.** The firmware compiles in every configuration, and the BTHome bytes match the
  spec, but no board has been seen in Home Assistant, joined Wi-Fi or taken an update.
- **The regulator gap:** with the 0.5 A requirement, the catalog's only fitting regulator is the AP2112K, which draws
  55 µA of its own. A low-quiescent regulator rated 0.5 A or more would need adding to the catalog, with its
  datasheet checked.
- **Security:** BLE is open (no pairing), MQTT uses no TLS, and updates come over plain HTTP with no signature. The EU
  Radio Equipment Directive's cybersecurity requirements (since 1 Aug 2025) and the Cyber Resilience Act (reporting
  from 11 Sep 2026, everything else from 11 Dec 2027) make this a requirement, not a nice-to-have. It is the next
  step.
- **Provisioning:** credentials are compiled in from your own file. Setting them on a finished device (over
  Bluetooth, or a setup page) is not built.
- The Wi-Fi connection cost is an estimate until measured on the bench.

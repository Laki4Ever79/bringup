# Edge AI: the device around the model

Bringup treats an on-device model as one more domain of the design contract. The model has an owner (the `ml` agent),
and plain-code checks tie it to the rest of the design:

- **Fit:** weights and tensor arena against the flash and RAM the firmware leaves. The budget was measured with `pio run`.
- **Sensor:** the parts list must have a sensor of the right kind, its data lines must be in the pins, and the sample
  rate must be one the sensor supports.
- **Power:** listening is counted in the battery estimate.
- **Hardware:** the sensor path the training data was recorded on must still be the path the hardware has.

Bringup doesn't train models or host datasets. It generates what the device needs around the model: the
microphone footprint, the case opening, `model.h`, the data-collection firmware, and the fit check of the converted
model.

## The pieces

| Step | What it does | Where |
| --- | --- | --- |
| Model in the contract | `model`: task, sensor, rate, window, weights/arena plan, int8, listening. Checks wake the agent who can fix each mismatch | `src/contract/model.ts` |
| Board | ICS-43434 on TDK's land pattern, I2S lines wired, LR to GND | `src/codegen/circuit.ts` |
| Case | A 2 mm opening through the floor under the bottom-port mic; `port-missing` when it isn't under the sound hole | `py/enclosure.py` |
| `model.h` | Rate, window, arena and weights sizes, the sensor path hash, mic capture settings. The firmware reserves the arena and the weights, so `pio` counts them | `src/codegen/firmware.ts` |
| Sensor path | Part, placement, rotation, case opening, rate, channels, capture gain, hashed. `model-stale` when the hardware moves under recorded data | `src/contract/sensor-path.ts` |
| Data collection | Firmware that streams the mic, one model window per frame, stamped with revision and path hash; a recorder that keeps one dataset per path | `templates/fw/src/collect.cpp`, `py/collect.py` |
| Quantize + verify | TFLite int8 conversion, TFLite Micro's own arena figure, the real model compiled into the firmware | `py/quantize.py`, `bringup verify-model` |

## Run it

```bash
# 1. A design with a wake word (mock models, no hardware needed)
npx tsx src/main.ts briefs/logger.md --mock --no-review --change "add a wake word" --out out/wake

# 2. Record training data on the real board (needs an ICS-43434 wired as the contract says)
cd out/wake/firmware/rev-<n> && ../../../../.venv/bin/pio run -e esp32c3_collect -t upload && cd -
.venv/bin/python py/collect.py --port /dev/ttyACM0 --label hey_bringup --windows 50 --out data/wake --contract out/wake/contract.json

# 3. Convert (your trained Keras model with --keras; without it, the untrained MLPerf Tiny DS-CNN for sizes)
tools/mlvenv/bin/python py/quantize.py --out out/wake/model --dataset data/wake

# 4. Verify against the design, and build the firmware with the real model in flash
npx tsx src/main.ts verify-model out/wake/model out/wake/contract.json --firmware out/wake/fw-model
```

The ML tools live in their own venv, so TensorFlow can't change the numpy that build123d uses:

```bash
python3 -m venv tools/mlvenv
tools/mlvenv/bin/pip install tensorflow-cpu==2.21.0 tflite-micro==0.dev20261104051855
```

## Measured (5 Nov 2026, ESP32-C3, espressif32@8.0.0)

| What | Bytes |
| --- | --- |
| Logger firmware, no model | RAM 25,760, flash 841,627 |
| MLPerf Tiny DS-CNN keyword spotter, int8 (TF 2.21) | 44,008 (24,908 parameters) |
| Its tensor arena, TFLite Micro host build | 24,800 (slightly above a 32-bit MCU's) |
| Firmware with the real model and its arena | RAM 51,360, flash 885,761 |
| Data-collection firmware | RAM 45,320 (one 1 s window buffered), flash 317,314 |

The contract's planning figure for the arena was 23 KB; TFLite Micro needs 24,800 B. `verify-model` reports the
shortfall and proposes the measured sizes as the new plan.

## Not done yet

- The data-collection firmware compiles but has not run: no ICS-43434 is on the bench.
- No inference code: the firmware reserves the model's memory and links it, but doesn't run it yet.
- Microphones only for data collection. IMU range, output data rate and axis orientation will join the sensor path when an IMU
  is in the catalog.
- The arena is measured on the host. On the device it comes from the interpreter's `arena_used_bytes()`.

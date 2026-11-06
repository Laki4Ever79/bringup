import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { dataFormatHeader, DATA_FORMAT, readerPython } from "../src/codegen/data-format.ts"
import { LOGGER_DESIGN } from "../src/inference/scripts.ts"
import { fixtureContract } from "./fixture.ts"

// The firmware's own record code (templates/fw/include/record.h with the generated dataformat.h), compiled on the
// host, packs readings; the generated Python reader decodes them. Both come from src/codegen/data-format.ts.
const root = resolve(import.meta.dirname, "..")
const python = join(root, ".venv/bin/python")
const skip = spawnSync("g++", ["--version"]).status !== 0 ? "no host g++" : !existsSync(python) ? "no .venv python" : false

test("what the firmware packs, the generated reader decodes: GATT history and the MQTT batch", { skip }, () => {
	const dir = mkdtempSync(join(tmpdir(), "dataformat-"))
	writeFileSync(join(dir, "dataformat.h"), dataFormatHeader())
	const readings: [number, number][] = [[21.37, 48.5], [-12.34, 0], [0, 100], [85.5, 33.33]]
	writeFileSync(join(dir, "t.cpp"), `#include "${join(root, "templates/fw/include/record.h")}"\n#include <stdio.h>\nint main() {\n${readings.map(([t, h]) => `printf("%u\\n", packReading((float)(${t}), (float)(${h})));`).join("\n")}\n}\n`)
	execFileSync("g++", ["-std=c++17", "-Wall", "-Werror", `-I${dir}`, "-o", join(dir, "t"), join(dir, "t.cpp")])
	const records = execFileSync(join(dir, "t"), { encoding: "utf8" }).trim().split("\n").map(Number)

	const s = fixtureContract()
	s.values = { ...s.values, ...structuredClone(LOGGER_DESIGN) }
	writeFileSync(join(dir, "bringup_reader.py"), readerPython(s))
	// GATT: newest first, little-endian; MQTT: oldest first, PERIOD_S apart.
	const gatt = Buffer.alloc(records.length * 4)
	records.forEach((r, i) => gatt.writeUInt32LE(r, i * 4))
	const script = `import json, sys\nsys.path.insert(0, ${JSON.stringify(dir)})\nimport bringup_reader as r\nprint(json.dumps([r.decode_history(bytes.fromhex("${gatt.toString("hex")}")), r.decode_mqtt_batch(json.dumps({"periodS": 300, "records": ${JSON.stringify(records)}})), r.decode_record(${DATA_FORMAT.latestSensorFailed})]))`
	const [history, batch, failed] = JSON.parse(execFileSync(python, ["-I", "-c", script], { encoding: "utf8" }))
	assert.deepEqual(history.map((x: { temperature_c: number; humidity_pct: number }) => [x.temperature_c, x.humidity_pct]), readings)
	assert.deepEqual(batch.map((x: { age_s: number }) => x.age_s), [900, 600, 300, 0])
	assert.equal(failed, null)
})

test("the firmware's GATT UUIDs and MQTT topics come from the data format, not from literals in main.cpp", async () => {
	const { readFileSync } = await import("node:fs")
	const main = readFileSync(join(root, "templates/fw/src/main.cpp"), "utf8")
	assert.ok(!main.includes(DATA_FORMAT.gatt.service), "the service UUID is not written out in main.cpp")
	assert.ok(!/"bringup\/%s/.test(main) && !/"homeassistant\/sensor/.test(main), "MQTT topics use DF_MQTT_PREFIX / DF_MQTT_DISCOVERY")
	assert.match(dataFormatHeader(), new RegExp(`#define DF_GATT_SERVICE "${DATA_FORMAT.gatt.service}"`))
})

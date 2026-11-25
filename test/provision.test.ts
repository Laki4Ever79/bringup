import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chassisSpec } from "../src/tools/chassis.ts"
import { ROVER_BOARD } from "../src/inference/scripts.ts"
import { writeRosPackage } from "../src/ros/package.ts"
import { aptPackages, provisionFiles, robotUsbId } from "../src/ros/provision.ts"
import type { ContractSnapshot } from "../src/contract/types.ts"

// ROS step 2 (docs/ros.md): a Raspberry Pi 5's first boot, from the design, checked without the Pi.

const contract = (parts: { role: string; mpn: string }[]) => ({ revision: 7, values: { parts } }) as unknown as ContractSnapshot
const S3 = contract([{ role: "mcu", mpn: "ESP32-S3-MINI-1" }])
const python = existsSync(".venv/bin/python") ? ".venv/bin/python" : "python3"

function workspace(): string {
	const ws = mkdtempSync(join(tmpdir(), "pi5-ws-"))
	const spec = chassisSpec({ revision: 7, versions: {} as never, values: JSON.parse(JSON.stringify(ROVER_BOARD)) } as ContractSnapshot)!
	writeRosPackage(join(ws, "src"), spec, { robot: "rover", revision: 7 })
	cpSync(join("templates", "ros", "bringup_hardware"), join(ws, "src", "bringup_hardware"), { recursive: true })
	return ws
}

// user-data parsed by PyYAML, as cloud-init reads it; the workspace tarball and the service unit out of it.
function parse(userData: string) {
	const r = spawnSync(python, ["-I", "-c", `
import sys, yaml, json, base64, io, tarfile
d = yaml.safe_load(sys.stdin)
ws = [w for w in d["write_files"] if w["path"].endswith(".tar.gz")][0]
names = tarfile.open(fileobj=io.BytesIO(base64.b64decode(ws["content"]))).getnames()
print(json.dumps({"keys": sorted(d), "files": {w["path"]: w.get("content", "")[:4000] for w in d["write_files"] if not w["path"].endswith(".tar.gz")}, "tar": names, "runcmd": d["runcmd"]}))
`], { input: userData })
	assert.equal(r.status, 0, String(r.stderr))
	return JSON.parse(String(r.stdout)) as { keys: string[]; files: Record<string, string>; tar: string[]; runcmd: unknown[] }
}

test("the board's serial port is named from its parts: a USB-UART bridge first, else the MCU's own USB", () => {
	assert.equal(robotUsbId(S3)?.vid, "303a")
	assert.equal(robotUsbId(contract([{ role: "mcu", mpn: "ESP32-S3-MINI-1" }, { role: "usb-uart", mpn: "CP2102N-A02-GQFN28" }]))?.vid, "10c4")
	assert.equal(robotUsbId(contract([{ role: "mcu", mpn: "STM32G431CBU6" }]))?.pid, "5740")
	assert.equal(robotUsbId(contract([{ role: "mcu", mpn: "NRF52840" }])), null, "an unknown one: no udev rule, /dev/ttyACM0")
})

test("apt packages are the workspace's own dependencies (Nav2's included), never its own packages", () => {
	const pkgs = aptPackages(join(workspace(), "src"))
	for (const p of ["ros-jazzy-diff-drive-controller", "ros-jazzy-nav2-controller", "ros-jazzy-nav2-regulated-pure-pursuit-controller", "ros-jazzy-hardware-interface"]) assert.ok(pkgs.includes(p), p)
	assert.ok(!pkgs.some((p) => /bringup/.test(p)), "rover_bringup and bringup_hardware are built, not installed")
})

test("the Pi's user-data is valid cloud-config: the workspace, the first-boot script, the service at /dev/bringup, the udev rule", () => {
	const files = provisionFiles(workspace(), "rover_bringup", S3, { revision: 7 })
	assert.match(files["user-data"], /^#cloud-config\n/)
	const d = parse(files["user-data"])
	assert.deepEqual(d.keys, ["chpasswd", "hostname", "runcmd", "ssh_pwauth", "users", "write_files"])
	assert.ok(d.tar.includes("src/rover_bringup/config/nav2.yaml") && d.tar.includes("src/bringup_hardware/package.xml"))
	const unit = d.files["/etc/systemd/system/bringup-robot.service"]
	assert.match(unit, /ros2 launch rover_bringup bringup\.launch\.py hardware:=bringup port:=\/dev\/bringup nav:=true/)
	assert.match(d.files["/etc/udev/rules.d/99-bringup.rules"], /ATTRS\{idVendor\}=="303a", ATTRS\{idProduct\}=="1001", SYMLINK\+="bringup"/)
	const boot = d.files["/opt/bringup/first-boot.sh"]
	assert.match(boot, /ros2-apt-source/, "ROS's own apt source package, the Jazzy install guide's way")
	assert.match(boot, /colcon build[\s\S]*systemctl enable --now bringup-robot\.service/)
	assert.deepEqual(d.runcmd, [["bash", "/opt/bringup/first-boot.sh"]])
	assert.equal(spawnSync("bash", ["-n"], { input: boot }).status, 0, "the first-boot script parses")
	const verify = spawnSync("systemd-analyze", ["--version"]).status === 0
	if (verify) {
		const f = join(mkdtempSync(join(tmpdir(), "unit-")), "bringup-robot.service")
		writeFileSync(f, unit)
		const r = spawnSync("systemd-analyze", ["verify", "--man=no", f])
		assert.equal(r.status, 0, String(r.stderr))
	}
})

test("with an SSH key there is no password; with Wi-Fi a network-config; without Nav2 the service says so", () => {
	const ws = workspace()
	const keyed = provisionFiles(ws, "rover_bringup", S3, { sshKey: "ssh-ed25519 AAAAC3Nza test@laptop\n", wifi: { ssid: "lab", password: "pw" }, nav: false })
	const d = parse(keyed["user-data"])
	assert.ok(!d.keys.includes("chpasswd"))
	assert.match(keyed["user-data"], /ssh_authorized_keys:\n\s+- ssh-ed25519 AAAAC3Nza test@laptop\nssh_pwauth: false/)
	assert.match(keyed["network-config"], /"lab":\n\s+password: "pw"/)
	assert.match(d.files["/etc/systemd/system/bringup-robot.service"], /nav:=false/)
	assert.equal(provisionFiles(ws, "rover_bringup", contract([{ role: "mcu", mpn: "NRF52840" }]))["user-data"].includes("99-bringup.rules"), false)
})

// The build package's assembly pictures: the robot drawn up to each assembly step (src/geometry/assembly-steps.js), once
// exploded, and from the top and the side, as PNGs in <package>/assembly/. Drawn by py/stills.py from the chassis the
// package itself just built (its spec.json and chassis.stl) and the bought parts placed as py/chassis.py places them, so
// it needs neither the hosted page nor a browser (the open-core split, 25 Nov 2026: before, the pictures were
// screenshots of the page's 3D view in headless Chromium, and an install without the page got none).
import { execFile } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { promisify } from "node:util"
import { ASSEMBLY_STEPS } from "../geometry/assembly-steps.js"

const exec = promisify(execFile)

// The PNGs stills.py printed, one per line. Python on Windows ends its lines with \r\n: split on \n alone, every name
// kept its \r, none ended in .png, and the pictures were drawn but never listed (OS smoke test, Windows, 27 Nov 2026).
export const pngLines = (stdout: string): string[] => stdout.split(/\r?\n/).map((f) => f.trim()).filter((f) => f.endsWith(".png")).map((f) => `assembly/${f}`)

export interface AssemblyPictures {
	files: string[]
	note: string | null
}

export async function assemblyPictures(python: string, root: string, chassisDir: string, outDir: string, log: (m: string) => void = () => {}): Promise<AssemblyPictures> {
	if (!existsSync(join(chassisDir, "spec.json")) || !existsSync(join(chassisDir, "chassis.stl"))) return { files: [], note: `no assembly pictures: ${chassisDir} holds no built chassis` }
	const dir = join(outDir, "assembly")
	try {
		const { stdout } = await exec(python, [join(root, "py", "stills.py"), chassisDir, dir, ASSEMBLY_STEPS.join(",")], { timeout: 600_000 })
		const files = pngLines(stdout)
		log(`assembly pictures: ${files.length} in ${dir}`)
		return { files, note: null }
	} catch (e) {
		return { files: [], note: `no assembly pictures: py/stills.py stopped: ${String((e as { stderr?: string }).stderr || e).trim().split("\n").pop()}` }
	}
}

// An arm (py/arm.py's posed/ folder: the assembled arm at rest, groups.json in assembly order): the same pictures, one
// per body from the base plate to the gripper, the printed parts in PLA orange and the servos dark.
export async function armPictures(python: string, root: string, posedDir: string, outDir: string, log: (m: string) => void = () => {}): Promise<AssemblyPictures> {
	if (!existsSync(join(posedDir, "groups.json"))) return { files: [], note: `no assembly pictures: ${posedDir} holds no posed arm` }
	const dir = join(outDir, "assembly")
	try {
		const { stdout } = await exec(python, [join(root, "py", "stills.py"), "--groups", posedDir, dir], { timeout: 600_000 })
		const files = pngLines(stdout)
		log(`assembly pictures: ${files.length} in ${dir}`)
		return { files, note: null }
	} catch (e) {
		return { files: [], note: `no assembly pictures: py/stills.py stopped: ${String((e as { stderr?: string }).stderr || e).trim().split("\n").pop()}` }
	}
}

// A board in its printed case (py/enclosure.py's case.stl and lid.stl, the board on its standoffs with its connectors):
// the open case, the board in it, the lid on, an exploded view and a top and side view (stills.py --case). Most first
// designs are a plain board in a case, and before this only robots and arms had pictures of their printed parts.
export async function casePictures(python: string, root: string, enclosureDir: string, outDir: string, log: (m: string) => void = () => {}): Promise<AssemblyPictures> {
	if (!existsSync(join(enclosureDir, "spec.json")) || !existsSync(join(enclosureDir, "case.stl"))) return { files: [], note: `no case pictures: ${enclosureDir} holds no built case` }
	const dir = join(outDir, "assembly")
	try {
		const { stdout } = await exec(python, [join(root, "py", "stills.py"), "--case", enclosureDir, dir], { timeout: 600_000 })
		const files = pngLines(stdout)
		log(`case pictures: ${files.length} in ${dir}`)
		return { files, note: null }
	} catch (e) {
		return { files: [], note: `no case pictures: py/stills.py stopped: ${String((e as { stderr?: string }).stderr || e).trim().split("\n").pop()}` }
	}
}

// pictures/drive/pictures.json: { revision, files, at }, the drive the pictures show.
export const DRIVE_PICTURES_FILE = "pictures.json"

// The rover's simulated drive (py/drive_pictures.py): the robot's own meshes at the poses of its MuJoCo drive's
// trajectory, on the course, drawn without MuJoCo or OpenGL: from above with the whole path, three key frames following
// the robot (start, farthest, end) and a GIF of the whole drive. Files under drive/ in outDir.
export async function drivePictures(python: string, root: string, chassisDir: string, driveDir: string, outDir: string, log: (m: string) => void = () => {}): Promise<AssemblyPictures> {
	if (!existsSync(join(chassisDir, "spec.json")) || !existsSync(join(chassisDir, "chassis.stl"))) return { files: [], note: `no drive pictures: ${chassisDir} holds no built chassis` }
	// drive.py writes an empty trajectory when the firmware never answered: say so, not that the drawing failed.
	if (!existsSync(join(driveDir, "trajectory.json")) || readFileSync(join(driveDir, "trajectory.json"), "utf8").trim() === "[]") return { files: [], note: `no drive pictures: the drive didn't run (${driveDir} holds no trajectory)` }
	const dir = join(outDir, "drive")
	try {
		const { stdout } = await exec(python, [join(root, "py", "drive_pictures.py"), chassisDir, driveDir, dir], { timeout: 600_000 })
		const files = stdout.split(/\r?\n/).map((f) => f.trim()).filter((f) => /\.(png|gif)$/.test(f)).map((f) => `drive/${f}`)
		// Which drive they show (the newest when they were made): Studio's Drive tab and the report label them by it.
		const revision = Number(/rev-(\d+)$/.exec(driveDir.replace(/[\\/]+$/, ""))?.[1]) || null
		writeFileSync(join(dir, DRIVE_PICTURES_FILE), JSON.stringify({ revision, files: files.map((f) => f.replace(/^drive\//, "")), at: new Date().toISOString() }, null, "\t"))
		log(`drive pictures: ${files.length} in ${dir}`)
		return { files, note: null }
	} catch (e) {
		return { files: [], note: `no drive pictures: py/drive_pictures.py stopped: ${String((e as { stderr?: string }).stderr || e).trim().split("\n").pop()}` }
	}
}

// The arm's simulated pick-and-place (py/arm_pictures.py): the arm's posed parts moved to each recorded set of joint
// angles with py/arm.py's own kinematics, the cup and the cube: three key frames (pick, carry, drop), every landing from
// above and a GIF of the first cycle. Files under armsim/ in outDir.
export async function armSimPictures(python: string, root: string, posedDir: string, simDir: string, outDir: string, log: (m: string) => void = () => {}): Promise<AssemblyPictures> {
	if (!existsSync(join(posedDir, "groups.json"))) return { files: [], note: `no pick-and-place pictures: ${posedDir} holds no posed arm` }
	if (!existsSync(join(simDir, "trajectory.json"))) return { files: [], note: `no pick-and-place pictures: ${simDir} holds no trajectory (the simulation didn't run, or ran before trajectories were recorded)` }
	const dir = join(outDir, "armsim")
	try {
		const { stdout } = await exec(python, [join(root, "py", "arm_pictures.py"), posedDir, simDir, dir], { timeout: 600_000 })
		const files = stdout.split(/\r?\n/).map((f) => f.trim()).filter((f) => /\.(png|gif)$/.test(f)).map((f) => `armsim/${f}`)
		log(`pick-and-place pictures: ${files.length} in ${dir}`)
		return { files, note: null }
	} catch (e) {
		return { files: [], note: `no pick-and-place pictures: py/arm_pictures.py stopped: ${String((e as { stderr?: string }).stderr || e).trim().split("\n").pop()}` }
	}
}

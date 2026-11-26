// A tool's failure in words a person can act on, when its raw error is a known machine problem rather than the
// design's (setup streamlining, 26 Nov 2026). null: the raw error stands.
export function explainToolError(text: string): string | null {
	// build123d's CAD kernel (OCP) loads the system's OpenGL library; a minimal Linux (a server, a container) has none.
	if (/libGL\.so\.1/.test(text)) return "the CAD kernel (build123d) can't load: this machine lacks the system's OpenGL library (libGL.so.1). On Debian or Ubuntu: sudo apt install libgl1 (a desktop has it already); or install Docker, and Bringup builds in its toolchain image"
	return null
}

// The assembly order's steps, as groups of the rover's parts (src/package/build.ts assemblyOrder): a build package draws
// the rover up to a step and once exploded. Plain ES module: the engine's package pictures and the page's 3D view
// (world3d.js, which loads it from /geometry/assembly-steps.js) share it.
export const ASSEMBLY_STEPS = ["plate", "motors", "wheels", "board", "battery", "sensor", "top"]

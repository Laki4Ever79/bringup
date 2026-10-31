import {defineConfig} from 'vite';
import motionCanvasPlugin from '@motion-canvas/vite-plugin';
import ffmpegPlugin from '@motion-canvas/ffmpeg';

// Both packages ship CommonJS; unwrap the default export under "type": "module".
const unwrap = <T,>(m: T): T => ((m as {default?: T}).default ?? m);

export default defineConfig({
  plugins: [unwrap(motionCanvasPlugin)(), unwrap(ffmpegPlugin)()],
});

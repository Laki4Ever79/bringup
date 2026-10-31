import {makeProject} from '@motion-canvas/core';
import './fonts.css';

import problem from './scenes/b1-problem?scene';
import title from './scenes/b2-title?scene';
import firstDesign from './scenes/b3-first-design?scene';
import change from './scenes/b4-change?scene';
import realModels from './scenes/b7-real-models?scene';
import proof from './scenes/b8-proof?scene';
import board from './scenes/b9-board?scene';
import end from './scenes/b10-end?scene';

export default makeProject({
  scenes: [problem, title, firstDesign, change, realModels, proof, board, end],
});

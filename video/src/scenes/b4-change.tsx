// Beats 4–6 (0:50–1:45): "make it 40 mm wide" → one field → only the affected agents wake → red, then green.
import {Node, makeScene2D} from '@motion-canvas/2d';
import {all, chain, createRef, waitFor} from '@motion-canvas/core';
import {FULL, caption, fontsReady, footage, tag} from '../lib';

// Source pixels in the 1920×1080 dashboard recording (see act-3.png in ../wt-board/out/footage).
const COMPOSER = {x: 640, y: 120, zoom: 1.6};
const FIELDS = {x: 520, y: 250, zoom: 1.9};
const AGENTS = {x: 1015, y: 270, zoom: 1.75};
const OVERVIEW = {x: 760, y: 380, zoom: 1.25};
const RESULT = {x: 470, y: 440, zoom: 1.7};
const MOVED = {x: 1110, y: 760, zoom: 1.5};
const WHY = {x: 1580, y: 200, zoom: 1.7};

export default makeScene2D(function* (view) {
  yield* fontsReady();
  const stage = createRef<Node>();
  view.add(<Node ref={stage} />);
  const t = tag(view, 'SCRIPTED AGENTS · REAL TOOLS');
  const c4 = caption(view, 'Change one thing.');
  const c5 = caption(view, 'Only the affected agents wake, and they work at the same time.', 'WAITING CUT · THE CLOCK ON SCREEN IS REAL');
  const c6 = caption(view, 'Consistent again. Nobody coordinated by hand.');
  yield* t().opacity(1, 0.3);

  // Beat 4: typing the change; the one field it touched.
  yield* all(
    footage(stage(), '/a3_type.mp4', 7, [{at: 4.6, to: FIELDS, dur: 1}], COMPOSER),
    chain(waitFor(1.5), c4.in(), waitFor(5), c4.out()),
  );

  // Beat 5: four agents work, the rest stay dimmed; the checks go red.
  yield* all(
    footage(stage(), '/a3_ripple.mp4', 14, [{at: 1.5, to: AGENTS, dur: 1}, {at: 9, to: OVERVIEW, dur: 1.2}], FIELDS),
    chain(waitFor(2.5), c5.in(), waitFor(9), c5.out()),
  );

  // Beat 6: consistent again (the result line held), what moved, and why.
  yield* all(
    footage(stage(), '/a3_settle.mp4', 12, [{at: 3.5, to: RESULT, dur: 1}], OVERVIEW),
    chain(waitFor(6), c6.in(), waitFor(5), c6.out()),
  );
  yield* footage(stage(), '/a3_moved.mp4', 12, [{at: 1, to: MOVED, dur: 1}, {at: 8.5, to: WHY, dur: 1}], FULL);
});

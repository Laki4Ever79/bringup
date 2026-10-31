// Beats 4–6 (0:50–1:45): "make it 40 mm wide" → one field → only the affected agents wake → red, then green.
// The ripple plays in real time with no cuts (act-3 0:21–0:58: typed → consistent again in 31 s).
import {Node, makeScene2D} from '@motion-canvas/2d';
import {all, chain, createRef, waitFor} from '@motion-canvas/core';
import {sceneClock, FULL, caption, fontsReady, footage, tag} from '../lib';

// Source pixels in the 1920×1080 dashboard recording (31 Oct re-recording; see act-3 at 0:30).
const COMPOSER = {x: 700, y: 330, zoom: 1.6};
const FIELDS = {x: 565, y: 300, zoom: 1.7};
const AGENTS = {x: 1240, y: 300, zoom: 1.7};
const RESULT = {x: 700, y: 390, zoom: 1.4};
const BOARD = {x: 960, y: 790, zoom: 1.35}; // the PCB with its rulers and the 3D case
const WHY = {x: 1580, y: 300, zoom: 1.7};

export default makeScene2D(function* (view) {
  const clock = sceneClock('b4-change');
  yield* fontsReady();
  const stage = createRef<Node>();
  view.add(<Node ref={stage} />);
  const t = tag(view, 'SCRIPTED AGENTS · REAL TOOLS');
  const c4 = caption(view, 'Change one thing.');
  const c5 = caption(view, 'Only the affected agents wake, and they work at the same time.', 'REAL TIME · NO CUTS');
  const c5b = caption(view, 'The checks go red, then the builders catch up.', 'REAL TIME · NO CUTS');
  const c6 = caption(view, 'Consistent again. Nobody coordinated by hand.');
  yield* t().opacity(1, 0.3);

  // Beat 4: typing the change.
  yield* all(
    footage(stage(), '/a3_type.mp4', 4, [], COMPOSER),
    chain(waitFor(1), c4.in()),
  );

  // Beats 5–6: the outline field changes; four agents work, the rest stay dimmed; Consistency goes FAILED (about 9 s
  // in), then green at about 30 s; the result line holds.
  yield* all(
    footage(stage(), '/a3_ripple.mp4', 37, [
      {at: 0, to: FIELDS, dur: 0.8},
      {at: 3.5, to: AGENTS, dur: 1},
      {at: 28, to: RESULT, dur: 1},
    ]),
    chain(c4.out(), waitFor(3.5), c5.in(), waitFor(4.5), c5.out(), c5b.in(), waitFor(18), c5b.out(), waitFor(2), c6.in()),
  );

  // What moved (50 → 40 mm), then "What changed & why".
  yield* all(
    footage(stage(), '/a3_moved.mp4', 13, [{at: 0.5, to: BOARD, dur: 1}, {at: 7, to: WHY, dur: 1}], FULL),
    chain(waitFor(5), c6.out()),
  );
  yield* clock.end();
});

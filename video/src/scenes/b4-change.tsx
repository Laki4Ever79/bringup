// Beats 4–6: "add a temperature/humidity sensor" → parts, pins, requirements → 7 of 9 agents wake → 9 conflicts
// (incl. the case vent) → consistent in 3 min 15 s. The wait is cut and labelled; the dashboard's clock stays real.
// FOOTAGE TIMINGS: re-set from 7a's re-recorded act-3 (beacon brief) before rendering.
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
  const c4 = caption(view, 'Change “one thing”: add a sensor.');
  const c5 = caption(view, 'Only the affected agents wake, and they work at the same time.');
  const c5b = caption(view, '9 conflicts caught, even: the case has no vent over the sensor.', 'WAITING CUT · THE CLOCK ON SCREEN IS REAL');
  const c6 = caption(view, 'Board, case and firmware agree. The case grew a vent.');
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

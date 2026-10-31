// Beats 4–6: "add a temperature/humidity sensor" → requirements, parts, pins → 7 of 9 agents wake → mismatches,
// the case cuts its vent → "board, case and firmware agree" in 3 min 15 s. The long middle of the real ripple is
// cut and labelled; the dashboard's own clock stays real. Footage: the final act-3 (frozen design, real tools).
import {Node, makeScene2D} from '@motion-canvas/2d';
import {all, chain, createRef, waitFor} from '@motion-canvas/core';
import {sceneClock, caption, fontsReady, footage, tag} from '../lib';

// Source pixels in the 1920×1080 recording (see act-3 at 0:25).
const COMPOSER = {x: 640, y: 360, zoom: 1.5}; // the composer, the change and its fields
const FIELDS_AGENTS = {x: 640, y: 330, zoom: 1.5}; // the change, its fields, the agents
const AGENTS_TIMELINE = {x: 1340, y: 330, zoom: 1.6}; // the agents and the timeline of mismatches
const CASE3D = {x: 1545, y: 770, zoom: 2.0}; // the 3D case: the vent
const RESULT = {x: 760, y: 420, zoom: 1.35}; // the banner over the board
const PCB = {x: 600, y: 790, zoom: 1.6}; // the PCB: U2 NEW, U1 CHANGED

export default makeScene2D(function* (view) {
  const clock = sceneClock('b4-change');
  yield* fontsReady();
  const stage = createRef<Node>();
  view.add(<Node ref={stage} />);
  const t = tag(view, 'SCRIPTED AGENTS · REAL TOOLS');
  const c4 = caption(view, 'Change “one thing”: add a sensor.');
  const c5 = caption(view, 'Only the affected agents wake, and they work at the same time.');
  const c5b = caption(view, '9 mismatches caught. The case cuts a vent over the sensor.');
  const cut = caption(view, '3 minutes of real board, case and firmware builds, cut.', 'WAITING CUT · THE CLOCK ON SCREEN IS REAL');
  const c6 = caption(view, 'Board, case and firmware agree. The case grew a vent.');
  yield* t().opacity(1, 0.3);

  // Beat 4: typing the change.
  yield* all(footage(stage(), '/a3_type.mp4', 5, [], COMPOSER), chain(waitFor(0.8), c4.in()));

  // Beat 5: the fields change, 7 of 9 agents wake, mismatches pile up, the case rebuilds with its vent (+12 s).
  yield* all(
    footage(stage(), '/a3_rip_a.mp4', 20, [
      {at: 0, to: FIELDS_AGENTS, dur: 0.8},
      {at: 5, to: AGENTS_TIMELINE, dur: 1},
      {at: 13, to: CASE3D, dur: 1},
    ]),
    chain(c4.out(), waitFor(1.5), c5.in(), waitFor(9), c5.out(), c5b.in(), waitFor(8), c5b.out()),
  );

  // The cut, then the banner at 3:41 (the dashboard's clock shows the real time).
  yield* all(
    footage(stage(), '/a3_rip_b.mp4', 14, [{at: 3.5, to: RESULT, dur: 1}]),
    chain(cut.in(), waitFor(3.5), cut.out(), waitFor(1.5), c6.in()),
  );

  // Beat 6: the reveal: the vent on the case, the new sensor on the board.
  yield* footage(stage(), '/a3_case.mp4', 9, [], CASE3D);
  yield* all(footage(stage(), '/a3_pcb.mp4', 9, [], PCB), chain(waitFor(6), c6.out()));
  yield* clock.end();
});

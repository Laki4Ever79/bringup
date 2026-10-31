// Beat 3 (0:22–0:50): one brief in, nine participants at once, the design settles; what a run hands you.
import {Node, Rect, Txt, makeScene2D} from '@motion-canvas/2d';
import {all, chain, createRef, sequence, waitFor} from '@motion-canvas/core';
import {sceneClock, C, F, FULL, caption, fontsReady, footage, tag} from '../lib';

// Source pixels in the 1920×1080 dashboard recording.
const AGENTS = {x: 1240, y: 300, zoom: 1.7};
const RESULT = {x: 700, y: 390, zoom: 1.4};

export default makeScene2D(function* (view) {
  const clock = sceneClock('b3-first-design');
  yield* fontsReady();
  const stage = createRef<Node>();
  view.add(<Node ref={stage} />);
  const t = tag(view, 'SCRIPTED AGENTS · REAL TOOLS');
  const cap = caption(view, 'One brief in. 9 agents at once, one shared design contract.');

  yield* t().opacity(1, 0.3);
  yield* all(
    chain(
      footage(stage(), '/a2_start.mp4', 10, [{at: 2, to: AGENTS, dur: 1.2}], FULL),
      // (cut: the first design keeps building; the board appears)
      footage(stage(), '/a2_board.mp4', 5),
      footage(stage(), '/a2_settle.mp4', 5, [{at: 2.2, to: RESULT, dur: 1}]),
    ),
    chain(waitFor(3), cap.in(), waitFor(9), cap.out()),
  );

  // What one run hands you (README "What one run hands you").
  const card = createRef<Rect>();
  view.add(
    <Rect ref={card} layout direction="column" gap={18} fill={C.paper} stroke={C.ink} lineWidth={4} padding={[40, 60]} y={-60} opacity={0}>
      <Txt text="WHAT ONE RUN HANDS YOU" fontFamily={F.mono} fontWeight={700} fontSize={26} fill={C.ink3} letterSpacing={3} />
      {[
        ['case.stl  lid.stl', 'a printable case whose holes match the board'],
        ['fab/gerbers.zip  bom.csv  cpl.csv', 'a JLCPCB fab package, every part in stock'],
        ['firmware rev N', 'compiled for the real pin map, booted in QEMU'],
        ['SPICE', 'each power rail simulated under load'],
      ].map(([a, b]) => (
        <Rect layout direction="column" gap={2} opacity={0}>
          <Txt text={a} fontFamily={F.mono} fontWeight={700} fontSize={34} fill={C.ink} />
          <Txt text={b} fontFamily={F.sans} fontSize={28} fill={C.ink2} />
        </Rect>
      ))}
    </Rect>,
  );
  yield* card().opacity(1, 0.4);
  yield* sequence(0.35, ...card().children().slice(1).map(c => c.opacity(1, 0.3)));
  yield* clock.end();
});

// Beat 8 (2:10–2:35): the A/B experiment (docs/experiment.md): 6 changes, 0 violations vs 16 mismatches shipped.
import {Node, Rect, Txt, makeScene2D} from '@motion-canvas/2d';
import {all, createRef, createSignal, easeOutCubic, waitFor} from '@motion-canvas/core';
import {sceneClock, C, F, caption, fontsReady, footage, tag} from '../lib';

const J1 = {x: 960, y: 540, zoom: 1}; // act-4 already closes in on the J1 line by itself

export default makeScene2D(function* (view) {
  view.fill(C.paper);
  const clock = sceneClock('b8-proof');
  yield* fontsReady();
  const card = createRef<Rect>();
  const n = createSignal(0);
  view.add(
    <Rect ref={card} layout direction="column" alignItems="center" gap={30} y={-40}>
      <Txt text="6 CHANGES, APPLIED TWICE" fontFamily={F.mono} fontWeight={700} fontSize={34} fill={C.ink3} letterSpacing={4} />
      <Rect layout gap={160}>
        <Rect layout direction="column" alignItems="center">
          <Txt text="0" fontFamily={F.display} fontWeight={900} fontSize={300} fill={C.ok} />
          <Txt text={'violations\nshared contract'} textAlign="center" fontFamily={F.sans} fontWeight={600} fontSize={38} fill={C.ink2} />
        </Rect>
        <Rect layout direction="column" alignItems="center">
          <Txt text={() => Math.round(n()).toString()} fontFamily={F.display} fontWeight={900} fontSize={300} fill={C.error} />
          <Txt text={'mismatches shipped\neach team on its own copy'} textAlign="center" fontFamily={F.sans} fontWeight={600} fontSize={38} fill={C.ink2} />
        </Rect>
      </Rect>
      <Txt text="scripted agents · real tools · docs/experiment.md" fontFamily={F.mono} fontSize={24} fill={C.ink3} />
    </Rect>,
  );
  const cap = caption(view, '0 violations vs 16 mismatches shipped.');
  yield* n(16, 2.2, easeOutCubic);
  yield* cap.in();
  yield* waitFor(7);
  yield* all(cap.out(), card().opacity(0, 0.4));

  // One of the 16, on the dashboard's evidence band.
  const stage = createRef<Node>();
  view.add(<Node ref={stage} />);
  const t = tag(view, 'ONE OF THE 16');
  const c2 = caption(view, 'Like a USB port that no longer meets its hole.');
  yield* t().opacity(1, 0.3);
  yield* all(footage(stage(), '/a4_proof.mp4', 10.8, [], J1), c2.in());
  yield* c2.out();
  yield* clock.end();
});

// Beat 7 (1:45–2:10): with real models. Every number is from docs/runs/real-20/ripples.json (req-1).
import {Rect, Txt, makeScene2D} from '@motion-canvas/2d';
import {all, createRef, sequence, waitFor} from '@motion-canvas/core';
import {sceneClock, C, F, caption, fontsReady, tag} from '../lib';

export default makeScene2D(function* (view) {
  view.fill(C.paper);
  const clock = sceneClock('b7-real-models');
  yield* fontsReady();
  const t = tag(view, 'REAL MODELS · RUN 20', C.ok);
  const cap = caption(view, 'With real models, too.');

  const req = createRef<Txt>();
  const rows = createRef<Rect>();
  view.add(
    <Txt ref={req} text={'“Our temperature/humidity sensor is out of stock;\nswitch to the other one.”'} fontFamily={F.display} fontWeight={800} fontSize={72} lineHeight={82} textAlign="center" fill={C.ink} y={-260} opacity={0} />,
  );
  const line = (mark: string, color: string, text: string) => (
    <Rect layout gap={22} alignItems="center" opacity={0}>
      <Txt text={mark} fontFamily={F.mono} fontWeight={800} fontSize={46} fill={color} />
      <Txt text={text} fontFamily={F.sans} fontWeight={600} fontSize={42} fill={C.ink} />
    </Rect>
  );
  view.add(
    <Rect ref={rows} layout direction="column" gap={22} y={40}>
      {line('✗', C.error, 'caught: the firmware was still built for the old sensor')}
      {line('✗', C.error, 'caught: the board still placed the old part')}
      {line('✓', C.ok, 'cleared: consistent again in 75 s')}
      {line('·', C.ink3, '5 of 9 agents woke; the case stayed idle (nothing physical changed)')}
    </Rect>,
  );

  yield* t().opacity(1, 0.3);
  yield* req().opacity(1, 0.6);
  yield* waitFor(1.5);
  yield* sequence(1.6, ...rows().children().map(c => c.opacity(1, 0.4)));
  yield* waitFor(1);
  yield* cap.in();
  yield* waitFor(8);
  yield* all(cap.out(), rows().opacity(0.0, 0.3), req().opacity(0, 0.3));
  yield* clock.end();
});

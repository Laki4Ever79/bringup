// Beat 2 (0:15–0:22): the title and the one line.
import {Rect, Txt, makeScene2D} from '@motion-canvas/2d';
import {all, createRef, waitFor} from '@motion-canvas/core';
import {sceneClock, C, F, fontsReady} from '../lib';

export default makeScene2D(function* (view) {
  view.fill(C.ink);
  const clock = sceneClock('b2-title');
  yield* fontsReady();
  const title = createRef<Txt>();
  const line = createRef<Txt>();
  const bar = createRef<Rect>();
  view.add(<Rect ref={bar} width={0} height={14} fill={C.signal} y={-150} />);
  view.add(<Txt ref={title} text="BRINGUP" fontFamily={F.display} fontWeight={900} fontSize={220} fill={C.paper} y={-30} opacity={0} letterSpacing={6} />);
  view.add(
    <Txt
      ref={line}
      text={'Change “one thing”, and the whole hardware design follows:\nboard, case, firmware and parts, in parallel.\nEven designing from scratch is just the first change.'}
      fontFamily={F.sans}
      fontWeight={600}
      fontSize={46}
      lineHeight={66}
      textAlign="center"
      fill={C.rule}
      y={170}
      opacity={0}
    />,
  );
  yield* all(bar().width(420, 0.6), title().opacity(1, 0.6));
  yield* line().opacity(1, 0.8);
  yield* clock.end();
});

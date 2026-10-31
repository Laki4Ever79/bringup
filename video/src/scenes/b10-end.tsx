// Beat 10 (2:55–3:00): the end card.
import {Rect, Txt, makeScene2D} from '@motion-canvas/2d';
import {all, createRef, waitFor} from '@motion-canvas/core';
import {C, F, fontsReady} from '../lib';

export default makeScene2D(function* (view) {
  view.fill(C.ink);
  yield* fontsReady();
  const a = createRef<Txt>();
  const b = createRef<Txt>();
  view.add(<Rect width={420} height={14} fill={C.signal} y={-170} />);
  view.add(<Txt ref={a} text={'Change one thing.\nThe whole design follows.'} textAlign="center" fontFamily={F.display} fontWeight={900} fontSize={120} lineHeight={130} fill={C.paper} y={-30} opacity={0} />);
  view.add(<Txt ref={b} text="github.com/Laki4Ever79/bringup  ·  built on Mozaik" fontFamily={F.mono} fontSize={36} fill={C.rule} y={170} opacity={0} />);
  yield* all(a().opacity(1, 0.5), b().opacity(1, 0.8));
  yield* waitFor(4.2);
});

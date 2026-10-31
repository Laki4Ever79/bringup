// Beat 1 (0:00–0:14): add one sensor, and the parts list, the board and the firmware all have to change.
// An illustration, labelled so.
import {Line, Rect, Txt, makeScene2D} from '@motion-canvas/2d';
import {all, createRef, easeOutBack, sequence, waitFor} from '@motion-canvas/core';
import {sceneClock, C, F, caption, fontsReady, tag} from '../lib';

export default makeScene2D(function* (view) {
  view.fill(C.paper);
  const clock = sceneClock('b1-problem');
  yield* fontsReady();

  const sensor = createRef<Rect>();
  const wires = [createRef<Line>(), createRef<Line>()];
  const q = createRef<Txt>();
  const teams = createRef<Rect>();

  // The board and its chip.
  view.add(<Rect width={900} height={440} y={-90} fill="#1d4a35" radius={22} />);
  view.add(
    <Rect width={250} height={200} x={-220} y={-90} fill="#e9c46a" radius={12}>
      <Txt text="CHIP" fontFamily={F.display} fontWeight={800} fontSize={64} fill="#1d4a35" />
    </Rect>,
  );
  // The new sensor drops in; its wires and its code don't exist yet.
  view.add(
    <Rect ref={sensor} width={170} height={140} x={250} y={-90} stroke={C.signal} lineWidth={7} lineDash={[16, 10]} radius={12} scale={0}>
      <Txt text="SENSOR" fontFamily={F.display} fontWeight={800} fontSize={42} fill={C.signal} />
    </Rect>,
  );
  wires.forEach((w, i) =>
    view.add(<Line ref={w} points={[[-95, -125 + i * 70], [165, -125 + i * 70]]} stroke={C.signal} lineWidth={6} lineDash={[12, 10]} end={0} />),
  );
  view.add(<Txt ref={q} text="which pins? in stock? which driver?" fontFamily={F.mono} fontSize={30} fill={C.paper} y={70} opacity={0} />);

  const label = tag(view, 'ILLUSTRATION', C.ink3);
  const cap = caption(view, 'Add one sensor. Every part of the design has to change.');
  view.add(
    <Rect ref={teams} layout gap={28} y={265} opacity={0}>
      {['PARTS: in stock', 'BOARD: wire it in', 'FIRMWARE: a driver', 'CASE: vents over it'].map(t => (
        <Rect layout fill={C.paper2} stroke={C.signal} lineWidth={3} padding={[12, 22]}>
          <Txt text={t} fontFamily={F.mono} fontWeight={700} fontSize={28} fill={C.ink} />
        </Rect>
      ))}
    </Rect>,
  );

  yield* label().opacity(1, 0.3);
  yield* waitFor(0.8);
  yield* sensor().scale(1, 0.7, easeOutBack);
  yield* all(...wires.map(w => w().end(1, 0.9)), q().opacity(1, 0.6));
  yield* cap.in();
  yield* waitFor(1);
  yield* teams().opacity(1, 0.5);
  yield* sequence(0.15, ...teams().children().map(c => (c as Rect).fill('#fbe1d7', 0.3)));
  yield* clock.end();
});

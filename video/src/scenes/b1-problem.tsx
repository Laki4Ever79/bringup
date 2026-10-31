// Beat 1 (0:00–0:15): a USB-C port moves 5 mm and no longer meets its hole in the case. An illustration, labelled so.
import {Rect, Txt, makeScene2D, Line} from '@motion-canvas/2d';
import {all, createRef, easeInOutCubic, sequence, waitFor} from '@motion-canvas/core';
import {sceneClock, C, F, caption, fontsReady, tag} from '../lib';

export default makeScene2D(function* (view) {
  view.fill(C.paper);
  const clock = sceneClock('b1-problem');
  yield* fontsReady();

  const board = createRef<Rect>();
  const port = createRef<Rect>();
  const hole = createRef<Rect>();
  const mm = createRef<Txt>();
  const teams = createRef<Rect>();

  // The case: a thick outline; the hole is a gap in its left wall.
  view.add(
    <Rect width={900} height={520} y={-60} stroke={C.ink} lineWidth={18} radius={28} />,
  );
  view.add(
    <Rect ref={hole} width={34} height={110} x={-450} y={-120} fill={C.paper} stroke={C.ink2} lineWidth={3} lineDash={[10, 8]} />,
  );
  view.add(<Txt text="CASE" fontFamily={F.mono} fontSize={26} fill={C.ink3} x={0} y={-290} letterSpacing={4} />);
  view.add(
    <Rect ref={board} width={780} height={400} y={-60} fill="#1d4a35" radius={12} stroke="#0f2f21" lineWidth={4}>
      <Txt text="BOARD" fontFamily={F.mono} fontSize={26} fill="#9fd3b8" letterSpacing={4} />
    </Rect>,
  );
  view.add(<Rect ref={port} width={90} height={84} x={-400} y={-120} fill="#b9b4a8" stroke={C.ink} lineWidth={4} radius={10} />);
  view.add(
    <Txt ref={mm} text="5 mm" fontFamily={F.display} fontWeight={800} fontSize={56} fill={C.signal} x={-560} y={-60} opacity={0} />,
  );

  const label = tag(view, 'ILLUSTRATION', C.ink3);
  const cap = caption(view, 'Move a connector 5 mm. Three teams have work to do.');

  view.add(
    <Rect ref={teams} layout gap={28} x={0} y={300} opacity={0}>
      {['BOARD: re-route', 'CASE: move the hole', 'FIRMWARE: check the pins'].map(t => (
        <Rect layout fill={C.paper2} stroke={C.signal} lineWidth={3} padding={[12, 22]}>
          <Txt text={t} fontFamily={F.mono} fontWeight={700} fontSize={28} fill={C.ink} />
        </Rect>
      ))}
    </Rect>,
  );

  yield* label().opacity(1, 0.3);
  yield* waitFor(1.2);
  // The board (and its port) slides down 5 mm; the case and its hole stay put.
  yield* all(
    board().y(-60 + 80, 1.6, easeInOutCubic),
    port().y(-120 + 80, 1.6, easeInOutCubic),
    mm().opacity(1, 0.6),
  );
  yield* all(hole().stroke(C.error, 0.4), hole().lineWidth(6, 0.4), port().stroke(C.error, 0.4));
  view.add(
    <Line points={[[-450, -120], [-400, -40]]} stroke={C.error} lineWidth={4} lineDash={[8, 8]} endArrow arrowSize={16} />,
  );
  yield* cap.in();
  yield* waitFor(1.5);
  yield* teams().opacity(1, 0.5);
  yield* sequence(0.15, ...teams().children().map(c => (c as Rect).fill('#fbe1d7', 0.3)));
  yield* clock.end();
});

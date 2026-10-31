// Beat 9 (2:35–2:55): the real board. Needs a phone clip at public/board.mp4 (see docs/video.md, beat 9).
// Until it exists, a placeholder card says so; it must never ship in the final render.
import {Node, Rect, Txt, makeScene2D} from '@motion-canvas/2d';
import {all, chain, createRef, waitFor} from '@motion-canvas/core';
import {C, F, caption, fontsReady, footage, tag} from '../lib';

export const HAVE_BOARD_CLIP = false;
const BOARD_SECONDS = 20;

export default makeScene2D(function* (view) {
  yield* fontsReady();
  const stage = createRef<Node>();
  view.add(<Node ref={stage} />);
  const t = tag(view, 'ESP32-S3 DEV BOARD, STANDING IN FOR THE DESIGN’S C3', C.ink);
  const cap = caption(view, 'And it reaches the real board.');
  const result = createRef<Rect>();
  view.add(
    <Rect ref={result} layout direction="column" alignItems="end" fill={C.ink} padding={[18, 28]} x={960 - 40} y={-540 + 120} offset={[1, -1]} opacity={0}>
      <Txt text="TILTED: 244 ms" fontFamily={F.display} fontWeight={900} fontSize={72} fill={C.okBright} />
      <Txt text="measured on the board · the design asked for 250 ms" fontFamily={F.mono} fontSize={22} fill={C.rule} />
    </Rect>,
  );

  yield* t().opacity(1, 0.3);
  const clip = HAVE_BOARD_CLIP
    ? footage(stage(), '/board.mp4', BOARD_SECONDS)
    : (function* () {
        view.fill(C.paper2);
        stage().add(
          <Txt text={'[ phone clip of the real board goes here ]\nslow blink → type “blink faster when tilted” → reflash → tilt → fast blink'} textAlign="center" fontFamily={F.mono} fontSize={30} fill={C.ink2} />,
        );
        yield* waitFor(BOARD_SECONDS);
      })();
  yield* all(clip, chain(waitFor(2), cap.in(), waitFor(6), cap.out(), waitFor(5), result().opacity(1, 0.4)));
});

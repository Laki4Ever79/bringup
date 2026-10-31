// Beat 9 (2:35–2:55): the real board. With a phone clip at public/board.mp4 (docs/video.md, beat 9), set
// HAVE_BOARD_CLIP. Until then an illustration, labelled so, plays the bench run with its measured numbers
// (docs/submission.md, "The real board"): 1000 ms blink → "blink faster when tilted" → rev 8 flashed in 16 s → 244 ms.
import {Circle, Line, Node, Rect, Txt, makeScene2D} from '@motion-canvas/2d';
import {all, chain, createRef, createSignal, easeInOutCubic, waitFor} from '@motion-canvas/core';
import {sceneClock, C, F, caption, fontsReady, footage, tag} from '../lib';

export const HAVE_BOARD_CLIP = false;
const BOARD_SECONDS = 19.5;
const LED_GREEN = '#3fcf86';
const LED_RED = '#ff3b2f';
const LED_OFF = '#2a3a5a';

export default makeScene2D(function* (view) {
  const clock = sceneClock('b9-board');
  yield* fontsReady();
  const stage = createRef<Node>();
  view.add(<Node ref={stage} />);
  const t = HAVE_BOARD_CLIP
    ? tag(view, 'ESP32-S3 DEV BOARD, STANDING IN FOR THE DESIGN’S C3', C.ink)
    : tag(view, 'ILLUSTRATION · NUMBERS FROM THE BENCH RUN · S3 STANDING IN FOR THE C3', C.ink3);
  const cap = caption(view, 'And it reaches the real board.');
  const result = createRef<Rect>();
  view.add(
    <Rect ref={result} layout direction="column" alignItems="end" fill={C.ink} padding={[18, 28]} x={960 - 40} y={-540 + 120} offset={[1, -1]} opacity={0}>
      <Txt text="TILTED: 244 ms" fontFamily={F.display} fontWeight={900} fontSize={72} fill={C.okBright} />
      <Txt text="measured on the board · the design asked for 250 ms" fontFamily={F.mono} fontSize={22} fill={C.rule} />
    </Rect>,
  );

  yield* t().opacity(1, 0.3);
  if (HAVE_BOARD_CLIP) {
    yield* all(footage(stage(), '/board.mp4', BOARD_SECONDS), chain(waitFor(2), cap.in(), waitFor(6), cap.out(), waitFor(5), result().opacity(1, 0.4)));
    yield* clock.end();
    return;
  }

  view.fill(C.paper);
  const board = createRef<Node>();
  const led = createRef<Circle>();
  const glow = createRef<Circle>();
  const readout = createRef<Txt>();
  const prompt = createRef<Txt>();
  const promptBox = createRef<Rect>();
  const flash = createRef<Rect>();
  const flashTxt = createRef<Txt>();
  const bar = createSignal(0);

  // The dev board from above: USB-C on the left, the S3 module's can, the RGB LED.
  stage().add(
    <Node ref={board} x={-400} y={-40}>
      <Rect width={620} height={250} fill="#1b2a4a" radius={16} stroke="#0f1830" lineWidth={4} />
      <Rect x={-322} width={46} height={90} fill="#b9bcc2" radius={10} stroke="#8a8e96" lineWidth={3} />
      <Rect x={60} width={300} height={190} fill="#c9ccd2" radius={8} stroke="#9a9ea6" lineWidth={3}>
        <Txt text="ESP32-S3" fontFamily={F.mono} fontWeight={700} fontSize={34} fill="#4b4f57" />
      </Rect>
      {[-1, 1].map(s => (
        <Line points={[[-280, s * 112], [280, s * 112]]} stroke="#e9c46a" lineWidth={10} lineDash={[8, 14]} />
      ))}
      <Circle ref={glow} x={-200} y={-50} size={90} fill={LED_GREEN} opacity={0} />
      <Circle ref={led} x={-200} y={-50} size={34} fill={LED_OFF} stroke="#0f1830" lineWidth={3} />
      <Txt text="LED" x={-200} y={0} fontFamily={F.mono} fontSize={20} fill="#8fa3c8" />
    </Node>,
  );
  stage().add(<Txt ref={readout} x={-400} y={250} text="blink: 1000 ms · measured" fontFamily={F.mono} fontWeight={700} fontSize={32} fill={C.ink2} />);

  // The change, typed in plain words, then the rebuild and the flash.
  stage().add(
    <Rect ref={promptBox} layout direction="column" gap={22} x={430} y={-40} width={720} fill={C.ink} padding={[30, 36]} opacity={0}>
      <Txt text="CHANGE REQUEST" fontFamily={F.mono} fontWeight={700} fontSize={22} fill={C.rule} letterSpacing={3} />
      <Txt ref={prompt} text=" " fontFamily={F.mono} fontSize={40} fill={C.paper} />
      <Rect ref={flash} layout direction="column" gap={12} opacity={0}>
        <Txt text="firmware: behaviour field → rebuild → reflash" fontFamily={F.mono} fontSize={24} fill={C.rule} />
        <Rect layout width={648} height={22} fill="#2c2920" radius={4}>
          <Rect width={() => 648 * bar()} height={22} fill={C.signal} radius={4} />
        </Rect>
        <Txt ref={flashTxt} text="flashing rev 8 …" fontFamily={F.mono} fontSize={24} fill={C.rule} />
      </Rect>
    </Rect>,
  );

  // The LED on its own thread: green at 1000 ms until tilted, then red at the measured 244 ms.
  let period = 1.0;
  let color = LED_GREEN;
  let done = false;
  function* blinker() {
    while (!done) {
      led().fill(color);
      glow().fill(color);
      glow().opacity(0.35);
      yield* waitFor(period / 2);
      led().fill(LED_OFF);
      glow().opacity(0);
      yield* waitFor(period / 2);
    }
  }
  function* type(text: string, seconds: number) {
    for (let i = 1; i <= text.length; i++) {
      prompt().text(text.slice(0, i));
      yield* waitFor(seconds / text.length);
    }
  }
  function* story() {
    yield* waitFor(1.5);
    yield* cap.in();
    yield* waitFor(2.5);
    yield* cap.out();
    yield* promptBox().opacity(1, 0.4);
    yield* type('blink faster when tilted', 1.8);
    yield* waitFor(0.4);
    yield* flash().opacity(1, 0.3);
    yield* bar(1, 2.6, easeInOutCubic);
    flashTxt().text('rev 8 flashed in 16 s (sped up here) · booted');
    flashTxt().fill(C.okBright);
    yield* waitFor(1.2);
    yield* board().rotation(-22, 0.6, easeInOutCubic);
    period = 0.244;
    color = LED_RED;
    readout().text('tilted · blink: 244 ms · measured');
    readout().fill(C.error);
    yield* waitFor(1.2);
    yield* result().opacity(1, 0.4);
    yield* waitFor(5);
    done = true;
  }

  yield* all(blinker(), story());
  yield* clock.end();
});

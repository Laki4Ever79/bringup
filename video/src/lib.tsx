import {Node, Rect, Txt, Video, View2D} from '@motion-canvas/2d';
import {all, createRef, easeInOutCubic, ThreadGenerator, waitFor} from '@motion-canvas/core';

// The dashboard's palette (src/dashboard/page.html), so cards and footage look like one thing.
export const C = {
  paper: '#efe9dc',
  paper2: '#e6dfcf',
  rule: '#c9bea7',
  ink: '#16140f',
  ink2: '#4b463c',
  ink3: '#807865',
  signal: '#ff4a17',
  ok: '#11804a',
  okBright: '#3fcf86',
  error: '#c8231a',
};
export const F = {display: 'Shoulders', sans: 'Instrument', mono: 'JBMono'};

export function* fontsReady(): ThreadGenerator {
  yield Promise.all([
    document.fonts.load(`800 40px ${F.display}`),
    document.fonts.load(`600 40px ${F.sans}`),
    document.fonts.load(`600 40px ${F.mono}`),
  ]);
}

/** The burned-in caption: carries the story on mute. */
export function caption(view: View2D, text: string, small?: string) {
  const box = createRef<Rect>();
  view.add(
    <Rect
      ref={box}
      layout
      direction="column"
      alignItems="center"
      gap={6}
      fill={C.ink}
      padding={[22, 48]}
      y={430}
      opacity={0}
      shadowColor="rgba(0,0,0,.35)"
      shadowBlur={30}
    >
      <Txt text={text} fontFamily={F.display} fontWeight={800} fontSize={64} fill={C.paper} letterSpacing={1} />
      {small ? <Txt text={small} fontFamily={F.mono} fontSize={22} fill={C.rule} letterSpacing={2} /> : null}
    </Rect>,
  );
  return {
    in: () => box().opacity(1, 0.4),
    out: () => box().opacity(0, 0.3),
    node: box,
  };
}

/** A small label in the top-left corner, e.g. "SCRIPTED AGENTS · REAL TOOLS". */
export function tag(view: View2D, text: string, color = C.signal) {
  const r = createRef<Rect>();
  view.add(
    <Rect ref={r} layout fill={color} padding={[8, 14]} x={-960 + 40} y={-540 + 40} offset={[-1, -1]} opacity={0}>
      <Txt text={text} fontFamily={F.mono} fontWeight={700} fontSize={22} fill="#fff" letterSpacing={2} />
    </Rect>,
  );
  return r;
}

/** Where to look in a 1920×1080 recording: the source pixel to centre on and the zoom. */
export type Focus = {x: number; y: number; zoom: number};
export const FULL: Focus = {x: 960, y: 540, zoom: 1};

/** Keeps the camera inside the recording, so a zoom never shows black past its edges. */
function clampFocus(f: Focus): Focus {
  const hx = 960 / f.zoom, hy = 540 / f.zoom;
  return {zoom: f.zoom, x: Math.min(Math.max(f.x, hx), 1920 - hx), y: Math.min(Math.max(f.y, hy), 1080 - hy)};
}

function place(v: Video, f0: Focus) {
  const f = clampFocus(f0);
  v.scale(f.zoom);
  v.position([-(f.x - 960) * f.zoom, -(f.y - 540) * f.zoom]);
}

/** Plays a cut clip from public/ for `seconds`, optionally moving the camera between focuses. */
export function* footage(
  parent: Node,
  src: string,
  seconds: number,
  moves: {at: number; to: Focus; dur?: number}[] = [],
  start: Focus = FULL,
): ThreadGenerator {
  const v = createRef<Video>();
  parent.add(<Video ref={v} src={src} width={1920} height={1080} />);
  place(v(), start);
  v().play();
  let t = 0;
  for (const m of moves) {
    yield* waitFor(m.at - t);
    const d = m.dur ?? 0.8;
    const to = clampFocus(m.to);
    yield* all(
      v().scale(to.zoom, d, easeInOutCubic),
      v().position([-(to.x - 960) * to.zoom, -(to.y - 540) * to.zoom], d, easeInOutCubic),
    );
    t = m.at + d;
  }
  yield* waitFor(Math.max(0, seconds - t));
  v().remove();
}

import timing from './timing.json';
import {useTime} from '@motion-canvas/core';

/** Call at the start of a scene; `yield* end()` pads it to its length in timing.json (the voice track relies on it). */
export function sceneClock(name: string) {
  const t0 = useTime();
  const s = timing.scenes.find(x => x.scene === name);
  if (!s) throw new Error(`no timing for ${name}`);
  return {
    *end(): ThreadGenerator {
      const left = s.length - (useTime() - t0);
      if (left < 0) console.warn(`${name} runs ${(-left).toFixed(2)} s over its ${s.length} s`);
      yield* waitFor(Math.max(0, left));
    },
  };
}

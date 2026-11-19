import { Circle, Line, Rect, Txt, makeScene2D } from "@revideo/2d";
import { all, createRef, easeOutCubic, easeOutExpo, waitFor } from "@revideo/core";

function paletteOf(variables: any): string[] {
  const colors = Object.values(variables?.tokens?.palette ?? {}).filter((v): v is string => typeof v === "string");
  return colors.length > 0 ? colors : ["#0b0d10", "#f2f2f0", "#ffb703", "#219ebc"];
}

/**
 * Parametric generator choreography (`yield*` explainer): an axis, growing
 * vector arrows and labels — deterministic frame-by-frame, no wall-clock.
 */
export default makeScene2D(function* (view) {
  const vars: any = (view as any).variables?.() ?? {};
  const palette = paletteOf(vars);
  const fg = palette[1] ?? "#f2f2f0";
  const accent = palette[2] ?? "#ffb703";
  const secondary = palette[3] ?? palette[2] ?? "#219ebc";
  const payload: any = vars.payload ?? {};
  const title: string = payload.title ?? "Signal over time";
  const points: number[] = Array.isArray(payload.values) && payload.values.length > 1 ? payload.values : [0.2, 0.42, 0.31, 0.66, 0.58, 0.86];

  const axis = createRef<Line>();
  const heading = createRef<Txt>();
  const dots = points.map(() => createRef<Circle>());
  const labels = points.map(() => createRef<Txt>());
  const connector = createRef<Line>();

  view.add(
    <>
      <Line
        ref={axis}
        points={[
          [-560, 240],
          [560, 240],
        ]}
        stroke={secondary}
        lineWidth={3}
        end={0}
      />
      <Txt ref={heading} text={title} fill={fg} fontSize={54} fontFamily={"Segoe UI"} y={-330} opacity={0} />
    </>,
  );
  for (let i = 0; i < points.length; i += 1) {
    const x = -560 + (i / (points.length - 1)) * 1120;
    const y = 240 - (points[i] as number) * 520;
    view.add(
      <>
        <Circle ref={dots[i]} size={26} fill={i === points.length - 1 ? accent : secondary} position={[x, y]} scale={0} />
        <Txt ref={labels[i]} text={`${Math.round((points[i] as number) * 100)}`} fill={fg} fontSize={30} fontFamily={"Segoe UI"} position={[x, y - 44]} opacity={0} />
      </>,
    );
  }
  view.add(<Line ref={connector} points={[]} stroke={accent} lineWidth={5} lineJoin={"round"} />);

  yield* waitFor(0.1);
  yield* heading().opacity(1, 0.5, easeOutCubic);
  yield* axis().end(1, 0.6, easeOutCubic);

  const trail: [number, number][] = [];
  for (let i = 0; i < points.length; i += 1) {
    const dot = dots[i];
    const label = labels[i];
    if (!dot || !label) continue;
    const x = -560 + (i / (points.length - 1)) * 1120;
    const y = 240 - (points[i] as number) * 520;
    trail.push([x, y]);
    connector().points(trail);
    yield* all(dot().scale(1, 0.35, easeOutExpo), label().opacity(1, 0.35, easeOutCubic));
  }
  yield* waitFor(0.4);
});

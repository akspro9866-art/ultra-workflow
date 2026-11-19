import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

export interface UltraSceneProps {
  scene: any;
  fps: number;
  width: number;
  height: number;
  durationSec: number;
  tokens: any;
}

function paletteOf(tokens: any): string[] {
  const palette = tokens?.palette ?? {};
  const colors = Object.values(palette).filter((v): v is string => typeof v === "string");
  return colors.length > 0 ? colors : ["#0b0d10", "#f2f2f0", "#ffb703", "#219ebc"];
}

const Grain: React.FC<{ opacity: number }> = ({ opacity }) => (
  <div
    style={{
      position: "absolute",
      inset: 0,
      opacity,
      backgroundImage:
        "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='180' height='180' filter='url(%23n)'/></svg>\")",
      backgroundSize: "180px 180px",
      pointerEvents: "none",
    }}
  />
);

export const SceneRenderer: React.FC<UltraSceneProps> = ({ scene, tokens, durationSec }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const palette = paletteOf(tokens);
  const bg = scene?.background && scene.background !== "transparent" ? scene.background : (palette[0] as string);
  const fg = (palette[1] ?? "#f2f2f0") as string;
  const accent = (palette[2] ?? "#ffb703") as string;
  const secondary = (palette[3] ?? palette[2] ?? "#219ebc") as string;
  const headingFont = tokens?.fonts?.heading ?? "Segoe UI";
  const bodyFont = tokens?.fonts?.body ?? headingFont;
  const payload: any = scene?.enginePayload ?? {};
  const sceneType: string = payload.sceneType ?? "springType";
  const t = frame / fps;
  const outProgress = interpolate(t, [Math.max(0, durationSec - 0.25), durationSec], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  let content: React.ReactNode = null;

  if (sceneType === "springType") {
    const lines: string[] = Array.isArray(payload.lines) ? payload.lines : [scene?.name ?? "ULTRA"];
    content = (
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        {lines.map((line, index) => {
          const entry = spring({ frame: frame - index * Math.round(fps * 0.12), fps, config: { damping: 16, stiffness: 110 } });
          return (
            <div
              key={index}
              style={{
                fontFamily: headingFont,
                fontWeight: 800,
                fontSize: 148,
                lineHeight: 1.02,
                letterSpacing: "-0.035em",
                color: index % 2 === 0 ? fg : accent,
                transform: `translateY(${(1 - entry) * 90}px) scale(${0.9 + entry * 0.1})`,
                opacity: entry,
                textTransform: "uppercase",
              }}
            >
              {line}
            </div>
          );
        })}
        <div
          style={{
            marginTop: 42,
            height: 10,
            width: 240,
            background: secondary,
            transformOrigin: "left center",
            transform: `scaleX(${spring({ frame: frame - 14, fps, config: { damping: 20, stiffness: 90 } })})`,
          }}
        />
      </AbsoluteFill>
    );
  } else if (sceneType === "uiMock") {
    const rows = [0.92, 0.71, 0.83, 0.56, 0.77];
    content = (
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            width: 980,
            height: 610,
            borderRadius: 26,
            background: "rgba(255,255,255,0.04)",
            border: `1.5px solid ${secondary}55`,
            boxShadow: "0 40px 120px rgba(0,0,0,0.5)",
            padding: 34,
            fontFamily: bodyFont,
            transform: `perspective(1400px) rotateX(${6 - outProgress * 4}deg) translateY(${(1 - spring({ frame, fps, config: { damping: 18 } })) * 60}px)`,
          }}
        >
          <div style={{ display: "flex", gap: 10, marginBottom: 26 }}>
            {[accent, secondary, fg].map((c, i) => (
              <div key={i} style={{ width: 13, height: 13, borderRadius: 7, background: c as string, opacity: 0.85 }} />
            ))}
          </div>
          {rows.map((w, i) => (
            <div key={i} style={{ marginBottom: 18 }}>
              <div style={{ height: 16, width: `${w * 100}%`, borderRadius: 8, background: "rgba(255,255,255,0.14)" }} />
              <div style={{ height: 10, width: `${w * 74}%`, borderRadius: 6, background: "rgba(255,255,255,0.07)", marginTop: 8 }} />
            </div>
          ))}
          <div style={{ display: "flex", alignItems: "flex-end", gap: 14, height: 150, marginTop: 22 }}>
            {rows.map((w, i) => {
              const grow = spring({ frame: frame - 10 - i * 4, fps, config: { damping: 14, stiffness: 120 } });
              return <div key={i} style={{ flex: 1, height: `${w * 100 * grow}%`, background: i === 1 ? accent : secondary, opacity: 0.9 - i * 0.1, borderRadius: 6 }} />;
            })}
          </div>
        </div>
      </AbsoluteFill>
    );
  } else if (sceneType === "chart") {
    const values: number[] = Array.isArray(payload.values) && payload.values.length > 0 ? payload.values : [0.52, 0.71, 0.44, 0.88, 0.63, 0.79];
    const labels: string[] = Array.isArray(payload.labels) ? payload.labels : values.map((_, i) => `Q${i + 1}`);
    content = (
      <AbsoluteFill style={{ padding: 140, justifyContent: "flex-end" }}>
        <div style={{ fontFamily: headingFont, fontSize: 42, fontWeight: 700, color: fg, marginBottom: 26, letterSpacing: "0.02em" }}>
          {payload.title ?? "Momentum by quarter"}
        </div>
        <div style={{ display: "flex", gap: 34, alignItems: "flex-end", height: 560 }}>
          {values.map((v, i) => {
            const grow = spring({ frame: frame - i * 6, fps, config: { damping: 15, stiffness: 100 } });
            return (
              <div key={i} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 14 }}>
                <div style={{ fontFamily: bodyFont, fontSize: 26, color: accent, opacity: grow }}>{Math.round(v * 100)}%</div>
                <div
                  style={{
                    width: "100%",
                    height: `${Math.min(1, v) * 100 * grow}%`,
                    background: i === values.length - 1 ? accent : secondary,
                    borderRadius: 10,
                    boxShadow: `0 -10px 60px ${(i === values.length - 1 ? accent : secondary) as string}44`,
                  }}
                />
                <div style={{ fontFamily: bodyFont, fontSize: 22, color: fg, opacity: 0.7 }}>{labels[i] ?? i + 1}</div>
              </div>
            );
          })}
        </div>
      </AbsoluteFill>
    );
  } else {
    const caption: string = payload.caption ?? scene?.name ?? "GRADE";
    content = (
      <AbsoluteFill style={{ alignItems: "center", justifyContent: "center" }}>
        <div
          style={{
            position: "absolute",
            inset: -200,
            background: `conic-gradient(from ${t * 40}deg at 52% 46%, ${accent}22, ${secondary}33, transparent 55%)`,
            filter: "blur(70px)",
          }}
        />
        <div style={{ fontFamily: headingFont, fontSize: 128, fontWeight: 800, color: fg, letterSpacing: "-0.03em", opacity: spring({ frame, fps }) }}>
          {caption}
        </div>
        <div style={{ width: 340, height: 6, background: accent, marginTop: 30, opacity: 0.9 }} />
      </AbsoluteFill>
    );
  }

  return (
    <AbsoluteFill style={{ backgroundColor: bg }}>
      {content}
      <AbsoluteFill style={{ opacity: outProgress * 0.9, backgroundColor: "#000000" }} />
      <Grain opacity={0.05} />
    </AbsoluteFill>
  );
};

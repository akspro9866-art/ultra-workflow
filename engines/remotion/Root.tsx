import React from "react";
import { Composition, registerRoot, type CalculateMetadataFunction } from "remotion";
import { SceneRenderer, type UltraSceneProps } from "./SceneRenderer";

const defaultProps: UltraSceneProps = {
  scene: {
    id: "demo",
    enginePayload: { sceneType: "springType", lines: ["ULTRA", "WORKFLOW"] },
    background: "#0b0d10",
  },
  fps: 30,
  width: 1920,
  height: 1080,
  durationSec: 2,
  tokens: {
    palette: { bg: "#0b0d10", fg: "#f2f2f0", accent: "#ffb703", secondary: "#219ebc" },
    fonts: { heading: "Segoe UI", body: "Segoe UI", mono: "Consolas" },
  },
};

const calculateMetadata: CalculateMetadataFunction<UltraSceneProps> = ({ props }) => ({
  durationInFrames: Math.max(1, Math.round(props.durationSec * props.fps)),
  fps: props.fps,
  width: props.width,
  height: props.height,
});

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="UltraScene"
      component={SceneRenderer}
      durationInFrames={60}
      fps={30}
      width={1920}
      height={1080}
      defaultProps={defaultProps}
      calculateMetadata={calculateMetadata}
    />
  );
};

registerRoot(RemotionRoot);

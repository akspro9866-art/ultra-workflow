import { makeProject } from "@revideo/core";
import scene from "./scene";

/**
 * Revideo project entry. Variables (payload, palette, fps, size) are injected by
 * the Ultra adapter through `variables`; nothing here reads the wall clock, so
 * renders are frame-deterministic.
 */
export default makeProject({
  scenes: [scene],
  settings: {
    shared: {
      size: { x: 1920, y: 1080 },
    },
  },
});

import { z } from "zod";

export const HexColor3d = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "must be a hex color (#rgb or #rrggbb)");

export const Vec3 = z.tuple([z.number(), z.number(), z.number()]);

export const MeshKeyframe = z.object({
  atSec: z.number().min(0),
  position: Vec3.optional(),
  rotation: Vec3.optional(),
  scale: Vec3.optional(),
  opacity: z.number().min(0).max(1).optional(),
});

export const MaterialSpec = z.object({
  id: z.string().min(1),
  color: HexColor3d,
  metalness: z.number().min(0).max(1).default(0.2),
  roughness: z.number().min(0).max(1).default(0.5),
  emissive: HexColor3d.optional(),
  emissiveIntensity: z.number().min(0).max(10).default(1),
  opacity: z.number().min(0).max(1).default(1),
  specular: z.number().min(0).max(1).optional(),
  subsurface: z.number().min(0).max(1).optional(),
  clearcoat: z.number().min(0).max(1).optional(),
  transmission: z.number().min(0).max(1).optional(),
});

export const MeshSpec = z.object({
  id: z.string().min(1),
  primitive: z.enum(["cube", "sphere", "plane", "cylinder", "cone", "torus"]),
  materialId: z.string().min(1),
  position: Vec3.default([0, 0, 0]),
  rotation: Vec3.default([0, 0, 0]),
  scale: Vec3.default([1, 1, 1]),
  keyframes: z.array(MeshKeyframe).default([]),
});

export const LightSpec = z.object({
  id: z.string().optional(),
  type: z.enum(["point", "directional", "ambient"]).default("point"),
  color: HexColor3d.default("#ffffff"),
  intensity: z.number().min(0).max(100).default(1),
  position: Vec3.default([0, 0, 0]),
});

export const CameraKeyframe = z.object({
  atSec: z.number().min(0),
  position: Vec3.optional(),
  target: Vec3.optional(),
});

export const CameraSpec = z.object({
  position: Vec3.default([0, 2, 6]),
  target: Vec3.default([0, 0, 0]),
  fov: z.number().min(5).max(120).default(45),
  keyframes: z.array(CameraKeyframe).default([]),
});

export const SceneGraph = z.object({
  durationSec: z.number().positive(),
  fps: z.number().positive().default(30),
  width: z.number().int().positive().default(1920),
  height: z.number().int().positive().default(1080),
  backgroundAlpha: z.boolean().default(true),
  camera: CameraSpec.default({}),
  lights: z.array(LightSpec).default([]),
  materials: z.array(MaterialSpec).default([]),
  meshes: z.array(MeshSpec).default([]),
});

export type SceneGraphT = z.infer<typeof SceneGraph>;
export type MeshSpecT = z.infer<typeof MeshSpec>;
export type MaterialSpecT = z.infer<typeof MaterialSpec>;
export type CameraSpecT = z.infer<typeof CameraSpec>;

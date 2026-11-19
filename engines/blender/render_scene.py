"""Ultra Workflow — headless Blender scene renderer (Blender 3.6 → 4.5+).

Renders a JSON scene_graph (see engines/blender/schema.ts) to an RGBA PNG
sequence using `blender --background`. Strictly data-API driven: mesh primitives
are built with bmesh/bpy.data (torus is generated from raw vertices); the only
operator used is the headless render call itself.

Version hardening:
  - Principled BSDF input renames are handled through a name-list helper
    (Specular IOR Level vs Specular, Subsurface Weight vs Subsurface,
     Emission Color vs Emission, Coat Weight vs Clearcoat, Transmission Weight
     vs Transmission).
  - EEVEE engine identifiers are detected dynamically
    (BLENDER_EEVEE_NEXT on 4.2+, BLENDER_EEVEE on 3.x–4.1).
  - Color management prefers AgX, then Filmic, then Standard.
  - GPU (OptiX/CUDA/HIP/Metal/oneAPI) with automatic CPU fallback.

Usage:
  blender --background --factory-startup --python render_scene.py -- \
      --json /abs/scene_graph.json --out /abs/frames --fps 30 \
      [--width 1920] [--height 1080]
"""

import argparse
import json
import math
import os
import sys

import bpy
import bmesh
from mathutils import Vector


# ---------------------------------------------------------------------------
# Version-tolerant helpers
# ---------------------------------------------------------------------------

BSDF_INPUT_NAMES = {
    "base_color": ["Base Color"],
    "metallic": ["Metallic"],
    "roughness": ["Roughness"],
    "alpha": ["Alpha"],
    "emission": ["Emission Color", "Emission"],
    "emission_strength": ["Emission Strength"],
    "specular": ["Specular IOR Level", "Specular"],
    "subsurface": ["Subsurface Weight", "Subsurface"],
    "clearcoat": ["Coat Weight", "Clearcoat"],
    "transmission": ["Transmission Weight", "Transmission"],
    "ior": ["IOR"],
}


def set_bsdf_input(bsdf, key, value):
    """Set a Principled BSDF input across Blender 3.6–4.5 naming eras."""
    if bsdf is None:
        return False
    for name in BSDF_INPUT_NAMES.get(key, []):
        try:
            if name in bsdf.inputs:
                bsdf.inputs[name].default_value = value
                return True
        except Exception:
            continue
    return False


def engine_identifiers():
    try:
        prop = bpy.types.RenderSettings.bl_rna.properties["engine"]
        return {item.identifier for item in prop.enum_items}
    except Exception:
        return set()


def preferred_eevee():
    identifiers = engine_identifiers()
    for candidate in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        if candidate in identifiers:
            return candidate
    return None


def preferred_view_transform(scene):
    try:
        prop = scene.view_settings.bl_rna.properties["view_transform"]
        identifiers = {item.identifier for item in prop.enum_items}
        for candidate in ("AgX", "Filmic", "Standard"):
            if candidate in identifiers:
                return candidate
    except Exception:
        pass
    return "Standard"


def linearize_animation(target, data_path=None):
    try:
        animation_data = target.animation_data
        action = animation_data.action if animation_data is not None else None
        if action is None:
            return
        for curve in action.fcurves:
            if data_path is None or curve.data_path == data_path:
                for point in curve.keyframe_points:
                    point.interpolation = "LINEAR"
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Scene construction (bpy.data only)
# ---------------------------------------------------------------------------

def parse_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1 :] if "--" in argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--fps", type=float, default=30.0)
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    return parser.parse_args(argv)


def clear_scene():
    for obj in list(bpy.data.objects):
        bpy.data.objects.remove(obj, do_unlink=True)
    for block in (bpy.data.meshes, bpy.data.materials, bpy.data.cameras, bpy.data.lights):
        for item in list(block):
            block.remove(item)


def hex_to_rgba(hex_color, alpha=1.0):
    h = hex_color.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    r = int(h[0:2], 16) / 255.0
    g = int(h[2:4], 16) / 255.0
    b = int(h[4:6], 16) / 255.0
    return (r, g, b, alpha)


def linearize(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def srgb_to_linear(rgba):
    return (linearize(rgba[0]), linearize(rgba[1]), linearize(rgba[2]), rgba[3])


def make_material(spec):
    mat = bpy.data.materials.new(name=spec["id"])
    mat.use_nodes = True
    nodes = mat.node_tree.nodes
    bsdf = nodes.get("Principled BSDF")
    if bsdf is not None:
        base = srgb_to_linear(hex_to_rgba(spec["color"], spec.get("opacity", 1.0)))
        set_bsdf_input(bsdf, "base_color", base)
        set_bsdf_input(bsdf, "metallic", spec.get("metalness", 0.2))
        set_bsdf_input(bsdf, "roughness", spec.get("roughness", 0.5))
        set_bsdf_input(bsdf, "alpha", spec.get("opacity", 1.0))
        if spec.get("specular") is not None:
            set_bsdf_input(bsdf, "specular", spec["specular"])
        if spec.get("subsurface") is not None:
            set_bsdf_input(bsdf, "subsurface", spec["subsurface"])
        if spec.get("clearcoat") is not None:
            set_bsdf_input(bsdf, "clearcoat", spec["clearcoat"])
        if spec.get("transmission") is not None:
            set_bsdf_input(bsdf, "transmission", spec["transmission"])
        emissive = spec.get("emissive")
        if emissive:
            set_bsdf_input(bsdf, "emission", srgb_to_linear(hex_to_rgba(emissive)))
            set_bsdf_input(bsdf, "emission_strength", spec.get("emissiveIntensity", 1.0))
    if spec.get("opacity", 1.0) < 1.0:
        try:
            mat.blend_method = "BLEND"
        except Exception:
            pass
    return mat


def torus_geometry(major_segments=32, minor_segments=16, major_radius=0.4, minor_radius=0.12):
    verts = []
    faces = []
    for i in range(major_segments):
        u = (i / major_segments) * 2 * math.pi
        for j in range(minor_segments):
            v = (j / minor_segments) * 2 * math.pi
            x = (major_radius + minor_radius * math.cos(v)) * math.cos(u)
            y = (major_radius + minor_radius * math.cos(v)) * math.sin(u)
            z = minor_radius * math.sin(v)
            verts.append((x, y, z))
    for i in range(major_segments):
        for j in range(minor_segments):
            a = i * minor_segments + j
            b = ((i + 1) % major_segments) * minor_segments + j
            c = ((i + 1) % major_segments) * minor_segments + (j + 1) % minor_segments
            d = i * minor_segments + (j + 1) % minor_segments
            faces.append((a, b, c, d))
    return verts, faces


def build_mesh(spec):
    bm = bmesh.new()
    primitive = spec["primitive"]
    if primitive == "cube":
        bmesh.ops.create_cube(bm, size=1.0)
    elif primitive == "sphere":
        try:
            bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, radius=0.5)
        except TypeError:
            bmesh.ops.create_uvsphere(bm, u_segments=32, v_segments=16, diameter=0.5)
    elif primitive == "plane":
        bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.0)
    elif primitive == "cylinder":
        bmesh.ops.create_cone(bm, cap_ends=True, segments=32, radius1=0.5, radius2=0.5, depth=1.0)
    elif primitive == "cone":
        bmesh.ops.create_cone(bm, cap_ends=True, segments=32, radius1=0.5, radius2=0.0, depth=1.0)
    elif primitive == "torus":
        verts, faces = torus_geometry()
        for v in verts:
            bm.verts.new(v)
        bm.verts.ensure_lookup_table()
        for f in faces:
            try:
                bm.faces.new([bm.verts[i] for i in f])
            except ValueError:
                pass
    else:
        raise ValueError("unknown primitive: " + primitive)
    me = bpy.data.meshes.new(spec["id"] + "_mesh")
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new(spec["id"], me)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def apply_keyframes(obj, keyframes, fps, material):
    for kf in keyframes:
        frame = max(1, round(kf["atSec"] * fps) + 1)
        if "position" in kf:
            obj.location = Vector(kf["position"])
            obj.keyframe_insert("location", frame=frame)
            linearize_animation(obj, "location")
        if "rotation" in kf:
            obj.rotation_mode = "XYZ"
            obj.rotation_euler = tuple(math.radians(v) for v in kf["rotation"])
            obj.keyframe_insert("rotation_euler", frame=frame)
            linearize_animation(obj, "rotation_euler")
        if "scale" in kf:
            obj.scale = Vector(kf["scale"])
            obj.keyframe_insert("scale", frame=frame)
            linearize_animation(obj, "scale")
        if "opacity" in kf and material is not None:
            bsdf = material.node_tree.nodes.get("Principled BSDF")
            if bsdf is not None and "Alpha" in bsdf.inputs:
                bsdf.inputs["Alpha"].default_value = kf["opacity"]
                bsdf.inputs["Alpha"].keyframe_insert("default_value", frame=frame)
                linearize_animation(material.node_tree, 'nodes["Principled BSDF"].inputs["Alpha"].default_value')


def look_at(obj, target):
    direction = Vector(target) - obj.location
    if direction.length > 0:
        obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


# ---------------------------------------------------------------------------
# Render configuration (GPU -> CPU -> EEVEE fallback)
# ---------------------------------------------------------------------------

def configure_cycles(scene, device_type):
    scene.render.engine = "CYCLES"
    scene.cycles.device = "GPU" if device_type else "CPU"
    scene.cycles.samples = 32 if device_type else 48
    scene.cycles.use_denoising = True
    return "cycles-" + (device_type.lower() if device_type else "cpu")


def setup_render(scene, graph, args):
    scene.render.resolution_x = args.width
    scene.render.resolution_y = args.height
    scene.render.resolution_percentage = 100
    scene.render.fps = max(1, round(args.fps))
    scene.render.film_transparent = bool(graph.get("backgroundAlpha", True))
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.compression = 15
    scene.render.filepath = os.path.join(args.out, "f_")
    scene.frame_start = 1
    scene.frame_end = max(1, round(graph["durationSec"] * args.fps))

    backend = "default"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        device_type = None
        for candidate in ("OPTIX", "CUDA", "HIP", "METAL", "ONEAPI"):
            try:
                prefs.compute_device_type = candidate
                prefs.get_devices()
                if any(getattr(d, "type", None) == candidate for d in prefs.devices):
                    device_type = candidate
                    break
            except Exception:
                continue
        if device_type is not None:
            try:
                for device in prefs.devices:
                    device.use = getattr(device, "type", None) == device_type
                backend = configure_cycles(scene, device_type)
            except Exception:
                backend = configure_cycles(scene, None)  # GPU failed -> CPU
        else:
            backend = configure_cycles(scene, None)  # no GPU -> CPU
    except Exception:
        eevee = preferred_eevee()
        if eevee is not None:
            try:
                scene.render.engine = eevee
                backend = eevee.lower()
            except Exception:
                backend = "default"
        else:
            backend = "default"

    try:
        scene.view_settings.view_transform = preferred_view_transform(scene)
    except Exception:
        pass
    return backend


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    args = parse_args()
    os.makedirs(args.out, exist_ok=True)
    with open(args.json, "r", encoding="utf-8") as handle:
        graph = json.load(handle)

    clear_scene()
    scene = bpy.context.scene

    world = bpy.data.worlds.new("ultra_world")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg is not None:
        bg.inputs[0].default_value = (0.0, 0.0, 0.0, 0.0)
        bg.inputs[1].default_value = 1.0
    scene.world = world

    materials = {}
    for spec in graph.get("materials", []):
        materials[spec["id"]] = make_material(spec)

    for spec in graph.get("meshes", []):
        obj = build_mesh(spec)
        mat = materials.get(spec["materialId"])
        if mat is not None:
            obj.data.materials.append(mat)
        obj.location = Vector(spec.get("position", [0, 0, 0]))
        obj.rotation_mode = "XYZ"
        obj.rotation_euler = tuple(math.radians(v) for v in spec.get("rotation", [0, 0, 0]))
        obj.scale = Vector(spec.get("scale", [1, 1, 1]))
        apply_keyframes(obj, spec.get("keyframes", []), args.fps, mat)

    for spec in graph.get("lights", []):
        light_type = spec.get("type", "point")
        rgba = hex_to_rgba(spec.get("color", "#ffffff"))
        if light_type == "ambient":
            if bg is not None:
                bg.inputs[0].default_value = rgba
                bg.inputs[1].default_value = float(spec.get("intensity", 1)) * 0.35
            continue
        data = bpy.data.lights.new(name=spec.get("id", "light"), type="POINT" if light_type == "point" else "SUN")
        data.energy = float(spec.get("intensity", 1)) * (120.0 if light_type == "point" else 3.0)
        data.color = rgba[:3]
        obj = bpy.data.objects.new(spec.get("id", "light"), data)
        scene.collection.objects.link(obj)
        obj.location = Vector(spec.get("position", [0, 2, 3]))
        if light_type == "directional":
            look_at(obj, (0.0, 0.0, 0.0))

    camera_spec = graph.get("camera", {})
    cam_data = bpy.data.cameras.new("ultra_camera")
    cam_data.lens_unit = "FOV"
    cam_data.angle = math.radians(float(camera_spec.get("fov", 45)))
    cam_obj = bpy.data.objects.new("ultra_camera", cam_data)
    scene.collection.objects.link(cam_obj)
    cam_obj.location = Vector(camera_spec.get("position", [0, 2, 6]))
    look_at(cam_obj, camera_spec.get("target", [0, 0, 0]))
    scene.camera = cam_obj

    for kf in camera_spec.get("keyframes", []):
        frame = max(1, round(kf["atSec"] * args.fps) + 1)
        if "position" in kf:
            cam_obj.location = Vector(kf["position"])
            cam_obj.keyframe_insert("location", frame=frame)
            linearize_animation(cam_obj, "location")
        if "target" in kf:
            look_at(cam_obj, kf["target"])
            cam_obj.keyframe_insert("rotation_euler", frame=frame)
            linearize_animation(cam_obj, "rotation_euler")

    backend = setup_render(scene, graph, args)
    bpy.ops.render.render(animation=True)

    summary = {
        "engine": "blender",
        "backend": backend,
        "frames": scene.frame_end,
        "fps": args.fps,
        "width": args.width,
        "height": args.height,
        "outDir": args.out,
    }
    print("ULTRA_BLENDER_SUMMARY=" + json.dumps(summary))


if __name__ == "__main__":
    main()

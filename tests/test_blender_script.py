"""Mock-bpy unit test for engines/blender/render_scene.py.

Executes the ENTIRE headless pipeline with fake `bpy`, `bmesh` and `mathutils`
modules (no Blender install required): scene_graph.json loading, camera
keyframes, lights (point/directional/ambient), materials (including renamed
Principled BSDF inputs), transparent film, EEVEE/Cycles engine selection with
GPU -> CPU fallback, view-transform selection and the frame-output calls.

Run: python tests/test_blender_script.py
"""

import contextlib
import importlib.util
import io
import json
import math
import os
import py_compile
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "engines" / "blender" / "render_scene.py"


# ---------------------------------------------------------------------------
# Fake mathutils
# ---------------------------------------------------------------------------

class FakeVector:
    def __init__(self, value):
        self._v = [float(x) for x in value]

    @property
    def length(self):
        return math.sqrt(sum(x * x for x in self._v))

    def __sub__(self, other):
        return FakeVector([a - b for a, b in zip(self._v, other._v)])

    def __iter__(self):
        return iter(self._v)

    def __getitem__(self, index):
        return self._v[index]

    def __len__(self):
        return len(self._v)

    def to_track_quat(self, *_args, **_kwargs):
        return FakeQuaternion()


class FakeEuler(tuple):
    pass


class FakeQuaternion:
    def to_euler(self):
        return FakeEuler((0.5, 0.2, 0.1))


# ---------------------------------------------------------------------------
# Fake BSDF / node system
# ---------------------------------------------------------------------------

NEW_BSDF_NAMES = [
    "Base Color",
    "Metallic",
    "Roughness",
    "Alpha",
    "Emission Color",
    "Emission Strength",
    "IOR",
    "Specular IOR Level",
    "Subsurface Weight",
    "Coat Weight",
    "Transmission Weight",
]

LEGACY_BSDF_NAMES = [
    "Base Color",
    "Metallic",
    "Roughness",
    "Alpha",
    "Emission",
    "Emission Strength",
    "IOR",
    "Specular",
    "Subsurface",
    "Clearcoat",
    "Transmission",
]


class FakeInput:
    def __init__(self, name):
        self.name = name
        self.default_value = None
        self.keyframes = []

    def keyframe_insert(self, data_path, frame=None):
        self.keyframes.append((data_path, frame))


class FakeInputs:
    def __init__(self, names):
        self._list = [FakeInput(name) for name in names]
        self._by_name = {inp.name: inp for inp in self._list}

    def __contains__(self, name):
        return name in self._by_name

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._list[key]
        return self._by_name[key]


class FakeNode:
    def __init__(self, inputs):
        self.inputs = inputs


class FakeNodeTree:
    def __init__(self, bsdf_names=None):
        self.bsdf_names = list(NEW_BSDF_NAMES if bsdf_names is None else bsdf_names)
        self.nodes = FakeNodes(self.bsdf_names)
        self.animation_data = None


class FakeNodes:
    def __init__(self, bsdf_names):
        self._by_name = {"Principled BSDF": FakeNode(FakeInputs(bsdf_names))}

    def get(self, name):
        return self._by_name.get(name)


class FakeWorldNodeTree:
    def __init__(self):
        self.nodes = FakeWorldNodes()


class FakeWorldNodes:
    def __init__(self):
        self._background = FakeNode(FakeInputs(["Color", "Strength"]))

    def get(self, name):
        return self._background if name == "Background" else None


# ---------------------------------------------------------------------------
# Fake data blocks
# ---------------------------------------------------------------------------

class FakeMaterial:
    def __init__(self, name, bsdf_names=None):
        self.name = name
        self._node_tree = None
        self._bsdf_names = bsdf_names
        self.blend_method = "OPAQUE"

    @property
    def node_tree(self):
        if self._node_tree is None:
            self._node_tree = FakeNodeTree(self._bsdf_names)
        return self._node_tree

    @property
    def use_nodes(self):
        return True

    @use_nodes.setter
    def use_nodes(self, value):
        if value:
            _ = self.node_tree


class FakeMesh:
    def __init__(self, name):
        self.name = name
        self.materials = []
        self.vertex_count = 0


class FakeCameraData:
    def __init__(self, name):
        self.name = name
        self.lens_unit = "MILLIMETERS"
        self.angle = 0.0


class FakeLightData:
    def __init__(self, name, light_type="POINT"):
        self.name = name
        self.type = light_type
        self.energy = 0.0
        self.color = (1.0, 1.0, 1.0)


class FakeObject:
    def __init__(self, name, data=None):
        self.name = name
        self.data = data
        self.location = FakeVector((0, 0, 0))
        self.rotation_euler = FakeEuler((0, 0, 0))
        self.scale = FakeVector((1, 1, 1))
        self.rotation_mode = "XYZ"
        self.animation_data = None
        self.keyframes = []

    def keyframe_insert(self, data_path, frame=None):
        self.keyframes.append((data_path, frame))


class FakeWorld:
    def __init__(self, name):
        self.name = name
        self._node_tree = FakeWorldNodeTree()

    @property
    def node_tree(self):
        return self._node_tree

    @property
    def use_nodes(self):
        return True

    @use_nodes.setter
    def use_nodes(self, value):
        if value:
            _ = self.node_tree


class FakeCollection:
    def __init__(self, factory):
        self.factory = factory
        self.items = []

    def new(self, *args, **kwargs):
        item = self.factory(*args, **kwargs)
        self.items.append(item)
        return item

    def remove(self, item, do_unlink=True):
        if item in self.items:
            self.items.remove(item)

    def __iter__(self):
        return iter(self.items)

    def __len__(self):
        return len(self.items)


class FakeData:
    def __init__(self, legacy_bsdf=False):
        bsdf_names = LEGACY_BSDF_NAMES if legacy_bsdf else NEW_BSDF_NAMES
        self.objects = FakeCollection(lambda name, data=None: FakeObject(name, data))
        self.meshes = FakeCollection(lambda name: FakeMesh(name))
        self.materials = FakeCollection(lambda name: FakeMaterial(name, bsdf_names))
        self.cameras = FakeCollection(lambda name: FakeCameraData(name))
        self.lights = FakeCollection(lambda name, type="POINT": FakeLightData(name, type))
        self.worlds = FakeCollection(lambda name: FakeWorld(name))


# ---------------------------------------------------------------------------
# Fake bmesh
# ---------------------------------------------------------------------------

class FakeBMVert:
    def __init__(self, co):
        self.co = co


class FakeBMVerts:
    def __init__(self):
        self.items = []

    def new(self, co):
        vert = FakeBMVert(co)
        self.items.append(vert)
        return vert

    def ensure_lookup_table(self):
        pass

    def __getitem__(self, index):
        return self.items[index]

    def __len__(self):
        return len(self.items)


class FakeBMFaces:
    def __init__(self):
        self.items = []

    def new(self, verts):
        self.items.append(list(verts))


class FakeBMesh:
    def __init__(self, call_log):
        self.verts = FakeBMVerts()
        self.faces = FakeBMFaces()
        self.call_log = call_log
        self.freed = False

    def to_mesh(self, mesh):
        mesh.vertex_count = len(self.verts)

    def free(self):
        self.freed = True


class FakeBmeshOps:
    def __init__(self, call_log):
        self.call_log = call_log

    def _record(self, name):
        self.call_log.append(name)

    def create_cube(self, bm, size=1.0):
        self._record("create_cube")
        bm.verts.new((0.0, 0.0, 0.0))

    def create_uvsphere(self, bm, **kwargs):
        if "radius" not in kwargs and "diameter" not in kwargs:
            raise TypeError("radius or diameter required")
        self._record("create_uvsphere")
        bm.verts.new((0.0, 0.0, 0.0))

    def create_grid(self, bm, **kwargs):
        self._record("create_grid")
        bm.verts.new((0.0, 0.0, 0.0))

    def create_cone(self, bm, **kwargs):
        self._record("create_cone")
        bm.verts.new((0.0, 0.0, 0.0))


# ---------------------------------------------------------------------------
# Fake scene / render settings / engine enums
# ---------------------------------------------------------------------------

class FakeImageSettings:
    def __init__(self):
        self.file_format = "PNG"
        self.color_mode = "RGBA"
        self.color_depth = "8"
        self.compression = 0


class FakeRender:
    def __init__(self):
        self.resolution_x = 1920
        self.resolution_y = 1080
        self.resolution_percentage = 100
        self.fps = 24
        self.film_transparent = False
        self.image_settings = FakeImageSettings()
        self.filepath = ""
        self.engine = "BLENDER_EEVEE"


class FakeCycles:
    def __init__(self):
        self.device = "CPU"
        self.samples = 0
        self.use_denoising = False


class FakeEnumProperty:
    def __init__(self, identifiers):
        self.enum_items = [types.SimpleNamespace(identifier=i) for i in identifiers]


class FakeBlRna:
    def __init__(self, properties):
        self.properties = properties


class FakeViewSettings:
    bl_rna = FakeBlRna({"view_transform": FakeEnumProperty(["Standard", "Filmic", "AgX", "ACES"])})

    def __init__(self):
        self.view_transform = "Standard"


class FakeRenderSettings:
    bl_rna = FakeBlRna(
        {"engine": FakeEnumProperty(["CYCLES", "BLENDER_EEVEE", "BLENDER_EEVEE_NEXT", "BLENDER_WORKBENCH"])}
    )


class FakeObjectsCollection:
    def __init__(self):
        self.linked = []

    def link(self, obj):
        self.linked.append(obj)


class FakeScene:
    def __init__(self):
        self.render = FakeRender()
        self.cycles = FakeCycles()
        self.view_settings = FakeViewSettings()
        self.frame_start = 1
        self.frame_end = 250
        self.camera = None
        self.world = None
        self.collection = types.SimpleNamespace(objects=FakeObjectsCollection())


class FakePreferences:
    def __init__(self):
        self._preferences = None

    def __getitem__(self, key):
        raise KeyError(key)


class FakeDevice:
    def __init__(self, device_type):
        self.type = device_type
        self.use = False


class FakeCyclesPreferences:
    def __init__(self, devices):
        self.device_types = devices
        self.devices = []
        self.compute_device_type = None

    def get_devices(self):
        self.devices = [FakeDevice(t) for t in self.device_types]


class FakeContext:
    def __init__(self, devices, with_cycles=True):
        self.scene = FakeScene()
        addons = {}
        if with_cycles:
            addons["cycles"] = types.SimpleNamespace(preferences=FakeCyclesPreferences(devices))
        self.preferences = types.SimpleNamespace(addons=addons)


class FakeRenderOps:
    def __init__(self):
        self.calls = []

    def render(self, **kwargs):
        self.calls.append(kwargs)


class FakeBpy(types.ModuleType):
    pass


def make_fake_bpy(devices, with_cycles=True, legacy_bsdf=False):
    bpy = FakeBpy("bpy")
    bpy.data = FakeData(legacy_bsdf=legacy_bsdf)
    bpy.context = FakeContext(devices, with_cycles=with_cycles)
    bpy.types = types.SimpleNamespace(RenderSettings=FakeRenderSettings)
    bpy.ops = types.SimpleNamespace(render=FakeRenderOps())
    bmesh_ops = FakeBmeshOps([])
    bmesh_mod = types.ModuleType("bmesh")
    bmesh_mod.ops = bmesh_ops
    bmesh_mod.call_log = bmesh_ops.call_log
    bmesh_mod.new = lambda: FakeBMesh(bmesh_ops.call_log)
    mathutils_mod = types.ModuleType("mathutils")
    mathutils_mod.Vector = FakeVector
    bpy.bmesh = bmesh_mod
    bpy.mathutils = mathutils_mod
    return bpy


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def load_render_module(fake_bpy):
    sys.modules["bpy"] = fake_bpy
    sys.modules["bmesh"] = fake_bpy.bmesh
    sys.modules["mathutils"] = fake_bpy.mathutils
    spec = importlib.util.spec_from_file_location("ultra_render_scene", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sample_graph(duration=1.0):
    return {
        "durationSec": duration,
        "fps": 10,
        "width": 320,
        "height": 180,
        "backgroundAlpha": True,
        "camera": {
            "position": [0, 1.4, 4.2],
            "target": [0, 0, 0],
            "fov": 45,
            "keyframes": [
                {"atSec": 0, "position": [0, 1.4, 4.6], "target": [0, 0, 0]},
                {"atSec": 1.0, "position": [0, 1.4, 3.8], "target": [0, 0.2, 0]},
            ],
        },
        "lights": [
            {"id": "key", "type": "point", "color": "#ffffff", "intensity": 5, "position": [2, 3, 3]},
            {"id": "sun", "type": "directional", "color": "#8ecae6", "intensity": 2, "position": [0, 4, 0]},
            {"id": "fill", "type": "ambient", "color": "#8ecae6", "intensity": 0.6, "position": [0, 0, 0]},
        ],
        "materials": [
            {"id": "accent", "color": "#ffb703", "metalness": 0.6, "roughness": 0.3},
            {
                "id": "secondary",
                "color": "#8ecae6",
                "metalness": 0.1,
                "roughness": 0.6,
                "opacity": 0.8,
                "emissive": "#ffb703",
                "emissiveIntensity": 2,
                "specular": 0.5,
                "clearcoat": 0.4,
                "transmission": 0.1,
                "subsurface": 0.2,
            },
        ],
        "meshes": [
            {
                "id": "torus",
                "primitive": "torus",
                "materialId": "accent",
                "position": [0, 0, 0],
                "rotation": [0, 0, 0],
                "scale": [1.2, 1.2, 1.2],
                "keyframes": [
                    {"atSec": 0, "rotation": [0, 0, 0]},
                    {"atSec": 1, "rotation": [0, 180, 90]},
                ],
            },
            {
                "id": "sphere",
                "primitive": "sphere",
                "materialId": "secondary",
                "position": [1.1, 0.3, 0],
                "rotation": [0, 0, 0],
                "scale": [0.8, 0.8, 0.8],
                "keyframes": [
                    {"atSec": 0, "position": [1.1, 0.3, 0], "opacity": 1.0},
                    {"atSec": 1, "position": [-1.1, 0.5, 0], "opacity": 0.25},
                ],
            },
        ],
    }


class BlenderScriptTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ultra-blender-test-")
        self.out_dir = str(Path(self.tmp) / "frames")
        self.graph_file = str(Path(self.tmp) / "scene_graph.json")
        self._argv = list(sys.argv)

    def tearDown(self):
        sys.argv = self._argv
        for name in ("bpy", "bmesh", "mathutils", "ultra_render_scene"):
            sys.modules.pop(name, None)

    def _run(self, bpy, graph):
        Path(self.graph_file).write_text(json.dumps(graph), encoding="utf-8")
        module = load_render_module(bpy)
        sys.argv = [
            "render_scene.py",
            "--",
            "--json",
            self.graph_file,
            "--out",
            self.out_dir,
            "--fps",
            str(graph.get("fps", 10)),
            "--width",
            str(graph.get("width", 320)),
            "--height",
            str(graph.get("height", 180)),
        ]
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout):
            module.main()
        return stdout.getvalue()

    def test_script_compiles(self):
        py_compile.compile(str(SCRIPT), doraise=True)

    def test_eevee_fallback_pipeline_end_to_end(self):
        bpy = make_fake_bpy(devices=[], with_cycles=False)  # no cycles addon -> EEVEE_NEXT
        output = self._run(bpy, sample_graph())

        scene = bpy.context.scene
        self.assertEqual(scene.render.engine, "BLENDER_EEVEE_NEXT")
        self.assertTrue(scene.render.film_transparent)
        self.assertEqual(scene.frame_start, 1)
        self.assertEqual(scene.frame_end, 10)
        self.assertTrue(scene.render.filepath.endswith("f_"))
        self.assertTrue(out_dir_ok(self.out_dir, scene.render.filepath))
        self.assertEqual(scene.view_settings.view_transform, "AgX")
        self.assertIn("ULTRA_BLENDER_SUMMARY=", output)
        self.assertIn('"backend": "blender_eevee_next"', output)
        self.assertEqual(bpy.ops.render.calls, [{"animation": True}])

        # Camera + keyframes
        cameras = [o for o in bpy.data.objects.items if o.name == "ultra_camera"]
        self.assertEqual(len(cameras), 1)
        camera = cameras[0]
        self.assertAlmostEqual(math.degrees(camera.data.angle), 45, places=3)
        self.assertIn(("location", 1), camera.keyframes)
        self.assertIn(("location", 11), camera.keyframes)
        self.assertIn(("rotation_euler", 11), camera.keyframes)

        # Lights: point + directional objects, ambient drives the world background.
        light_names = {o.name for o in bpy.data.objects.items}
        self.assertTrue({"key", "sun"}.issubset(light_names))
        ambient = bpy.data.worlds.items[0].node_tree.nodes.get("Background")
        self.assertAlmostEqual(ambient.inputs[1].default_value, 0.6 * 0.35, places=5)

        # Materials: renamed Principled inputs are populated (new-style names).
        materials = {m.name: m for m in bpy.data.materials.items}
        secondary = materials["secondary"]
        bsdf = secondary.node_tree.nodes.get("Principled BSDF")
        self.assertAlmostEqual(bsdf.inputs["Metallic"].default_value, 0.1)
        self.assertAlmostEqual(bsdf.inputs["Roughness"].default_value, 0.6)
        self.assertAlmostEqual(bsdf.inputs["Coat Weight"].default_value, 0.4)
        self.assertAlmostEqual(bsdf.inputs["Transmission Weight"].default_value, 0.1)
        self.assertAlmostEqual(bsdf.inputs["Subsurface Weight"].default_value, 0.2)
        self.assertAlmostEqual(bsdf.inputs["Emission Strength"].default_value, 2)
        self.assertGreater(len(bsdf.inputs["Alpha"].keyframes), 0)

        # Meshes: sphere via bmesh op, torus via raw verts/faces, transforms applied.
        self.assertIn("create_uvsphere", bpy.bmesh.call_log)
        torus = [o for o in bpy.data.objects.items if o.name == "torus"][0]
        sphere = [o for o in bpy.data.objects.items if o.name == "sphere"][0]
        self.assertGreater(torus.data.vertex_count, 400)
        self.assertGreater(sphere.data.vertex_count, 0)
        self.assertAlmostEqual(torus.scale[0], 1.2)
        self.assertIn(("rotation_euler", 1), torus.keyframes)
        self.assertIn(("location", 1), sphere.keyframes)
        self.assertIn(("location", 11), sphere.keyframes)
        self.assertEqual(len(bpy.bmesh.call_log) >= 1, True)

    def test_cycles_gpu_selection(self):
        bpy = make_fake_bpy(devices=["CUDA"], with_cycles=True)
        output = self._run(bpy, sample_graph(0.5))
        scene = bpy.context.scene
        self.assertEqual(scene.render.engine, "CYCLES")
        self.assertEqual(scene.cycles.device, "GPU")
        self.assertEqual(scene.cycles.samples, 32)
        prefs = bpy.context.preferences.addons["cycles"].preferences
        self.assertTrue(all(device.use for device in prefs.devices))
        self.assertIn('"backend": "cycles-cuda"', output)

    def test_cycles_cpu_fallback_when_no_gpu(self):
        bpy = make_fake_bpy(devices=[], with_cycles=True)
        output = self._run(bpy, sample_graph(0.5))
        scene = bpy.context.scene
        self.assertEqual(scene.render.engine, "CYCLES")
        self.assertEqual(scene.cycles.device, "CPU")
        self.assertEqual(scene.cycles.samples, 48)
        self.assertIn('"backend": "cycles-cpu"', output)

    def test_legacy_bsdf_input_names(self):
        bpy = make_fake_bpy(devices=[], with_cycles=False, legacy_bsdf=True)
        graph = sample_graph(0.5)
        graph["meshes"] = []
        self._run(bpy, graph)
        materials = {m.name: m for m in bpy.data.materials.items}
        legacy = materials["secondary"]
        bsdf = legacy.node_tree.nodes.get("Principled BSDF")
        self.assertAlmostEqual(bsdf.inputs["Specular"].default_value, 0.5)
        self.assertAlmostEqual(bsdf.inputs["Clearcoat"].default_value, 0.4)
        self.assertAlmostEqual(bsdf.inputs["Transmission"].default_value, 0.1)
        self.assertAlmostEqual(bsdf.inputs["Subsurface"].default_value, 0.2)
        self.assertIsNotNone(bsdf.inputs["Emission"].default_value)


def out_dir_ok(out_dir, filepath):
    """Compare paths across Windows separators without platform surprises."""
    return Path(os.path.normpath(filepath)).parent == Path(os.path.normpath(out_dir))


if __name__ == "__main__":
    unittest.main(verbosity=2)

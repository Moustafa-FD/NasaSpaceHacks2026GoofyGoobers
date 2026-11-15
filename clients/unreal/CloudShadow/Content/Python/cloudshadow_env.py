"""
Footprint Atlas - the 2021 meadow at xAI Colossus 2, rebuilt in 3D (editor Python, UE 5.8 + Cesium).

The "after" world is Google Photorealistic 3D Tiles (real 3D capture of today). For the "before",
the land that NASA HLS imagery shows changed between 2021 and 2025 is clipped out of the Google tiles
and rebuilt as the meadow it was: Megascans grass + flowers, Megaplants (Nanite) trees.

The zone is split into NSTRIP north-south strips so Sequencer can sweep the change across the land
behind a "satellite scan" line: each strip has a meadow actor (FA_Meadow_k) and a scraped-ground
actor (FA_Rubble_k) whose visibility is keyed.

    import cloudshadow_env as env
    env.build()            # clip + ground + meadow + trees + rubble + rising hall (re-runnable)
    env.state("before")    # meadow, Google halls clipped out
    env.state("after")     # real Google 3D, our meadow hidden

Zone geometry comes from comparing NASA HLS 30 m imagery of 2021-07-04 and 2025-06-10 on a 250 m
grid (new north hall + scraped land); the south hall predates 2021 and is left untouched.
"""
import math
import random

import unreal

import cloudshadow_setup as cs

TAG = "CloudShadowEnv"
FOLDER = "CloudShadow/Env"
C2 = (-90.0349, 34.9980)                 # xAI Colossus 2 (data/cloudshadow/sites.json)
ZONE_E, ZONE_N = (-560.0, 160.0), (-290.0, 300.0)      # metres east/north of C2: built 2021 -> 2025
HERO_E, HERO_N = (-330.0, -20.0), (-290.0, -60.0)      # shot 3 close-up: full density
HALL = (-144.0, 122.0, -264.0, 288.0)                  # new north hall footprint (E0, E1, N0, N1)
NSTRIP = 9                                             # 80 m strips, west -> east
TILE = 80.0                                            # ground tile size (m)
SEED = 2021
GROUND_H = 61.75   # ellipsoid height of open ground in the zone (line trace on Google tiles, 2026-11-14)

MS = "/Game/Fab/Megascans/Plants/"
GRASS = [MS + "Wild_Grass_vlkhcbxia/Medium/vlkhcbxia_tier_2/StaticMeshes/SM_vlkhcbxia_Var" + v for v in "ABCDE"] + \
        [MS + "Grass_Clumps_rbdoo/Medium/rbdoo_tier_2/StaticMeshes/SM_rbdoo_Var" + v for v in "ABC"]
FLOWERS = {   # mesh list, share of flower instances, cluster radius (m)
    "goldenrod": ([MS + "Goldenrods_xg1lbfxia/Medium/xg1lbfxia_tier_2/StaticMeshes/SM_xg1lbfxia_Var" + v for v in "ABCDE"], 0.40, 9.0),
    "everlasting": ([MS + "White_Everlasting_ucvobbbia/Medium/ucvobbbia_tier_2/StaticMeshes/SM_ucvobbbia_Var" + v for v in "ACDE"], 0.25, 6.0),
    "poppy": ([MS + "Field_Poppy_vmcobd0ja/Medium/vmcobd0ja_tier_2/StaticMeshes/SM_vmcobd0ja_Var" + v for v in "ABCE"], 0.20, 5.0),
    "sorrel": ([MS + "Violet_Wood_Sorrel_uchkajuia/Medium/uchkajuia_tier_2/StaticMeshes/SM_uchkajuia_Var" + v for v in "BDGH"], 0.15, 4.0),
}
TREES = {
    "oak": ["/Game/Megaplant_Library/Tree_English_Oak/Tree_English_Oak_Forest_01/Tree_English_Oak_Forest_01_" + v for v in "ABCD"],
    "maple": ["/Game/Megaplant_Library/Tree_Norway_Maple/Tree_Norway_Maple_Forest_01/Tree_Norway_Maple_Forest_01_" + v for v in "ABC"],
    "hornbeam": ["/Game/Megaplant_Library/Tree_Hornbeam/Tree_Hornbeam_01/Tree_Hornbeam_01_" + v for v in "ABCD"],
}
HERO_TREES = [(-262, -150, "oak", 0), (-96, -118, "oak", 1), (-205, 35, "oak", 0), (-55, 70, "hornbeam", 0),
              (-310, -40, "oak", 2), (-150, -235, "hornbeam", 2), (-238, -212, "oak", 1), (-120, -190, "hornbeam", 0),
              (-290, -95, "hornbeam", 3), (-70, -20, "oak", 0), (-175, 160, "oak", 1), (-20, 140, "hornbeam", 2)]
SRF_PARENT = "/Game/Fab/Megascans/Surfaces/Ground_Rubble_vl3jbbcg/Medium/vl3jbbcg_tier_2/Materials/MI_vl3jbbcg"
MOSS_TEX = "/Game/Fab/Megascans/3D/Nordic_Mossy_Ground_vi2ldcomw/Medium/vi2ldcomw_tier_2/Textures/T_vi2ldcomw_2K_"
MAT_MEADOW = "/Game/CloudShadow/Materials/MI_FA_MeadowSoil"
MAT_RUBBLE = "/Game/CloudShadow/Materials/MI_FA_Rubble"

log = unreal.log
warn = unreal.log_warning
_es = lambda: unreal.get_editor_subsystem(unreal.EditorActorSubsystem)


# ------------------------------------------------------------------ helpers
def _offset(e, n):
    return (C2[0] + e / (111320.0 * math.cos(math.radians(C2[1]))), C2[1] + n / 111320.0)


def _strip_bounds(k):
    w = (ZONE_E[1] - ZONE_E[0]) / NSTRIP
    return ZONE_E[0] + k * w, ZONE_E[0] + (k + 1) * w


def _spawn(cls, label, folder=FOLDER):
    a = _es().spawn_actor_from_class(cls, unreal.Vector(0, 0, 0))
    a.set_actor_label(label)
    a.set_folder_path(folder)
    a.tags = list(a.tags) + [TAG]
    return a


def _remove_tagged():
    for a in _es().get_all_level_actors():
        if TAG in [str(t) for t in a.tags]:
            _es().destroy_actor(a)


def find(label):
    return next((a for a in _es().get_all_level_actors() if a.get_actor_label() == label), None)


def _google():
    return next((a for a in _es().get_all_level_actors() if a.get_actor_label().startswith("Google Photorealistic")), None)


def _local(e, n, z=0.0):
    """Offset (m east, m north) from a strip/container origin -> Unreal local vector (cm).
    Cesium frame near the origin: +X east, +Y south."""
    return unreal.Vector(e * 100.0, -n * 100.0, z * 100.0)


def ground_height():
    """Ellipsoid height of the ground in the zone, from line traces onto the Google tiles at points
    outside the hall roofs (median; the site is flat). Run before clipping matters - physics stays."""
    world = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    geo = next(a for a in _es().get_all_level_actors() if isinstance(a, unreal.CesiumGeoreference))
    hs = []
    for e, n in ((-450, 0), (-400, -200), (-480, 200), (-300, 100), (-250, -150), (-350, -250)):
        lon, lat = _offset(e, n)
        top = geo.transform_longitude_latitude_height_position_to_unreal(unreal.Vector(lon, lat, 600.0))
        bot = geo.transform_longitude_latitude_height_position_to_unreal(unreal.Vector(lon, lat, -200.0))
        hit = unreal.SystemLibrary.line_trace_single(world, top, bot, unreal.TraceTypeQuery.ECC_VISIBILITY, True, [],
                                                     unreal.DrawDebugTrace.NONE, True)
        if hit and hit.to_tuple()[0]:          # None when tiles' collision isn't streamed in (editor in background)
            hs.append(geo.transform_unreal_position_to_longitude_latitude_height(hit.to_tuple()[4]).z)
    hs.sort()
    h = hs[len(hs) // 2] if hs else GROUND_H
    log("Footprint Atlas env: ground height %.1f m (samples %s)" % (h, [round(x, 1) for x in hs]))
    return h


def _material(path, parent, textures, scalars, tint=None):
    """Material instance of a Megascans surface master (tiling UVs), created once."""
    M = unreal.MaterialEditingLibrary
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        mi = unreal.load_asset(path)                                     # re-apply parameters on rebuilds
    else:
        folder, name = path.rsplit("/", 1)
        mi = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, folder, unreal.MaterialInstanceConstant,
                                                                     unreal.MaterialInstanceConstantFactoryNew())
        M.set_material_instance_parent(mi, unreal.load_asset(parent).get_editor_property("parent"))
        src = unreal.load_asset(parent)
        for n in M.get_texture_parameter_names(src):                   # start from the parent's textures
            M.set_material_instance_texture_parameter_value(mi, n, M.get_material_instance_texture_parameter_value(src, n))
    for n, t in textures.items():
        M.set_material_instance_texture_parameter_value(mi, n, unreal.load_asset(t))
    for n, v in scalars.items():
        M.set_material_instance_scalar_parameter_value(mi, n, v)
    if tint:
        M.set_material_instance_vector_parameter_value(mi, "BaseColor Tint", unreal.LinearColor(*tint))
    unreal.EditorAssetLibrary.save_loaded_asset(mi)
    return mi


def _hism(actor, mesh_path, name, shadows=True, cull=None):
    comp = cs._add_component(actor, unreal.HierarchicalInstancedStaticMeshComponent, name)
    comp.set_static_mesh(unreal.load_asset(mesh_path))
    comp.set_mobility(unreal.ComponentMobility.MOVABLE)
    cs._set(comp, cast_shadow=shadows)
    comp.set_collision_enabled(unreal.CollisionEnabled.NO_COLLISION)
    if cull:
        comp.set_cull_distances(cull[0], cull[1])
    return comp


def _xf(e, n, yaw, s, z=0.0, sz=None):
    return unreal.Transform(location=_local(e, n, z), rotation=unreal.Rotator(0.0, 0.0, yaw),
                            scale=unreal.Vector(s, s, s if sz is None else sz))


# ------------------------------------------------------------------ build
def enable_nanite_foliage():
    """Nanite on the Megascans grass/flower meshes (masked foliage, preserve area)."""
    n = 0
    for p in GRASS + [m for ms, _, _ in FLOWERS.values() for m in ms]:
        m = unreal.load_asset(p)
        ns = m.get_editor_property("nanite_settings")
        if not ns.enabled:
            ns.enabled = True
            try:
                ns.preserve_area = True
            except Exception:
                pass
            m.set_editor_property("nanite_settings", ns)
            unreal.EditorAssetLibrary.save_loaded_asset(m)
            n += 1
    log("Footprint Atlas env: Nanite enabled on %d foliage meshes" % n)


def build_clip():
    """Cut the changed land out of the Google 3D tiles (CesiumCartographicPolygon + polygon overlay)."""
    g = _google()
    poly = _spawn(unreal.CesiumCartographicPolygon, "FA_ClipZone")
    pts = [unreal.Vector(*_offset(e, n), 0.0) for e, n in
           ((ZONE_E[0], ZONE_N[1]), (ZONE_E[1], ZONE_N[1]), (ZONE_E[1], ZONE_N[0]), (ZONE_E[0], ZONE_N[0]))]
    poly.set_polygon_points(unreal.CesiumCoordinateReferenceSystem.LONGITUDE_LATITUDE_HEIGHT, pts)
    for c in g.get_components_by_class(unreal.CesiumPolygonRasterOverlay):
        if c.get_name() == "FA_Clip":
            c.destroy_component(g)
    ov = cs._add_component(g, unreal.CesiumPolygonRasterOverlay, "FA_Clip")
    cs._set(ov, polygons=[poly], material_layer_key="Clipping", invert_selection=False, exclude_selected_tiles=True)
    ov.refresh()
    return ov


def _ground_tiles(actor, name, mat, e0, e1, n0, n1, z):
    comp = _hism(actor, "/Engine/BasicShapes/Plane", name, shadows=False)
    comp.set_material(0, mat)
    xs = []
    e = e0
    while e < e1 - 0.1:
        n = n0
        while n < n1 - 0.1:
            xs.append(_xf(e + TILE / 2 - actor_e(actor), n + TILE / 2 - actor_n(actor), 0.0, TILE * 1.02, z, 1.0))   # 2% overlap hides seams
            n += TILE
        e += TILE
    comp.add_instances(xs, False, False)


_origin = {}


def actor_e(a):
    return _origin[a.get_actor_label()][0]


def actor_n(a):
    return _origin[a.get_actor_label()][1]


def _container(label, e, n, h):
    a = _spawn(unreal.StaticMeshActor, label)
    a.static_mesh_component.set_mobility(unreal.ComponentMobility.MOVABLE)
    cs._anchor(a, *_offset(e, n), h)
    a.set_actor_rotation(unreal.Rotator(0, 0, 0), False)      # keep +X east / +Y south (no ellipsoid tilt)
    _origin[label] = (e, n)
    return a


def build(density=1.0, seed=SEED):
    """Everything for the before/after: clip, meadow strips, trees, rubble strips, rising hall."""
    rnd = random.Random(seed)
    _remove_tagged()
    h = ground_height()
    meadow_mat = _material(MAT_MEADOW, SRF_PARENT,
                           {"BaseColorTexture": MOSS_TEX + "B", "NormalTexture": MOSS_TEX + "N", "MetallicRoughnessTexture": MOSS_TEX + "ORM"},
                           {"Tiling": TILE / 6.0, "Saturation": 1.1, "Brightness": 0.6, "Min Roughness": 0.85, "Max Roughness": 1.0, "Specular": 0.2}, tint=(0.42, 0.52, 0.28, 1.0))
    rubble_mats = [_material(MAT_RUBBLE + sfx, SRF_PARENT, {}, {"Tiling": TILE / tl, "Brightness": br, "Min Roughness": 0.8},
                             tint=tn) for sfx, tl, br, tn in (("", 4.0, 1.0, (1.0, 0.90, 0.78, 1.0)),
                                                             ("_B", 3.0, 0.8, (0.92, 0.80, 0.66, 1.0)),
                                                             ("_C", 5.0, 1.2, (1.0, 0.96, 0.90, 1.0)))]
    build_clip()
    for mi_path in (MS + "Wild_Grass_vlkhcbxia/Medium/vlkhcbxia_tier_2/Materials/MI_vlkhcbxia",
                    MS + "Grass_Clumps_rbdoo/Medium/rbdoo_tier_2/Materials/MI_rbdoo"):
        mi = unreal.load_asset(mi_path)
        unreal.MaterialEditingLibrary.set_material_instance_vector_parameter_value(mi, "Base Color Tint", unreal.LinearColor(0.62, 0.95, 0.42, 1.0))
        unreal.EditorAssetLibrary.save_loaded_asset(mi)

    # flower patches (shared across strips so clusters don't stop at strip edges)
    patches = []
    for kind, (_, share, rad) in FLOWERS.items():
        for _ in range(int(260 * share * density)):
            patches.append((kind, rnd.uniform(*ZONE_E), rnd.uniform(*ZONE_N), rad * rnd.uniform(0.6, 1.5)))

    for k in range(NSTRIP):
        e0, e1 = _strip_bounds(k)
        ec, nc = (e0 + e1) / 2, (ZONE_N[0] + ZONE_N[1]) / 2
        m = _container("FA_Meadow_%d" % k, ec, nc, h)
        _ground_tiles(m, "Soil", meadow_mat, e0, e1, ZONE_N[0], ZONE_N[1], -0.05)
        # grass: dense in the hero strip, lighter (bigger clumps) elsewhere
        comps = [_hism(m, p, "Grass_%d" % i) for i, p in enumerate(GRASS)]          # no distance culling: it fades from 0
        buckets = [[] for _ in comps]
        # random scatter (a jittered grid reads as stripes from the air): a light layer over the whole
        # strip, plus a dense layer where the strip overlaps the shot-3 hero area
        def scatter(ea, eb, na, nb, step, smin, smax):
            for _ in range(int((eb - ea) * (nb - na) / (step * step) * density)):
                i = rnd.randrange(len(comps))
                buckets[i].append(_xf(rnd.uniform(ea, eb) - ec, rnd.uniform(na, nb) - nc, rnd.uniform(0, 360), rnd.uniform(smin, smax)))
        scatter(e0, e1, ZONE_N[0], ZONE_N[1], 0.8, 2.2, 3.3)
        he0, he1 = max(e0, HERO_E[0]), min(e1, HERO_E[1])
        if he0 < he1:
            scatter(he0, he1, HERO_N[0], HERO_N[1], 0.45, 1.4, 2.2)
        for c, b in zip(comps, buckets):
            if b:
                c.add_instances(b, False, False)
        # flowers in patches
        fl = {}
        for kind, pe, pn, rad in patches:
            if not (e0 - rad <= pe <= e1 + rad):
                continue
            hero = HERO_E[0] <= pe <= HERO_E[1] and HERO_N[0] <= pn <= HERO_N[1]
            for _ in range(int((160 if hero else 60) * density)):
                a, r = rnd.uniform(0, 2 * math.pi), rad * math.sqrt(rnd.random())
                fe, fn = pe + r * math.cos(a), pn + r * math.sin(a)
                if e0 <= fe < e1 and ZONE_N[0] <= fn <= ZONE_N[1]:
                    meshes = FLOWERS[kind][0]
                    fl.setdefault((kind, rnd.randrange(len(meshes))), []).append(
                        _xf(fe - ec, fn - nc, rnd.uniform(0, 360), rnd.uniform(0.9, 1.3)))
        for (kind, i), xs in fl.items():
            _hism(m, FLOWERS[kind][0][i], "%s_%d" % (kind, i)).add_instances(xs, False, False)
        # trees belong to the strip, so they disappear with it
        for (te, tn, kind, var, s) in _trees_in(e0, e1, rnd):
            t = cs._add_component(m, unreal.SkeletalMeshComponent, "Tree_%d_%d" % (int(te), int(tn)))
            t.set_skeletal_mesh_asset(unreal.load_asset(TREES[kind][var]))
            t.set_relative_transform(_xf(te - ec, tn - nc, rnd.uniform(0, 360), s), False, False)
            cs._set(t, cast_shadow=True)

        r = _container("FA_Rubble_%d" % k, ec, nc, h)
        lots = [_hism(r, "/Engine/BasicShapes/Plane", "Rubble_%d" % i, shadows=False) for i in range(len(rubble_mats))]
        for c_, m_ in zip(lots, rubble_mats):
            c_.set_material(0, m_)
        nn, buckets_r = ZONE_N[0], [[] for _ in lots]
        while nn < ZONE_N[1] - 0.1:
            buckets_r[rnd.randrange(len(lots))].append(_xf(e0 + TILE / 2 - ec, nn + TILE / 2 - nc, 0.0, TILE * 1.02, 0.03, 1.0))
            nn += TILE
        for c_, b_ in zip(lots, buckets_r):
            if b_:
                c_.add_instances(b_, False, False)
        r.set_actor_hidden_in_game(True)
        r.set_is_temporarily_hidden_in_editor(True)
        log("Footprint Atlas env: strip %d/%d (E %.0f..%.0f) built" % (k + 1, NSTRIP, e0, e1))
    build_hall(h)
    state("before")
    log("Footprint Atlas env: built. state('before') active.")


def _trees_in(e0, e1, rnd):
    """Hero trees + a dense tree line on the west and north edges + a few meadow clumps."""
    out = []
    for te, tn, kind, var in HERO_TREES:
        if e0 <= te < e1:
            out.append((te, tn, kind, var, rnd.uniform(1.3, 1.6)))
    e = e0
    while e < e1:
        for _ in range(4):                                   # north edge, four rows
            tn = ZONE_N[1] - rnd.uniform(3, 22)
            out.append((e + rnd.uniform(-3, 3), tn, rnd.choice(["oak", "oak", "hornbeam", "maple"]), rnd.randrange(3), rnd.uniform(1.1, 1.5)))
        e += rnd.uniform(7, 11)
    if e0 <= ZONE_E[0] + 1:                                  # west edge, three rows
        n = ZONE_N[0]
        while n < ZONE_N[1]:
            for _ in range(5):
                out.append((ZONE_E[0] + rnd.uniform(2, 45), n + rnd.uniform(-3, 3), rnd.choice(["oak", "hornbeam", "oak"]), rnd.randrange(3), rnd.uniform(1.1, 1.5)))
            n += rnd.uniform(6, 10)
    for (se, sn) in SAVANNA:                                 # scattered big oaks (open oak savanna)
        if e0 <= se < e1:
            out.append((se, sn, "oak" if rnd.random() < 0.75 else "hornbeam", rnd.randrange(3), rnd.uniform(1.25, 1.65)))
    for ce, cn in ((-470, 120), (-420, -180), (-60, 210), (40, -120), (-330, 230), (-120, 40), (-480, -40), (90, 120), (-260, 200), (-20, -230)):   # clumps (dark patches in 2021 HLS)
        if e0 <= ce < e1:
            for _ in range(26):
                out.append((ce + rnd.gauss(0, 12), cn + rnd.gauss(0, 12), rnd.choice(["oak", "hornbeam"]), rnd.randrange(4), rnd.uniform(0.85, 1.2)))
    return out


def _savanna(seed=7, n=150, min_gap=19.0):
    """Big trees scattered over the meadow with a minimum spacing, kept off the shot-3 flight line."""
    rnd, pts = random.Random(seed), []
    while len(pts) < n:
        e, nn = rnd.uniform(ZONE_E[0] + 40, ZONE_E[1] - 20), rnd.uniform(ZONE_N[0] + 25, ZONE_N[1] - 40)
        if abs(e - (-185)) < 22 and nn < 120:                # keep the low glide path clear
            continue
        if all((e - a) ** 2 + (nn - b) ** 2 > min_gap ** 2 for a, b in pts):
            pts.append((e, nn))
    return pts


SAVANNA = _savanna()


HALL_H = 14.0                             # m, the hall's height


def build_hall(h):
    """Our stand-in for the new north hall: it drops out of the sky in shot 4 (Google's real hall
    takes over in shot 5). Unscaled container (pivot at ground level) with the body and rooftop
    plant as child components, so the drop can be keyed on the actor alone."""
    white = cs._emissive_material("/Game/CloudShadow/Materials/M_HallWhite", (0.82, 0.84, 0.86), 0.0)
    grey = cs._emissive_material("/Game/CloudShadow/Materials/M_HallPlant", (0.30, 0.32, 0.34), 0.0)
    cube = unreal.load_asset("/Engine/BasicShapes/Cube")
    e0, e1, n0, n1 = HALL
    hall = _container("FA_Hall", (e0 + e1) / 2, (n0 + n1) / 2, h)
    sx, sy = e1 - e0, n1 - n0
    body = cs._add_component(hall, unreal.StaticMeshComponent, "Body")
    body.set_static_mesh(cube)
    body.set_material(0, white)
    body.set_relative_transform(unreal.Transform(location=unreal.Vector(0, 0, HALL_H * 50.0),
                                                 scale=unreal.Vector(sx, sy, HALL_H)), False, False)
    # rooftop cooling units: rows of chillers, like the real halls
    units = _hism(hall, "/Engine/BasicShapes/Cube", "RoofUnits")
    units.set_material(0, grey)
    xs = []
    for i in range(10):
        for j in range(24):
            e = -sx / 2 + 18 + i * (sx - 36) / 9
            n = -sy / 2 + 20 + j * (sy - 40) / 23
            xs.append(unreal.Transform(location=_local(e, n, HALL_H + 1.4), scale=unreal.Vector(9.0, 5.0, 2.8)))
    units.add_instances(xs, False, False)
    hall.set_actor_hidden_in_game(True)
    hall.set_is_temporarily_hidden_in_editor(True)


# ------------------------------------------------------------------ states
def _show(a, on):
    a.set_actor_hidden_in_game(not on)
    a.set_is_temporarily_hidden_in_editor(not on)


def clip(on):
    """Cut (before) or restore (after) the change zone in the Google tiles. Deactivating the overlay
    component isn't enough - the clipping stays baked into loaded tiles - so swap the polygon list
    and refresh."""
    g, poly = _google(), find("FA_ClipZone")
    for c in g.get_components_by_class(unreal.CesiumPolygonRasterOverlay):
        if c.get_name() == "FA_Clip":
            c.set_editor_property("polygons", [poly] if (on and poly) else [])
            c.set_editor_property("exclude_selected_tiles", bool(on))
            c.refresh()


def hide_globe_terrain(hidden=True):
    """Cesium World Terrain (with the 30 m overlays) z-fights with Google 3D up close."""
    t = next((a for a in _es().get_all_level_actors() if a.get_actor_label() == "Cesium World Terrain"), None)
    if t:
        t.set_actor_hidden_in_game(hidden)
        t.set_is_temporarily_hidden_in_editor(hidden)
        t.root_component.set_visibility(not hidden, True)


def state(name, scanned=0):
    """'before': meadow everywhere, Google clipped. 'scan': first `scanned` strips turned to rubble.
    'after': real Google 3D everywhere, our actors hidden."""
    for k in range(NSTRIP):
        m, r = find("FA_Meadow_%d" % k), find("FA_Rubble_%d" % k)
        if not m:
            continue
        if name == "after":
            _show(m, False); _show(r, False)
        else:
            gone = name == "scan" and k < scanned
            _show(m, not gone); _show(r, gone)
    hall = find("FA_Hall")
    if hall:
        _show(hall, False)
    clip(name != "after")
    hide_globe_terrain(True)
    log("Footprint Atlas env: state %s%s" % (name, (" (%d strips scanned)" % scanned) if name == "scan" else ""))

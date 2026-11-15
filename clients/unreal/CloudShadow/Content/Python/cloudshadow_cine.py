"""
Footprint Atlas - 25 s cinematic intro (editor Python, UE 5.8 + Cesium for Unreal).

The story, in one breath: AI runs in real buildings -> here is a field in Memphis (2021) ->
a NASA satellite pass later it is an AI campus (2025) -> next door, gas turbines power the
first one, and NASA sees the air change -> Footprint Atlas measures this, with NASA data.

Menu:  Cloud Shadow > Cinematic: 1 / 2 / 3
Or in the Output Log (Python):
    import cloudshadow_cine as c
    c.build()            # look (clouds, fog, grade), cine camera, fluid plume, particles, scan beam
    c.build_sequence()   # /Game/CloudShadow/Cine/SEQ_FootprintAtlas - camera path + scan-beam sweep
    c.preview(5)         # put the level in beat 5's state (year, layer, sun, FX) to tune by eye
    c.render_film()      # Movie Render Queue slice by slice, then ffmpeg -> mp4 with titles + captions

A Cesium raster overlay can't be keyframed, so each beat is rendered as its own slice of one
continuous camera path, with the level state (NASA imagery year, data layer, sun, FX) set in
between. All slices write into one PNG sequence numbered by sequence frame, so a single ffmpeg
pass makes the film. The data is the web app's: timeline/<site>.json, hls_timeline.json and
CloudShadowSites.json (all computed with apps/web/js/stats.js).

Effects (plume, particles, scan beam) are visualizations driven by NASA data, never measured
concentrations; the end card says so. Everything spawned is tagged "CloudShadowCine".
"""
import json
import math
import os
import random
import subprocess

import unreal

import cloudshadow_env as env
import cloudshadow_setup as cs

TAG = "CloudShadowCine"
SEQ_DIR = "/Game/CloudShadow/Cine"
SEQ = SEQ_DIR + "/SEQ_FootprintAtlas"
FX_DIR = "/Game/CloudShadow/FX"
PLUME_SRC = "/NiagaraFluids/Templates/Gas/3D/Systems/Grid3D_Gas_ColoredSmoke"
PARTICLES_SRC = "/NiagaraFluids/Templates/Gas/3D/Systems/Grid3D_Gas_ParticleAdvection"
CLOUD_MAT = "/Engine/EngineSky/VolumetricClouds/m_SimpleVolumetricCloud_Inst"
MAT_SCAN = "/Game/CloudShadow/Materials/M_Scan"
FPS = 30
TOTAL = 900                       # 30 s (the challenge maximum)
OUT = os.path.abspath(os.path.join(unreal.Paths.project_saved_dir(), "Cine"))
TIMELINE = os.path.join(cs.REPO, "data", "cloudshadow", "unreal", "timeline")

log = unreal.log
warn = unreal.log_warning

# same coordinates as data/cloudshadow/sites.json
C1 = (-90.1564, 35.0601)          # xAI Colossus 1: converted factory + on-site gas turbines
C2 = (-90.0349, 34.9980)          # xAI Colossus 2: built on open land, 2021 field -> 2025 campus
BOX = (-90.1254, 35.0484)         # Boxtown, ~3 km ESE of Colossus 1
PLUME_AT = (-90.1590, 35.0607)    # turbine yard, just west of the Colossus 1 hall


# ------------------------------------------------------------------ the story (tune here)
C1_GROUND = 60.0                  # approx. ellipsoid height of the ground at Colossus 1 (m)
FOOTER = "3D reconstruction from NASA HLS satellite imagery (2021, 2025) · Google Photorealistic 3D Tiles"
POWER_FOOT = ("Reported: 150 MW grid supply + on-site gas turbines (Colossus 1); "
              "~500 MW from turbines (Colossus 2, single source)")
WATER_FOOT = ("Reported: 0.38–1.3 million gal/day (Colossus 1); "
              "up to 3.7 million gal/day requested (Colossus 1 + 2)")
AIR_FOOT = ("NASA TROPOMI: NO₂ above surroundings after mid-2024, borderline (p = 0.051) "
            "· the plume is a visualization")


def _key(f, cam, look, cut=False):
    """A camera key: frame, camera (lon, lat, h), look-at (lon, lat, h); cut=True holds the value
    until the next key (a hard cut instead of a fly-through)."""
    return (f, cam, look, cut)


def _c2(e, n, h):                 # metres east/north of Colossus 2, height above the meadow ground
    return (*env._offset(e, n), env.GROUND_H + h)


def _c1(e, n, h):
    return (*_offset(C1[0], C1[1], e, n), C1_GROUND + h)


def _orbit(f0, f1, at, center_en, r_m, h_m, b0, b1, n=4, cut_last=False):
    """Camera keys on a circle around a point (at = _c2 or _c1), bearing b0 -> b1 (deg from north)."""
    keys = []
    for i in range(n + 1):
        t = i / n
        b = math.radians(b0 + (b1 - b0) * t)
        cam = at(center_en[0] + r_m * math.sin(b), center_en[1] + r_m * math.cos(b), h_m)
        keys.append(_key(int(round(f0 + (f1 - f0) * t)), cam, at(center_en[0], center_en[1], 0.0),
                         cut=(cut_last and i == n)))
    return keys


HALL_C = ((env.HALL[0] + env.HALL[1]) / 2, (env.HALL[2] + env.HALL[3]) / 2)   # hall centre (E, N)
DROP = (324, 348)                 # the hall falls from the sky ... and hits the ground
TOTAL_S = 30


def camera_path():
    """The 30 s film: S1 planet, S2 dive, S3 BEFORE glide over the 2021 meadow, S4 the hall drops out
    of the sky (wide), S5 the real campus (Google 3D), S6 POWER, S7 WATER, S8 AIR (Colossus 1
    turbine plume over homes), S9 back to the planet for the title."""
    hx, hy = HALL_C
    p = [
        _key(0,   (-98.0, 21.0, 9.0e6), (-90.0, 36.0, 0.0)),            # S1 the planet
        _key(75,  (-94.5, 26.5, 6.0e6), (-90.1, 35.3, 0.0)),
        _key(120, (-90.9, 33.4, 3.0e5), _c2(0, 0, 0)),                  # S2 dive through the clouds
        _key(145, (-90.25, 34.70, 2.0e4), _c2(-150, 0, 0)),
        _key(165, _c2(-200, -420, 70), _c2(-150, 160, 0)),              #    settle over the meadow
        _key(180, _c2(-190, -265, 9), _c2(-150, 160, 0)),               # S3 BEFORE: low glide north
        _key(299, _c2(-172, -85, 15), _c2(-150, 260, 0), cut=True),
        _key(300, _c2(-470, -760, 175), _c2(hx, hy, 260)),              # S4 wide: sky above the meadow
        _key(330, _c2(-480, -770, 178), _c2(hx, hy, 300)),              #    the hall enters from the top
        _key(348, _c2(-490, -785, 180), _c2(hx, hy, 60)),               #    ...follow it down to the impact
        _key(389, _c2(-520, -820, 200), _c2(hx, hy, 40), cut=True),     #    dust rolls out
    ]
    p += _orbit(390, 479, _c2, (-40, 0), 650, 300, 205, 235, cut_last=True)    # S5 the real campus
    p += [
        _key(480, _c2(-760, -560, 110), _c2(-260, -200, 10)),           # S6 POWER: grid into the halls
        _key(569, _c2(-640, -470, 140), _c2(-150, -120, 10), cut=True),
        _key(570, _c2(-207, -49, 10.0), _c2(-200, -40, 0.0)),             # S7 WATER: close dolly over the basin
        _key(659, _c2(-203, -44, 6.5), _c2(-200, -40, 0.0), cut=True),
        _key(660, _c1(900, -700, 120), (*PLUME_AT, C1_GROUND + 150)),   # S8 AIR: turbine plume over homes
        _key(779, _c1(620, -400, 180), (*PLUME_AT, C1_GROUND + 210)),
        _key(900, (-91.5, 32.5, 2.8e6), (-90.1, 35.3, 0.0)),            # S9 back to the planet: title
    ]
    return p


def _data():
    sites = {x["id"]: x for x in json.load(open(cs.SITES_JSON, encoding="utf-8"))["sites"]}
    return sites


def story():
    """Render slices: (start, end, state). Each slice sets the level state that Sequencer cannot key
    (Google clip on/off = before/after, sun, FX). Category titles, no charts; any number shown sits in
    the small source footer, straight from the sourced ledger / NASA results."""
    base = dict(env="before", sun=19.2, plume=False, particles=False, power=False, water=False, haze=None,
                grade="natural", stamp="", caption="", footer="", focus=(-160, 120))

    def beat(f0, f1, **kw):
        st = dict(base)
        st.update(kw)
        return (f0, f1, st)

    return [
        beat(0, 165, grade="space", haze="space", caption="Every AI answer is computed in a real building, somewhere."),
        beat(165, 300, stamp="WHITEHAVEN, MEMPHIS · 2021", footer=FOOTER),
        beat(300, 348, stamp="2025", caption="Then, almost overnight…", focus=HALL_C, footer=FOOTER),
        beat(348, 370, stamp="2025", caption="Then, almost overnight…", focus=HALL_C, footer=FOOTER, haze="dust"),
        beat(370, 390, stamp="2025", caption="Then, almost overnight…", focus=HALL_C, footer=FOOTER, haze="settle"),
        beat(390, 480, env="after", sun=18.9, grade="dusk", focus=(-40, 0),
             stamp="xAI COLOSSUS 2", caption="An AI supercomputer", footer=FOOTER),
        beat(480, 570, env="after", sun=18.8, grade="dusk", power=True, focus=(-260, -200),
             stamp="POWER", caption="Hundreds of megawatts, around the clock", footer=POWER_FOOT),
        beat(570, 660, env="after", sun=15.8, grade="dusk", water=True, focus=(-200, -40, 1.0),
             stamp="WATER", caption="Millions of gallons a day to keep it cool", footer=WATER_FOOT),
        beat(660, 780, env="after", sun=19.7, grade="dusk", haze="smog", focus=None,
             stamp="AIR", caption="Gas turbines, next to homes", footer=AIR_FOOT),
        beat(780, 900, env="after", grade="space", haze="space"),
    ]


# kept for the caption code
def shots():
    return [(a, b, "colossus2", 0, "", st["caption"]) for a, b, st in story()]


TITLE = ("FOOTPRINT ATLAS", "The hidden footprint of data centers, measured from space with NASA data", 780, 900)
TITLE_NOTE = "Effects are visualizations driven by NASA data and sourced reports."

# post-process looks per beat: (saturation, white temp K, bloom, vignette, grain)
GRADES = {
    "space":   (1.05, 6500, 1.2, 0.55, 0.10),
    "natural": (1.12, 6100, 0.7, 0.40, 0.12),       # warm morning, the land before
    "after":   (0.92, 7000, 0.8, 0.45, 0.12),       # cooler, more clinical
    "dusk":    (1.08, 5200, 1.1, 0.55, 0.15),       # backlit smoke at golden hour
}


# ------------------------------------------------------------------ helpers
_probe = None


def _spawn(cls, label, folder, loc=unreal.Vector(0, 0, 0)):
    a = cs._actors().spawn_actor_from_class(cls, loc)
    a.set_actor_label(label)
    a.set_folder_path(folder)
    a.tags = list(a.tags) + [TAG]
    return a


def _remove_tagged():
    for a in cs._actors().get_all_level_actors():
        if TAG in [str(t) for t in a.tags]:
            cs._actors().destroy_actor(a)


def _find(label):
    return next((a for a in cs._actors().get_all_level_actors() if a.get_actor_label() == label), None)


def _find_class(cls):
    return next((a for a in cs._actors().get_all_level_actors() if isinstance(a, cls)), None)


def _offset(lon, lat, east_m, north_m):
    return (lon + east_m / (111320.0 * math.cos(math.radians(lat))), lat + north_m / 111320.0)


def _geo_to_unreal(lon, lat, height_m):
    """Geographic -> Unreal world coords via a throwaway globe-anchored probe actor.
    Uses only the Cesium calls cloudshadow_setup already relies on (verified in 5.8.3)."""
    global _probe
    if _probe is None:
        _probe = cs._actors().spawn_actor_from_class(unreal.StaticMeshActor, unreal.Vector(0, 0, 0))
        _probe.set_actor_label("CineProbe_TEMP")
    cs._anchor(_probe, lon, lat, height_m)
    return _probe.get_actor_location()


def _drop_probe():
    global _probe
    if _probe is not None:
        cs._actors().destroy_actor(_probe)
        _probe = None


def _copy_asset(src, name):
    """Copy an engine/plugin template into the project so it can be edited (wind, colours)."""
    dst = "%s/%s" % (FX_DIR, name)
    if unreal.EditorAssetLibrary.does_asset_exist(dst):
        return unreal.load_asset(dst)
    if not unreal.EditorAssetLibrary.does_asset_exist(src):
        warn("Footprint Atlas: %s not found (is the Niagara Fluids plugin enabled?)" % src)
        return None
    return unreal.EditorAssetLibrary.duplicate_asset(src, dst)


def _niagara(asset, label, lon, lat, h, folder="CloudShadow/Cine/FX"):
    a = _spawn(unreal.NiagaraActor, label, folder)
    a.niagara_component.set_asset(asset)
    cs._anchor(a, lon, lat, h)
    return a


def _try(fn, *args):
    try:
        fn(*args)
        return True
    except Exception as e:
        warn("Footprint Atlas: %s%s failed (%s)" % (getattr(fn, "__name__", fn), args[:1], e))
        return False


def _sun_light():
    sun = _find_class(unreal.CesiumSunSky) if hasattr(unreal, "CesiumSunSky") else None
    return sun, (sun.get_component_by_class(unreal.DirectionalLightComponent) if sun else None)


# ------------------------------------------------------------------ build: look + FX
def build():
    """Clouds, fog, post-process, cine camera + focus target, fluid plume, particles, scan beam."""
    _remove_tagged()
    _build_look()
    cam = _spawn(unreal.CineCameraActor, "CineCam_FootprintAtlas", "CloudShadow/Cine")
    cam.set_actor_location(_geo_to_unreal(*camera_path()[0][1]), False, False)
    cc = cam.camera_component
    cs._set(cc, current_focal_length=18.0, current_aperture=2.8)      # wide drone lens; DOF on the focus target
    focus = _spawn(unreal.StaticMeshActor, "CineFocus", "CloudShadow/Cine")
    try:                                        # depth of field follows the focus target: miniature look up close
        fs = cc.focus_settings
        fs.focus_method = unreal.CameraFocusMethod.TRACKING
        tfs = fs.tracking_focus_settings
        tfs.actor_to_track = focus
        fs.tracking_focus_settings = tfs
        fs.smooth_focus_changes = True
        cc.focus_settings = fs
    except Exception as e:
        warn("Footprint Atlas: tracking focus not set (%s); DOF stays off." % e)
    build_plume()
    build_scan_beam()
    build_dust_ring()
    build_flows()
    build_bolts()
    build_volumes()
    build_water()
    _drop_probe()
    log("Footprint Atlas: look + camera + FX built. Next: Cinematic 2 (sequence), then 3 (render).")
    return cam


def _build_look():
    """Volumetric clouds, height fog with volumetric fog (light shafts through the plume), and an
    unbound post-process volume. Lumen GI/reflections are on project-wide (DefaultEngine.ini)."""
    sky = _spawn(unreal.VolumetricCloud, "FA_VolumetricClouds", "CloudShadow/Cine/Look")
    comp = sky.get_component_by_class(unreal.VolumetricCloudComponent)
    if unreal.EditorAssetLibrary.does_asset_exist(CLOUD_MAT):
        cs._set(comp, material=unreal.load_asset(CLOUD_MAT))
    cs._set(comp, layer_bottom_altitude=2.2, layer_height=5.0)          # km: the dive passes through it

    fog = _spawn(unreal.ExponentialHeightFog, "FA_HeightFog", "CloudShadow/Cine/Look")
    cs._anchor(fog, C1[0], C1[1], 0.0)
    fc = fog.get_component_by_class(unreal.ExponentialHeightFogComponent)
    cs._set(fc, fog_density=0.0009, fog_height_falloff=0.02, enable_volumetric_fog=False,   # volumetric fog ends at a hard 'wall' in renders
            volumetric_fog_scattering_distribution=0.6, volumetric_fog_extinction_scale=1.5)

    ppv = _spawn(unreal.PostProcessVolume, "FA_PostProcess", "CloudShadow/Cine/Look")
    cs._set(ppv, unbound=True, priority=10.0)
    _grade("natural")


def _grade(name):
    ppv = _find("FA_PostProcess")
    if not ppv:
        return
    sat, temp, bloom, vig, grain = GRADES.get(name, GRADES["natural"])
    s = ppv.settings
    for k, v in (("bloom_intensity", bloom), ("vignette_intensity", vig), ("film_grain_intensity", grain),
                 ("white_temp", float(temp)), ("color_saturation", unreal.Vector4(sat, sat, sat, 1.0)),
                 ("scene_fringe_intensity", 0.25), ("motion_blur_amount", 0.4)):
        try:
            s.set_editor_property("override_" + k, True)
            s.set_editor_property(k, v)
        except Exception as e:
            warn("Footprint Atlas: post-process %s not set (%s)" % (k, e))
    ppv.settings = s


def build_plume():
    """Real 3D gas simulation (Niagara Fluids, Grid3D) on the Colossus 1 turbine yard, plus a
    particle-advection sim riding the same kind of flow. Size ~ NO2 site-minus-surroundings
    (TROPOMI); drift = NASA POWER prevailing wind. Visualization, not a measured concentration."""
    data = json.load(open(os.path.join(TIMELINE, "colossus1.json"), encoding="utf-8"))
    r = next(x for x in data["rows"] if int(x["Year"]) == data["lastObservedYear"])
    wind = _data()["colossus1"]["wind"]
    excess = max(0.0, (r.get("NO2_Site") or 0.0) - (r.get("NO2_Surround") or 0.0))
    k = 0.6 + 0.8 * min(1.0, excess / 0.6)                  # relative intensity, 0.6..1.4
    _, light = _sun_light()

    plume = _copy_asset(PLUME_SRC, "NS_TurbinePlume")
    if plume:
        a = _niagara(plume, "FA_TurbinePlume", PLUME_AT[0], PLUME_AT[1], 30.0)
        nc = a.niagara_component
        _try(nc.set_variable_vec3, "WorldSpaceSize", unreal.Vector(70000 * k, 70000 * k, 90000 * k))   # ~700 m domain
        _try(nc.set_variable_int, "ResolutionMaxAxis", 256)                   # cinematic detail (RTX laptop)
        if light:
            _try(nc.set_variable_object, "DirectionalLight1", light)          # self-shadowing from the real sun
        # Cesium frame at the origin: +X = east, +Y = south, so compass bearing -> yaw = bearing - 90
        a.set_actor_rotation(unreal.Rotator(0.0, 0.0, wind["plumeTowardDeg"] - 90.0), False)

    parts = _copy_asset(PARTICLES_SRC, "NS_PlumeParticles")
    if parts:
        p = _niagara(parts, "FA_PlumeParticles", PLUME_AT[0], PLUME_AT[1], 60.0)
        _try(p.niagara_component.set_variable_vec3, "WorldSpaceSize", unreal.Vector(90000 * k, 90000 * k, 90000 * k))
        _try(p.niagara_component.set_variable_int, "ResolutionMaxAxis", 160)
        p.set_actor_rotation(unreal.Rotator(0.0, 0.0, wind["plumeTowardDeg"] - 90.0), False)

    log("Footprint Atlas: plume intensity %.2f (NO2 excess %.3f e15). ONE MANUAL STEP: open %s/NS_TurbinePlume, "
        "select the gas emitter > Wind module: Local Space Wind = on, Wind Direction = (1, 0, 0), "
        "Wind Magnitude ~ %.0f (NASA POWER mean %.1f m/s, scaled for the 700 m domain). Same for NS_PlumeParticles."
        % (k, excess, FX_DIR, wind["meanWindSpeedMS"] * 60, wind["meanWindSpeedMS"]))


DUST_SRC = "/NiagaraFluids/Templates/Gas/3D/Systems/Grid3D_Gas_DustExplosion"


def build_dust():
    """The impact: a 3D gas dust explosion (Niagara Fluids) where the hall lands. Started by a
    Sequencer life-cycle track at the impact frame."""
    asset = _copy_asset(DUST_SRC, "NS_ImpactDust")
    if not asset:
        return
    hx, hy = (env.HALL[0] + env.HALL[1]) / 2, (env.HALL[2] + env.HALL[3]) / 2
    a = _niagara(asset, "FA_ImpactDust", *env._offset(hx, hy), env.GROUND_H + 2.0)
    nc = a.niagara_component
    cs._set(nc, auto_activate=False)
    _try(nc.set_variable_vec3, "WorldSpaceSize", unreal.Vector(110000.0, 110000.0, 40000.0))   # 1.1 km x 400 m
    _try(nc.set_variable_int, "ResolutionMaxAxis", 256)
    _, light = _sun_light()
    if light:
        _try(nc.set_variable_object, "DirectionalLight1", light)
    a.set_actor_hidden_in_game(True)
    a.set_is_temporarily_hidden_in_editor(True)
    return a


def build_scan_beam():
    """A glowing north-south bar that sweeps east across Colossus 2 like a satellite pass; the
    ground image changes year as it passes. Keyframed in build_sequence()."""
    mat = cs._emissive_material(MAT_SCAN, (0.25, 0.85, 1.0), 40.0)
    beam = _spawn(unreal.StaticMeshActor, "FA_ScanBeam", "CloudShadow/Cine/FX")
    smc = beam.static_mesh_component
    smc.set_mobility(unreal.ComponentMobility.MOVABLE)
    smc.set_static_mesh(unreal.load_asset("/Engine/BasicShapes/Cube"))
    smc.set_material(0, mat)
    cs._set(smc, cast_shadow=False)
    beam.set_actor_scale3d(unreal.Vector(0.01, 0.01, 0.01))     # hidden until the sweep (keyed)


# ------------------------------------------------------------------ POWER / WATER flows (S6, S7)
SUBSTATION = (-1250.0, -70.0)     # the real substation west of the campus (Google 3D), E/N of Colossus 2
PUMP = (-420.0, 10.0)             # pump house (illustrative) west of the hall
POWER_LINES = [[(SUBSTATION[0], SUBSTATION[1] + d, 24.0), (-700.0, -40.0 + d, 30.0), (-150.0, -30.0 + d, 17.0)]
               for d in (-14.0, 0.0, 14.0)]
WATER_PATH = [(PUMP[0], PUMP[1], -40.0), (PUMP[0], PUMP[1], 4.0), (-150.0, 10.0, 4.0), (-150.0, 10.0, 17.0),
              (-60.0, 10.0, 17.0)]
FLOW_SLICES = {"FA_PowerFX": (480, 570, 45), "FA_WaterFX": (570, 660, 60)}   # frames + pulse period


def _seg_actor(label, mat, a, b, thick):
    """A thin box from a to b (E, N, h above the meadow ground)."""
    pa, pb = _geo_to_unreal(*_c2(*a)), _geo_to_unreal(*_c2(*b))
    mid = (pa + pb) * 0.5
    act = _spawn(unreal.StaticMeshActor, label, "CloudShadow/Cine/Flows")
    smc = act.static_mesh_component
    smc.set_mobility(unreal.ComponentMobility.MOVABLE)
    smc.set_static_mesh(unreal.load_asset("/Engine/BasicShapes/Cube"))
    smc.set_material(0, mat)
    cs._set(smc, cast_shadow=False)
    act.set_actor_location(mid, False, False)
    act.set_actor_rotation(unreal.MathLibrary.find_look_at_rotation(pa, pb), False)
    act.set_actor_scale3d(unreal.Vector((pb - pa).length() / 100.0, thick, thick))
    return act


def _polyline_pos(pts, t):
    """Point at fraction t (0..1) along a polyline of Unreal vectors."""
    lens = [(pts[i + 1] - pts[i]).length() for i in range(len(pts) - 1)]
    d = t * sum(lens)
    for i, L in enumerate(lens):
        if d <= L or i == len(lens) - 1:
            u = min(1.0, d / L) if L else 0.0
            return pts[i] + (pts[i + 1] - pts[i]) * u, unreal.MathLibrary.find_look_at_rotation(pts[i], pts[i + 1])
        d -= L


def build_flows():
    """Cables/pipes plus glowing pulses. The pulses are keyed in build_sequence()."""
    power = cs._emissive_material("/Game/CloudShadow/Materials/M_PowerPulse", (1.0, 0.82, 0.45), 80.0)
    water = cs._emissive_material("/Game/CloudShadow/Materials/M_WaterPulse", (0.15, 0.55, 1.0), 60.0)
    cable = cs._emissive_material("/Game/CloudShadow/Materials/M_CableGlow", (0.35, 0.30, 0.22), 3.0)
    pipe = cs._emissive_material("/Game/CloudShadow/Materials/M_Pipe", (0.35, 0.38, 0.42), 0.0)
    made = []
    for li, line in enumerate(POWER_LINES):
        for si in range(len(line) - 1):
            made.append(_seg_actor("FA_PowerFX_Cable_%d_%d" % (li, si), cable, line[si], line[si + 1], 0.35))
        for k in range(5):
            made.append(_seg_actor("FA_PowerFX_Pulse_%d_%d" % (li, k), power, (0, 0, 0), (14, 0, 0), 1.1))
    for si in range(len(WATER_PATH) - 1):
        made.append(_seg_actor("FA_WaterFX_Pipe_%d" % si, pipe, WATER_PATH[si], WATER_PATH[si + 1], 1.6))
    made.append(_seg_actor("FA_WaterFX_PumpHouse", pipe, (PUMP[0] - 9, PUMP[1], 4.0), (PUMP[0] + 9, PUMP[1], 4.0), 9.0))
    for k in range(7):
        made.append(_seg_actor("FA_WaterFX_Pulse_%d" % k, water, (0, 0, 0), (9, 0, 0), 1.9))
    for a in made:
        a.set_actor_hidden_in_game(True)
        a.set_is_temporarily_hidden_in_editor(True)
    log("Footprint Atlas: %d power/water flow actors built" % len(made))


def _key_flows(seq):
    """Pulses travel along their paths, looping, only inside their slice."""
    lin = unreal.MovieSceneKeyInterpolation.LINEAR
    const = unreal.MovieSceneKeyInterpolation.CONSTANT
    jobs = []
    for li, line in enumerate(POWER_LINES):
        pts = [_geo_to_unreal(*_c2(*p)) for p in line]
        for k in range(5):
            jobs.append(("FA_PowerFX_Pulse_%d_%d" % (li, k), pts, k / 5.0 + li * 0.07, FLOW_SLICES["FA_PowerFX"]))
    wpts = [_geo_to_unreal(*_c2(*p)) for p in WATER_PATH]
    for k in range(7):
        jobs.append(("FA_WaterFX_Pulse_%d" % k, wpts, k / 7.0, FLOW_SLICES["FA_WaterFX"]))
    for label, pts, phase, (f0, f1, period) in jobs:
        a = _find(label)
        if not a:
            continue
        scl = a.get_actor_scale3d()
        b = seq.add_possessable(a)
        sec = b.add_track(unreal.MovieScene3DTransformTrack).add_section()
        sec.set_range(0, TOTAL)
        ch = sec.get_all_channels()
        prev_t = None
        for f in range(f0, f1 + 1, 3):
            t = ((f - f0) / float(period) + phase) % 1.0
            if prev_t is not None and t < prev_t:          # wrap: arrive at the end, then jump to the start
                end, erot = _polyline_pos(pts, 1.0)
                for c, v in zip(ch, (end.x, end.y, end.z, erot.roll, erot.pitch, erot.yaw, scl.x, scl.y, scl.z)):
                    c.add_key(unreal.FrameNumber(f - 1), float(v), interpolation=const)
            prev_t = t
            loc, rot = _polyline_pos(pts, t)
            for c, v in zip(ch, (loc.x, loc.y, loc.z, rot.roll, rot.pitch, rot.yaw, scl.x, scl.y, scl.z)):
                c.add_key(unreal.FrameNumber(f), float(v), interpolation=lin)


# ------------------------------------------------------------------ impact dust (deterministic)
MPC_PATH = "/Game/CloudShadow/Materials/MPC_FA"
DUST_MAT = "/Game/CloudShadow/Materials/M_FA_Dust"


def _mpc():
    """Material Parameter Collection with the scalars Sequencer animates (DustOpacity)."""
    if unreal.EditorAssetLibrary.does_asset_exist(MPC_PATH):
        return unreal.load_asset(MPC_PATH)
    folder, name = MPC_PATH.rsplit("/", 1)
    mpc = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, folder, unreal.MaterialParameterCollection,
                                                                  unreal.MaterialParameterCollectionFactoryNew())
    p = unreal.CollectionScalarParameter()
    p.set_editor_property("parameter_name", "DustOpacity")
    p.set_editor_property("default_value", 0.0)
    mpc.set_editor_property("scalar_parameters", [p])
    unreal.EditorAssetLibrary.save_loaded_asset(mpc)
    return mpc


def _dust_material():
    """Soft translucent dust: tan colour, opacity = (1 - fresnel) x noise x MPC.DustOpacity."""
    mpc = _mpc()
    if unreal.EditorAssetLibrary.does_asset_exist(DUST_MAT):        # rebuild the graph in place (it's referenced)
        mat = unreal.load_asset(DUST_MAT)
        unreal.MaterialEditingLibrary.delete_all_material_expressions(mat)
    else:
        folder, name = DUST_MAT.rsplit("/", 1)
        mat = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, folder, unreal.Material, unreal.MaterialFactoryNew())
    mat.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
    mat.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)   # sunlit dust glows; lit puffs read as clay
    mat.set_editor_property("two_sided", True)
    M = unreal.MaterialEditingLibrary
    col = M.create_material_expression(mat, unreal.MaterialExpressionConstant3Vector, -600, -200)
    col.set_editor_property("constant", unreal.LinearColor(0.78, 0.66, 0.50, 1.0))
    glow = M.create_material_expression(mat, unreal.MaterialExpressionMultiply, -400, -200)
    M.connect_material_expressions(col, "", glow, "A")
    glow.set_editor_property("const_b", 1.15)                 # ~ the sunlit ground's luminance at our exposure
    M.connect_material_property(glow, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    fres = M.create_material_expression(mat, unreal.MaterialExpressionFresnel, -900, 100)
    fres.set_editor_property("exponent", 1.2)
    inv0 = M.create_material_expression(mat, unreal.MaterialExpressionOneMinus, -760, 100)
    M.connect_material_expressions(fres, "", inv0, "")
    inv = M.create_material_expression(mat, unreal.MaterialExpressionPower, -640, 100)
    M.connect_material_expressions(inv0, "", inv, "Base")
    inv.set_editor_property("const_exponent", 2.5)
    noise = M.create_material_expression(mat, unreal.MaterialExpressionNoise, -900, 300)
    noise.set_editor_property("scale", 0.004)
    noise.set_editor_property("levels", 4)
    noise.set_editor_property("output_min", 0.35)
    m1 = M.create_material_expression(mat, unreal.MaterialExpressionMultiply, -500, 150)
    M.connect_material_expressions(inv, "", m1, "A")
    M.connect_material_expressions(noise, "", m1, "B")
    par = M.create_material_expression(mat, unreal.MaterialExpressionCollectionParameter, -700, 450)
    par.set_editor_property("collection", mpc)
    par.set_editor_property("parameter_name", "DustOpacity")
    m2 = M.create_material_expression(mat, unreal.MaterialExpressionMultiply, -300, 250)
    M.connect_material_expressions(m1, "", m2, "A")
    M.connect_material_expressions(par, "", m2, "B")
    M.connect_material_property(m2, "", unreal.MaterialProperty.MP_OPACITY)
    M.recompile_material(mat)
    unreal.EditorAssetLibrary.save_loaded_asset(mat)
    return mat


def build_dust_ring(seed=11):
    """~70 billowing dust volumes around the hall footprint; expanded and faded in build_sequence()."""
    rnd = random.Random(seed)
    mat = _dust_material()
    hx, hy = HALL_C
    a = _spawn(unreal.StaticMeshActor, "FA_DustRing", "CloudShadow/Cine/FX")
    a.static_mesh_component.set_mobility(unreal.ComponentMobility.MOVABLE)
    cs._anchor(a, *env._offset(hx, hy), env.GROUND_H)
    a.set_actor_rotation(unreal.Rotator(0, 0, 0), False)
    comp = cs._add_component(a, unreal.HierarchicalInstancedStaticMeshComponent, "Puffs")
    comp.set_static_mesh(unreal.load_asset("/Engine/BasicShapes/Sphere"))
    comp.set_material(0, mat)
    cs._set(comp, cast_shadow=False)
    hw, hh = (env.HALL[1] - env.HALL[0]) / 2, (env.HALL[3] - env.HALL[2]) / 2
    xs = []
    for _ in range(150):
        ang = rnd.uniform(0, 2 * math.pi)
        r = rnd.uniform(0.7, 1.35)
        e, n = hw * r * math.cos(ang) * 1.15, hh * r * math.sin(ang) * 1.05
        d = rnd.uniform(55.0, 120.0)                       # puff diameter (m)
        xs.append(unreal.Transform(location=unreal.Vector(e * 100.0, -n * 100.0, d * 18.0),
                                   rotation=unreal.Rotator(0, 0, rnd.uniform(0, 360)),
                                   scale=unreal.Vector(d, d, d * 0.45)))
    comp.add_instances(xs, False, False)
    a.set_actor_scale3d(unreal.Vector(0.3, 0.3, 0.3))
    a.set_actor_hidden_in_game(True)
    a.set_is_temporarily_hidden_in_editor(True)
    return a


def _key_dust(seq, impact):
    """Burst outward from the impact over ~1.5 s while the opacity rises and settles."""
    ring = _find("FA_DustRing")
    if not ring:
        return
    at, rot0 = ring.get_actor_location(), ring.get_actor_rotation()
    s = lambda k: unreal.Vector(k, k, k * 0.8)
    _key_xform(seq, ring, [(0, at, rot0, s(0.3)), (impact, at, rot0, s(0.3)), (impact + 10, at, rot0, s(0.95)),
                           (impact + 45, at, rot0, s(1.35))])
    return                                                # parked: the impact dust is the fog burst
    try:
        tr = seq.add_track(unreal.MovieSceneMaterialParameterCollectionTrack)
        tr.set_editor_property("mpc", _mpc())
        sec = tr.add_section()
        sec.set_range(0, TOTAL)
        for f, v in ((0, 0.0), (impact, 0.0), (impact + 4, 0.42), (impact + 25, 0.34), (389, 0.15), (390, 0.0)):
            sec.add_scalar_parameter_key("DustOpacity", unreal.FrameNumber(f), v)
    except Exception as e:
        warn("Footprint Atlas: dust opacity track not added (%s)" % e)



# ------------------------------------------------------------------ soft smoke/dust cards
RADIAL = "/Engine/Functions/Engine_MaterialFunctions01/Gradient/RadialGradientExponential"


def _soft_material(path, color, opacity, glow=1.1, use_mpc=False):
    """Classic smoke card: translucent unlit plane, opacity = radial falloff x noise x opacity
    (x MPC.DustOpacity when use_mpc). Rebuilt in place on every call."""
    M = unreal.MaterialEditingLibrary
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        mat = unreal.load_asset(path)
        M.delete_all_material_expressions(mat)
    else:
        folder, name = path.rsplit("/", 1)
        mat = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, folder, unreal.Material, unreal.MaterialFactoryNew())
    mat.set_editor_property("blend_mode", unreal.BlendMode.BLEND_TRANSLUCENT)
    mat.set_editor_property("shading_model", unreal.MaterialShadingModel.MSM_UNLIT)
    mat.set_editor_property("two_sided", True)
    col = M.create_material_expression(mat, unreal.MaterialExpressionConstant3Vector, -700, -250)
    col.set_editor_property("constant", unreal.LinearColor(*color, 1.0))
    em = M.create_material_expression(mat, unreal.MaterialExpressionMultiply, -450, -250)
    M.connect_material_expressions(col, "", em, "A")
    em.set_editor_property("const_b", glow)
    M.connect_material_property(em, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    # soft radial falloff from basic nodes (a function-call node made from Python gets no output pins):
    # clamp(1 - 2 * distance(uv, 0.5))^1.6
    uv = M.create_material_expression(mat, unreal.MaterialExpressionTextureCoordinate, -1400, 50)
    mid = M.create_material_expression(mat, unreal.MaterialExpressionConstant2Vector, -1400, 150)
    mid.set_editor_property("r", 0.5)
    mid.set_editor_property("g", 0.5)
    dist = M.create_material_expression(mat, unreal.MaterialExpressionDistance, -1250, 80)
    M.connect_material_expressions(uv, "", dist, "A")
    M.connect_material_expressions(mid, "", dist, "B")
    dbl = M.create_material_expression(mat, unreal.MaterialExpressionMultiply, -1120, 80)
    M.connect_material_expressions(dist, "", dbl, "A")
    dbl.set_editor_property("const_b", 2.0)
    inv = M.create_material_expression(mat, unreal.MaterialExpressionOneMinus, -1000, 80)
    M.connect_material_expressions(dbl, "", inv, "")
    sat = M.create_material_expression(mat, unreal.MaterialExpressionSaturate, -900, 80)
    M.connect_material_expressions(inv, "", sat, "")
    grad = M.create_material_expression(mat, unreal.MaterialExpressionPower, -800, 50)
    M.connect_material_expressions(sat, "", grad, "Base")
    grad.set_editor_property("const_exponent", 1.6)
    noise = M.create_material_expression(mat, unreal.MaterialExpressionNoise, -900, 300)
    noise.set_editor_property("scale", 0.02)
    noise.set_editor_property("levels", 5)
    noise.set_editor_property("output_min", 0.2)
    m1 = M.create_material_expression(mat, unreal.MaterialExpressionMultiply, -650, 120)
    M.connect_material_expressions(grad, "", m1, "A")
    M.connect_material_expressions(noise, "", m1, "B")
    m2 = M.create_material_expression(mat, unreal.MaterialExpressionMultiply, -450, 120)
    M.connect_material_expressions(m1, "", m2, "A")
    m2.set_editor_property("const_b", opacity)
    out = m2
    if use_mpc:
        par = M.create_material_expression(mat, unreal.MaterialExpressionCollectionParameter, -650, 400)
        par.set_editor_property("collection", _mpc())
        par.set_editor_property("parameter_name", "DustOpacity")
        m3 = M.create_material_expression(mat, unreal.MaterialExpressionMultiply, -250, 200)
        M.connect_material_expressions(m2, "", m3, "A")
        M.connect_material_expressions(par, "", m3, "B")
        out = m3
    M.connect_material_property(out, "", unreal.MaterialProperty.MP_OPACITY)
    M.recompile_material(mat)
    unreal.EditorAssetLibrary.save_loaded_asset(mat)
    return mat


def _cards(actor, name, mat, cards, face_world):
    """HISM of planes, each turned to face `face_world` (a world-space camera position)."""
    comp = cs._add_component(actor, unreal.HierarchicalInstancedStaticMeshComponent, name)
    comp.set_static_mesh(unreal.load_asset("/Engine/BasicShapes/Plane"))
    comp.set_material(0, mat)
    cs._set(comp, cast_shadow=False)
    origin = actor.get_actor_location()
    xs = []
    for loc_local, size in cards:
        world = origin + loc_local
        rot = unreal.MathLibrary.make_rot_from_z(face_world - world)
        xs.append(unreal.Transform(location=loc_local, rotation=rot, scale=unreal.Vector(size, size, 1.0)))
    comp.add_instances(xs, False, False)
    return comp


def build_dust_ring(seed=11):
    """~160 soft tan dust cards around the hall footprint, facing the S4 camera; expanded and
    faded in build_sequence()."""
    rnd = random.Random(seed)
    mat = _soft_material("/Game/CloudShadow/Materials/M_FA_DustCard", (0.80, 0.68, 0.52), 0.9, glow=1.15, use_mpc=True)
    hx, hy = HALL_C
    a = _spawn(unreal.StaticMeshActor, "FA_DustRing", "CloudShadow/Cine/FX")
    a.static_mesh_component.set_mobility(unreal.ComponentMobility.MOVABLE)
    cs._anchor(a, *env._offset(hx, hy), env.GROUND_H)
    a.set_actor_rotation(unreal.Rotator(0, 0, 0), False)
    cam_at_impact = next(k for k in camera_path() if k[0] == DROP[1])[1]
    face = _geo_to_unreal(*cam_at_impact)
    hw, hh = (env.HALL[1] - env.HALL[0]) / 2, (env.HALL[3] - env.HALL[2]) / 2
    cards = []
    for _ in range(160):
        ang = rnd.uniform(0, 2 * math.pi)
        r = rnd.uniform(0.75, 1.4)
        e, n = hw * r * math.cos(ang) * 1.1, hh * r * math.sin(ang)
        d = rnd.uniform(60.0, 150.0)
        cards.append((unreal.Vector(e * 100.0, -n * 100.0, rnd.uniform(0.15, 0.45) * d * 100.0), d))
    _cards(a, "Puffs", mat, cards, face)
    a.set_actor_scale3d(unreal.Vector(0.3, 0.3, 0.3))
    a.set_actor_hidden_in_game(True)
    a.set_is_temporarily_hidden_in_editor(True)
    return a


def build_plume(seed=5):
    """AIR: the turbine exhaust at Colossus 1 as a rising column of soft cards, drifting downwind
    (NASA POWER prevailing wind) and widening with height. Strength ~ TROPOMI NO2 site-minus-
    surroundings. A visualization, never a measured concentration."""
    rnd = random.Random(seed)
    data = json.load(open(os.path.join(TIMELINE, "colossus1.json"), encoding="utf-8"))
    r = next(x for x in data["rows"] if int(x["Year"]) == data["lastObservedYear"])
    wind = _data()["colossus1"]["wind"]
    excess = max(0.0, (r.get("NO2_Site") or 0.0) - (r.get("NO2_Surround") or 0.0))
    k = 0.7 + 0.6 * min(1.0, excess / 0.6)                    # relative strength
    mats = [_soft_material("/Game/CloudShadow/Materials/M_FA_Smoke%d" % i, c, o, glow=0.9)
            for i, (c, o) in enumerate((((0.30, 0.27, 0.24), 0.75), ((0.42, 0.39, 0.35), 0.55), ((0.58, 0.55, 0.50), 0.35)))]
    a = _spawn(unreal.StaticMeshActor, "FA_TurbinePlume", "CloudShadow/Cine/FX")
    a.static_mesh_component.set_mobility(unreal.ComponentMobility.MOVABLE)
    cs._anchor(a, PLUME_AT[0], PLUME_AT[1], C1_GROUND)
    a.set_actor_rotation(unreal.Rotator(0, 0, 0), False)
    face = _geo_to_unreal(*_c1(760, -560, 150))
    b = math.radians(wind["plumeTowardDeg"])
    layers = [[], [], []]
    for i in range(110):
        t = (i + rnd.random()) / 110.0
        up = 12.0 + t * 330.0 * k
        drift = t * t * 420.0 * k                             # bends over downwind as it rises
        e = drift * math.sin(b) + rnd.gauss(0, 6 + 30 * t)
        n = drift * math.cos(b) + rnd.gauss(0, 6 + 30 * t)
        size = (22.0 + 150.0 * t) * rnd.uniform(0.8, 1.2) * k
        layers[min(2, int(t * 3))].append((unreal.Vector(e * 100.0, -n * 100.0, up * 100.0), size))
    for i, cards in enumerate(layers):
        _cards(a, "Smoke%d" % i, mats[i], cards, face)
    a.set_actor_hidden_in_game(True)
    a.set_is_temporarily_hidden_in_editor(True)
    log("Footprint Atlas: plume strength %.2f (NO2 excess %.3f e15), drifting toward %.0f deg" % (k, excess, wind["plumeTowardDeg"]))
    return a


def _key_plume(seq):
    """The column slowly rises and swells over the AIR shot."""
    p = _find("FA_TurbinePlume")
    if not p:
        return
    at, rot0 = p.get_actor_location(), p.get_actor_rotation()
    _key_xform(seq, p, [(0, at, rot0, unreal.Vector(1, 1, 1)), (660, at, rot0, unreal.Vector(1, 1, 1)),
                        (780, unreal.Vector(at.x, at.y, at.z + 2500.0), rot0, unreal.Vector(1.08, 1.08, 1.08))])


# ------------------------------------------------------------------ POWER: lightning arcs
BOLT_VARIANTS = 6                  # pre-built bolt shapes per line; Sequencer flickers between them
BOLT_STEP = 2                      # frames each bolt stays lit


def _fractal_bolt(a, b, rnd, depth=8, rough=0.13, branch_p=0.22):
    """Midpoint-displacement lightning between Unreal points a and b. Returns segments [(p, q)]
    including a few short side forks (the classic look of film lightning)."""
    def split(p, q, d, amp):
        if d == 0:
            return [(p, q)]
        m = (p + q) * 0.5
        L = (q - p).length()
        off = unreal.Vector(rnd.gauss(0, 1), rnd.gauss(0, 1), rnd.gauss(0, 1)) * (L * amp)
        m = m + off
        segs = split(p, m, d - 1, amp * 0.62) + split(m, q, d - 1, amp * 0.62)
        if d <= 3 and rnd.random() < branch_p:                      # side fork
            dirv = (q - p) * 0.5 + unreal.Vector(rnd.gauss(0, 1), rnd.gauss(0, 1), rnd.gauss(0, 0.5)) * (L * 0.5)
            segs += split(m, m + dirv, max(1, d - 2), amp * 0.8)
        return segs
    return split(a, b, depth, rough)


def build_bolts(seed=21):
    """Several jagged bolt variants along each power line (thin additive-bright segments + a soft
    glow sleeve), plus a flash light per line. Flickered in _key_bolts()."""
    rnd = random.Random(seed)
    core = cs._emissive_material("/Game/CloudShadow/Materials/M_BoltCore2", (0.80, 0.88, 1.0), 900.0)
    glow = cs._emissive_material("/Game/CloudShadow/Materials/M_BoltGlow2", (0.30, 0.48, 1.0), 60.0)
    cube = unreal.load_asset("/Engine/BasicShapes/Cube")
    made = 0
    for li, line in enumerate(POWER_LINES):
        pts = [_geo_to_unreal(*_c2(*p)) for p in line]
        for v in range(BOLT_VARIANTS):
            a = _spawn(unreal.StaticMeshActor, "FA_PowerFX_Bolt_%d_%d" % (li, v), "CloudShadow/Cine/Flows")
            a.static_mesh_component.set_mobility(unreal.ComponentMobility.MOVABLE)
            a.set_actor_location(pts[0], False, False)
            segs = []
            for i in range(len(pts) - 1):
                segs += _fractal_bolt(pts[i], pts[i + 1], rnd)
            for name, mat, thick in (("Core", core, 0.55), ("Glow", glow, 2.6)):
                h = cs._add_component(a, unreal.HierarchicalInstancedStaticMeshComponent, name)
                h.set_static_mesh(cube)
                h.set_material(0, mat)
                cs._set(h, cast_shadow=False)
                xs = []
                for p, q in segs:
                    d = q - p
                    L = d.length()
                    if L < 1.0:
                        continue
                    rot = unreal.MathLibrary.find_look_at_rotation(p, q)
                    xs.append(unreal.Transform(location=(p + q) * 0.5 - pts[0], rotation=rot,
                                               scale=unreal.Vector(L / 100.0, thick, thick)))
                h.add_instances(xs, False, False)
            a.set_actor_hidden_in_game(True)
            a.set_is_temporarily_hidden_in_editor(True)
            made += 1
        # flash light at the middle of the line (lights the ground under the strike)
        lt = _spawn(unreal.PointLight, "FA_PowerFX_Flash_%d" % li, "CloudShadow/Cine/Flows")
        lt.set_actor_location((pts[0] + pts[-1]) * 0.5, False, False)
        lc = lt.get_component_by_class(unreal.PointLightComponent)
        cs._set(lc, intensity=4.0e6, attenuation_radius=90000.0, light_color=unreal.Color(200, 215, 255, 255),
                source_radius=2000.0, cast_shadows=False)
        lt.set_actor_hidden_in_game(True)
        lt.set_is_temporarily_hidden_in_editor(True)
    log("Footprint Atlas: %d lightning bolt variants built" % made)


def _key_bolts(seq, seed=33):
    """Re-strike every BOLT_STEP frames: one random variant per line is lit, sometimes none (flicker)."""
    rnd = random.Random(seed)
    f0, f1, _ = FLOW_SLICES["FA_PowerFX"]
    for li in range(len(POWER_LINES)):
        on_frames = {v: [] for v in range(BOLT_VARIANTS)}
        lit = []
        for f in range(f0, f1, BOLT_STEP):
            if rnd.random() < 0.82:
                v = rnd.randrange(BOLT_VARIANTS)
                on_frames[v].append(f)
                lit.append(f)
        for v, frames in on_frames.items():
            a = _find("FA_PowerFX_Bolt_%d_%d" % (li, v))
            if not a:
                continue
            keys = [(0, False)]
            for f in frames:
                keys += [(f, True), (f + BOLT_STEP, False)]
            _key_bool(seq, a, keys)
        lt = _find("FA_PowerFX_Flash_%d" % li)
        if lt:
            keys = [(0, False)]
            for f in lit:
                keys += [(f, True), (f + 1, False)]                      # the flash is a single frame
            _key_bool(seq, lt, keys)


# ------------------------------------------------------------------ simulated volumes (OpenVDB -> Heterogeneous Volumes)
# CC0 EmberGen simulations by JangaFX (jangafx.com/software/embergen/download/free-vdb-animations), imported as
# AnimatedSparseVolumeTextures and ray-marched as Heterogeneous Volumes (offline-quality, self-shadowed).
VDB_DIR = "/Game/CloudShadow/VDB"
SVT_MASTER = "/Engine/EngineMaterials/SparseVolumeMaterial"
VOLUMES = {   # svt, albedo colour, density scale, albedo scale (the master defaults it to 0.18 = grey)
    "Dust": ("ground_explosion", (0.95, 0.82, 0.62), 0.9, 0.9),
    "Smoke": ("industrial_chimney_smoke", (0.60, 0.55, 0.50), 1.6, 0.45),
    "Steam": ("steam_plume", (1.0, 1.0, 1.0), 0.35, 1.0),
}
HV_CVARS = {"r.HeterogeneousVolumes.MaxTraceDistance": 300000, "r.HeterogeneousVolumes.MaxShadowTraceDistance": 300000,
            "r.HeterogeneousVolumes.IndirectLighting": 0,                 # experimental: crashed the D3D12 driver (2026-11-15)
            "sg.EffectsQuality": 3, "fx.Niagara.QualityLevel": 3}   # 4 = FLIP water asks 100M+ GPU particles -> crash


def _vdb_material(kind):
    svt, albedo, dens, ascale = VOLUMES[kind]
    path = "%s/MI_VDB_%s" % (VDB_DIR, kind)
    M = unreal.MaterialEditingLibrary
    mi = unreal.load_asset(path) if unreal.EditorAssetLibrary.does_asset_exist(path) else \
        unreal.AssetToolsHelpers.get_asset_tools().create_asset("MI_VDB_%s" % kind, VDB_DIR, unreal.MaterialInstanceConstant,
                                                                unreal.MaterialInstanceConstantFactoryNew())
    M.set_material_instance_parent(mi, unreal.load_asset(SVT_MASTER))
    M.set_material_instance_sparse_volume_texture_parameter_value(mi, "SparseVolumeTexture", unreal.load_asset("%s/%s" % (VDB_DIR, svt)))
    M.set_material_instance_static_switch_parameter_value(mi, "Use Blackbody Temperature", False)
    M.set_material_instance_scalar_parameter_value(mi, "Temperature Scale", 0.0)
    M.set_material_instance_scalar_parameter_value(mi, "Blackbody Scale", 0.0)
    M.set_material_instance_scalar_parameter_value(mi, "Density Scale", dens)
    M.set_material_instance_scalar_parameter_value(mi, "Albedo Scale", ascale)
    M.set_material_instance_vector_parameter_value(mi, "Albedo Color", unreal.LinearColor(*albedo, 1.0))
    M.update_material_instance(mi)
    unreal.EditorAssetLibrary.save_loaded_asset(mi)
    return mi


def _volume(label, kind, lon, lat, ground_h, scale, yaw=0.0):
    """A Heterogeneous Volume whose simulation floor sits on the ground (SVT frame offset x scale)."""
    svt = unreal.load_asset("%s/%s" % (VDB_DIR, VOLUMES[kind][0]))
    base = -svt.get_frame_transform().translation.z * scale / 100.0        # m from volume centre to sim floor
    a = _spawn(unreal.HeterogeneousVolume, label, "CloudShadow/Cine/Volumes")
    cs._anchor(a, lon, lat, ground_h + base)
    a.set_actor_rotation(unreal.Rotator(0.0, 0.0, yaw), False)
    a.set_actor_scale3d(unreal.Vector(scale, scale, scale))
    hv = a.get_component_by_class(unreal.HeterogeneousVolumeComponent)
    hv.set_material(0, _vdb_material(kind))
    hv.set_playing(False)
    hv.set_looping(False)
    hv.set_frame(0.0)
    a.set_actor_hidden_in_game(True)
    a.set_is_temporarily_hidden_in_editor(True)
    return a


def build_volumes():
    """Dust burst at the hall (S4), steam from the real hall roof (S7 WATER), turbine exhaust at
    Colossus 1 drifting on the NASA POWER prevailing wind (S8 AIR)."""
    w = unreal.get_editor_subsystem(unreal.UnrealEditorSubsystem).get_editor_world()
    for k, v in HV_CVARS.items():
        unreal.SystemLibrary.execute_console_command(w, "%s %d" % (k, v))
    hx, hy = HALL_C
    _volume("FA_VDB_Dust", "Dust", *env._offset(hx, hy), env.GROUND_H, 300.0)
    for i, (e, n) in enumerate(((20, -150), (60, 30))):                        # rooftop cooling plant, fully in the S7 frame
        _volume("FA_VDB_Steam_%d" % i, "Steam", *env._offset(hx + e, hy + n), env.GROUND_H + env.HALL_H, 16.0,
                yaw=180.0 + _data()["colossus2"]["wind"]["plumeTowardDeg"])
    wind = _data()["colossus1"]["wind"]["plumeTowardDeg"]
    for i, (e, n) in enumerate(((-40, -20), (30, 25))):                       # turbine stacks
        lon, lat = _offset(PLUME_AT[0], PLUME_AT[1], e, n)
        _volume("FA_VDB_Smoke_%d" % i, "Smoke", lon, lat, C1_GROUND + 10.0, 90.0, yaw=180.0 + wind)
    log("Footprint Atlas: simulated volumes built (dust, steam x3, turbine smoke x2)")


def _key_frame(seq, actor, keys):
    """Drive a Heterogeneous Volume's simulation frame from Sequencer: keys [(seq frame, sim frame)]."""
    hv = actor.get_component_by_class(unreal.HeterogeneousVolumeComponent)
    b = seq.add_possessable(hv)
    tr = b.add_track(unreal.MovieSceneFloatTrack)
    tr.set_property_name_and_path("Frame", "Frame")
    sec = tr.add_section()
    sec.set_range(0, TOTAL)
    ch = sec.get_all_channels()[0]
    for f, v in keys:
        ch.add_key(unreal.FrameNumber(f), float(v), interpolation=unreal.MovieSceneKeyInterpolation.LINEAR)


def _key_volumes(seq):
    impact = DROP[1]
    d = _find("FA_VDB_Dust")
    if d:   # the explosion runs ~1.7x speed from the impact: a fast, violent burst that keeps rolling
        _key_bool(seq, d, [(0, False), (impact, True), (390, False)])
        _key_frame(seq, d, [(0, 0.0), (impact, 0.0), (390, 72.0)])
    for i in range(2):
        s = _find("FA_VDB_Steam_%d" % i)
        if s:
            _key_frame(seq, s, [(0, 40.0 + 20 * i), (570, 40.0 + 20 * i), (660, 100.0 + 20 * i)])
    for i in range(2):
        s = _find("FA_VDB_Smoke_%d" % i)
        if s:
            _key_frame(seq, s, [(0, 120.0 + 40 * i), (660, 120.0 + 40 * i), (780, 200.0 + 40 * i)])


# ------------------------------------------------------------------ WATER: a FLIP liquid simulation (S7)
FLIP_HOSE = "/NiagaraFluids/Templates/Liquid/3D/Systems/Grid3D_Flip_Hose"
BASIN = (-200.0, -40.0)          # E/N of Colossus 2: ground level, west of the hall (cooling-water basin)
FLIP_SIZE = (4.9, 4.9, 2.6)      # m: the template's simulation domain (calibrated top-down: square, centred)
FLIP_SHIFT = (0.0, 0.0)          # m E/N from the tank centre to the actor (calibrated from a top-down render)


def build_water():
    """A cooling-water basin at the foot of the hall: Niagara Fluids FLIP liquid (real simulated
    water) churned by an inflow jet, contained by concrete walls that sit on the sim domain, with
    an intake pipe, a pump house and evaporation steam. Labels start FA_WaterFX so the WATER slice
    shows them."""
    for a in cs._actors().get_all_level_actors():
        if a.get_actor_label().startswith(("FA_WaterFX", "FA_FlipTest")):
            cs._actors().destroy_actor(a)
    conc = unreal.load_asset(env.MAT_RUBBLE + "_C")
    steel = cs._emissive_material("/Game/CloudShadow/Materials/M_Steel", (0.45, 0.47, 0.50), 0.0)
    cube = unreal.load_asset("/Engine/BasicShapes/Cube")
    cyl = unreal.load_asset("/Engine/BasicShapes/Cylinder")
    e0, n0 = BASIN
    h = env.GROUND_H

    def box(label, mesh, mat, e, n, z, sx, sy, sz, rot=unreal.Rotator(0, 0, 0)):
        a = _spawn(unreal.StaticMeshActor, label, "CloudShadow/Cine/Water")
        smc = a.static_mesh_component
        smc.set_mobility(unreal.ComponentMobility.MOVABLE)
        smc.set_static_mesh(mesh)
        smc.set_material(0, mat)
        cs._anchor(a, *env._offset(e, n), h + z)
        a.set_actor_rotation(rot, False)
        a.set_actor_scale3d(unreal.Vector(sx, sy, sz))
        return a

    made = [box("FA_WaterFX_Pad", cube, conc, e0 - 5, n0 - 18, -0.05, 74.0, 90.0, 0.2)]          # covers Google's mud
    L, W, H = FLIP_SIZE
    wall_h, t = H + 0.1, 0.35                                       # walls contain the whole sim domain
    for i, (de, dn, sx, sy) in enumerate(((0, W / 2 + t / 2, L + 2 * t, t), (0, -W / 2 - t / 2, L + 2 * t, t),
                                          (L / 2 + t / 2, 0, t, W), (-L / 2 - t / 2, 0, t, W))):
        made.append(box("FA_WaterFX_Wall_%d" % i, cube, conc, e0 + de, n0 + dn, wall_h / 2, sx, sy, wall_h))
    # a row of identical basins behind it: the plant is bigger than one tank
    for k in ():                                     # (solid stand-ins read as plain blocks: off)
        made.append(box("FA_WaterFX_Basin_%d" % k, cube, conc, e0 + k * (L + 2.2), n0, wall_h / 2, L + 0.7, W + 0.7, wall_h))
    # intake pipe from the pump house to the jet nozzle, pump house behind
    made.append(box("FA_WaterFX_Pipe", cyl, steel, e0 - L / 2 - 3.5, n0, 2.4, 0.45, 0.45, 7.0, unreal.Rotator(0, 90, 0)))
    made.append(box("FA_WaterFX_Riser", cyl, steel, e0 - L / 2 - 7.0, n0, 1.2, 0.45, 0.45, 2.4))
    made.append(box("FA_WaterFX_PumpHouse", cube, conc, e0 - L / 2 - 10.5, n0, 2.2, 5.0, 4.0, 4.4))
    flip = c_niagara = _niagara(unreal.load_asset(FLIP_HOSE), "FA_WaterFX_Flip", *env._offset(e0, n0),
 h + 0.05,
                                folder="CloudShadow/Cine/Water")
    flip.set_actor_rotation(unreal.Rotator(0, 0, 0), False)
    de_, dn_ = FLIP_SHIFT                           # calibrated: the template's grid is not centred on the actor
    if de_ or dn_:
        cs._anchor(flip, *env._offset(e0 + de_, n0 + dn_), h + 0.05)
    made.append(flip)
    # evaporation steam off the basin (the steam VDB, small)
    if False:                                        # steam read as smoke over the small basin
      _volume("FA_VDB_Steam_B", "Steam", *env._offset(e0 + 1.0, n0), h + 0.6, 2.5,
            yaw=180.0 + _data()["colossus2"]["wind"]["plumeTowardDeg"])
    for a in made:
        a.set_actor_hidden_in_game(True)
        a.set_is_temporarily_hidden_in_editor(True)
    # cut Google's photogrammetry out around the basin during the WATER shot (close range = mud)
    poly = _spawn(unreal.CesiumCartographicPolygon, "FA_ClipWater", "CloudShadow/Cine/Water")
    poly.set_polygon_points(unreal.CesiumCoordinateReferenceSystem.LONGITUDE_LATITUDE_HEIGHT,
                            [unreal.Vector(*env._offset(e0 + de, n0 + dn), 0.0)
                             for de, dn in ((-40, 25), (30, 25), (30, -60), (-40, -60))])
    log("Footprint Atlas: FLIP water basin built at E%+.0f N%+.0f" % BASIN)


# ------------------------------------------------------------------ per-beat state
def apply(state):
    """Put the level in a slice's state: before/after (Google clip), sun, FX, grade, focus."""
    env.state(state["env"])
    if state.get("water"):
        g, wp = env._google(), _find("FA_ClipWater")
        for comp in g.get_components_by_class(unreal.CesiumPolygonRasterOverlay):
            if comp.get_name() == "FA_Clip" and wp:
                comp.set_editor_property("polygons", [wp])
                comp.set_editor_property("exclude_selected_tiles", False)
                comp.refresh()
    sun, _ = _sun_light()
    if sun:
        cs._set(sun, solar_time=float(state["sun"]))
        # At runtime (and the render runs as a game) CesiumSunSky sizes the atmosphere from the player
        # camera - the DynamicPawn 18 km up - so low shots end up "below" its ground and the sky goes
        # black. Huge thresholds pin it to the ground-level radius for every shot.
        cs._set(sun, inscribed_ground_threshold=1.0e7, circumscribed_ground_threshold=2.0e7)
        _try(sun.update_sun)
        _try(sun.update_atmosphere_radius)
    for a in cs._actors().get_all_level_actors():
        if str(a.get_folder_path()).startswith("CloudShadow/Sites"):    # the data pillars are km-scale
            a.set_actor_hidden_in_game(True)
            a.set_is_temporarily_hidden_in_editor(True)
            a.set_actor_enable_collision(False)
    for label, on in (("FA_TurbinePlume", state["plume"]), ("FA_PlumeParticles", state["particles"])):
        a = _find(label)
        if a:
            a.set_actor_hidden_in_game(not on)
            a.set_is_temporarily_hidden_in_editor(not on)
            if hasattr(a, "niagara_component"):
                (a.niagara_component.activate if on else a.niagara_component.deactivate)()
    for a in cs._actors().get_all_level_actors():          # flows: every actor with the prefix
        lab = a.get_actor_label()
        for prefix, on in (("FA_PowerFX", state["power"]), ("FA_WaterFX", state["water"]),
                           ("FA_VDB_Steam", state["water"]), ("FA_VDB_Smoke", state.get("haze") == "smog")):
            if lab.startswith(prefix):
                a.set_actor_hidden_in_game(not on)
                a.set_is_temporarily_hidden_in_editor(not on)
                if hasattr(a, "niagara_component"):
                    (a.niagara_component.activate if on else a.niagara_component.deactivate)()
    _grade(state["grade"])
    fog = _find("FA_HeightFog")
    if fog:   # (density, height falloff, inscattering colour): clear air / impact dust / smog
        dens, fall, col = {None: (0.0009, 0.02, (0.45, 0.55, 0.70)),
                           "space": (0.0, 0.02, (0.45, 0.55, 0.70)),      # from orbit the haze integrates to white
                           "dust": (0.006, 0.008, (0.78, 0.62, 0.42)),
                           "settle": (0.003, 0.01, (0.74, 0.60, 0.44)),
                           "smog": (0.004, 0.06, (0.40, 0.27, 0.15))}[state.get("haze")]   # light; the plume volumes carry it
        fc = fog.get_component_by_class(unreal.ExponentialHeightFogComponent)
        cs._set(fc, fog_density=dens, fog_height_falloff=fall, fog_inscattering_luminance=unreal.LinearColor(*col, 1.0),
                volumetric_fog_albedo=unreal.Color(int(col[0] * 255), int(col[1] * 255), int(col[2] * 255), 255))
    for label in ("FA_DustRing", "FA_TurbinePlume"):         # card effects parked (see notes)
        a = _find(label)
        if a:
            a.set_actor_hidden_in_game(True)
            a.set_is_temporarily_hidden_in_editor(True)
    focus = _find("CineFocus")
    if focus:                                                   # depth of field focuses here
        if state["focus"] is None:
            cs._anchor(focus, PLUME_AT[0], PLUME_AT[1], C1_GROUND + 120.0)
        else:
            fz = state["focus"][2] if len(state["focus"]) > 2 else 10.0
            cs._anchor(focus, *env._offset(*state["focus"][:2]), env.GROUND_H + fz)


def preview(beat_index, frame=None):
    """Set the level to one slice and lock the viewport to the film camera at its first frame."""
    f0, f1, st = story()[beat_index]
    apply(st)
    L = unreal.LevelSequenceEditorBlueprintLibrary
    try:
        L.open_level_sequence(unreal.load_asset(SEQ))
        L.set_lock_camera_cut_to_viewport(True)
        L.set_current_time(0)
        L.set_current_time(f0 if frame is None else frame)
    except Exception as e:
        warn("Footprint Atlas: build the sequence first (%s)" % e)
    log("Footprint Atlas: slice %d, frames %d-%d [%s] %s" % (beat_index, f0, f1, st["stamp"], st["caption"]))


# ------------------------------------------------------------------ build: the sequence
def _key_transform(seq, actor, keys):
    """keys: [(frame, location Vector, Rotator, scale Vector)]"""
    b = seq.add_possessable(actor)
    sec = b.add_track(unreal.MovieScene3DTransformTrack).add_section()
    sec.set_range(0, TOTAL)
    ch = sec.get_all_channels()            # Location XYZ, Rotation roll/pitch/yaw, Scale XYZ
    for frame, loc, rot, scl in keys:
        for c, v in zip(ch, (loc.x, loc.y, loc.z, rot.roll, rot.pitch, rot.yaw, scl.x, scl.y, scl.z)):
            c.add_key(unreal.FrameNumber(frame), float(v))
    return b


def _key_bool(seq, actor, keys):
    """Visibility track: keys [(frame, visible)], held until the next key."""
    b = seq.add_possessable(actor)
    sec = b.add_track(unreal.MovieSceneVisibilityTrack).add_section()
    sec.set_range(0, TOTAL)
    ch = sec.get_all_channels()[0]
    for frame, visible in keys:
        ch.add_key(unreal.FrameNumber(frame), bool(visible))
    return b


def _key_xform(seq, actor, keys, interp=None):
    """Transform track: keys [(frame, location, rotator, scale)] with one interpolation for all."""
    b = seq.add_possessable(actor)
    sec = b.add_track(unreal.MovieScene3DTransformTrack).add_section()
    sec.set_range(0, TOTAL)
    for frame, loc, rot, scl in keys:
        for c, v in zip(sec.get_all_channels(), (loc.x, loc.y, loc.z, rot.roll, rot.pitch, rot.yaw, scl.x, scl.y, scl.z)):
            if interp is None:
                c.add_key(unreal.FrameNumber(frame), float(v))
            else:
                c.add_key(unreal.FrameNumber(frame), float(v), interpolation=interp)
    return b


def _niagara_track(seq, actor, start):
    """Spawn a Niagara system at `start` (Sequencer life-cycle track); returns False if unsupported."""
    try:
        b = seq.add_possessable(actor.niagara_component)
        sec = b.add_track(unreal.MovieSceneNiagaraSystemTrack).add_section()
        sec.set_range(start, TOTAL)
        return True
    except Exception as e:
        warn("Footprint Atlas: Niagara life-cycle track not added (%s)" % e)
        return False


def build_sequence():
    """One LevelSequence: the camera path (with an impact shake), the hall dropping out of the sky,
    the meadow vanishing under the dust at the impact, and the dust shockwave."""
    cam = _find("CineCam_FootprintAtlas") or build()
    if unreal.EditorAssetLibrary.does_asset_exist(SEQ):
        unreal.EditorAssetLibrary.delete_asset(SEQ)
    seq = unreal.AssetToolsHelpers.get_asset_tools().create_asset(
        SEQ.rsplit("/", 1)[1], SEQ_DIR, unreal.LevelSequence, unreal.LevelSequenceFactoryNew())
    seq.set_display_rate(unreal.FrameRate(FPS, 1))
    seq.set_playback_start(0)
    seq.set_playback_end(TOTAL)

    # camera, with a decaying shake after the impact
    b = seq.add_possessable(cam)
    sec = b.add_track(unreal.MovieScene3DTransformTrack).add_section()
    sec.set_range(0, TOTAL)
    ch = sec.get_all_channels()            # Location XYZ, Rotation roll/pitch/yaw, Scale XYZ
    last_yaw = None
    path = camera_path()
    impact = DROP[1]
    for frame, camp, look, cut in path:
        loc, tgt = _geo_to_unreal(*camp), _geo_to_unreal(*look)
        rot = unreal.MathLibrary.find_look_at_rotation(loc, tgt)
        if last_yaw is not None:           # unwrap so the camera never spins the long way round
            rot.yaw += 360.0 * round((last_yaw - rot.yaw) / 360.0)
        last_yaw = rot.yaw
        interp = unreal.MovieSceneKeyInterpolation.CONSTANT if cut else unreal.MovieSceneKeyInterpolation.AUTO
        for c, v in zip(ch, (loc.x, loc.y, loc.z, rot.roll, rot.pitch, rot.yaw, 1.0, 1.0, 1.0)):
            c.add_key(unreal.FrameNumber(frame), float(v), interpolation=interp)
        if frame == impact:                # impact shake: rotation jitter decaying over ~0.6 s
            for i, f in enumerate(range(impact + 1, impact + 19)):
                a = 1.6 * (1.0 - i / 18.0)
                s = 1 if i % 2 == 0 else -1
                ch[4].add_key(unreal.FrameNumber(f), float(rot.pitch + s * a), interpolation=unreal.MovieSceneKeyInterpolation.LINEAR)
                ch[5].add_key(unreal.FrameNumber(f), float(rot.yaw - s * a * 0.6), interpolation=unreal.MovieSceneKeyInterpolation.LINEAR)
    cam_binding = b

    # S4: at the impact the meadow (trees and all) vanishes under the dust; scraped ground appears
    const = unreal.MovieSceneKeyInterpolation.CONSTANT
    for k in range(env.NSTRIP):
        m, r = env.find("FA_Meadow_%d" % k), env.find("FA_Rubble_%d" % k)
        if m:   # a visibility track won't hide these (hundreds of tree components); sink them instead
            at, rot0, one = m.get_actor_location(), m.get_actor_rotation(), m.get_actor_scale3d()
            _key_xform(seq, m, [(0, at, rot0, one), (impact + 2, at, rot0, one),
                                (impact + 3, unreal.Vector(at.x, at.y, at.z - 5000.0), rot0, one)], const)
        if r:
            _key_bool(seq, r, [(0, False), (impact + 3, True), (390, False)])   # S5 shows the real ground
    # the hall: falls from 900 m, accelerating, hits at the impact frame with a cartoon squash
    hall = env.find("FA_Hall")
    if hall:
        ground, rot0 = hall.get_actor_location(), hall.get_actor_rotation()
        up = lambda m: unreal.Vector(ground.x, ground.y, ground.z + m * 100.0)
        one = unreal.Vector(1, 1, 1)
        f0, f1 = DROP
        lin, auto = unreal.MovieSceneKeyInterpolation.LINEAR, unreal.MovieSceneKeyInterpolation.AUTO
        hb = seq.add_possessable(hall)
        hs = hb.add_track(unreal.MovieScene3DTransformTrack).add_section()
        hs.set_range(0, TOTAL)
        keys = [(0, up(900), one, const), (f0, up(900), one, auto), (f0 + 12, up(420), one, lin),
                (f1, up(0), one, lin), (f1 + 3, up(0), unreal.Vector(1.03, 1.03, 0.72), auto),
                (f1 + 9, up(0), unreal.Vector(0.99, 0.99, 1.06), auto), (f1 + 15, up(0), one, auto)]
        for frame, loc, scl, ip in keys:
            for c, v in zip(hs.get_all_channels(), (loc.x, loc.y, loc.z, rot0.roll, rot0.pitch, rot0.yaw, scl.x, scl.y, scl.z)):
                c.add_key(unreal.FrameNumber(frame), float(v), interpolation=ip)
        _key_bool(seq, hall, [(0, False), (f0, True), (390, False)])
    dust = _find("FA_ImpactDust")
    if dust:
        _key_bool(seq, dust, [(0, False), (impact, True), (390, False)])
        _niagara_track(seq, dust, impact)
    _key_flows(seq)
    _key_bolts(seq)
    _key_volumes(seq)
    _key_dust(seq, impact)
    _key_plume(seq)
    _drop_probe()

    cut = seq.add_track(unreal.MovieSceneCameraCutTrack).add_section()
    cut.set_range(0, TOTAL)
    cut.set_camera_binding_id(seq.get_binding_id(cam_binding))
    unreal.EditorAssetLibrary.save_loaded_asset(seq)
    log("Footprint Atlas: %s built (%d frames, %d camera keys, drop %d-%d)." % (SEQ, TOTAL, len(path), DROP[0], DROP[1]))
    return seq


# ------------------------------------------------------------------ render
# Movie Render Queue console variables: high-end Lumen (hardware ray tracing), shadows, DOF, motion blur
USE_RENDER_CVARS = True
RENDER_CVARS = {
    "r.Lumen.HardwareRayTracing": 1,
    "r.Lumen.TranslucencyReflections.FrontLayer.Enable": 1,      # the Mississippi reflects the sky
    "r.Lumen.ScreenProbeGather.DownsampleFactor": 8,
    "r.Lumen.Reflections.DownsampleFactor": 1,
    "r.Shadow.Virtual.Enable": 1,
    "r.VolumetricFog.GridPixelSize": 4,
    "r.VolumetricFog.GridSizeZ": 128,
    "r.DepthOfFieldQuality": 4,
    "r.MotionBlurQuality": 4,
    "r.BloomQuality": 5,
    "r.Tonemapper.Quality": 5,
}

RENDER_CVARS.update(HV_CVARS)


def _cesium_quality(sse):
    """Lower screen-space error = sharper tiles; costs streaming time (warm-up covers it). Applies to
    every tileset - Google Photorealistic 3D Tiles carry almost every real-world shot."""
    for t in cs._actors().get_all_level_actors():
        if isinstance(t, unreal.Cesium3DTileset):
            cs._set(t, maximum_screen_space_error=float(sse))


# "final" profile: cinematic scalability everywhere, finer Nanite, sharper shadows, full texture streaming.
# (Never r.ViewDistanceScale / HighQualityAerialPerspective: those blacked out the sky in renders.)
FINAL_CVARS = {
    "sg.ShadowQuality": 4, "sg.FoliageQuality": 4, "sg.EffectsQuality": 3, "sg.PostProcessQuality": 4,   # effects 4 = FLIP water asks 100M+ particles -> GPU crash
    "sg.TextureQuality": 4, "sg.GlobalIlluminationQuality": 4, "sg.ReflectionQuality": 4, "sg.ShadingQuality": 4,
    "r.Nanite.MaxPixelsPerEdge": 0.5,                    # finer Nanite triangles
    "r.Shadow.Virtual.ResolutionLodBiasDirectional": -1.5,
    "r.Lumen.ScreenProbeGather.DownsampleFactor": 8,
    "r.Lumen.ScreenProbeGather.TracingOctahedronResolution": 16,
    "r.Lumen.Reflections.DownsampleFactor": 1,
    "r.Streaming.FullyLoadUsedTextures": 1,
    "r.MotionBlurQuality": 4, "r.DepthOfFieldQuality": 4, "r.BloomQuality": 5, "r.Tonemapper.Quality": 5,
    "foliage.LODDistanceScale": 4.0,
    "r.ScreenPercentage": 100,
}
QUALITY = "draft"                                         # set to "final" for the delivery render


_exe = None          # module-level so the executor isn't garbage-collected mid-render
_queue = []


def render_test(slice_index, f0, f1, warmup=120, resolution=(960, 540)):
    """Draft-render a few frames of one slice (fast look at FX / lighting)."""
    render_film(warmup=warmup, resolution=resolution, samples=1, only=[slice_index], frames=(f0, f1))


def render_film(warmup=240, resolution=(1920, 1080), samples=8, only=None, sse=4.0, frames=None):
    """Render the film beat by beat into one PNG sequence (Saved/Cine), then stitch it.
    warmup:  engine frames before each beat (Cesium tiles stream in, fluid sims develop).
    samples: temporal samples per frame (AA + real motion blur). 1 = fast draft.
    only:    beat indices to (re)render; then call stitch()."""
    if not unreal.EditorAssetLibrary.does_asset_exist(SEQ):
        build_sequence()
    _cesium_quality(sse)
    global _queue
    beats = list(enumerate(story()))
    if only is not None:
        beats = [b for b in beats if b[0] in only]
    if frames is not None:                               # clip the slice(s) to a test range
        beats = [(i, (max(a, frames[0]), min(b, frames[1]), st)) for i, (a, b, st) in beats]
    _queue = [dict(i=i, start=a, end=b, state=st, warmup=warmup, res=resolution, samples=samples,
                   last=(only is None and i == len(story()) - 1)) for i, (a, b, st) in beats]
    os.makedirs(OUT, exist_ok=True)
    log("Footprint Atlas: rendering %d beats -> %s" % (len(_queue), OUT))
    _next_beat()


def _next_beat():
    global _exe
    if not _queue:
        _exe = None
        log("Footprint Atlas: all beats rendered.")
        stitch()
        return
    shot = _queue.pop(0)
    apply(shot["state"])

    qs = unreal.get_editor_subsystem(unreal.MoviePipelineQueueSubsystem)
    queue = qs.get_queue()
    queue.delete_all_jobs()
    job = queue.allocate_new_job(unreal.MoviePipelineExecutorJob)
    job.job_name = "FA_%02d_%s" % (shot["i"], shot["state"]["env"])
    job.sequence = unreal.SoftObjectPath(SEQ)
    job.map = unreal.SoftObjectPath(cs.MAP)

    cfg = job.get_configuration()
    cfg.find_or_add_setting_by_class(unreal.MoviePipelineDeferredPassBase)
    cfg.find_or_add_setting_by_class(unreal.MoviePipelineImageSequenceOutput_PNG)
    out = cfg.find_or_add_setting_by_class(unreal.MoviePipelineOutputSetting)
    # every beat writes into the same folder, numbered by sequence frame -> one contiguous PNG sequence
    cs._set(out,
            output_directory=unreal.DirectoryPath(OUT),
            file_name_format="fa.{frame_number}",
            output_resolution=unreal.IntPoint(*shot["res"]),
            use_custom_frame_rate=True,
            output_frame_rate=unreal.FrameRate(FPS, 1),
            use_custom_playback_range=True,
            custom_start_frame=shot["start"],
            custom_end_frame=shot["end"],
            zero_pad_frame_numbers=4,
            override_existing_output=True)
    aa = cfg.find_or_add_setting_by_class(unreal.MoviePipelineAntiAliasingSetting)
    cs._set(aa, engine_warm_up_count=shot["warmup"], render_warm_up_frames=True,
            spatial_sample_count=1, temporal_sample_count=shot["samples"],
            override_anti_aliasing=True, anti_aliasing_method=unreal.AntiAliasingMethod.AAM_NONE)
    cv = cfg.find_or_add_setting_by_class(unreal.MoviePipelineConsoleVariableSetting)
    cvars = dict(RENDER_CVARS if USE_RENDER_CVARS else {})
    if QUALITY == "final":
        cvars.update(FINAL_CVARS)
        go = cfg.find_or_add_setting_by_class(unreal.MoviePipelineGameOverrideSetting)
        cs._set(go, cinematic_quality_settings=True, use_high_quality_shadows=True, use_lod_zero=True,
                texture_streaming=unreal.MoviePipelineTextureStreamingMethod.FULLY_LOAD)
    for k, v in cvars.items():
        _try(cv.add_or_update_console_variable, k, float(v))

    log("Footprint Atlas: %s frames %d-%d [%s]" % (job.job_name, shot["start"], shot["end"], shot["state"]["stamp"]))
    _exe = unreal.MoviePipelinePIEExecutor()
    _exe.on_executor_finished_delegate.add_callable_unique(_on_beat_done)
    qs.render_queue_with_executor_instance(_exe)


def _on_beat_done(executor, success):
    if not success:
        warn("Footprint Atlas: a beat reported failure; continuing with the rest.")
    _next_beat()


# ------------------------------------------------------------------ titles + stitch
def _ts(sec, srt=False):
    cs_ = int(round(sec * 100))
    if srt:
        return "%02d:%02d:%02d,%03d" % (cs_ // 360000, cs_ // 6000 % 60, cs_ // 100 % 60, cs_ % 100 * 10)
    return "%d:%02d:%02d.%02d" % (cs_ // 360000, cs_ // 6000 % 60, cs_ // 100 % 60, cs_ % 100)


def _cues(key):
    """Merge consecutive beats with the same text into one cue."""
    out = []
    for a, b, st in story():
        t = st[key]
        if out and out[-1][2] == t:
            out[-1][1] = b
        else:
            out.append([a, b, t])
    return [c for c in out if c[2]]


def write_titles():
    """footprint_atlas.ass (burned in: year stamp top-left, caption bottom, title card) and
    footprint_atlas.srt (captions only, for the submission page / players)."""
    os.makedirs(OUT, exist_ok=True)
    ass = os.path.join(OUT, "footprint_atlas.ass")
    srt = os.path.join(OUT, "footprint_atlas.srt")
    head = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Stamp,Arial,84,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,6,0,1,2,2,7,90,90,80,1
Style: Caption,Arial,60,&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,0,0,0,0,100,100,0,0,1,2,1,2,120,120,70,1
Style: Title,Arial,120,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,1,0,0,0,100,100,18,0,1,0,4,5,60,60,60,1
Style: Sub,Arial,54,&H0033D1FF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,2,0,1,0,2,5,60,60,60,1
Style: Footer,Arial,32,&H00DDDDDD,&H00FFFFFF,&H00000000,&H64000000,0,0,0,0,100,100,1,0,1,1,1,3,60,60,28,1
Style: Note,Arial,34,&H00CCCCCC,&H00FFFFFF,&H00000000,&H00000000,0,1,0,0,100,100,1,0,1,0,1,5,60,60,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    ev = []
    for a, b, t in _cues("stamp"):
        ev.append("Dialogue: 1,%s,%s,Stamp,,0,0,0,,{\\fad(200,200)}%s" % (_ts(a / FPS), _ts(b / FPS), t))
    for a, b, t in _cues("caption"):
        ev.append("Dialogue: 0,%s,%s,Caption,,0,0,0,,{\\fad(250,250)}%s" % (_ts(a / FPS), _ts(b / FPS), t))
    title, sub, a, b = TITLE
    ev.append("Dialogue: 2,%s,%s,Title,,0,0,0,,{\\fad(600,0)\\pos(960,470)}%s" % (_ts(a / FPS + 0.3), _ts(b / FPS), title))
    ev.append("Dialogue: 2,%s,%s,Sub,,0,0,0,,{\\fad(600,0)\\pos(960,580)}%s" % (_ts(a / FPS + 0.8), _ts(b / FPS), sub))
    ev.append("Dialogue: 2,%s,%s,Note,,0,0,0,,{\\fad(600,0)\\pos(960,660)}%s" % (_ts(a / FPS + 1.0), _ts(b / FPS), TITLE_NOTE))
    for a, b, t in _cues("footer"):
        ev.append("Dialogue: 0,%s,%s,Footer,,0,0,0,,{\\fad(250,250)}%s" % (_ts(a / FPS), _ts(b / FPS), t))
    with open(ass, "w", encoding="utf-8") as f:
        f.write(head + "\n".join(ev) + "\n")
    lines = []
    for i, (a, b, t) in enumerate(_cues("caption"), 1):
        lines += [str(i), "%s --> %s" % (_ts(a / FPS, True), _ts(b / FPS, True)), t, ""]
    with open(srt, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))
    return ass, srt


def stitch(burn=False):
    """Saved/Cine/fa.####.png -> footprint_atlas.mp4 with titles burned in (libass); falls back to a
    clean video if burning fails. footprint_atlas.srt is always written next to it."""
    mp4 = os.path.join(OUT, "footprint_atlas.mp4")
    ass, srt = write_titles()
    pngs = sorted(f for f in os.listdir(OUT) if f.startswith("fa.") and f.endswith(".png")) if os.path.isdir(OUT) else []
    if not pngs:
        warn("Footprint Atlas: no frames in %s - nothing to stitch." % OUT)
        return
    base = ["ffmpeg", "-y", "-framerate", str(FPS), "-start_number", pngs[0].split(".")[1],
            "-i", os.path.join(OUT, "fa.%04d.png")]
    # sound: the mix (effects + music) if scripts/film_audio.py made one, else the effects alone
    audio = next((os.path.join(OUT, f) for f in ("footprint_atlas_mix.wav", "footprint_atlas_sfx.wav")
                  if os.path.exists(os.path.join(OUT, f))), None)
    if audio:
        base = base + ["-i", audio]
    tail = (["-map", "0:v", "-map", "1:a", "-c:a", "aac", "-b:a", "256k", "-shortest"] if audio else []) +         ["-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", mp4]
    esc = ass.replace("\\", "/").replace(":", "\\:")        # ffmpeg filter syntax: drive colon escaped
    attempts = ([base + ["-vf", "ass='%s'" % esc] + tail] if burn else []) + [base + tail]
    for cmd in attempts:
        try:
            r = subprocess.run(cmd, capture_output=True, text=True)
        except FileNotFoundError:
            warn("Footprint Atlas: ffmpeg not on PATH. Frames are in %s." % OUT)
            return
        if r.returncode == 0:
            log("Footprint Atlas: %d frames -> %s (captions: %s)" % (len(pngs), mp4, srt))
            return mp4
        warn("Footprint Atlas: ffmpeg attempt failed: %s" % (r.stderr or "")[-400:])

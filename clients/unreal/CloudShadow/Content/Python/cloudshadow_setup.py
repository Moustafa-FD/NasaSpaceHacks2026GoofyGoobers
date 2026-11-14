"""
Cloud Shadow - one-click level builder for Unreal Engine + Cesium for Unreal.

Menu:  Cloud Shadow > Build Cloud Shadow level
Or in the Output Log (Python):  import cloudshadow_setup; cloudshadow_setup.run()

Creates /Game/CloudShadow/Maps/CloudShadow with:
  * CesiumGeoreference centred on xAI Colossus 1 (Memphis)
  * Cesium World Terrain + Bing aerial imagery (Overlay0)
  * Overlay1 = one cloud-free 30 m NASA HLS image per site per year (the timeline "terrain")
  * Overlay2 = NASA data layers (NO2, heat, NDVI, night lights); NO2 2025 active
  * Google Photorealistic 3D Tiles (hidden, for close-ups)
  * Cesium SunSky + Dynamic Pawn
  * One glowing pillar per data center, height = reported power draw (MW)
Everything it creates is tagged "CloudShadow", so re-running replaces it cleanly.
"""
import json
import math
import os

import unreal

TAG = "CloudShadow"
MAP = "/Game/CloudShadow/Maps/CloudShadow"
MAT = "/Game/CloudShadow/Materials/M_Pillar"
MAT_NB = "/Game/CloudShadow/Materials/M_Neighbor"
ORIGIN = dict(lat=35.0601, lon=-90.1564, height=100.0)  # xAI Colossus 1
# clients/unreal/CloudShadow -> repo root (override with env var CLOUDSHADOW_REPO if the project lives elsewhere)
REPO = os.environ.get("CLOUDSHADOW_REPO") or os.path.abspath(os.path.join(unreal.Paths.project_dir(), "..", "..", ".."))
SITES_JSON = os.path.join(REPO, "data", "cloudshadow", "unreal", "CloudShadowSites.json")
HLS_TIMELINE = os.path.join(REPO, "data", "cloudshadow", "hls_timeline.json")
IMAGERY_KEY = "Overlay1"   # yearly terrain imagery
DATA_KEY = "Overlay2"      # NASA data layer drawn on top

GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"
# (component name, layer, date, max level, active at start)
OVERLAYS = [
    ("NASA_NO2_2025", "TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column", "2025-07-15", 6, True),
    ("NASA_NO2_2023", "TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column", "2023-10-15", 6, False),
    ("NASA_HeatDay_2025", "MODIS_Terra_L3_Land_Surface_Temp_8Day_Day", "2025-07-12", 7, False),
    ("NASA_HeatNight_2025", "MODIS_Terra_L3_Land_Surface_Temp_8Day_Night", "2025-07-12", 7, False),
    ("NASA_NDVI_2025", "MODIS_Terra_L3_NDVI_16Day", "2025-07-12", 9, False),
    ("NASA_LandDisturbance_2025", "OPERA_L3_DIST-ANN-HLS_Color_Index", "2025-01-01", 12, False),
    ("NASA_NightLights", "VIIRS_Black_Marble", "2016-01-01", 8, False),
    ("NASA_Aerosol_2025", "MODIS_Terra_Aerosol_Optical_Depth_3km", "2025-07-15", 6, False),
]
ION_WORLD_TERRAIN = 1
ION_BING_AERIAL = 2
ION_GOOGLE_3D = 2275207

log = unreal.log
warn = unreal.log_warning


# ------------------------------------------------------------------ helpers
def _actors():
    return unreal.get_editor_subsystem(unreal.EditorActorSubsystem)


def _spawn(cls, label, folder, loc=unreal.Vector(0, 0, 0)):
    a = _actors().spawn_actor_from_class(cls, loc)
    a.set_actor_label(label)
    a.set_folder_path(folder)
    a.tags = list(a.tags) + [TAG]
    return a


def _add_component(actor, cls, name):
    """Add a component to a placed actor instance (editor)."""
    sds = unreal.get_engine_subsystem(unreal.SubobjectDataSubsystem)
    root = sds.k2_gather_subobject_data_for_instance(actor)[0]
    params = unreal.AddNewSubobjectParams(parent_handle=root, new_class=cls, blueprint_context=None)
    handle, fail = sds.add_new_subobject(params)
    if str(fail):
        raise RuntimeError("could not add %s: %s" % (cls, fail))
    sds.rename_subobject(handle, unreal.Text(name))
    data = unreal.SubobjectDataBlueprintFunctionLibrary.get_data(handle)
    return unreal.SubobjectDataBlueprintFunctionLibrary.get_object(data)


def _set(obj, **props):
    for k, v in props.items():
        try:
            obj.set_editor_property(k, v)
        except Exception as e:
            warn("Cloud Shadow: couldn't set %s.%s (%s)" % (obj.get_name(), k, e))


def _remove_tagged(only_sites=False):
    for a in _actors().get_all_level_actors():
        if TAG in [str(t) for t in a.tags] and (not only_sites or "Sites" in str(a.get_folder_path())):
            _actors().destroy_actor(a)


def _emissive_material(path, rgb, glow):
    if unreal.EditorAssetLibrary.does_asset_exist(path):
        return unreal.load_asset(path)
    folder, name = path.rsplit("/", 1)
    mat = unreal.AssetToolsHelpers.get_asset_tools().create_asset(name, folder, unreal.Material, unreal.MaterialFactoryNew())
    mel = unreal.MaterialEditingLibrary
    base = mel.create_material_expression(mat, unreal.MaterialExpressionConstant3Vector, -400, 0)
    base.set_editor_property("constant", unreal.LinearColor(*rgb, 1.0))
    emis = mel.create_material_expression(mat, unreal.MaterialExpressionConstant3Vector, -400, 200)
    emis.set_editor_property("constant", unreal.LinearColor(rgb[0] * glow, rgb[1] * glow, rgb[2] * glow, 1.0))
    mel.connect_material_property(base, "", unreal.MaterialProperty.MP_BASE_COLOR)
    mel.connect_material_property(emis, "", unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    mel.recompile_material(mat)
    unreal.EditorAssetLibrary.save_loaded_asset(mat)
    return mat


def _anchor(actor, lon, lat, height_m):
    a = actor.get_component_by_class(unreal.CesiumGlobeAnchorComponent) or _add_component(actor, unreal.CesiumGlobeAnchorComponent, "GlobeAnchor")
    a.move_to_longitude_latitude_height(unreal.Vector(lon, lat, height_m))
    try:
        a.snap_local_up_to_ellipsoid_normal()
    except Exception:
        pass
    return a


# ------------------------------------------------------------------ checks
def check():
    ok = True
    for name in ("CesiumGeoreference", "Cesium3DTileset", "CesiumUrlTemplateRasterOverlay", "CesiumIonRasterOverlay", "CesiumGlobeAnchorComponent", "CesiumSunSky"):
        has = hasattr(unreal, name)
        ok &= has
        (log if has else warn)("Cloud Shadow check: %-32s %s" % (name, "OK" if has else "MISSING"))
    log("Cloud Shadow check: sites file %s -> %s" % (SITES_JSON, "OK" if os.path.exists(SITES_JSON) else "MISSING (run: npm run data:unreal)"))
    if not ok:
        warn("Cloud Shadow: Cesium for Unreal is not installed/enabled. Epic Launcher > Fab > 'Cesium for Unreal' > Install to Engine, then Edit > Plugins > enable it and restart.")
    return ok


# ------------------------------------------------------------------ build
def _open_level():
    les = unreal.get_editor_subsystem(unreal.LevelEditorSubsystem)
    if unreal.EditorAssetLibrary.does_asset_exist(MAP):
        les.load_level(MAP)
        _remove_tagged()
    else:
        les.new_level(MAP)


def _build_globe():
    geo = _spawn(unreal.CesiumGeoreference, "CesiumGeoreference", "CloudShadow")
    geo.set_origin_longitude_latitude_height(unreal.Vector(ORIGIN["lon"], ORIGIN["lat"], ORIGIN["height"]))

    terrain = _spawn(unreal.Cesium3DTileset, "Cesium World Terrain", "CloudShadow/Globe")
    _set(terrain, tileset_source=unreal.TilesetSource.FROM_CESIUM_ION, ion_asset_id=ION_WORLD_TERRAIN)

    bing = _add_component(terrain, unreal.CesiumIonRasterOverlay, "BingAerial")
    _set(bing, ion_asset_id=ION_BING_AERIAL, material_layer_key="Overlay0")
    bing.refresh()

    for name, layer, date, zmax, active in OVERLAYS:
        tms = "GoogleMapsCompatible_Level%d" % zmax
        ov = _add_component(terrain, unreal.CesiumUrlTemplateRasterOverlay, name)
        _set(ov,
             template_url="%s/%s/default/%s/%s/{z}/{y}/{x}.png" % (GIBS, layer, date, tms),
             projection=unreal.CesiumUrlTemplateRasterOverlayProjection.WEB_MERCATOR,
             minimum_level=0, maximum_level=zmax, tile_width=256, tile_height=256,
             material_layer_key=DATA_KEY, auto_activate=active)
        if active:
            ov.refresh()
        else:
            ov.deactivate()

    _build_timeline_imagery(terrain)

    google = _spawn(unreal.Cesium3DTileset, "Google Photorealistic 3D Tiles (toggle for close-ups)", "CloudShadow/Globe")
    _set(google, tileset_source=unreal.TilesetSource.FROM_CESIUM_ION, ion_asset_id=ION_GOOGLE_3D)
    google.set_actor_hidden_in_game(True)
    google.set_is_temporarily_hidden_in_editor(True)

    _spawn(unreal.CesiumSunSky, "CesiumSunSky", "CloudShadow")

    try:
        pawn_cls = unreal.load_class(None, "/CesiumForUnreal/DynamicPawn.DynamicPawn_C")
        pawn = _spawn(pawn_cls, "DynamicPawn", "CloudShadow")
        _set(pawn, auto_possess_player=unreal.AutoReceiveInput.PLAYER0)
        _anchor(pawn, ORIGIN["lon"] - 0.12, ORIGIN["lat"] - 0.18, 18000)
        pawn.set_actor_rotation(unreal.Rotator(0, -50, 35), False)  # roll, pitch, yaw
    except Exception as e:
        warn("Cloud Shadow: DynamicPawn not added (%s). Use Cesium panel > Quick Add > Dynamic Pawn." % e)


def _build_timeline_imagery(terrain):
    """One inactive overlay per site per year: HLS_<site>_<year> on Overlay1 (see hls_timeline.json)."""
    if not os.path.exists(HLS_TIMELINE):
        warn("Cloud Shadow: %s missing; run `npm run data:timeline-imagery`. Skipping yearly imagery." % HLS_TIMELINE)
        return
    tl = json.load(open(HLS_TIMELINE, encoding="utf-8"))
    n = 0
    for site_id, years in tl.items():
        for year, im in sorted(years.items()):
            ov = _add_component(terrain, unreal.CesiumUrlTemplateRasterOverlay, "HLS_%s_%s" % (site_id, year))
            _set(ov, template_url=im["templateUrl"],
                 projection=unreal.CesiumUrlTemplateRasterOverlayProjection.WEB_MERCATOR,
                 minimum_level=0, maximum_level=12, tile_width=256, tile_height=256,
                 material_layer_key=IMAGERY_KEY, auto_activate=False)
            ov.deactivate()
            n += 1
    log("Cloud Shadow: %d yearly imagery overlays (HLS_<site>_<year>) added." % n)


def _terrain():
    for a in _actors().get_all_level_actors():
        if a.get_actor_label() == "Cesium World Terrain":
            return a
    return None


def set_year(site_id, year, data_layer=None):
    """Editor helper (and reference for the Blueprint slider): show site_id's imagery for `year`.
    Future years (no imagery) keep the most recent image; the slider UI should label them PROJECTED.
    data_layer: optional overlay component name to show on top (e.g. "NASA_NO2_2025"); others are hidden."""
    terrain = _terrain()
    if not terrain:
        warn("Cloud Shadow: build the level first.")
        return
    comps = terrain.get_components_by_class(unreal.CesiumUrlTemplateRasterOverlay)
    prefix = "HLS_%s_" % site_id
    years = sorted(int(c.get_name()[len(prefix):]) for c in comps if c.get_name().startswith(prefix))
    if not years:
        warn("Cloud Shadow: no yearly imagery for %s" % site_id)
        return
    shown = max([y for y in years if y <= year] or [years[0]])
    for c in comps:
        name = c.get_name()
        if name.startswith("HLS_"):
            (c.activate if name == "%s%d" % (prefix, shown) else c.deactivate)()
        elif data_layer is not None and name.startswith("NASA_"):
            (c.activate if name == data_layer else c.deactivate)()
    log("Cloud Shadow: %s year %d -> imagery %d%s" % (site_id, year, shown, " (PROJECTED year, latest image)" if year > years[-1] else ""))
    return shown


def rebuild_sites():
    if not os.path.exists(SITES_JSON):
        warn("Cloud Shadow: %s not found. Run `npm run data:unreal` in the repo." % SITES_JSON)
        return
    _remove_tagged(only_sites=True)
    sites = json.load(open(SITES_JSON, encoding="utf-8"))["sites"]
    pillar_mat = _emissive_material(MAT, (1.0, 0.45, 0.12), 6.0)
    nb_mat = _emissive_material(MAT_NB, (0.9, 0.2, 0.2), 4.0)
    cyl = unreal.load_asset("/Engine/BasicShapes/Cylinder")
    sph = unreal.load_asset("/Engine/BasicShapes/Sphere")

    for s in sites:
        mw = s.get("powerMW") or 0
        h_km = 4 + math.sqrt(mw) * 1.1 if mw else 3        # same rule as the web app
        # pillar (engine cylinder = 100 uu tall/wide, pivot at centre; 1 uu = 1 cm)
        p = _spawn(unreal.StaticMeshActor, "Pillar_%s" % s["id"], "CloudShadow/Sites")
        smc = p.static_mesh_component
        smc.set_mobility(unreal.ComponentMobility.MOVABLE)
        smc.set_static_mesh(cyl)
        smc.set_material(0, pillar_mat)
        p.set_actor_scale3d(unreal.Vector(700, 700, h_km * 1000))
        _anchor(p, s["lon"], s["lat"], h_km * 1000 / 2)

        label = s["name"] + ("\n%s MW" % format(int(mw), ",") if mw else "")
        t = _spawn(unreal.TextRenderActor, "Label_%s" % s["id"], "CloudShadow/Sites")
        tr = t.text_render
        tr.set_mobility(unreal.ComponentMobility.MOVABLE)
        tr.set_text(label)
        _set(tr, world_size=120000.0, text_render_color=unreal.Color(255, 230, 200, 255))
        try:
            _set(tr, horizontal_alignment=unreal.HorizTextAligment.EHTA_CENTER)
        except AttributeError:
            pass
        _anchor(t, s["lon"], s["lat"], h_km * 1000 + 1500)

        for nb in s.get("neighbors", []):
            n = _spawn(unreal.StaticMeshActor, "Neighbor_%s" % nb["name"], "CloudShadow/Sites")
            n.static_mesh_component.set_mobility(unreal.ComponentMobility.MOVABLE)
            n.static_mesh_component.set_static_mesh(sph)
            n.static_mesh_component.set_material(0, nb_mat)
            n.set_actor_scale3d(unreal.Vector(300, 300, 300))
            _anchor(n, nb["lon"], nb["lat"], 200)
    log("Cloud Shadow: %d site pillars placed." % len(sites))


def run():
    if not check():
        return
    _open_level()
    _build_globe()
    rebuild_sites()
    unreal.get_editor_subsystem(unreal.LevelEditorSubsystem).save_current_level()
    unreal.EditorAssetLibrary.save_directory("/Game/CloudShadow", only_if_is_dirty=True, recursive=True)
    log("Cloud Shadow: level built and saved at %s. Connect to Cesium ion (Window > Cesium) if the globe is blank." % MAP)

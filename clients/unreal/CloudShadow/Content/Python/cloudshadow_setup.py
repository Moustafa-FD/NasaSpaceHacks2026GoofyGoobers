"""
Cloud Shadow - one-click level builder for Unreal Engine + Cesium for Unreal.

Menu:  Cloud Shadow > Build Cloud Shadow level
Or in the Output Log (Python):  import cloudshadow_setup; cloudshadow_setup.run()

Creates /Game/CloudShadow/Maps/CloudShadow with:
  * CesiumGeoreference centred on xAI Colossus 1 (Memphis)
  * Cesium World Terrain + Bing aerial imagery (Overlay0)
  * NASA GIBS overlays (Overlay1) - NO2 active, others ready to toggle
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
REPO = os.path.abspath(os.path.join(unreal.Paths.project_dir(), "..", "..", ".."))  # clients/unreal/CloudShadow -> repo root
SITES_JSON = os.path.join(REPO, "data", "cloudshadow", "unreal", "CloudShadowSites.json")

GIBS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best"
# (component name, layer, date, max level, active at start)
OVERLAYS = [
    ("NASA_NO2_2025", "TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column", "2025-07-15", 6, True),
    ("NASA_NO2_2023", "TROPOMI_L2_Nitrogen_Dioxide_Tropospheric_Column", "2023-10-15", 6, False),
    ("NASA_HeatDay_2025", "MODIS_Terra_L3_Land_Surface_Temp_8Day_Day", "2025-07-12", 7, False),
    ("NASA_HeatNight_2025", "MODIS_Terra_L3_Land_Surface_Temp_8Day_Night", "2025-07-12", 7, False),
    ("NASA_NDVI_2025", "MODIS_Terra_L3_NDVI_16Day", "2025-07-12", 9, False),
    ("NASA_HLS_Colossus1_Before", "HLS_S30_Nadir_BRDF_Adjusted_Reflectance", "2023-06-29", 12, False),
    ("NASA_HLS_Colossus1_After", "HLS_S30_Nadir_BRDF_Adjusted_Reflectance", "2025-07-08", 12, False),
    ("NASA_HLS_Colossus2_Before", "HLS_S30_Nadir_BRDF_Adjusted_Reflectance", "2024-06-13", 12, False),
    ("NASA_HLS_Colossus2_After", "HLS_L30_Nadir_BRDF_Adjusted_Reflectance", "2026-06-20", 12, False),
    ("NASA_LandDisturbance_2025", "OPERA_L3_DIST-ANN-HLS_Color_Index", "2025-01-01", 12, False),
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
             material_layer_key="Overlay1", auto_activate=active)
        if active:
            ov.refresh()
        else:
            ov.deactivate()

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

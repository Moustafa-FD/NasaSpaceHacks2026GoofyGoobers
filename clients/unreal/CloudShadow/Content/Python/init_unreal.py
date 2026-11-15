# Runs automatically when the editor starts (Python Script Plugin).
# Adds a "Cloud Shadow" menu to the main menu bar.
import unreal


def _add_menu():
    menus = unreal.ToolMenus.get()
    main = menus.find_menu("LevelEditor.MainMenu")
    if not main:
        return
    sub = main.add_sub_menu("CloudShadow", "", "CloudShadowMenu", "Cloud Shadow", "NASA Space Apps 2026 tools")

    def entry(name, label, tip, cmd):
        e = unreal.ToolMenuEntry(name=name, type=unreal.MultiBlockType.MENU_ENTRY)
        e.set_label(label)
        e.set_tool_tip(tip)
        e.set_string_command(unreal.ToolMenuStringCommandType.PYTHON, "", cmd)
        sub.add_menu_entry("Items", e)

    reload = "import importlib, cloudshadow_setup; importlib.reload(cloudshadow_setup); "
    entry("BuildLevel", "Build Cloud Shadow level", "Create/refresh the globe level: Cesium terrain, NASA overlays, site pillars.",
          reload + "cloudshadow_setup.run()")
    entry("RefreshSites", "Refresh site markers from data/", "Re-read data/cloudshadow/unreal/CloudShadowSites.json and rebuild the pillars.",
          reload + "cloudshadow_setup.rebuild_sites()")
    for site, label in (("colossus1", "Colossus 1"), ("ashburn", "Ashburn")):
        for yr in (2015, 2020, 2025):
            entry("Year_%s_%d" % (site, yr), "Timeline: %s %d" % (label, yr), "Show that year's NASA 30 m imagery (editor preview)",
                  reload + "cloudshadow_setup.set_year('%s', %d)" % (site, yr))
    cine = reload + "import cloudshadow_cine; importlib.reload(cloudshadow_cine); "
    entry("CineBuild", "Cinematic: 1. Build look + camera + FX", "Clouds, fog, grade, cine camera, fluid plume, particles, scan beam.",
          cine + "cloudshadow_cine.build()")
    entry("CineSeq", "Cinematic: 2. Build 25 s sequence", "Create /Game/CloudShadow/Cine/SEQ_FootprintAtlas (camera path + scan sweep).",
          cine + "cloudshadow_cine.build_sequence()")
    for i, label in ((2, "BEFORE 2021"), (7, "AFTER 2025"), (9, "Turbine plume + NO2")):
        entry("CinePreview%d" % i, "Cinematic: Preview beat %d (%s)" % (i, label), "Set the level to that beat to tune it by eye.",
              cine + "cloudshadow_cine.preview(%d)" % i)
    entry("CineRender", "Cinematic: 3. Render film (MRQ + ffmpeg)", "Render all shots to Saved/Cine and stitch footprint_atlas.mp4.",
          cine + "cloudshadow_cine.render_film()")
    entry("CineStitch", "Cinematic: Re-stitch mp4 from frames", "Rebuild footprint_atlas.mp4 + .srt from Saved/Cine/fa.*.png.",
          cine + "cloudshadow_cine.stitch()")
    entry("Check", "Check setup", "Print what's installed and what's missing to the Output Log.",
          reload + "cloudshadow_setup.check()")
    menus.refresh_all_widgets()


try:
    _add_menu()
except Exception as e:  # never block editor startup
    unreal.log_warning("Cloud Shadow menu not added: %s" % e)

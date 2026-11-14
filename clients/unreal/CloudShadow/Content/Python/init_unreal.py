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
    entry("Check", "Check setup", "Print what's installed and what's missing to the Output Log.",
          reload + "cloudshadow_setup.check()")
    menus.refresh_all_widgets()


try:
    _add_menu()
except Exception as e:  # never block editor startup
    unreal.log_warning("Cloud Shadow menu not added: %s" % e)

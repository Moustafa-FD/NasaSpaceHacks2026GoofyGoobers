# Footprint Atlas low-poly kit

Original architectural and vegetation meshes authored for this project. These are reusable **illustrative** models, not surveyed reconstructions of particular houses or independently measured vegetation. No third-party art, textures, or model licenses are bundled.

Regenerate from the repository root with Python 3.11+ (standard library only):

```sh
python scripts/build-low-poly-assets.py
```

The builder writes individual `.glb` files, a shared `kit.glb`, `manifest.json`, `templates.json`, and an orthographic `preview.svg` contact sheet. It validates each binary model's headers, buffer/accessor ranges, min/max bounds, finite coordinates, triangle indices, unit normals, and ground alignment.

Append `--preview-png` to regenerate the depth-tested `preview.png` contact sheet as well. It uses a small software rasterizer and Python's standard library; no rendering package is required. The SVG supplies model-name labels but uses painter ordering, so the depth-tested PNG is the accurate visual silhouette check.

All assets use glTF's **+Y up**, **+X width**, **+Z depth/front**. Their X/Z bounds are centered at the origin and their lowest Y coordinate is zero. Dimensions are meters. Windows, doors, roof slopes, dormers, chimneys, porches, balconies, loading bays and crowns are mesh geometry; no texture downloads are needed.

`manifest.json.models` is an array containing `id`, `kind`, `style`, measured `width` / `depth` / `height`, `bounds`, `triangles`, individual `url`, and `meshIndex` / `nodeIndex` in the shared kit. Kinds include `house`, `apartment`, `office`, `shop`, `warehouse`, `farm`, `civic`, `tree`, and `shrub`. The shared kit has one named mesh/node per model; callers should select or instance meshes rather than rendering all overlapping kit nodes.

The appended `crop` family includes `wheat-clump-gold` (`style: wheat`), `wheat-clump-green`, `crop-row-green`, `crop-seedling` (`style: young`), and `crop-stubble` (`style: dry`). Stems, seed heads and leaves are actual geometry. The first 48 mesh/node indices remain unchanged. Crop variants illustrate appearance and growth stages; their presence does not establish the real field's crop species, planting date or measured yield.

Indices 53–60 add eight `data-center` assets: cloud server hall, paired hyperscale campus, brown-brick industrial retrofit, modular prefab pods, cooling hall, secure service hall, electrical substation, and backup-generator yard. They use loading shutters, corrugated industrial walls, broad parapet roofs, louver banks, rooftop chillers with visible fan discs/blades, electrical equipment, exhaust stacks and security rails. No regular residential window grid is applied to server halls. `role: infrastructure` identifies the substation and generator yard; use these as ancillary props rather than replacing a primary server hall with them. These are illustrative architectural families, not measured replicas of a named operator's campus.

Indices 61–64 provide efficient dense vegetation: `forest-grove` contains nine trunks/crowns in one asset; `meadow-grass-patch` and `meadow-flower-patch` contain clustered 3D blade tufts; `wheat-field-patch` contains 25 stems with solid faceted seed heads. Manifest `stemCount` and `canopyCount` describe the internal cluster count. Place clusters only in the relevant mapped land cover and keep them clear of roads, water, and source building footprints. Double-sided thin blades avoid disappearing when viewed from the opposite direction.

`templates.json.materials` maps material names to RGB color and roughness. `templates.json.models[id].groups[materialName]` supplies flat `positions`, flat unit `normals`, and local triangle `indices`. The position/normal arrays have three components per vertex. Every group's indices start at zero and refer only to that group's vertices. This source representation supports efficient neighborhood batching; `kit.glb` also supports callers adding `EXT_mesh_gpu_instancing` transforms without rebuilding geometry.

Choose model variants and muted color variation using a stable geographic/feature seed. Keep window and roof colors distinct from the wall palette; avoid tinting every material with a saturated uniform color. Leafless and autumn tree assets are artistic states, not biological predictions.

The kit now contains 81 models. Indices 65-80 add markets, cafe terraces, retail courts, offices, logistics buildings, aircraft hangars, a fuel canopy and civic facilities. Specialized hangar/fuel/clinic/fire-station/library/transit styles require matching source-use tags; other details remain illustrative.

# Reading environmental change in Footprint Atlas

The story beside the Cesium scene answers four questions: **what changed, where, by how much, and how clear is the evidence?** It uses the existing five case studies and NASA/Earth-observation inputs from the data pipeline. The project’s Earth System Trend Detective brief motivates these questions; the linked 2026 challenge detail page was unavailable during this implementation, so this document does not certify every submission requirement.

## Observations, comparisons and maps

The main readout uses four plain category controls, large site/nearby numbers and one baseline-change figure. The chart can expand into a keyboard-accessible dialog; opening it pauses timeline playback for inspection. Its solid site line and dashed nearby line use larger axes, and a table exposes the same displayed values. Annual readouts, chart points and tables all use matched-month site/nearby means. Unavailable future years show one explanation and an explicit jump to the last observed year; the historical chart is never stretched across an empty future horizon.

- **Air, vegetation and heat:** annual site and nearby-region values come from the prepared monthly series. At least nine matching months are required for a paired annual comparison. A three-year view uses only the selected year and the two preceding years; missing years remain gaps.
- **Earlier baseline:** up to five full calendar years before the study’s comparison-start year. The start year itself is excluded. Change beyond the nearby region is `(selected site − baseline site) − (selected nearby − baseline nearby)`. This is context for investigating a local signal, not proof that a particular facility caused it.
- **Significance:** the existing whole-record trend test is shown separately. Its p-value does not test the selected-year baseline difference. Favorable, adverse and uncertain findings remain visible.
- **Spatial maps:** fixed scales compare actual dated NASA GIBS snapshots, generally near July. They are not annual-average or three-year-average rasters. Their values are estimates decoded from rendered colour classes, not original scientific-pixel retrievals. Transparent areas indicate missing coverage.
- **Playback:** keep the preceding map while its replacement loads, then blend over 700 ms of wall-clock time. The intermediate colour is display interpolation, not another observation. One active and one replacement map group are retained, with a latest-only request queue and a four-entry decoded-raster cache. A comparison pair is one group. Readiness requires decoded imagery from each selected side, or the independently decoded source raster used by the visible close-up material; additional globe tiles load progressively. Unrelated basemap requests do not block that local evidence. Slow imagery fails visibly rather than discarding the previous reference. Playback waits for the map transition; manual scrubbing can skip intermediate years. A/B split comparison applies to globe imagery; generated low-poly ground retains natural colours in that mode.
- **Beyond coverage:** an unavailable year has no annual map or invented annual site forecast. Regional future-climate period summaries remain a separate model view. No unchanged historical colour is presented as a future prediction.

## Water and less visible risks

Water evidence distinguishes facility use, consumption, planned demand and requested supply. Reported annual totals and reported peak daily rates have different units and boundaries. Discrete reports are never interpolated into a continuous consumption series or converted into pond loss, evaporation or remaining water percentages. Historical records are explicitly dated.

The water view can open soil/rain evidence and nearby monitoring stations. Soil moisture is not groundwater level. Nearby water-quality observations do not establish a facility discharge or a change in river flow. Air-column NO₂ and aerosol optical depth are not street-level PM2.5 exposure. Modeled near-surface air is a separate evidence action. Resident noise complaints are documented qualitatively; no unsupported dB radius is drawn.

These distinctions make important potential environmental pressures visible without forcing all indicators to worsen. Greenness does not directly measure forest mortality, crop yield or biodiversity. Terrain deformation, shrinking lakes and altered waterways require a hydrological or geomorphic model and suitable source data; the current scene does not invent those effects.

## History in the scene

Play changes the timeline while preserving the user's camera. It does not start a cinematic orbit or interrupt the approach to a close-up campus.

Lighting uses an illustrative reference sun direction independent of the selected data year. The native animation clock advances continuously at the chosen motion speed; selecting a year or switching day/night never jumps that clock. Native campus particle emitters also use a short looping system lifetime, bounding catch-up after hidden intervals instead of allocating millions of particles.

The timeline shows sourced conversion, construction, expansion and opening milestones, including rewind notices. Present-day map geometry is reference scenery. An existing factory remains visible before its data-center conversion, and a regional boom date does not erase all campuses. Contributed OSM `start_date` tags are preserved as unverified metadata. A specific structure may be hidden historically only with a verified primary-source new-construction record for that structure; the current bundled inventory has no such records.

At close range, a maximum of two depth-tested campus labels show historical context and source-dated reported water use. They belong only to the selected base campus, retire with its patch, and never copy a regional figure onto every streamed building. The existing station and environmental-model views provide additional geographic context.

## Source records and validation

Typed facility records and source links live in `apps/web/js/site-evidence.js` and `site-history.js`. The Google The Dalles operator consumption figure and released city water-use figures are separate accounting measures; their difference is not an evaporation estimate.

Focused tests cover annual coverage, zeros versus unknowns, fixed baselines, no future leakage, missing-year chart gaps, water metric eligibility, event precision, mapped-building chronology, bounded transitions, stale work, and 3D shader/resource retirement. Run the repository’s `npm run check` and `npm run web:build` for integration validation.

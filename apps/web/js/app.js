// Cloud Shadow - main app: globe, panel, charts, ledger, tour.
(async function () {
  const $ = (s) => document.querySelector(s);
  const fmt = (v, d = 2) => (v == null || !isFinite(v) ? "–" : (v > 0 ? "+" : "") + v.toFixed(d));
  const fmtP = (p) => (p == null || !isFinite(p) ? "–" : p < 0.001 ? "p < 0.001" : "p = " + p.toFixed(3));
  const toast = (msg, ms = 3500) => { const t = $("#toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms); };

  // ------------------------------------------------------------ data
  const [sitesDoc, hlsDates] = await Promise.all([
    fetch("data/sites.json").then((r) => r.json()),
    fetch("data/hls_dates.json").then((r) => r.json()).catch(() => ({})),
    loadCatalog(),
  ]);
  const SITES = sitesDoc.sites, CTX = sitesDoc.context;
  const SERIES = {};
  await Promise.all(SITES.map(async (s) => { try { SERIES[s.id] = (await (await fetch(`data/series/${s.id}.json`)).json()).vars; } catch { SERIES[s.id] = {}; } }));

  // ------------------------------------------------------------ globe
  Cesium.Ion.defaultAccessToken = localStorage.getItem("cesiumIonToken") || "";
  const viewer = new Cesium.Viewer("globe", {
    baseLayer: new Cesium.ImageryLayer(new Cesium.UrlTemplateImageryProvider({
      url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      maximumLevel: 19, credit: "Esri, Maxar, Earthstar Geographics",
    })),
    terrainProvider: new Cesium.EllipsoidTerrainProvider(),
    baseLayerPicker: false, geocoder: false, timeline: false, animation: false, homeButton: false,
    sceneModePicker: false, navigationHelpButton: false, fullscreenButton: false, infoBox: false, selectionIndicator: false,
  });
  const scene = viewer.scene;
  scene.globe.enableLighting = false;
  scene.skyAtmosphere.show = true;
  scene.fog.enabled = true;
  viewer.cesiumWidget.creditContainer.style.display = "block";

  // Optional: Cesium ion token unlocks 3D terrain + OSM buildings (paste once in console: setIonToken("..."))
  window.setIonToken = (t) => { localStorage.setItem("cesiumIonToken", t); location.reload(); };
  if (Cesium.Ion.defaultAccessToken) {
    try {
      scene.setTerrain(Cesium.Terrain.fromWorldTerrain());
      scene.primitives.add(await Cesium.createOsmBuildingsAsync());
    } catch (e) { console.warn("ion features unavailable", e); }
  }

  // Site markers: pillar height = reported power draw (MW). Taller = hungrier.
  const pillarKm = (s) => (s.ledger?.power?.mw ? 4 + Math.sqrt(s.ledger.power.mw) * 1.1 : 3);
  for (const s of SITES) {
    const h = pillarKm(s) * 1000;
    viewer.entities.add({
      id: "site-" + s.id,
      position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, h / 2),
      cylinder: { length: h, topRadius: 350, bottomRadius: 350, material: Cesium.Color.fromCssColorString("#ff9a4d").withAlpha(0.85), outline: false,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(70000, Number.POSITIVE_INFINITY) },
    });
    viewer.entities.add({
      id: "label-" + s.id,
      position: Cesium.Cartesian3.fromDegrees(s.lon, s.lat, h + 600),
      label: {
        text: s.name + (s.ledger?.power?.mw ? `\n${s.ledger.power.mw.toLocaleString()} MW` : ""),
        font: "600 14px Inter, sans-serif", fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE, verticalOrigin: Cesium.VerticalOrigin.BOTTOM, showBackground: true,
        backgroundColor: Cesium.Color.fromCssColorString("#0b0e13").withAlpha(0.7), disableDepthTestDistance: Number.POSITIVE_INFINITY,
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 4.0e6),
      },
    });
    for (const nb of s.neighbors || []) {
      viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(nb.lon, nb.lat),
        point: { pixelSize: 9, color: Cesium.Color.fromCssColorString("#e66767"), outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
        label: { text: nb.name, font: "13px Inter, sans-serif", pixelOffset: new Cesium.Cartesian2(0, -16), fillColor: Cesium.Color.WHITE, outlineColor: Cesium.Color.BLACK, outlineWidth: 3, style: Cesium.LabelStyle.FILL_AND_OUTLINE, disableDepthTestDistance: Number.POSITIVE_INFINITY, distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 1.5e5) },
      });
    }
  }

  // Ring showing the "surroundings" used for the comparison
  const ringEntities = [];
  function drawRings(lat, lon, ring) {
    ringEntities.forEach((e) => viewer.entities.remove(e)); ringEntities.length = 0;
    for (const [r, dash] of [[ring[0], true], [ring[1], false]]) {
      ringEntities.push(viewer.entities.add({
        position: Cesium.Cartesian3.fromDegrees(lon, lat),
        ellipse: { semiMajorAxis: r * 1000, semiMinorAxis: r * 1000, fill: false, outline: true, height: 0, outlineColor: Cesium.Color.fromCssColorString(dash ? "#3987e5" : "#3987e5").withAlpha(dash ? 0.6 : 0.95), outlineWidth: 2 },
      }));
    }
    ringEntities.push(viewer.entities.add({
      position: Cesium.Cartesian3.fromDegrees(lon, lat),
      point: { pixelSize: 10, color: Cesium.Color.fromCssColorString("#d95926"), outlineColor: Cesium.Color.WHITE, outlineWidth: 2, disableDepthTestDistance: Number.POSITIVE_INFINITY },
    }));
  }

  function flyTo(lat, lon, km = 45, pitch = -50, heading = 0, duration = 2.5) {
    const range = km * 1000;
    viewer.camera.flyToBoundingSphere(new Cesium.BoundingSphere(Cesium.Cartesian3.fromDegrees(lon, lat), 10), {
      offset: new Cesium.HeadingPitchRange(Cesium.Math.toRadians(heading), Cesium.Math.toRadians(pitch), range), duration,
    });
  }
  viewer.camera.setView({ destination: Cesium.Cartesian3.fromDegrees(-92, 37, 9.5e6) });

  // ------------------------------------------------------------ map overlay + compare
  let overlayA = null, overlayB = null;
  const state = { site: SITES[0], live: null, varId: "NO2", mapLayer: "none" };
  const today = new Date().toISOString().slice(0, 10);

  function overlaySpec(kind, date) {
    if (kind === "none") return null;
    if (VARS[kind]) { const L = VARS[kind].layer; const d = snapDate(L, date); return { layer: L, date: d }; }
    if (kind === "DIST") { const L = MAP_LAYERS.DIST.layer; return { layer: L, date: snapDate(L, date) }; }
    if (kind === "HLS") {
      // prefer the hand-picked cloud-free date for the current site
      const h = hlsDates[state.site?.id] || {};
      const pick = [h.before, h.after].filter(Boolean).find((x) => x.date === date);
      if (pick) return { layer: pick.layer, date: pick.date };
      const L = "HLS_S30_Nadir_BRDF_Adjusted_Reflectance"; return { layer: L, date: snapDate(L, date) };
    }
  }
  function makeLayer(spec) {
    const z = CATALOG[spec.layer].z;
    const p = new Cesium.UrlTemplateImageryProvider({ url: tileUrl(spec.layer, spec.date), maximumLevel: z, credit: "NASA GIBS" });
    const l = viewer.imageryLayers.addImageryProvider(p);
    l.alpha = +$("#opacity").value;
    return l;
  }
  function refreshOverlay() {
    [overlayA, overlayB].forEach((l) => l && viewer.imageryLayers.remove(l, true)); overlayA = overlayB = null;
    const cmp = $("#cmpToggle").checked;
    const a = overlaySpec(state.mapLayer, $("#dateA").value || today);
    if (a) {
      overlayA = makeLayer(a); $("#dateA").value = a.date;
      if (cmp) {
        const b = overlaySpec(state.mapLayer, $("#dateB").value || today);
        overlayB = makeLayer(b); $("#dateB").value = b.date;
        overlayA.splitDirection = Cesium.SplitDirection.LEFT; overlayB.splitDirection = Cesium.SplitDirection.RIGHT;
        $("#splitL").textContent = "◀ " + a.date; $("#splitR").textContent = b.date + " ▶";
      }
    }
    $("#split").hidden = !(cmp && a); $("#dateBWrap").hidden = !cmp;
  }
  function setMapLayer(kind, dateA, dateB, compare) {
    state.mapLayer = kind; $("#layerSel").value = kind;
    if (dateA) $("#dateA").value = dateA; if (dateB) $("#dateB").value = dateB;
    if (compare != null) $("#cmpToggle").checked = compare;
    refreshOverlay();
  }
  $("#layerSel").onchange = (e) => {
    const s = state.site;
    if (e.target.value === "HLS" && s && hlsDates[s.id]?.before) setMapLayer("HLS", hlsDates[s.id].before.date, hlsDates[s.id].after?.date, true);
    else setMapLayer(e.target.value);
  };
  $("#dateA").onchange = $("#dateB").onchange = $("#cmpToggle").onchange = refreshOverlay;
  $("#opacity").oninput = (e) => [overlayA, overlayB].forEach((l) => l && (l.alpha = +e.target.value));

  // draggable split
  scene.splitPosition = 0.5;
  (() => {
    const bar = $("#split"); let drag = false;
    bar.addEventListener("pointerdown", (e) => { drag = true; bar.setPointerCapture(e.pointerId); });
    bar.addEventListener("pointerup", () => (drag = false));
    bar.addEventListener("pointermove", (e) => {
      if (!drag) return; const r = viewer.canvas.getBoundingClientRect();
      const x = Math.min(Math.max(e.clientX, r.left + 20), r.right - 20);
      bar.style.left = x + "px"; scene.splitPosition = (x - r.left) / r.width;
    });
  })();

  // ------------------------------------------------------------ panel: sites + vars
  function renderChips() {
    $("#siteChips").innerHTML = "";
    for (const s of SITES) {
      const b = document.createElement("button"); b.className = "chip" + (state.site === s && !state.live ? " active" : "");
      b.textContent = s.name; b.onclick = () => selectSite(s); $("#siteChips").appendChild(b);
    }
  }
  function renderStory() {
    const s = state.site;
    if (state.live) {
      $("#story").innerHTML = `<h3>Your investigation</h3><div class="place">${state.live.lat.toFixed(4)}, ${state.live.lon.toFixed(4)}</div>
        <p>Live NASA data for this spot vs. the ring around it. Try a new industrial park, a mine, a new suburb, or a data center in your city.</p>`;
      return;
    }
    $("#story").innerHTML = `<h3>${s.name}</h3><div class="place">${s.place} · ${s.operator}</div>
      <div class="headline">${s.headline}</div><p>${s.story}</p>
      <p class="muted">Start date used for before/after: <b>${s.onset}</b> (${s.onsetLabel})</p>`;
  }
  function renderTabs() {
    $("#varTabs").innerHTML = "";
    for (const [id, v] of Object.entries(VARS)) {
      const b = document.createElement("button"); b.className = "tab" + (state.varId === id ? " active" : "");
      const star = !state.live && state.site.watchFor?.includes(id) ? '<span class="star" title="Most relevant for this site">★ watch</span>' : "";
      b.innerHTML = `${v.label}${star}`; b.onclick = () => { state.varId = id; renderTabs(); runAnalysis(); };
      $("#varTabs").appendChild(b);
    }
    const v = VARS[state.varId];
    $("#varDefine").innerHTML = `${v.define}<br><span class="muted">${v.sensor} · surroundings ring ${v.ring[0]}–${v.ring[1]} km</span>`;
  }

  function selectSite(s, { fly = true, varId } = {}) {
    state.site = s; state.live = null; liveAbort?.abort();
    state.varId = varId || s.watchFor?.[0] || "LST_Day";
    renderChips(); renderStory(); renderTabs(); renderLedger(); runAnalysis();
    if (fly) flyTo(s.lat, s.lon, 40, -45);
  }

  // ------------------------------------------------------------ analysis + charts
  let chartMain, chartDiff, liveAbort;
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const lastResults = {}; // siteId -> varId -> analysis (feeds the ledger)

  function onsetPlugin(x) {
    return { id: "onset", afterDatasetsDraw(c) {
      if (!x) return; const { ctx, chartArea: a, scales: { x: sx } } = c; const px = sx.getPixelForValue(x);
      if (px < a.left || px > a.right) return;
      ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = css("--text-2"); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(px, a.top); ctx.lineTo(px, a.bottom); ctx.stroke(); ctx.restore();
    } };
  }
  const axisCommon = (title) => ({
    grid: { color: "rgba(255,255,255,0.06)" }, border: { display: false },
    ticks: { color: css("--muted"), font: { size: 10.5 } }, title: { display: !!title, text: title, color: css("--muted"), font: { size: 10.5 } },
  });

  function drawCharts(a, v, onset) {
    chartMain?.destroy(); chartDiff?.destroy();
    const xs = a.t.map(Stats.decYear);
    const roll = (vals) => Stats.rolling(vals).map((y, i) => ({ x: xs[i], y }));
    const onX = onset ? Stats.decYear(onset) : null;
    chartMain = new Chart($("#chartMain"), {
      type: "line",
      data: { datasets: [
        { label: "Site", data: roll(a.site), borderColor: css("--site"), borderWidth: 2, pointRadius: 0, spanGaps: false, tension: 0.2 },
        { label: "Surroundings", data: roll(a.ref), borderColor: css("--ref"), borderWidth: 2, pointRadius: 0, spanGaps: false, tension: 0.2 },
      ] },
      options: {
        parsing: false, animation: false, responsive: true, interaction: { mode: "nearest", axis: "x", intersect: false },
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          title: (it) => { const x = it[0].parsed.x; const y = Math.floor(x); return `${y}-${String(Math.floor((x - y) * 12) + 1).padStart(2, "0")}`; },
          label: (it) => `${it.dataset.label}: ${it.parsed.y.toFixed(v.digits)} ${v.unit}` } } },
        scales: { x: { type: "linear", ...axisCommon(), ticks: { ...axisCommon().ticks, callback: (x) => Math.round(x), stepSize: 2 } }, y: axisCommon(v.unit) },
      },
      plugins: [onsetPlugin(onX)],
    });
    const ann = a.trendDiff.annual;
    const tr = a.trendDiff;
    chartDiff = new Chart($("#chartDiff"), {
      data: { datasets: [
        { type: "bar", label: "Local anomaly", data: ann.x.map((x, i) => ({ x, y: ann.y[i] })),
          backgroundColor: ann.y.map((y) => ((y > 0) === v.higherIsWorse ? css("--site") : css("--ref"))), borderRadius: 3, barPercentage: 0.8, categoryPercentage: 1 },
        { type: "line", label: "Sen's slope trend", data: ann.x.length ? [ann.x[0], ann.x[ann.x.length - 1]].map((x) => ({ x, y: tr.intercept + tr.slope * x })) : [],
          borderColor: css("--text"), borderWidth: 2, borderDash: [6, 4], pointRadius: 0 },
      ] },
      options: {
        parsing: false, animation: false, responsive: true,
        plugins: { legend: { display: false }, tooltip: { callbacks: {
          title: (it) => String(Math.floor(it[0].parsed.x)),
          label: (it) => `${it.dataset.label}: ${fmt(it.parsed.y, v.digits)} ${v.unit}` } } },
        scales: { x: { type: "linear", offset: false, ...axisCommon(), ticks: { ...axisCommon().ticks, callback: (x) => Math.round(x), stepSize: 2 } }, y: axisCommon(v.unit) },
      },
      plugins: [onsetPlugin(onX)],
    });
  }

  function renderVerdict(a, v) {
    const per10 = (t) => t.slope * 10;
    const sig = (p) => (p < 0.05 ? '<span class="badge sig">✓ significant</span>' : '<span class="badge ns">not significant</span>');
    const d = a.trendDiff, ba = a.ba;
    const dir = (x) => (x > 0 ? "rising" : "falling");
    let head;
    const span = `${a.first?.slice(0, 4)}–${a.last?.slice(0, 4)}`;
    if (v.layer.startsWith("MERRA2")) {
      const t = a.trendSite;
      head = `☁️ Regional climate control: air temperature here is ${t.slope > 0 ? "warming" : "cooling"} <b>${fmt(t.slope * 10, 2)} °C/decade</b> (${fmtP(t.p)}, ${span}). A site's local heat signal has to stand out against this background.`;
    } else if (ba && ba.p < 0.05) {
      const worse = (ba.diff > 0) === v.higherIsWorse;
      head = `${worse ? "⚠️" : "ℹ️"} Since ${a.onset.slice(0, 4)}, ${v.noun} at the site moved <b>${fmt(ba.diff, v.digits)} ${v.unit}</b> relative to its surroundings, and that's statistically significant.`;
    } else if (d.p < 0.05) {
      head = `📈 The site's ${v.noun} has been <b>${dir(d.slope)}</b> relative to its surroundings, ${fmt(per10(d), v.digits)} ${v.unit}/decade (${span}).`;
    } else {
      head = `🔍 No significant local change in ${v.noun} yet (${span}). That could mean no effect, or a pixel too big for the facility, or a record too short after the start date.`;
    }
    $("#verdict").innerHTML = `<div class="v-head">${head}</div>
      <div class="stats">
        <div class="stat"><div class="k">Site trend</div><div class="v">${fmt(per10(a.trendSite), v.digits)}</div><div class="p">${v.unit}/decade · ${fmtP(a.trendSite.p)}</div></div>
        <div class="stat"><div class="k">Surroundings</div><div class="v">${fmt(per10(a.trendRef), v.digits)}</div><div class="p">${v.unit}/decade · ${fmtP(a.trendRef.p)}</div></div>
        <div class="stat"><div class="k">Local signal</div><div class="v">${fmt(per10(d), v.digits)}</div><div class="p">/decade · ${fmtP(d.p)}<br>${sig(d.p)}</div></div>
      </div>
      ${ba ? `<div class="stat" style="margin-top:6px"><div class="k">Before vs. after ${a.onset} (site − surroundings)</div>
        <div class="v">${fmt(ba.diff, v.digits)} ${v.unit} <span class="p">95% CI [${fmt(ba.lo, v.digits)}, ${fmt(ba.hi, v.digits)}] · ${fmtP(ba.p)}</span></div>
        <div class="p">${ba.nA} months before vs. ${ba.nB} after (effective n ≈ ${ba.nEffA.toFixed(0)} / ${ba.nEffB.toFixed(0)}) ${sig(ba.p)}</div></div>` : ""}
      <div class="p muted" style="margin-top:6px;font-size:11px">Mann-Kendall on yearly means of de-seasonalized monthly data (n = ${d.n} years). Slopes = Sen's estimator.</div>`;
  }

  async function runAnalysis() {
    const v = VARS[state.varId];
    let series, onset = null;
    if (state.live) {
      liveAbort?.abort(); liveAbort = new AbortController(); const my = liveAbort;
      $("#progress").hidden = false; $("#verdict").innerHTML = '<div class="muted">Pulling NASA tiles and decoding pixels…</div>';
      // live mode: thin the record so it finishes in ~30 s
      const stride = state.varId === "NO2" ? 3 : 2;
      series = await sampleSeries(state.live.lat, state.live.lon, state.varId, {
        stride, signal: my.signal,
        onProgress: (d, n) => { $("#progress .bar i").style.width = (100 * d) / n + "%"; $("#progress span").textContent = `${d}/${n}`; },
      });
      if (my.signal.aborted) return;
      $("#progress").hidden = true;
      drawRings(state.live.lat, state.live.lon, v.ring);
    } else {
      series = SERIES[state.site.id]?.[state.varId];
      onset = state.site.onset;
      drawRings(state.site.lat, state.site.lon, v.ring);
      if (!series) { $("#verdict").innerHTML = '<div class="muted">No precomputed data yet. Run <code>python3 scripts/precompute.py</code>.</div>'; chartMain?.destroy(); chartDiff?.destroy(); return; }
    }
    const a = Stats.analyze(series, onset);
    if (!state.live) (lastResults[state.site.id] ||= {})[state.varId] = a;
    renderVerdict(a, v); drawCharts(a, v, onset);
    if (!state.live) renderLedger();
  }

  // ------------------------------------------------------------ impact ledger
  const CATS = [
    ["air", "🏭 Emission sources (reported)"], ["noise", "🔊 Noise pollution"], ["noise_suit", "⚖️ Noise lawsuit"],
    ["water", "💧 Water use"], ["water_quality", "🧪 Water quality"], ["power", "⚡ Power draw (drives emissions & heat)"],
  ];
  const GAP_TEXT = {
    water_quality: "Not visible at this scale from orbit. Next step: Landsat/HLS aquatic reflectance or NASA PACE for nearby rivers and lakes, plus local water-utility test results.",
    noise: "No satellite can hear. Noise needs ground sensors or resident reports, which a citizen-science layer could add.",
  };
  function satelliteCard(id, cat) {
    const a = lastResults[state.site.id]?.[id]; const v = VARS[id];
    if (!a) return "";
    const ba = a.ba, d = a.trendDiff;
    let txt;
    if (v.layer.startsWith("MERRA2")) {
      if (!isFinite(a.trendSite.slope)) return "";
      txt = `Regional air ${a.trendSite.slope > 0 ? "warming" : "cooling"} <b>${fmt(a.trendSite.slope * 10, 2)} °C/decade</b> (${fmtP(a.trendSite.p)}), the background a local signal must beat`;
    } else if (ba) txt = `Site vs. surroundings after ${a.onset}: <b>${fmt(ba.diff, v.digits)} ${v.unit}</b> (${fmtP(ba.p)})`;
    else if (isFinite(d.slope)) txt = `Local trend ${fmt(d.slope * 10, v.digits)} ${v.unit}/decade (${fmtP(d.p)})`;
    else return "";
    return `<div class="led"><div class="top"><span class="cat">${cat}</span><span class="kind satellite">🛰 measured</span></div><div class="val">${txt}</div></div>`;
  }
  function renderLedger() {
    const s = state.site, L = s.ledger || {};
    let html = "";
    html += satelliteCard("NO2", "🌫️ Air: NO₂ (satellite)") + satelliteCard("AOD", "🌫️ Air: particles (satellite)") + satelliteCard("LST_Night", "🌡️ Night heat (satellite)")
      + satelliteCard("LST_Day", "🌡️ Day heat (satellite)") + satelliteCard("NDVI", "🌳 Land cover (satellite)") + satelliteCard("AirTemp", "☁️ Regional weather (control)");
    for (const [k, label] of CATS) {
      const e = L[k];
      if (e) html += `<div class="led"><div class="top"><span class="cat">${label}</span><span class="kind">${e.kind}</span></div><div class="val">${e.value}</div>${e.src ? `<a href="${e.src[1]}" target="_blank" rel="noopener">↗ ${e.src[0]}</a>` : ""}</div>`;
      else if (GAP_TEXT[k]) html += `<div class="led"><div class="top"><span class="cat">${label}</span><span class="kind gap">data gap</span></div><div class="val">${GAP_TEXT[k]}</div></div>`;
    }
    $("#ledger").innerHTML = html;
  }

  // ------------------------------------------------------------ click anywhere = live mode
  new Cesium.ScreenSpaceEventHandler(viewer.canvas).setInputAction((ev) => {
    const picked = scene.pick(ev.position);
    if (picked?.id?.id?.startsWith?.("site-")) return selectSite(SITES.find((s) => "site-" + s.id === picked.id.id));
    const cart = viewer.camera.pickEllipsoid(ev.position, scene.globe.ellipsoid); if (!cart) return;
    const c = Cesium.Cartographic.fromCartesian(cart);
    state.live = { lat: Cesium.Math.toDegrees(c.latitude), lon: Cesium.Math.toDegrees(c.longitude) };
    renderChips(); renderStory(); renderTabs(); runAnalysis();
    $("#ledger").innerHTML = '<div class="led"><div class="val">The ledger is available for the case-study sites. For your own spot, the satellite results above are the measured part.</div></div>';
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  // ------------------------------------------------------------ guided tour (the challenge's "demonstration examples")
  const S = Object.fromEntries(SITES.map((s) => [s.id, s]));
  const hls = (id) => hlsDates[id] || {};
  const TOUR = [
    { t: "Data centers are physical", p: "Every chatbot reply runs in a building that burns power, heats the ground and, sometimes, pollutes the air. Let's look for those footprints with NASA satellites.", go: () => { setMapLayer("none", null, null, false); viewer.camera.flyTo({ destination: Cesium.Cartesian3.fromDegrees(-92, 37, 7.5e6), duration: 2.5 }); } },
    { t: "Memphis: xAI Colossus", p: "A former appliance factory became one of the world's largest AI supercomputers in 2024, powered partly by on-site methane gas turbines. Boxtown (red dot) is ~3 km away.", go: () => { selectSite(S.colossus1, { varId: "NO2" }); setMapLayer("HLS", hls("colossus1").before?.date, hls("colossus1").after?.date, true); flyTo(S.colossus1.lat, S.colossus1.lon, 9, -55, 20, 3); } },
    { t: "What the turbines put in the air", p: "Gas turbines emit NOx. TROPOMI sees NO₂ from space. The panel compares NO₂ over the site with a 20–50 km ring around it, before vs. after mid-2024.", go: () => { selectSite(S.colossus1, { fly: false, varId: "NO2" }); setMapLayer("NO2", "2025-07-15", null, false); flyTo(S.colossus1.lat, S.colossus1.lon, 160, -60, 0, 2.5); } },
    { t: "Colossus 2: watching land disappear", p: "The second campus went from open land to industrial site in 2025. Drag the split to compare before and after in 30 m imagery, then check the greenness trend.", go: () => { selectSite(S.colossus2, { fly: false, varId: "NDVI" }); setMapLayer("HLS", hls("colossus2").before?.date, hls("colossus2").after?.date, true); flyTo(S.colossus2.lat, S.colossus2.lon, 7, -55, -15, 3); } },
    { t: "The long view: Data Center Alley", p: "Twenty years of build-out in Ashburn, VA. Its nights now run warmer than the land around it, a 24/7 heat fingerprint. Mann-Kendall says that trend is real (p = 0.001).", go: () => { selectSite(S.ashburn, { fly: false, varId: "LST_Night" }); setMapLayer("LST_Night", "2004-07-11", "2025-07-12", true); flyTo(S.ashburn.lat, S.ashburn.lon, 60, -55, 0, 3.5); } },
    { t: "Weather or data center?", p: "Is it just a hotter climate? NASA's MERRA-2 weather reanalysis shows the regional air temperature, our control. A site only counts as a signal when it changes relative to its surroundings, not with the whole region.", go: () => { selectSite(S.ashburn, { fly: false, varId: "AirTemp" }); setMapLayer("LST_Night", "2025-07-12", null, false); flyTo(S.ashburn.lat, S.ashburn.lon, 220, -60, 0, 3); } },
    { t: "Stargate Abilene: the next one", p: "Pillar height = planned power draw (~1.2 GW). Power at this scale means heat, and where it's generated on site, air pollution. Drag the split to watch rangeland turn into server halls.", go: () => { selectSite(S.abilene, { fly: false, varId: "NDVI" }); setMapLayer("HLS", hls("abilene").before?.date, hls("abilene").after?.date, true); flyTo(S.abilene.lat, S.abilene.lon, 12, -50, 30, 3.5); } },
    { t: "Your turn, detective", p: "Click anywhere on Earth. We'll pull live NASA data for that spot and its surroundings, then test whether the change is real.", go: () => { setMapLayer("none", null, null, false); } },
  ];
  let tourI = 0;
  function showTour(i) {
    tourI = Math.max(0, Math.min(TOUR.length - 1, i)); const s = TOUR[tourI];
    $("#tourCard").hidden = false; $("#tourText").innerHTML = `<h4>${s.t}</h4><p>${s.p}</p>`; $("#tourStep").textContent = `${tourI + 1} / ${TOUR.length}`;
    $("#tourNext").textContent = tourI === TOUR.length - 1 ? "Finish" : "Next ›"; s.go();
  }
  $("#tourBtn").onclick = () => showTour(0);
  $("#tourNext").onclick = () => (tourI === TOUR.length - 1 ? ($("#tourCard").hidden = true) : showTour(tourI + 1));
  $("#tourPrev").onclick = () => showTour(tourI - 1);
  $("#tourEnd").onclick = () => ($("#tourCard").hidden = true);
  document.addEventListener("keydown", (e) => { if ($("#tourCard").hidden) return; if (e.key === "ArrowRight") $("#tourNext").click(); if (e.key === "ArrowLeft") $("#tourPrev").click(); if (e.key === "Escape") $("#tourEnd").click(); });

  // ------------------------------------------------------------ boot
  // pre-run the satellite analyses so the ledger shows measured cards immediately
  for (const s of SITES) for (const id of Object.keys(VARS)) { const ser = SERIES[s.id]?.[id]; if (ser) (lastResults[s.id] ||= {})[id] = Stats.analyze(ser, s.onset); }
  selectSite(SITES[0], { fly: false });
  // Unreal / embed hook: ?site=colossus1&var=NO2&embed=1
  const q = new URLSearchParams(location.search);
  if (q.get("site") && S[q.get("site")]) selectSite(S[q.get("site")], { varId: q.get("var") || undefined });
  if (q.get("tour") != null) showTour(+q.get("tour"));
  if (q.get("embed")) { $("#globe").style.display = "none"; $("#topbar").style.display = "none"; $("#panel").style.width = "100%"; }
  window.CloudShadow = { selectSite: (id, v) => S[id] && selectSite(S[id], { varId: v }), viewer, state };
})();

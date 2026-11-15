// Footprint Atlas - UI v3 shell: search → one panel (theme tabs, one claim, BEFORE | AFTER).
// Logic lives in ui-facts.js; this file only renders and wires the existing app (window.CloudShadow,
// window.CloudShadowTimeline). The panel renders from the data files immediately, so a slow 3D scene
// never leaves the user on an empty globe. ?ui=classic disables it.
import { THEMES, PUBLISHED, shown, confidence, measuredVerdict, claim, reportedWater, reportedPower, levelFact, beforeAfterYears } from "./ui-facts.js";

const q = new URLSearchParams(location.search);
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ALIASES = {
  colossus1: "memphis xai elon musk colossus tennessee boxtown grok", colossus2: "memphis xai colossus whitehaven southaven mississippi tulane",
  ashburn: "ashburn virginia loudoun data center alley aws amazon microsoft equinix", abilene: "abilene texas stargate openai oracle crusoe lancium",
  thedalles: "the dalles oregon google columbia river",
};
const S = { sites: [], context: {}, wayback: null, cs: null, site: null, theme: "air", rows: new Map(), facts: {}, side: "after", flip: null, heatMap: true, min: false };

// ------------------------------------------------------------------ landing
function buildLanding() {
  const L = document.createElement("div");
  L.id = "v2Landing"; L.setAttribute("role", "dialog"); L.setAttribute("aria-label", "Find a data center");
  L.innerHTML = `<div class="v3-landing"><div class="v3-kicker">Footprint Atlas · NASA Space Apps 2026</div>
    <h1>What is a data center doing to the place around it?</h1>
    <p class="lede">Pick a data center to see how the air, heat and greenery around it changed, measured with NASA Earth data.</p>
    <input id="v3Search" type="search" autocomplete="off" placeholder="Search a city, company or data center" aria-label="Search a city, company or data center" />
    <div class="v3-results" id="v3Results" role="listbox"></div>
    <div class="v3-foot">Data: NASA MODIS, Aura OMI, HLS, MERRA-2, POWER; ESA Sentinel-5P. Team Goofy Goobers.</div></div>`;
  document.body.append(L); document.body.classList.add("v2-landing-open");
  const input = $("#v3Search", L), list = $("#v3Results", L);
  const render = () => {
    const t = input.value.toLowerCase().trim();
    const hits = S.sites.filter((s) => !t || `${s.name} ${s.place} ${s.operator} ${ALIASES[s.id] || ""}`.toLowerCase().includes(t));
    list.innerHTML = hits.length ? hits.map((s, i) => `<button class="v3-site" role="option" data-site="${esc(s.id)}"><span class="n">${String(i + 1).padStart(2, "0")}</span><span><b>${esc(s.name)}</b><span class="where">${esc(s.place)} · ${esc(s.operator)}</span></span><span class="go">Open →</span></button>`).join("")
      : `<div class="v3-empty">We haven't studied “${esc(input.value)}” yet. Try Memphis, Virginia, Texas, Oregon, xAI or Google.</div>`;
  };
  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") list.querySelector("[data-site]")?.click(); });
  L.addEventListener("click", (e) => { const b = e.target.closest("[data-site]"); if (b) openSite(b.dataset.site); });
  if (q.get("q")) input.value = q.get("q");
  render(); setTimeout(() => input.focus(), 200);
}

// Simple line icons (24×24, stroke = currentColor) so each theme reads at a glance.
const ICONS = {
  air: '<path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h16a3 3 0 1 1-3 3"/><path d="M3 16h8"/>',
  heat: '<path d="M10 14.5V5a2 2 0 1 1 4 0v9.5a4 4 0 1 1-4 0z"/><path d="M12 9v7"/>',
  green: '<path d="M5 19c0-8 5-14 15-14 0 10-6 15-14 15"/><path d="M5 19l8-8"/>',
  water: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  power: '<path d="M13 2L5 14h6l-1 8 8-12h-6z"/>',
};
const icon = (k) => `<svg class="v3-ico" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[k]}</svg>`;

// ------------------------------------------------------------------ site chrome
function buildChrome() {
  document.body.insertAdjacentHTML("beforeend", `
    <header id="v2Header" hidden><button id="v2Back" class="v3-round" aria-label="Back to search">←</button>
      <div><div class="v3-name" id="v3Name"></div><div class="v3-where" id="v3Where"></div></div>
      <button id="v2Help" class="v3-round" aria-label="How to read this">?</button></header>
    <section id="v3Panel" hidden aria-live="polite">
      <nav class="v3-tabs" role="tablist" aria-label="What to look at">${Object.entries(THEMES).map(([k, t]) => `<button class="v3-tab" role="tab" data-theme="${k}" style="--c:${t.hex}">${icon(k)}<span>${t.label}</span></button>`).join("")}</nav>
      <div class="v3-body"><button class="v3-min" id="v3Min" aria-label="Hide panel" title="Hide to see the map">Hide ▾</button><p class="v3-claim" id="v3Claim"></p><p class="v3-conf" id="v3Conf"></p></div>
      <div class="v3-ba"><button class="side" data-side="before"></button><button class="side" data-side="after"></button><button class="v3-btn flip" id="v3Flip" aria-pressed="false">▶ Flip</button></div>
      <div class="v3-links"><button class="v3-btn dark" id="v3PhotosBtn">Compare satellite photos</button><button class="v3-link" id="v3Years">All years</button><button class="v3-link" id="v3Sources">Sources &amp; charts</button><button class="v3-link" id="v3HeatMap" hidden></button><span class="note" id="v3Note"></span></div>
    </section>
    <button id="v3Pill" class="v3-btn dark" hidden aria-label="Show panel"></button>
    <div id="v2HowCard" hidden><h3>How to read this</h3>
      <p>Every number compares <b>the data center site</b> with <b>the land around it</b>, so regional weather cancels out.</p>
      <p><b>Before / After</b> switches the 3D scene between a year before the site started and the latest year. <b>Flip</b> alternates them so changes jump out.</p>
      <p>We only show changes with <b>Strong</b> or <b>Clear evidence</b> (less than a 5% chance of being a fluke). Topics without that are left out for the site.</p>
      <p>Water and Power are <b>reported</b> figures with sources, not satellite measurements.</p>
      <p>The 3D glows, haze and ripples are <b>exaggerated</b> so changes are easy to spot; the exact numbers are in the text.</p>
      <p style="color:var(--ink-3);font-size:13px">A change next to a data center is evidence, not proof the data center caused it.</p>
      <button class="v3-btn dark" id="v3Tour">Take the guided tour</button></div>
    <div id="v3Photos" hidden role="dialog" aria-label="Satellite photos before and after"></div>`);
  $("#v2Back").onclick = showLanding;
  $("#v2Help").onclick = () => { $("#v2HowCard").hidden = !$("#v2HowCard").hidden; };
  $("#v3Tour").onclick = () => { $("#v2HowCard").hidden = true; $("#tourBtn")?.click(); };
  $("#v3Panel").addEventListener("click", (e) => {
    const t = e.target.closest("[data-theme]"); if (t) { if (S.min) setMinimized(false); return selectTheme(t.dataset.theme); }
    const s = e.target.closest("[data-side]"); if (s) { stopFlip(); setSide(s.dataset.side); }
  });
  $("#v3Flip").onclick = () => (S.flip ? stopFlip() : startFlip());
  $("#v3Years").onclick = () => document.body.classList.toggle("v3-years");
  $("#v3Sources").onclick = () => toggleScience(true);
  $("#v3PhotosBtn").onclick = openPhotos;
  $("#v3Min").onclick = () => setMinimized(true);
  $("#v3Pill").onclick = () => setMinimized(false);
  $("#v3HeatMap").onclick = () => { S.heatMap = !S.heatMap; selectTheme(S.theme); };
  const panel = $("#panel");
  if (panel) {
    panel.insertAdjacentHTML("afterbegin", `<div class="science-close"><b>Sources &amp; charts</b><button type="button">Close ✕</button></div>`);
    panel.querySelector(".science-close button").onclick = () => toggleScience(false);
  }
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { toggleScience(false); $("#v3Photos").hidden = true; $("#v2HowCard").hidden = true; } });
}

function setMinimized(min, label) {
  S.min = min;
  // The theme rail stays on the left edge; hiding only drops the cards that cover the scene.
  $("#v3Panel").hidden = !S.site; $("#v3Panel").classList.toggle("is-min", min); $("#v3Pill").hidden = !min || !S.site;
  $("#v3Pill").innerHTML = S.site ? `${icon(S.theme)}<span>${esc(label || `Show ${THEMES[S.theme].label.toLowerCase()} details`)}</span>` : "";
  if (!min) $("#v3Pill").classList.remove("v3-hint");
}
// ~4.5 km range at 38° tilt ≈ 2.8 km camera height, inside neighborhood.js ENTER_HEIGHT (5,800 m) so the low-poly scene loads.
const flyClose = () => S.cs && S.site && S.cs.flyTo(S.site.lat, S.site.lon, 4.5, -38, 20, 2.5);
// The app's own site flight can start after ours; re-check once the flights settle.
const ensureClose = () => { for (const t of [900, 3600]) setTimeout(() => { if ((S.cs?.viewer?.camera.positionCartographic.height ?? 0) > 5800) flyClose(); }, t); };
const toggleScience = (open) => { document.body.classList.toggle("science-open", open); if (open) document.body.classList.remove("panel-collapsed"); };

// ------------------------------------------------------------------ facts per site
async function loadFacts(site) {
  const [vars, tl] = await Promise.all([
    fetch(`data/series/${site.id}.json`).then((r) => r.json()).then((d) => d.vars).catch(() => ({})),
    fetch(`data/unreal/timeline/${site.id}.json`).then((r) => r.json()).catch(() => ({ rows: [] })),
  ]);
  S.rows = new Map(tl.rows.map((r) => [+r.Year, r]));
  const mean = (a) => { const v = a.filter((x) => x != null && isFinite(x)); return v.reduce((s, x) => s + x, 0) / v.length; };
  for (const key of ["air", "heat", "green"]) {
    const v = THEMES[key].rowVars.map((rv) => vars[rv] && measuredVerdict(key, Stats.analyze(vars[rv], site.onset), mean(vars[rv].ref), site.onset)).find(Boolean);
    const pub = PUBLISHED[site.id]?.[key], years = beforeAfterYears(key, S.rows, site.onset);
    S.facts[key] = { verdict: v, published: pub, years: pub ? { ...years, before: pub.before.year, after: pub.after.year } : years };
  }
  S.facts.water = { rep: reportedWater(site.id, site.ledger?.water), years: beforeAfterYears("water", S.rows, site.onset) };
  S.facts.power = { rep: reportedPower(site.ledger?.power, S.context.homesPerMW), years: beforeAfterYears("power", S.rows, site.onset) };
}

function sideFact(key, year, before) {
  const f = S.facts[key];
  if (f.published) return f.published[before ? "before" : "after"].fact;
  if (!THEMES[key].reported) return levelFact(key, S.rows.get(year), f.years.rowVar) || "No value for this year";
  if (before) return ["ashburn"].includes(S.site.id) ? "No figure for that year" : "Not a data center yet";
  if (f.rep.short) return f.rep.short;
  return f.rep.missing ? "No public figure" : key === "water" ? `≈ ${f.rep.homes} households' water a day` : `${f.rep.mw.toLocaleString("en-US")} MW`;
}

function render() {
  const key = S.theme, T = THEMES[key], f = S.facts[key], P = $("#v3Panel");
  P.style.setProperty("--c", T.hex);
  P.querySelectorAll(".v3-tab").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.theme === key)));
  if (T.reported) {
    $("#v3Claim").textContent = f.rep.missing ? f.rep.text : `${f.rep.text}${key === "water" ? "." : "."}`;
    $("#v3Conf").innerHTML = `<b>Reported, not measured by satellite</b>${f.rep.kindText ? ` · ${esc(f.rep.kindText)}` : ""}${f.rep.src ? ` · <a href="${esc(f.rep.src[1])}" target="_blank" rel="noopener">source ↗</a>` : ""}`;
    $("#v3Note").textContent = "";
  } else if (f.published) {
    $("#v3Claim").textContent = f.published.text;
    $("#v3Conf").innerHTML = `<b>${esc(f.published.conf)}</b> <a href="${esc(f.published.src[1])}" target="_blank" rel="noopener">source ↗</a>. ${esc(T.why)}`;
    $("#v3Note").textContent = f.published.src[0];
  } else {
    const c = f.verdict.conf;
    if (f.verdict.p >= 0.05) { // Heat only (see shown()): show the map, claim nothing
      $("#v3Claim").textContent = "NASA's night-heat map of the area. Red = warmer than in 2005, blue = cooler.";
      $("#v3Conf").innerHTML = `No clear change at the site itself yet, so we don't claim one. ${esc(T.why)}`;
      $("#v3Note").textContent = `Data: ${T.source}`;
    } else {
    $("#v3Claim").textContent = claim(key, f.verdict, S.site);
    $("#v3Conf").innerHTML = `<b>${c.word}</b>: ${c.note} (p = ${f.verdict.p < 0.001 ? "<0.001" : f.verdict.p.toFixed(3)}). ${esc(T.why)}`;
    $("#v3Note").textContent = `Data: ${T.source}`;
    }
  }
  for (const side of ["before", "after"]) {
    const y = f.years[side];
    P.querySelector(`[data-side="${side}"]`).innerHTML = `<span class="lab">${side.toUpperCase()}</span><span class="yr">${y}</span><span class="fact">${esc(sideFact(key, y, side === "before"))}</span>`;
    P.querySelector(`[data-side="${side}"]`).setAttribute("aria-pressed", String(S.side === side));
  }
  $("#v3PhotosBtn").hidden = !S.wayback?.[S.site.id];
}

// ------------------------------------------------------------------ before / after
function setSide(side) {
  S.side = side;
  const year = S.facts[S.theme].years[side];
  window.CloudShadowTimeline?.setYear(year); // drives the team's scene, smoke and landscape via "cs:year"
  window.dispatchEvent(new CustomEvent("cs:theme", { detail: { theme: S.theme, site: S.site, facts: S.facts[S.theme], side, year, mapOn: S.theme === "heat" && S.heatMap } }));
  render();
}
function startFlip() { S.flip = setInterval(() => setSide(S.side === "after" ? "before" : "after"), 1800); $("#v3Flip").setAttribute("aria-pressed", "true"); $("#v3Flip").textContent = "❚❚ Stop"; }
function stopFlip() { clearInterval(S.flip); S.flip = null; $("#v3Flip")?.setAttribute("aria-pressed", "false"); if ($("#v3Flip")) $("#v3Flip").textContent = "▶ Flip"; }

function selectTheme(key) {
  S.theme = key;
  try { S.cs?.setMapLayer(key === "heat" && S.heatMap ? "LST_Night" : "none"); } catch { /* scene not ready yet */ }
  // Map at near-full strength so the regional pattern reads clearly over the low-poly scene (team default is 0.65).
  const op = $("#opacity"); if (op && key === "heat" && S.heatMap && +op.value < 0.9) { op.value = "0.9"; op.dispatchEvent(new Event("input")); }
  const hm = $("#v3HeatMap"); hm.hidden = key !== "heat"; hm.textContent = S.heatMap ? "Hide heat map" : "Show heat map";
  setSide(S.side);
}

// High-resolution Esri Wayback photos of the same 3×3 tile block (data/cloudshadow/wayback.json, scripts/wayback_pick.py).
function openPhotos() {
  const w = S.wayback?.[S.site.id], tpl = S.wayback?._meta?.tile; if (!w || !tpl) return;
  const z = 16, n = 2 ** z, s = Math.sin(S.site.lat * Math.PI / 180);
  const cx = Math.floor((S.site.lon + 180) / 360 * n), cy = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
  const grid = (rel) => [-1, 0, 1].flatMap((dy) => [-1, 0, 1].map((dx) => `<img alt="" draggable="false" src="${tpl.replace("{release}", rel).replace("{z}", z).replace("{y}", cy + dy).replace("{x}", cx + dx)}">`)).join("");
  const box = $("#v3Photos");
  box.innerHTML = `<div class="v3-ph"><h2>The ground at ${esc(S.site.name)}</h2><p>Drag across the photo. Left: ${w.before.date.slice(0, 4)}, before the site's start. Right: ${w.after.date.slice(0, 4)}.</p>
    <div class="v3-cmp" id="v3Cmp" tabindex="0" role="slider" aria-label="Before and after divider" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50">
      <div class="img">${grid(w.before.release)}</div><div class="img after">${grid(w.after.release)}</div>
      <div class="bar"></div><div class="grip">◀ ▶</div><span class="tag l">BEFORE · ${w.before.date.slice(0, 4)}</span><span class="tag r">AFTER · ${w.after.date.slice(0, 4)}</span></div>
    <div class="row"><span class="credit">Imagery: Esri World Imagery Wayback (Maxar, Earthstar Geographics). Releases ${esc(w.before.date)} and ${esc(w.after.date)}; capture dates can differ.</span><button class="v3-btn" id="v3PhClose">Close</button></div></div>`;
  box.hidden = false;
  const cmp = $("#v3Cmp"), set = (pct) => { pct = Math.max(0, Math.min(100, pct)); cmp.style.setProperty("--x", pct + "%"); cmp.setAttribute("aria-valuenow", String(Math.round(pct))); };
  const fromEvent = (e) => set(((e.clientX - cmp.getBoundingClientRect().left) / cmp.clientWidth) * 100);
  cmp.addEventListener("pointerdown", (e) => { e.preventDefault(); cmp.setPointerCapture(e.pointerId); fromEvent(e); }); // no native image drag/selection
  cmp.addEventListener("pointermove", (e) => { if (e.buttons) fromEvent(e); });
  cmp.addEventListener("keydown", (e) => { if (e.key === "ArrowLeft" || e.key === "ArrowRight") set(+cmp.getAttribute("aria-valuenow") + (e.key === "ArrowLeft" ? -5 : 5)); });
  $("#v3PhClose").onclick = () => { box.hidden = true; };
  box.onclick = (e) => { if (e.target === box) box.hidden = true; };
}

// ------------------------------------------------------------------ navigation
async function openSite(id) {
  const site = S.sites.find((s) => s.id === id); if (!site) return;
  S.site = site; stopFlip();
  $("#v2Landing")?.classList.add("gone"); document.body.classList.remove("v2-landing-open");
  $("#v3Name").textContent = site.name; $("#v3Where").textContent = `${site.place} · ${site.operator}`;
  $("#v2Header").hidden = false;
  await loadFacts(site);
  // Themes without Clear/Strong evidence (or a documented figure) are not offered for this site.
  const ok = Object.keys(THEMES).filter((k) => shown(k, S.facts[k]));
  document.querySelectorAll(".v3-tab").forEach((b) => { b.hidden = !ok.includes(b.dataset.theme); });
  const pref = q.get("theme") in THEMES ? q.get("theme") : site.effects?.plume ? "air" : (site.watchFor?.[0] || "").startsWith("LST") ? "heat" : "green";
  S.theme = ok.includes(pref) ? pref : ok[0];
  S.side = q.get("side") === "before" ? "before" : "after";
  if (S.cs && S.cs.state?.site?.id !== id) S.cs.selectSite(id);
  flyClose(); ensureClose();
  selectTheme(S.theme);
  // Panel stays out of the way while the camera flies into the low-poly view, then the pill bounces as a hint.
  setMinimized(true, "See what changed here");
  clearTimeout(S.hintTimer); S.hintTimer = setTimeout(() => S.min && $("#v3Pill").classList.add("v3-hint"), 2800);
  if (q.get("photos") === "1") openPhotos();
  history.replaceState(null, "", `?site=${id}`);
}

function showLanding() {
  stopFlip(); toggleScience(false);
  $("#v2Header").hidden = true; $("#v3Panel").hidden = true; $("#v3Pill").hidden = true;
  $("#v2Landing").classList.remove("gone"); document.body.classList.add("v2-landing-open");
  history.replaceState(null, "", location.pathname);
}

// ------------------------------------------------------------------ boot: UI first, 3D scene when it's ready
if (q.get("ui") !== "classic") {
  document.body.classList.add("ui-v2");
  const [doc, wayback] = await Promise.all([
    fetch("data/sites.json").then((r) => r.json()),
    fetch("data/wayback.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  S.sites = doc.sites; S.context = doc.context || {}; S.wayback = wayback;
  buildChrome(); buildLanding();
  const ready = (cs) => { S.cs = cs; if (S.site) { if (cs.state?.site?.id !== S.site.id) cs.selectSite(S.site.id); selectTheme(S.theme); flyClose(); ensureClose(); } };
  if (window.CloudShadow) ready(window.CloudShadow); else window.addEventListener("cs:ready", (e) => ready(e.detail), { once: true });
  // shortcut: polls for the timeline module (no ready event); fine while it loads within seconds.
  const whenTimeline = () => (window.CloudShadowTimeline ? S.site && setSide(S.side) : setTimeout(whenTimeline, 500));
  whenTimeline();
  if (q.get("site")) openSite(q.get("site"));
  if (q.get("compare") === "1") setTimeout(() => S.site && startFlip(), 1500);
}

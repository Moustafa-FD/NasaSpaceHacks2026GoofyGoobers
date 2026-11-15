// Footprint Atlas - plain-language facts for the UI (pure functions, tested in tests/ui-facts.test.js).
// Verdicts describe the CHANGE in the site-minus-surroundings gap; year facts describe that year's LEVEL.

export const THEMES = {
  air: { label: "Air", hex: "#6b4fa0", rowVars: ["NO2", "NO2_OMI"], worseIfUp: true, noun: "NO₂",
    what: "nitrogen dioxide (NO₂), a gas from burning fuel", source: "Sentinel-5P TROPOMI (ESA/Copernicus) and NASA Aura OMI",
    why: "NO₂ irritates lungs and helps form smog; children, older adults and people with asthma feel it most." },
  heat: { label: "Heat", hex: "#c9541f", rowVars: ["LST_Night"], worseIfUp: true, noun: "night-time heat",
    what: "the temperature of the ground at night", source: "NASA MODIS land-surface temperature (Terra)",
    why: "Warmer nights give bodies and homes less chance to cool down during heat waves." },
  green: { label: "Greenery", hex: "#33803f", rowVars: ["NDVI"], worseIfUp: false, noun: "greenery",
    what: "plant cover (NDVI)", source: "NASA MODIS vegetation index (Terra)",
    why: "Plants shade and cool the ground and soak up rain; paving them over makes an area hotter." },
  water: { label: "Water", hex: "#23709f", reported: true,
    why: "Cooling water often comes from the same rivers and aquifers that homes and farms rely on." },
  power: { label: "Power", hex: "#a0760a", reported: true,
    why: "Electricity on this scale has to be generated somewhere; at Colossus 1 part of it came from on-site gas turbines." },
};

// EPA WaterSense: "The average American family uses more than 300 gallons of water per day at home."
export const HOUSEHOLD_GAL_PER_DAY = 300;
// Condensed from data/cloudshadow/sites.json → ledger (sources linked there).
export const WATER_QUICK = {
  colossus1: { galLow: 0.38e6, galPerDay: 1.3e6, kindText: "reported range: measured peak to contracted peak" },
  colossus2: { galPerDay: 3.7e6, kindText: "requested for Colossus 1 and 2 together, not measured" },
  thedalles: { galPerDay: 355e6 / 365, kindText: "reported for 2021: 29% of the city's water" },
};

// Peer-level outside analyses used where they are stronger than our own monthly MODIS/OMI series.
export const PUBLISHED = {
  colossus2: {
    air: { since: 2026, text: "In spring 2026, NO₂ over the area rose about 49% as the gas turbines powering the site were added: the largest rise among 656 US urban areas since 2020.",
      conf: "Clear evidence from a satellite study (NASA TEMPO and Sentinel-5P; permutation test p = 1/81). Preprint, not yet peer-reviewed.",
      src: ["Qiang et al. 2026, arXiv:2611.06115", "https://arxiv.org/abs/2611.06115"],
      // The study compares Apr–Jul 2026 with the same days in 2024–25 (2025 vs 2024: no significant change).
      before: { year: 2025, fact: "Before the turbine fleet grew" }, after: { year: 2026, fact: "≈ 49% more NO₂ (Apr–Jul)" } },
  },
};

// Only Clear/Strong measured results (p < 0.05), published analyses, and documented figures are shown.
export function shown(key, f) {
  if (!f) return false;
  if (THEMES[key].reported) return !!f.rep && !f.rep.missing;
  if (key === "heat") return true; // always offered for the NASA heat map; the claim text stays neutral unless Clear/Strong
  return !!f.published || (!!f.verdict && f.verdict.p < 0.05);
}

const fmtN = (x) => new Intl.NumberFormat("en-US").format(x);
const num = (x) => (x == null || x === "" ? null : +x);
const pct = (v, ref) => (v == null || !ref ? null : (v / Math.abs(ref)) * 100);

export function confidence(p) {
  if (p == null || !isFinite(p)) return { level: 0, word: "Not clear yet", note: "can't be told apart from chance yet" };
  if (p < 0.01) return { level: 3, word: "Strong evidence", note: "very unlikely to be chance" };
  if (p < 0.05) return { level: 2, word: "Clear evidence", note: "unlikely to be chance" };
  if (p < 0.1) return { level: 1, word: "Weak evidence", note: "suggestive, could still be chance" };
  return { level: 0, word: "Not clear yet", note: "can't be told apart from chance yet" };
}

// a = Stats.analyze(series, onset); refMean = mean of the surroundings series.
export function measuredVerdict(key, a, refMean, onset) {
  let value, p, since;
  if (a.ba && a.ba.nA >= 6 && a.ba.nB >= 6) { value = a.ba.diff; p = a.ba.p; since = +String(onset).slice(0, 4); }
  else if (isFinite(a.trendDiff?.slope)) { value = a.trendDiff.slope * 10; p = a.trendDiff.p; since = null; }
  else return null;
  const conf = confidence(p), up = value > 0;
  const dir = conf.level === 0 ? "flat" : up === THEMES[key].worseIfUp ? "worse" : "better";
  const amount = key === "heat" ? `${Math.abs(value).toFixed(1)} °C` : `${Math.abs(pct(value, refMean) ?? 0).toFixed(0)}%`;
  return { value, p, since, conf, dir, amount, up };
}

export function claim(key, v, site) {
  const when = v.since ? `Since ${v.since}` : "Each decade since 2003";
  if (v.dir === "flat") return `${when}, ${{ heat: "night-time heat", green: "greenery", air: "NO₂" }[key]} at the site hasn't clearly changed compared with the land around it.`;
  if (key === "heat") return `${when}, nights at the site ${v.up ? "warmed" : "cooled"} ${v.amount} more than the land around it.`;
  if (key === "green") return `${when}, the site ${v.up ? "gained" : "lost"} ${v.amount} of its greenery compared with the land around it.`;
  return `${when}, NO₂ over the site went ${v.up ? "up" : "down"} ${v.amount} compared with the area around it${v.since && site?.effects?.plume ? ", after on-site gas turbines were reported" : ""}.`;
}

export function reportedWater(siteId, entry) {
  const w = WATER_QUICK[siteId];
  if (!w && entry?.kind === "official") return { text: entry.value, short: entry.short, kindText: entry.scope, src: entry.src };
  if (!w) return { missing: true, text: entry?.value || "No public water figure for this site.", src: entry?.src };
  const f = (g) => fmtN(g / HOUSEHOLD_GAL_PER_DAY >= 10000 ? Math.round(g / HOUSEHOLD_GAL_PER_DAY / 1000) * 1000 : Math.round(g / HOUSEHOLD_GAL_PER_DAY / 100) * 100);
  const homes = w.galLow ? `${f(w.galLow)}–${f(w.galPerDay)}` : f(w.galPerDay);
  return { homes, households: w.galPerDay / HOUSEHOLD_GAL_PER_DAY, text: `About ${homes} households' daily water use`, kindText: w.kindText, src: entry?.src };
}

export function reportedPower(entry, homesPerMW = 800) {
  if (!entry?.mw && entry?.kind === "official") return { text: entry.value, short: entry.short, kindText: entry.scope, src: entry.src };
  if (!entry?.mw) return { missing: true, text: entry?.value || "Electricity use not published.", src: entry?.src };
  const homes = entry.mw * homesPerMW;
  const homesTxt = homes >= 1e6 ? `${(homes / 1e6).toFixed(1)} million` : fmtN(Math.round(homes / 1000) * 1000);
  const scope = /northern virginia/i.test(entry.value) ? " across Northern Virginia" : /planned/i.test(entry.value) ? " planned" : "";
  return { mw: entry.mw, text: `${fmtN(entry.mw)} MW${scope}: about ${homesTxt} homes' average electricity use`, src: entry.src };
}

// Level of the site-vs-surroundings gap in one timeline row.
export function levelFact(key, row, rowVar) {
  const v = num(row?.[`${rowVar}_Local`]);
  if (v == null) return null;
  if (key === "heat") return `Nights ${Math.abs(v).toFixed(1)} °C ${v >= 0 ? "warmer" : "cooler"} than nearby`;
  const p = pct(v, num(row[`${rowVar}_Surround`]));
  if (p == null) return null;
  if (key === "green") return `${Math.abs(p).toFixed(0)}% ${v < 0 ? "less green" : "greener"} than nearby`;
  return `${Math.abs(p).toFixed(0)}% ${v >= 0 ? "more" : "less"} NO₂ than nearby`;
}

// Before = last year before the site's start with data; after = latest complete year with data (same variable for both).
export function beforeAfterYears(key, rows, onset, lastYear = 2025) {
  const start = +String(onset).slice(0, 4);
  for (const rv of THEMES[key].rowVars || []) {
    const has = (y) => num(rows.get(y)?.[`${rv}_Local`]) != null;
    let before = null, after = null;
    for (let y = start - 1; y >= 2003; y--) if (has(y)) { before = y; break; }
    for (let y = lastYear; y >= start; y--) if (has(y)) { after = y; break; }
    if (before && after) return { before, after, rowVar: rv };
  }
  return { before: Math.max(2003, start - 1), after: lastYear, rowVar: null };
}

// One headline number per theme and year for the badge above BEFORE/AFTER.
// Returns { value, text, label } or null when there is no figure for that year.
export function statFor(key, f, row, year, site) {
  if (!f) return null;
  const start = +String(site.onset).slice(0, 4), started = year >= start;
  const lead = (s) => num(String(s ?? "").match(/[\d.,]+/)?.[0]?.replace(/,/g, ""));
  if (f.published) {
    const after = year >= f.published.after.year, p = lead(f.published.after.fact);
    return { value: after ? p : 0, text: after ? `+${p}%` : "0%", label: `${THEMES[key].noun} vs 2024–25` };
  }
  if (THEMES[key].reported) {
    const r = f.rep;
    if (!r || r.missing) return null;
    if (!started) return site.id === "ashburn" ? null : { value: 0, text: "0", label: key === "power" ? "MW" : "households' water" };
    if (key === "power" && r.mw) return { value: r.mw, text: fmtN(r.mw), label: "megawatts" };
    if (key === "water" && r.households) return { value: r.households, text: fmtN(Math.round(r.households / 100) * 100), label: "households' daily water" };
    const v = lead(r.short);
    return v == null ? null : { value: v, text: r.short.match(/^[\d.,]+%?/)[0], label: r.short.replace(/^[\d.,]+%?\s*/, "") };
  }
  const rv = f.years?.rowVar, v = num(row?.[`${rv}_Local`]);
  if (v == null) return null;
  if (key === "heat") return { value: Math.abs(v), text: `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)} °C`, label: `nights ${v >= 0 ? "warmer" : "cooler"} than nearby` };
  const p = pct(v, num(row[`${rv}_Surround`]));
  if (p == null) return null;
  if (key === "green") return { value: Math.max(0, -p), text: `${Math.abs(p).toFixed(0)}%`, label: p < 0 ? "less green than nearby" : "greener than nearby" };
  return { value: Math.max(0, p), text: `${Math.abs(p).toFixed(0)}%`, label: p >= 0 ? "more NO₂ than nearby" : "less NO₂ than nearby" };
}

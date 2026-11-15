import { loadElectricityData, nearestElectricityCity, electricitySnapshot } from './electricity-data.js';
import { loadWaterPriceData, waterPriceSnapshot } from './water-price-data.js';

const money = (value) => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value) : '—';
const number = (value, digits = 1) => Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const signedMoney = (value) => finite(value) ? `${value > 0 ? '+' : value < 0 ? '−' : ''}${money(Math.abs(value))}` : '—';

export function electricityComparisonText(snapshot) {
  if (!finite(snapshot?.changePct) || snapshot.kind === 'unavailable') return 'No price comparison available';
  const pct = snapshot.changePct;
  return `${number(Math.abs(pct), 1)}% ${pct > 0 ? 'higher' : pct < 0 ? 'lower' : 'unchanged'} electricity price vs ${snapshot.baselineYear}`;
}

/** A published water tariff is never labelled as a future household forecast. */
export function waterPricePresentation(snapshot, selectedYear) {
  const available = snapshot?.kind !== 'unavailable' && finite(snapshot?.monthlyBillUsd);
  const rateYear = finite(snapshot?.rateYear) ? snapshot.rateYear : null;
  const published = rateYear == null ? 'Published rate · date unspecified' : `Published ${rateYear} rate`;
  return {
    bill: available ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(snapshot.monthlyBillUsd) : 'Unavailable',
    usage: `${number(snapshot?.monthlyGallons ?? 3000, 0)} US gal/month example · water only`,
    status: !available ? snapshot?.reason || 'No verified water tariff for this city.' : snapshot.kind === 'reference'
      ? `${published} · reference for ${selectedYear}, not a forecast`
      : rateYear == null ? published : `${snapshot.scheduled ? 'Approved scheduled' : 'Published'} ${rateYear} water tariff`,
  };
}

/** Details are opt-in; closing them must never disable the map card. */
export function electricityViewState(previous, action) {
  if (action.type === 'activate') return { active: !!action.active, detailsOpen: !!action.active && !!previous.detailsOpen };
  if (action.type === 'open-details') return { active: true, detailsOpen: true };
  if (action.type === 'close-details') return { ...previous, detailsOpen: false };
  return previous;
}

/** Missing years are gaps; projections connect to the last recorded value. */
export function electricityChartSegments(points) {
  const observed = [], projected = [];
  let a = [], b = [], previous = null;
  for (const point of points) {
    if (!finite(point.priceCentsKwh) || point.kind === 'unavailable') {
      if (a.length) observed.push(a); if (b.length) projected.push(b);
      a = []; b = []; previous = null; continue;
    }
    if (point.kind === 'projected') {
      if (a.length) { observed.push(a); a = []; }
      if (!b.length && previous?.kind === 'observed') b.push(previous);
      b.push(point);
    } else {
      if (b.length) { projected.push(b); b = []; }
      a.push(point);
    }
    previous = point;
  }
  if (a.length) observed.push(a); if (b.length) projected.push(b);
  return { observed, projected };
}

export function electricityPhaseText(snapshot, onsetYear) {
  if (snapshot.kind === 'unavailable') return 'No estimate for this year';
  return `${snapshot.year < onsetYear ? 'Before site milestone' : 'Since site milestone'} · ${snapshot.kind === 'projected' ? 'Projected' : 'Recorded'}`;
}

function chartMarkup(data, city, site, current) {
  const records = data.states?.[city.state]?.records || [], first = records[0]?.year, last = current.lastObservedYear ?? records.at(-1)?.year;
  if (!finite(first) || !finite(last)) return '<p>Price history unavailable.</p>';
  const start = Math.max(first, 2003, (current.baselineYear ?? last - 12) - 3), end = current.projectionThrough ?? last;
  const onset = Number.parseInt(site.onset, 10);
  const points = Array.from({ length: end - start + 1 }, (_, k) => electricitySnapshot(data, city, start + k, onset));
  const valid = points.filter((p) => finite(p.priceCentsKwh) && p.kind !== 'unavailable');
  if (!valid.length) return '<p>Price history unavailable.</p>';
  const W = 300, H = 126, L = 30, R = 10, T = 10, B = 24;
  const prices = valid.flatMap((p) => [p.priceCentsKwh, p.lowerPriceCentsKwh, p.upperPriceCentsKwh].filter(finite));
  const low = Math.max(0, Math.floor(Math.min(...prices) / 5) * 5), high = Math.ceil((Math.max(...prices) + 1) / 5) * 5;
  const x = (v) => L + (v - start) / Math.max(1, end - start) * (W - L - R), y = (v) => T + (high - v) / Math.max(1, high - low) * (H - T - B);
  const path = (ps) => ps.map((p, k) => `${k ? 'L' : 'M'}${x(p.year)},${y(p.priceCentsKwh)}`).join(' ');
  const segments = electricityChartSegments(points), projected = points.filter((p) => p.kind === 'projected' && finite(p.lowerPriceCentsKwh) && finite(p.upperPriceCentsKwh));
  const band = projected.map((p) => `${x(p.year)},${y(p.upperPriceCentsKwh)}`).concat([...projected].reverse().map((p) => `${x(p.year)},${y(p.lowerPriceCentsKwh)}`)).join(' ');
  return `<div class="electricity-chart-title">Electricity price <span>¢ / kWh</span></div><svg class="electricity-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escape(`${city.state} electricity prices, ${start}–${end}. Solid: recorded; dashed: conditional projection with model range.`)}">
    ${[low, (low + high) / 2, high].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="electricity-grid"/><text x="${L - 5}" y="${y(v) + 4}" text-anchor="end">${number(v, v % 1 ? 1 : 0)}</text>`).join('')}
    ${band ? `<polygon points="${band}" class="electricity-band"/>` : ''}${segments.observed.map((p) => `<path d="${path(p)}" class="electricity-observed"/>`).join('')}${segments.projected.map((p) => `<path d="${path(p)}" class="electricity-projected"/>`).join('')}
    ${current.year >= start && current.year <= end && finite(current.priceCentsKwh) ? `<circle cx="${x(current.year)}" cy="${y(current.priceCentsKwh)}" r="4" class="electricity-dot"/>` : ''}
    ${[start, last, end].filter((v, k, all) => all.indexOf(v) === k).map((v) => `<text x="${x(v)}" y="${H - 4}" text-anchor="${v === start ? 'start' : v === end ? 'end' : 'middle'}">${v}</text>`).join('')}</svg><div class="electricity-chart-key"><span class="actual">Recorded</span><span class="projection">Projected + range</span></div>`;
}

function sourceMarkup(data, snapshot) {
  const ids = new Set(snapshot?.sourceIds || []), sources = Array.isArray(data.sources) ? data.sources : Object.values(data.sources || {});
  return sources.filter((s) => (!ids.size || ids.has(s.id)) && /^https:\/\//.test(s.url || '')).slice(0, 5).map((s) => `<a href="${escape(s.url)}" target="_blank" rel="noopener">${escape(s.title || 'Official source')} ↗</a>`).join('');
}

/** The toggle only enables the nearest-city card. Extra detail opens on card click. */
export function attachElectricityUI({ eventTarget = window, fetchImpl = fetch } = {}) {
  const doc = eventTarget.document || document;
  let data = null, dataTask = null, waterData = null, waterTask = null, waterError = false, costKind = 'electricity', destroyed = false, view = { active: false, detailsOpen: false };
  let site = eventTarget.CloudShadow?.state?.site || null, city = null, frame = null, currentSnapshot = null;
  let year = Number(eventTarget.CloudShadowTimeline?.year || doc.querySelector('#tlSlider')?.value || 2025);
  const handlers = [], on = (name, fn) => { eventTarget.addEventListener(name, fn); handlers.push([name, fn]); };
  const toggle = doc.createElement('button');
  toggle.id = 'electricityToggle'; toggle.type = 'button'; toggle.className = 'electricity-toggle';
  toggle.setAttribute('aria-pressed', 'false'); toggle.setAttribute('aria-label', 'Show nearest city bills');
  toggle.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m13 2-8 12h6l-1 8 9-13h-7z"/></svg><span>City bills</span>';
  const panel = doc.createElement('section'); panel.id = 'electricityPanel'; panel.hidden = true; panel.setAttribute('aria-label', 'Nearest city bills');
  panel.innerHTML = '<div class="electricity-heading"><h2>Household bills</h2><button type="button" class="electricity-close" aria-label="Close city bill details">×</button></div><nav class="city-cost-kind" aria-label="Bill type"><button type="button" data-city-cost-kind="electricity" aria-pressed="true">Electricity</button><button type="button" data-city-cost-kind="water" aria-pressed="false">Water</button></nav><div class="electricity-content"><p class="electricity-empty" role="status">Loading official records…</p></div>';
  doc.body.append(toggle, panel);
  const content = panel.querySelector('.electricity-content');
  toggle.onclick = () => setActive(!view.active, { reason: 'user' });
  panel.querySelector('.electricity-close').onclick = closeDetails;

  function requestYear(next) {
    if (!finite(next)) return;
    if (eventTarget.CloudShadowTimeline?.setYear) eventTarget.CloudShadowTimeline.setYear(next);
    else eventTarget.dispatchEvent(new CustomEvent('cs:year', { detail: { year: next, siteId: site?.id } }));
    year = next; update();
  }
  panel.addEventListener('input', (e) => { if (e.target.id === 'electricityYear') requestYear(Number(e.target.value)); });
  panel.addEventListener('click', (e) => {
    const kind = e.target.closest('[data-city-cost-kind]'); if (kind) chooseKind(kind.dataset.cityCostKind, true);
    const action = e.target.closest('[data-electricity-year]'); if (action) requestYear(Number(action.dataset.electricityYear));
    if (e.target.closest('[data-electricity-retry]')) { dataTask = null; waterTask = null; waterError = false; ensureData(); }
  });
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeDetails(); toggle.focus(); } });

  function visibility() {
    toggle.hidden = !site; toggle.classList.toggle('active', view.active); toggle.setAttribute('aria-pressed', String(view.active));
    toggle.setAttribute('aria-label', `${view.active ? 'Hide' : 'Show'} nearest city bills`);
    panel.hidden = !view.active || !view.detailsOpen;
    doc.body.classList.toggle('electricity-active', view.active);
    if (view.active) ensureData();
    update();
  }
  function setActive(active, { reason = 'user' } = {}) {
    applyActive(active);
    eventTarget.dispatchEvent(new CustomEvent('cs:electricity', { detail: { active: !!active, reason } }));
  }
  function applyActive(active) { view = electricityViewState(view, { type: 'activate', active }); visibility(); }
  function openDetails() {
    const wasActive = view.active; view = electricityViewState(view, { type: 'open-details' }); visibility();
    if (!wasActive) eventTarget.dispatchEvent(new CustomEvent('cs:electricity', { detail: { active: true } }));
  }
  function closeDetails() { view = electricityViewState(view, { type: 'close-details' }); visibility(); }

  function chooseKind(next, emit = false) {
    if (next !== 'electricity' && next !== 'water') return;
    costKind = next;
    for (const button of panel.querySelectorAll('[data-city-cost-kind]')) button.setAttribute('aria-pressed', String(button.dataset.cityCostKind === next));
    if (view.active) ensureData(); update();
    if (emit) eventTarget.dispatchEvent(new CustomEvent('cs:city-cost-kind', { detail: { kind: next } }));
  }

  function mountContent() {
    if (!content.querySelector('#electricityYear')) content.innerHTML = '<div class="electricity-reading"></div><div class="electricity-time"><label for="electricityYear">Year <output></output></label><input id="electricityYear" type="range" step="1" aria-label="City bill year"/><div class="electricity-year-actions"></div></div><div class="electricity-more"></div>';
  }
  function yearControls(snapshot) {
    const first = Math.max(2003, snapshot.firstObservedYear || 2003), last = snapshot.lastObservedYear, through = snapshot.projectionThrough;
    const slider = content.querySelector('#electricityYear'); slider.min = String(first); slider.max = String(through); slider.value = String(Math.max(first, Math.min(through, year)));
    content.querySelector('.electricity-time output').textContent = String(Math.round(year));
    const rateYear = finite(currentSnapshot?.rateYear) ? currentSnapshot.rateYear : null;
    const middle = costKind !== 'water' ? `<button type="button" data-electricity-year="${last}">Latest ${last}</button>` : rateYear == null ? '' : `<button type="button" data-electricity-year="${rateYear}">Rate ${rateYear}</button>`;
    content.querySelector('.electricity-year-actions').innerHTML = `<button type="button" data-electricity-year="${snapshot.baselineYear ?? first}">Before ${snapshot.baselineYear ?? first}</button>${middle}<button type="button" data-electricity-year="${through}">${costKind === 'water' ? 'Year' : 'Future'} ${through}</button>`;
  }
  function renderWater(electricity, moreOpen) {
    panel.querySelector('.electricity-heading h2').textContent = 'Water bill example';
    if (!waterData) { content.querySelector('.electricity-reading').innerHTML = `<p class="electricity-empty">${waterError ? 'Published water tariff unavailable.' : 'Loading published water tariff…'}</p>`; content.querySelector('.electricity-more').innerHTML = ''; yearControls(electricity); return; }
    const s = waterPriceSnapshot(waterData, city, year, 3000), text = waterPricePresentation(s, Math.round(year));
    currentSnapshot = s; panel.dataset.kind = s.kind;
    const source = /^https:\/\//.test(s.sourceUrl || '') ? `<a href="${escape(s.sourceUrl)}" target="_blank" rel="noopener">${escape(s.sourceTitle || 'Utility water tariff')} ↗</a>` : '';
    content.querySelector('.electricity-reading').innerHTML = `<p class="electricity-geography"><b>${escape(city.name)}, ${escape(city.state)}</b>${s.provider ? ` · ${escape(s.provider)}` : ''}</p>
      <div class="water-cost-bill">${escape(text.bill)}${finite(s.monthlyBillUsd) && s.kind !== 'unavailable' ? '<small>/mo</small>' : ''}</div><p class="water-cost-usage">${escape(text.usage)}</p>
      <p class="water-cost-reference">${escape(text.status)}</p>${finite(s.fixedChargeUsd) ? `<p class="water-cost-fee">Base charge ${new Intl.NumberFormat('en-US', {style:'currency',currency:'USD'}).format(s.fixedChargeUsd)}/month</p>` : ''}`;
    yearControls(electricity);
    content.querySelector('.electricity-more').innerHTML = `<details class="electricity-method"${moreOpen ? ' open' : ''}><summary>Source &amp; what this includes</summary><p>This is a 3,000-US-gallon example, not a measured average household bill. Water only; sewer, taxes and other services may be billed separately.</p>${s.effectiveDate ? `<p>Tariff effective ${escape(s.effectiveDate)}.</p>` : ''}${s.rateNote ? `<p>${escape(s.rateNote)}</p>` : ''}${s.referenceNote ? `<p>${escape(s.referenceNote)}</p>` : ''}<p>Future water rates are not forecast. A published reference rate does not establish the rate charged in another year or the effect of a data center.</p><div class="electricity-sources">${source}</div></details>`;
  }

  function render() {
    frame = null; if (destroyed) return;
    toggle.hidden = !site;
    if (!view.active || !view.detailsOpen || !data) return;
    city = nearestElectricityCity(data, site);
    if (!site || !city) { content.innerHTML = '<p class="electricity-empty">No nearby city electricity record.</p>'; return; }
    const onset = Number.parseInt(site.onset, 10), s = electricitySnapshot(data, city, year, onset); currentSnapshot = s;
    const available = s.kind !== 'unavailable' && finite(s.priceCentsKwh), projected = s.kind === 'projected';
    const first = Math.max(2003, s.firstObservedYear || 2003), last = s.lastObservedYear, through = s.projectionThrough;
    const moreOpen = !!content.querySelector('details[open]');
    mountContent();
    panel.dataset.kind = s.kind; panel.dataset.city = city.id; panel.dataset.year = String(year); panel.dataset.costKind = costKind;
    if (costKind === 'water') { renderWater(s, moreOpen); return; }
    panel.querySelector('.electricity-heading h2').textContent = 'Household electricity';
    content.querySelector('.electricity-reading').innerHTML = `<p class="electricity-geography"><b>${escape(city.name)}, ${escape(city.state)}</b> · state average</p>
      <div class="electricity-comparison"><div><span>BEFORE · ${s.baselineYear ?? '—'}</span><strong>${money(s.baselineBillUsd)}<small>/mo</small></strong><span>${number(s.baselinePriceCentsKwh, 2)}¢/kWh</span></div><div><span>${!available ? 'UNAVAILABLE' : projected ? 'PROJECTED' : 'RECORDED'} · ${Math.round(year)}</span><strong>${available ? money(s.monthlyBillUsd) : '—'}<small>/mo</small></strong><span>${available ? number(s.priceCentsKwh, 2) : '—'}¢/kWh</span></div></div>
      <p class="electricity-change">${escape(electricityComparisonText(s))}</p>${!available ? `<p class="electricity-empty">No estimate after ${through}.</p>` : ''}`;
    yearControls(s);
    content.querySelector('.electricity-more').innerHTML = `<details class="electricity-method"${moreOpen ? ' open' : ''}><summary>Chart, sources &amp; assumptions</summary>
      <div class="electricity-chart-block">${chartMarkup(data, city, site, s)}</div>
      <p>${escape(electricityPhaseText(s, onset))}. Milestone: ${escape(site.onsetLabel || site.onset)}. Before means the last full year before that milestone.</p>
      <p>${projected ? `Projected bill holds ${last} usage fixed at ${number(s.comparisonMonthlyKwh, 0)} kWh/month.` : 'Historical monthly bills are recorded EIA state household averages; household usage also changes.'} This is a state proxy, not this city's utility tariff.</p>
      ${available && finite(s.comparableBillChangeUsd) ? `<p>${signedMoney(s.comparableBillChangeUsd)}/month from price alone at the same ${number(s.comparisonMonthlyKwh, 0)} kWh.</p>` : ''}
      ${projected ? `<p>Conditional trend through ${through}; no data-center surcharge is predicted.${finite(s.lowerBillUsd) ? ` 95% model range: ${money(s.lowerBillUsd)}–${money(s.upperBillUsd)}/month.` : ''} This range is not calibrated for ten-year forecasts.</p>` : ''}
      ${finite(s.validationMaePct) ? `<p>One-year historical holdout error: ${number(s.validationMaePct, 1)}%. This does not validate a ten-year projection.</p>` : ''}
      <p>A price change does not identify how much this facility caused.</p><div class="electricity-sources">${sourceMarkup(data, s)}</div></details>`;
  }
  function update() {
    if (frame != null || destroyed) return;
    frame = eventTarget.requestAnimationFrame ? eventTarget.requestAnimationFrame(render) : setTimeout(render, 0);
  }
  async function ensureData() {
    try {
      data = await (dataTask ??= loadElectricityData({ fetchImpl }));
      if (costKind === 'water') { try { waterData = await (waterTask ??= loadWaterPriceData({ fetchImpl })); } catch { waterTask = null; waterError = true; } }
      if (!destroyed) { city = nearestElectricityCity(data, site); update(); }
    } catch { if (!destroyed) content.innerHTML = '<p class="electricity-empty" role="alert">City bill records unavailable.</p><button type="button" data-electricity-retry>Try again</button>'; }
  }
  on('cs:electricity', ({ detail }) => { if (typeof detail?.active === 'boolean') applyActive(detail.active); });
  on('cs:electricity-city', ({ detail }) => { if (detail?.kind) chooseKind(detail.kind); if (detail?.openDetails === true) openDetails(); });
  on('cs:city-cost-kind', ({ detail }) => chooseKind(detail?.kind));
  on('cs:site', ({ detail }) => { if (detail?.site) { site = detail.site; view = electricityViewState(view, { type: 'close-details' }); city = data ? nearestElectricityCity(data, site) : null; visibility(); } });
  on('cs:ready', ({ detail }) => { site = detail?.state?.site || eventTarget.CloudShadow?.state?.site || site; visibility(); });
  on('cs:year', ({ detail }) => { if (finite(detail?.year) && (!detail.siteId || detail.siteId === site?.id)) { year = detail.year; update(); } });
  update();
  return {
    setActive, openDetails, closeDetails, update,
    get state() { return { ...view, kind: costKind, site, city, year, snapshot: currentSnapshot }; },
    destroy() { destroyed = true; for (const [name, fn] of handlers) eventTarget.removeEventListener(name, fn); if (frame != null) { if (eventTarget.cancelAnimationFrame) eventTarget.cancelAnimationFrame(frame); else clearTimeout(frame); } toggle.remove(); panel.remove(); doc.body.classList.remove('electricity-active'); },
  };
}

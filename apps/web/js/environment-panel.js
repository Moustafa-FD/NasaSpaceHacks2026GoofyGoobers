import { ENVIRONMENT_ACTIONS, buildEnvironmentRequest, climateRows, createEnvironmentClient, createStaticEnvironment, createWaterStationLookup, environmentSeries, waterStations } from './environment-data.js';

export const escapeEnvironmentHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const h = escapeEnvironmentHtml;
const num = (v, digits = 1) => typeof v === 'number' && Number.isFinite(v) ? (v !== 0 && Math.abs(v) < 10 ** -digits ? v.toExponential(2) : v.toLocaleString('en-US', { maximumFractionDigits: digits })) : 'Unavailable';
const signed = (v) => typeof v === 'number' && Number.isFinite(v) ? `${v > 0 ? '+' : ''}${num(v)}` : 'Unavailable';
const note = (text) => `<p class="env-note">${h(text)}</p>`;
const metricNames = { meanTempC: 'Annual mean temperature', hotDays35C: 'Very hot days (maximum ≥35°C)', precipMmPerYear: 'Annual precipitation' };
const button = (action, label) => `<button type="button" class="env-secondary" data-action="${action}">${label}</button>`;
const link = (url, label = 'Source') => {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) && !u.username && !u.password ? `<a href="${h(u.href)}" target="_blank" rel="noopener noreferrer">${h(label)} ↗</a>` : ''; } catch { return ''; }
};

export function climateSummaryHtml(result, { metric = 'meanTempC', scenario = 'ssp245', year = 2025 } = {}) {
  const rows = climateRows(result, metric, scenario);
  if (!rows.length) return note('No prepared climate evidence for this location. A live climate request can query a selected point.');
  return `<div class="env-evidence">Climate scenario · ${h(result.source?.name || 'NASA NEX-GDDP-CMIP6')}</div>
    ${note(`Timeline ${year}. These are period summaries, not predictions for an individual year or a facility's effect.`)}
    <div class="env-table-scroll"><table><caption>${h(metricNames[metric] || metric)} · ${h(rows[0].unit)}</caption><thead><tr><th>Period</th><th>Median</th><th>Model range</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><th scope="row">${h(r.label)}</th><td>${num(r.median)}</td><td>${num(r.min)} – ${num(r.max)}</td></tr>${r.change ? `<tr class="env-change"><td>Change from baseline</td><td>${signed(r.change.median)}</td><td>${signed(r.change.min)} – ${signed(r.change.max)}</td></tr>` : ''}`).join('')}
    </tbody></table></div>${note(`${rows[0].models ?? result.ensemble?.length ?? 'Unknown number of'} models. Ranges show ensemble min–max spread, not confidence intervals.`)}
    ${note(result.sampling?.note || 'Sampled years represent each climate window; inspect source coverage.')}
    <details><summary>Source and assumptions</summary>${note(result.evidenceNote)}${note(`${result.sampling?.yearsPerWindow ?? 'Unspecified'} sampled years per 20-year window. ${result.source?.citation || ''} Retrieved ${result.source?.retrieved || 'date not supplied'}. ${result.source?.license || ''}`)}${link(result.source?.access, 'Climate source')}</details>`;
}

export function seriesChartHtml(series) {
  const points = series?.points || [], finite = points.filter((p) => typeof p.value === 'number' && Number.isFinite(p.value));
  if (!finite.length) return note('No numeric observations were returned. Missing and censored values are not zero.');
  const dates = points.map((p) => Date.parse(p.date));
  let first = Infinity, last = -Infinity, min = Infinity, max = -Infinity;
  for (const date of dates) if (Number.isFinite(date)) { first = Math.min(first, date); last = Math.max(last, date); }
  if (!Number.isFinite(first)) return '';
  for (const p of finite) { min = Math.min(min, p.value); max = Math.max(max, p.value); }
  const step = Math.max(1, Math.ceil(points.length / 600));
  let path = '', pen = false;
  for (let i = 0; i < points.length; i += step) {
    // Thinning must preserve missing intervals rather than imply continuous observations.
    if (points.slice(i, i + step).some((p) => p.value == null) || !Number.isFinite(dates[i]) || !Number.isFinite(points[i].value)) { pen = false; continue; }
    const x = 8 + (dates[i] - first) / (last - first || 1) * 284, y = 82 - (points[i].value - min) / (max - min || 1) * 70;
    path += `${pen ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `; pen = true;
  }
  return `<figure class="env-chart"><svg viewBox="0 0 300 94" role="img" aria-label="${h(series.label)} time series, ${h(series.unit)}"><path d="${path}" fill="none" stroke="currentColor" stroke-width="1.6"/></svg><figcaption>${h(points[0]?.date)} → ${h(points.at(-1)?.date)} · ${finite.length}/${points.length} numeric samples<br/>Range ${num(min, 3)} – ${num(max, 3)} ${h(series.unit)}${step > 1 ? ' · chart thinned to at most 600 recorded samples' : ''}</figcaption></figure>`;
}

/** These are the backend's complete-season indicators, kept separate by model. */
export function agricultureSummaryHtml(result) {
  if (!Array.isArray(result?.comparisons)) return '';
  const settings = result.settings || {};
  const fields = [
    ['meanTemperatureC', 'Mean growing-season temperature', '°C'],
    ['heatThresholdDays', `Days above ${num(settings.heatThresholdC)}°C`, 'days/season'],
    ['dryThresholdDays', `Days below ${num(settings.dryDayThresholdMm)} mm rain`, 'days/season'],
    ['precipitationMinusReferenceEt0Mm', 'Rain minus reference ET₀', 'mm/season'],
    ['growingDegreeDaysCdays', `Growing degree days above ${num(settings.baseTemperatureC)}°C`, '°C·days/season'],
    ['frostDays', 'Days below 0°C', 'days/season'],
    ['precipitationMm', 'Growing-season precipitation', 'mm/season'],
    ['referenceEvapotranspirationMm', 'Reference evapotranspiration', 'mm/season'],
    ['meanSurfaceSoilMoisture', 'Mean surface soil moisture', 'm³/m³'],
  ];
  const table = (model, rows) => `<div class="env-table-scroll"><table><caption>${h(model.model)} · means per complete season</caption><thead><tr><th>Indicator</th><th>Baseline</th><th>Future</th><th>Change</th></tr></thead><tbody>${rows.filter(([key]) => model.indicators?.[key]).map(([key, label, unit]) => {
    const row = model.indicators[key];
    return `<tr><th scope="row">${h(label)}<br/><span class="env-note">${h(unit)}</span></th><td>${num(row.baselineMeanPerSeason, 2)}</td><td>${num(row.futureMeanPerSeason, 2)}</td><td>${signed(row.change)}</td></tr>`;
  }).join('')}</tbody></table></div>`;
  return `<p class="env-result-head">Agricultural climate exposure</p>
    ${note(`Selected growing months: ${(settings.growingMonths || []).join(', ') || 'not supplied'}. Thresholds are screening assumptions, not universal crop limits.`)}
    ${note(`Baseline ${result.baselinePeriod?.start || 'unspecified'} → ${result.baselinePeriod?.end || 'unspecified'}; future ${result.futurePeriod?.start || 'unspecified'} → ${result.futurePeriod?.end || 'unspecified'}.`)}
    ${result.comparisons.map((model) => `${note(`${model.model}: ${model.baselineSeasons ?? 'unspecified'} baseline seasons; ${model.futureSeasons ?? 'unspecified'} future seasons.`)}${table(model, fields.slice(0, 4))}<details><summary>More climate-exposure indicators</summary>${table(model, fields.slice(4))}</details>`).join('')}
    ${note('These are conditional climate-exposure indicators, not crop yields, suitability or effects attributable to a data center. Rain minus reference ET₀ is not irrigation demand or water scarcity. Incomplete seasons remain unavailable, never zero.')}
    ${(result.sources || []).map((s) => link(s.sourceUrl, 'Climate input source')).join(' ')}`;
}

export function environmentLayerControlsHtml(result, activeLayer = 'off') {
  return `${waterStations(result).length ? `<label class="env-check"><input type="checkbox" data-env="water-layer" ${activeLayer === 'water' ? 'checked' : ''}/> Show the source water station</label>` : ''}
    ${result?.grid ? `<label class="env-check"><input type="checkbox" data-env="weather-layer" ${activeLayer === 'weather' ? 'checked' : ''}/> Show native weather grid</label>${note(`Native ${result.grid.variable || 'weather'} grid · ${result.grid.date || 'date not supplied'} · ${result.grid.units || 'unit not supplied'}. Coarse regional cells do not resolve a facility footprint.`)}` : ''}`;
}

export function resultSummaryHtml(result, { seriesIndex = 0, trendUnit } = {}) {
  if (!result) return note('Load evidence to see its values, units and coverage here.');
  const all = environmentSeries(result), chosen = all[seriesIndex] || all[0], report = result.report?.difference || result.report?.target || result.report;
  let body = `<div class="env-evidence">${h(result.evidence || 'Evidence type not supplied')} · ${h(result.kind || result.sourceId || 'Source result')}</div>`;
  if (report) {
    body += `<p class="env-result-head">${h(report.summary || (report.status === 'insufficient_data' ? 'Insufficient data for a trend.' : report.direction || 'Statistical report'))}</p>`;
    if (report.status === 'insufficient_data') body += note((report.reasons || []).join(' '));
    else if (report.sen) body += note(`Sen slope ${num(report.sen.slopePerDecade, 4)} ${result.target?.unit || trendUnit || '(unit not supplied; inspect the input evidence)'} per decade; 95% interval ${num(report.sen.ciPerDecade?.[0], 4)} to ${num(report.sen.ciPerDecade?.[1], 4)}. Mann–Kendall p=${num(report.mannKendall?.pValue, 5)}.`);
    for (const text of report.limitations || []) body += note(text);
  }
  if (chosen) body += `<label>Returned variable<select data-env="series">${all.map((s, i) => `<option value="${i}" ${i === seriesIndex ? 'selected' : ''}>${h(s.label)}${s.model ? ` · ${h(s.model)}` : ''} · ${h(s.unit)}</option>`).join('')}</select></label>${seriesChartHtml(chosen)}`;
  if (result.station) body += note(`${result.station.name || result.station.id}. ${result.coverage?.recordCount ?? result.records?.length ?? 0} returned records. Qualifiers, provisional approval and censored values remain in the full evidence.`);
  if (result.coverage?.capped || result.complete === false) body += note('Coverage is incomplete or capped. An absent record is not evidence of zero.');
  body += agricultureSummaryHtml(result);
  if (!chosen && !report && !Array.isArray(result.comparisons)) body += note(result.evidenceNote || result.note || `${result.records?.length ?? result.facilities?.length ?? 0} source records returned. Download the full evidence for individual units and provenance.`);
  for (const text of (result.warnings || []).slice(0, 5)) body += note(text);
  return body + link(result.sourceUrl || result.station?.sourceUrl || result.source?.documentationUrl, 'Source documentation');
}

export function attachEnvironmentPanel({ apiBase, site, year, sites, container, eventTarget = globalThis.window, document: doc = globalThis.document, client, products, storage, stationLookup } = {}) {
  if (!doc || !eventTarget) throw new Error('The environmental inspector needs a document and event target.');
  let savedStorage = storage; if (!savedStorage) { try { savedStorage = eventTarget.localStorage; } catch { /* optional */ } }
  const local = ['localhost', '127.0.0.1'].includes(eventTarget.location?.hostname);
  const api = client || createEnvironmentClient({ baseUrl: apiBase || (local && eventTarget.location?.port === '8765' ? '/api/environment' : 'http://127.0.0.1:3000'), storage: savedStorage });
  const prepared = products || createStaticEnvironment(), findStations = stationLookup || createWaterStationLookup();
  const initialSite = site || eventTarget.CloudShadow?.state?.site || sites?.[0] || eventTarget.CloudShadow?.sites?.[0];
  const state = { site: initialSite, year: year ?? eventTarget.CloudShadowTimeline?.year ?? 2025, tab: 'climate', metric: 'meanTempC', scenario: 'ssp245', climate: null, plume: null, climateError: '', plumeError: '', api: 'Checking live data…', connected: false, domains: [], sources: [], action: 'series', requestText: '', requestError: '', requestYear: 2025, dirty: false, result: null, resultRun: null, trendUnit: null, seriesIndex: 0, pending: false, status: '', library: null, libraryKind: 'facilities', libraryQuery: '', stations: [], selectedStation: '', stationStatus: '', stationWarnings: [], layer: 'off', destroyed: false };
  let loadToken = 0, jobController, discovery, browseController, stationController, downloadUrl, runError = '', lastStatus = '';
  const shell = doc.createElement('details'); shell.id = 'environmentInspector'; shell.className = 'env-inspector panel-detail';
  shell.innerHTML = `<summary>Environmental evidence <span class="env-state">Prepared + live</span></summary><div class="env-body"><p class="env-location"></p><div class="env-tabs" role="tablist" aria-label="Environmental evidence">${[['climate', 'Climate'], ['plume', 'Plume'], ['live', 'Live data'], ['sources', 'Sources']].map(([id, title]) => `<button type="button" role="tab" id="env-tab-${id}" data-tab="${id}">${title}</button>`).join('')}</div><div class="env-content" role="tabpanel"></div></div>`;
  const host = container || doc.querySelector('#panel') || doc.body, story = host.querySelector?.('#story');
  if (story?.after) story.after(shell); else host.append(shell);
  const content = shell.querySelector('.env-content'), location = shell.querySelector('.env-location');
  const emit = (type, detail) => eventTarget.dispatchEvent(new CustomEvent(type, { detail }));
  function emitData(kind, result, source, runId, context = state.site) { emit('cs:environment-data', { siteId: context?.id, kind, result, source, runId, year: state.year, stations: waterStations(result) }); }
  function layer(name, enabled = true) { state.layer = enabled ? name : 'off'; emit('cs:environment-layer', { layer: enabled ? name : 'off', enabled, siteId: state.site?.id, result: name === 'plume' ? state.plume : state.result }); }
  function makeRequest() {
    if (!state.site) return;
    const all = environmentSeries(state.result), chosen = all[state.seriesIndex] || all[0];
    state.requestError = ''; state.dirty = false; state.requestYear = state.year;
    try { state.requestText = JSON.stringify(buildEnvironmentRequest(state.action, state.site, state.year, { stationId: state.selectedStation, runId: state.resultRun?.id, variable: chosen?.id, model: chosen?.model, state: ({ ashburn: 'VA', colossus1: 'TN', colossus2: 'TN', abilene: 'TX', thedalles: 'OR' })[state.site.id] }), null, 2); }
    catch (error) { state.requestText = ''; state.requestError = error.message; }
  }
  function updateStatus() {
    const el = content.querySelector('.env-live-status'); if (el) el.textContent = state.status || state.api;
    const go = content.querySelector('[data-action="run"]'); if (go) go.disabled = state.pending || !state.connected || !!state.requestError;
    const stop = content.querySelector('[data-action="stop"]'); if (stop) stop.hidden = !state.pending;
    const statusDetail = { siteId: state.site?.id, kind: state.action, status: state.status || state.api, pending: state.pending, error: runError }, statusKey = JSON.stringify(statusDetail);
    if (statusKey !== lastStatus) { lastStatus = statusKey; emit('cs:environment-status', statusDetail); }
  }
  function climateView() {
    return `<label>Climate measure<select data-env="metric">${Object.entries(metricNames).map(([key, title]) => `<option value="${key}" ${key === state.metric ? 'selected' : ''}>${title}</option>`).join('')}</select></label><label>Emission pathway<select data-env="scenario"><option value="ssp245" ${state.scenario === 'ssp245' ? 'selected' : ''}>SSP2-4.5 · intermediate</option><option value="ssp585" ${state.scenario === 'ssp585' ? 'selected' : ''}>SSP5-8.5 · very high</option></select></label>${state.climate ? climateSummaryHtml(state.climate, state) : note(state.climateError || 'Loading prepared climate evidence…')}${button('weather', 'Explore separate 30-year weather context')}${note('The existing timeline trend extension and these conditional climate scenarios are different products. Neither establishes facility causation.')}`;
  }
  function plumeView() {
    const p = state.plume;
    return (p ? `<div class="env-evidence">Screening scenario · relative dilution</div>${note(p.evidenceNote)}<label class="env-check"><input type="checkbox" data-env="plume-layer" ${state.layer === 'plume' ? 'checked' : ''}/> Show χ/Q footprint on the map</label>${note(`Grid: ${p.grid.n} × ${p.grid.n}, ${p.grid.cellM} m cells; ${p.grid.units}. Effective stack height ${p.assumptions?.effectiveStackHeightM ?? 'unspecified'} m. ${p.assumptions?.effectiveStackHeightNote || ''}`)}${(p.receptors || []).map((r) => note(`${r.name}: χ/Q ${num(r.chiOverQ, 8)} ${p.grid.units}${typeof r.concentrationUgM3 === 'number' ? `; ${num(r.concentrationUgM3, 3)} µg/m³ with the supplied emission` : ''}.`)).join('')}${note(`Wind sampling ${p.frames?.first || 'unspecified'} to ${p.frames?.last || 'unspecified'}. This footprint summarizes those analyses; moving the timeline does not create a year-specific plume.`)}` : note(state.plumeError || 'Loading prepared plume evidence…')) + button('plume-job', 'Screen relative dilution at this place');
  }
  function liveView() {
    let period = ''; try { const q = JSON.parse(state.requestText); period = q.start ? `${q.start} → ${q.end}` : q.date || ''; } catch { /* unavailable or edited */ }
    const history = api.history().filter((r) => !r.siteId || r.siteId === state.site?.id);
    return `<div class="env-live-status" role="status" aria-live="polite"></div><div class="env-inline">${button('connect', 'Reconnect live data')}</div>
      <div class="env-quick" role="group" aria-label="Common environmental evidence">${button('weather', 'Weather')}${button('air', 'Air')}${button('soil', 'Water &amp; soil')}${button('water', 'Water station')}</div>
      <label>Evidence source<select data-env="action">${ENVIRONMENT_ACTIONS.map(([key, title]) => `<option value="${key}" ${key === state.action ? 'selected' : ''}>${h(title)}</option>`).join('')}</select></label>
      ${note(state.requestError || ENVIRONMENT_ACTIONS.find(([key]) => key === state.action)?.[2])}
      ${period ? note(`Requested period: ${period}. ${state.action === 'series' ? 'This 1991–2020 context stays fixed as the timeline moves.' : `Prepared for timeline ${state.requestYear}.`}`) : ''}
      ${state.dirty && state.requestYear !== state.year ? note('You edited the inputs. Reset them below to follow the current timeline year.') : ''}
      ${state.action === 'water-quality' ? `<p class="env-note">${h(state.stationStatus || 'Find a real monitoring location near this place.')}</p>${button('stations', 'Find nearby stations')}${state.stations.length ? `<label>Monitoring location<select data-env="station-choice">${state.stations.map((s) => `<option value="${h(s.id)}" ${s.id === state.selectedStation ? 'selected' : ''}>${h(s.name || s.id)} · ${num(s.distanceKm)} km · ${h(s.id)}</option>`).join('')}</select></label>` : ''}${note('A mapped station may have no observations for these parameters or dates. Loading evidence checks actual coverage; no river-wide quality is inferred.')}<details><summary>Use another sourced station ID</summary><label>USGS monitoring-location ID<input data-env="station" value="${h(state.selectedStation)}" placeholder="USGS- followed by the station number"/></label></details>${state.stationWarnings.map(note).join('')}` : ''}
      ${state.action === 'trend-analysis' ? note(state.resultRun ? `Input: completed evidence ${state.resultRun.id}. Select the returned variable below before loading its statistical analysis.` : 'First load a weather, air, soil or water series. Inline series and multiple completed records can be supplied in the options.') : ''}
      <details class="env-request"><summary>Dates, inputs and source options</summary>${note('These are the exact inputs sent to the data service. Change dates or source options here; coverage and units are validated.')}<textarea data-env="request" rows="9" spellcheck="false" aria-label="Environmental evidence request">${h(state.requestText)}</textarea>${button('reset-request', 'Reset inputs for this place/year')}<label class="env-check"><input type="checkbox" data-env="fresh"/> Refresh evidence instead of reusing a saved result</label></details>
      <div class="env-inline"><button type="button" data-action="run">Load evidence</button><button type="button" data-action="stop" class="env-secondary" hidden>Stop waiting</button></div>
      ${note('Only Load evidence starts a request. Stop waiting stops progress updates; preparation may finish in the background.')}
      <div class="env-result">${resultSummaryHtml(state.result, state)}</div>
      ${state.result ? `<div class="env-inline">${button('download', 'Download full evidence')}${environmentSeries(state.result).length ? button('trend', 'Analyze returned variable') : ''}</div>` : ''}
      ${environmentLayerControlsHtml(state.result, state.layer)}
      <details><summary>Saved evidence (${history.length}, up to 20 places/requests)</summary>${history.slice().reverse().map((r) => `<button type="button" class="env-history" data-run="${h(r.id)}">${h(r.kind)} · ${h(r.siteId || 'point')} · ${h(r.status)}</button>`).join('') || note('No saved evidence for this place.')}</details>`;
  }
  function libraryView() {
    const d = state.library;
    if (!d) return note('Browse locally saved snapshots. Source identities remain separate; a missing record is not zero emissions.');
    return note(`${d.total} matching records; showing ${d.total ? d.offset + 1 : 0}–${Math.min(d.total, d.offset + d.records.length)}.`) + d.records.map((r) => `<article class="env-library-record"><strong>${h(r.name || r.facility?.name || r.facilityId || r.id)}</strong><span>${h(r.sourceId || '')} · ${h(r.year ?? '')} · ${h(r.id || '')}</span>${state.libraryKind === 'emissions' ? `<p>${h(r.pollutant?.name || r.pollutantName || (typeof r.pollutant === 'string' ? r.pollutant : r.pollutant?.code) || 'Pollutant not supplied')}: ${r.amount == null ? 'Unknown quantity' : num(r.amount, 4)} ${h(r.units || 'unit not supplied')} · ${h(r.medium || '')}</p>` : ''}${link(r.sourceUrl || r.facility?.sourceUrl)}</article>`).join('') + (d.warnings || []).slice(0, 2).map(note).join('');
  }
  function sourceView() {
    return `<div class="env-live-status" role="status">${h(state.api)}</div><div class="env-inline">${button('connect', 'Reconnect live data')}${button('facilities', 'Nearby facilities')}${button('emissions', 'Reported emissions')}</div><label>${state.libraryKind === 'facilities' ? 'Filter facility names' : 'Source facility ID (optional)'}<input data-env="library-query" value="${h(state.libraryQuery)}"/></label>${button('search-library', 'Search saved records')}<div class="env-library">${libraryView()}</div>${state.library?.nextOffset != null ? button('next-library', 'Next source records') : ''}<details><summary>Available domains and limitations</summary>${state.domains.map((d) => `<p class="env-capability"><strong>${h(d.id)}</strong> <span>${h(d.status)}</span><br/>${h(d.description)}</p>`).join('') || note('Prepared evidence works without the local service. Connect to inspect live capabilities.')}${note('No pollutant chemistry, calibrated source attribution, hydrology/groundwater balance, crop-yield or noise-propagation model is supplied.')}</details><details><summary>Data providers</summary>${state.sources.map((s) => `<p class="env-capability"><strong>${h(s.provider || s.id)}</strong> · ${h(s.adapterStatus)}<br/>${h(s.note || s.coverage || '')} ${link(s.documentationUrl || s.resourceUrl)}</p>`).join('')}</details>`;
  }
  function render() {
    if (state.destroyed) return;
    location.textContent = `${state.site?.name || 'Select a place'} · Timeline ${state.year}`;
    for (const el of shell.querySelectorAll('[data-tab]')) { el.setAttribute('aria-selected', String(el.dataset.tab === state.tab)); el.tabIndex = el.dataset.tab === state.tab ? 0 : -1; }
    content.setAttribute('aria-labelledby', `env-tab-${state.tab}`);
    content.innerHTML = ({ climate: climateView, plume: plumeView, live: liveView, sources: sourceView })[state.tab](); updateStatus();
  }
  async function connect() {
    discovery?.abort(); const controller = new AbortController(); discovery = controller;
    const timer = setTimeout(() => controller.abort(), 7000); state.api = 'Checking live data…'; updateStatus();
    try { const result = await api.discover(controller.signal); if (state.destroyed || controller !== discovery) return; state.connected = true; state.api = 'Live data ready · source evidence can be loaded'; state.domains = result.domains; state.sources = result.sources; }
    catch { if (state.destroyed || controller !== discovery) return; state.connected = false; state.api = 'Prepared evidence available. Live data is unavailable right now.'; }
    finally { clearTimeout(timer); if (!state.destroyed && controller === discovery) { updateStatus(); if (state.tab === 'sources') render(); } }
  }
  async function searchStations() {
    stationController?.abort(); const controller = new AbortController(); stationController = controller; const id = state.site?.id;
    state.stationStatus = 'Looking up nearby USGS monitoring locations…'; if (state.tab === 'live') render();
    try {
      const result = await findStations(state.site, controller.signal);
      if (controller !== stationController || state.destroyed || state.site.id !== id) return;
      state.stations = result.stations; state.stationWarnings = result.warnings || [];
      state.stationStatus = result.stations.length ? `${result.stations.length} nearby monitoring locations. Parameter and date coverage still need to be checked.` : 'No nearby monitoring locations were returned. This does not establish absence of water-quality evidence.';
      if (!state.selectedStation && result.stations.length) { state.selectedStation = result.stations[0].id; if (state.action === 'water-quality' && !state.dirty) makeRequest(); }
    } catch (error) { if (controller !== stationController || state.destroyed) return; state.stationStatus = error.name === 'AbortError' ? 'Station search stopped.' : error.message; }
    finally { if (controller === stationController && !state.destroyed && state.tab === 'live') render(); }
  }
  async function setSite(next) {
    if (!next?.id || !Number.isFinite(next.lat) || !Number.isFinite(next.lon)) return;
    const token = ++loadToken; jobController?.abort(); browseController?.abort(); stationController?.abort(); jobController = null; state.pending = false;
    if (state.layer !== 'off') layer(state.layer, false);
    runError = '';
    Object.assign(state, { site: next, climate: null, plume: null, result: null, resultRun: null, trendUnit: null, library: null, climateError: '', plumeError: '', status: '', stations: [], selectedStation: '', stationStatus: '', stationWarnings: [] }); makeRequest(); render();
    await Promise.allSettled([
      prepared.climate(next.id).then((result) => { if (token !== loadToken || state.destroyed) return; state.climate = result; emitData('climate-projection', result, 'static'); if (state.tab === 'climate') render(); }).catch((error) => { if (token === loadToken && !state.destroyed) { state.climateError = error.message; if (state.tab === 'climate') render(); } }),
      loadYearPlume(token),
    ]);
    if (token === loadToken && state.action === 'water-quality' && !state.destroyed) void searchStations();
  }
  /** Per-year footprint (that year's GEOS-FP winds), only for documented on-site combustion. */
  function loadYearPlume(token = loadToken) {
    const site = state.site, year = Math.round(state.year);
    if (site?.effects?.plume !== true) { state.plume = null; state.plumeError = 'Dispersion screening is shown only where on-site combustion is documented (Colossus 1).'; return Promise.resolve(); }
    return prepared.plumeYear(site.id, year).then((result) => { if (token !== loadToken || state.destroyed || Math.round(state.year) !== year) return; state.plume = result; state.plumeError = ''; emitData('plume-scenario', result, 'static'); if (state.tab === 'plume') render(); })
      .catch(() => { if (token === loadToken && !state.destroyed) { state.plume = null; state.plumeError = `No analysed winds for ${year} (NASA GEOS-FP covers 2018–2026).`; if (state.tab === 'plume') render(); } });
  }
  function setYear(value) {
    if (!Number.isFinite(value)) return; const changed = Math.round(value) !== Math.round(state.year); state.year = value;
    if (changed) void loadYearPlume();
    if (!state.dirty && !state.pending) makeRequest();
    if (state.tab === 'live' && (state.dirty || state.pending)) location.textContent = `${state.site?.name || 'Select a place'} · Timeline ${state.year}`; else render();
  }
  async function runRequest({ throwOnError = false } = {}) {
    if (state.pending || !state.connected || state.requestError) { if (throwOnError) throw new Error(state.requestError || (state.pending ? 'A model job is already running for this place.' : 'The local environmental API is unavailable. Start the local web server to run Python models.')); return; }
    let payload; try { payload = JSON.parse(state.requestText); if (payload.kind === 'water-quality' && !/^USGS-\d{8,15}$/.test(payload.stationId)) throw new Error('Choose a nearby monitoring location, or enter a sourced USGS station ID.'); } catch (error) { runError = error.message; state.status = error.message; updateStatus(); if (throwOnError) throw error; return; }
    const context = { ...state.site }, controller = new AbortController(), reuse = !content.querySelector('[data-env="fresh"]')?.checked;
    const input = environmentSeries(state.result).find((s) => s.id === payload.input?.variable && (!payload.input?.model || s.model === payload.input.model));
    const trendUnit = payload.input?.series?.unit || input?.unit;
    jobController?.abort(); jobController = controller; runError = ''; state.pending = true; state.status = 'Requesting environmental evidence…'; updateStatus();
    try {
      const response = await api.run(payload, { signal: controller.signal, reuse, context: { siteId: context.id }, onProgress: (run) => { if (jobController === controller) { state.status = `${run.status} · ${Number.isFinite(run.progress) ? run.progress : 0}% · ${String(run.stage || '').replaceAll('-', ' ')}`; updateStatus(); } } });
      if (state.destroyed || jobController !== controller || state.site.id !== context.id) return;
      Object.assign(state, { result: response.result, resultRun: { ...response.run, request: payload }, trendUnit, seriesIndex: 0, status: response.reused ? 'Saved evidence reused' : 'Evidence loaded' });
      if (payload.kind === 'climate-projection') state.climate = response.result;
      if (payload.kind === 'plume-scenario') state.plume = response.result;
      emitData(payload.kind, response.result, 'api', response.run.id, context);
      return response;
    } catch (error) { if (jobController === controller) { runError = error.name === 'AbortError' ? '' : error.message; state.status = error.name === 'AbortError' ? 'Stopped waiting. Preparation may finish in the background.' : `${error.message}${Array.isArray(error.details) ? ` ${error.details.join('; ')}` : ''}`; } if (throwOnError) throw error; }
    finally { if (!state.destroyed && jobController === controller) { state.pending = false; render(); } }
  }
  async function browse(kind, offset = 0) {
    if (!state.connected) { state.status = 'Live data must be available to browse saved source records.'; render(); return; }
    browseController?.abort(); const controller = new AbortController(); browseController = controller; state.libraryKind = kind;
    const filters = { offset, ...(kind === 'facilities' ? { q: state.libraryQuery, bbox: buildEnvironmentRequest('facilities-sync', state.site).bbox.join(',') } : { facilityId: state.libraryQuery }) };
    try { const result = await api.browse(kind, filters, controller.signal); if (controller !== browseController || state.destroyed) return; state.library = result; state.status = ''; render(); emitData(kind, result, 'api'); }
    catch (error) { if (controller === browseController && !state.destroyed && error.name !== 'AbortError') { state.status = error.message; render(); } }
  }
  async function restoreRun(id) {
    const controller = new AbortController(), context = state.site?.id; jobController?.abort(); jobController = controller; state.pending = true; updateStatus();
    try {
      const run = await api.status(id, controller.signal); if (controller !== jobController || state.destroyed || context !== state.site?.id) return;
      if (run.status !== 'completed') { state.requestText = JSON.stringify(run.request, null, 2); state.dirty = true; state.requestError = ''; state.status = `Saved evidence is ${run.status}. Load the same inputs to reconnect, or retry a failed request.`; return; }
      const result = await api.result(id, controller.signal); if (controller !== jobController || state.destroyed || context !== state.site?.id) return;
      Object.assign(state, { result, resultRun: run, seriesIndex: 0, trendUnit: null, status: 'Saved evidence loaded' }); emitData(run.request?.kind, result, 'api', id);
    } catch (error) { if (controller === jobController) state.status = error.message; }
    finally { if (!state.destroyed && controller === jobController) { state.pending = false; render(); } }
  }
  function chooseAction(action) { state.tab = 'live'; state.action = action; state.status = ''; makeRequest(); render(); if (action === 'water-quality' && !state.stations.length) void searchStations(); }
  async function runAction(action, options = {}) {
    if (!ENVIRONMENT_ACTIONS.some(([id]) => id === action)) throw new Error('Choose a supported environmental operation.');
    if (state.pending) throw new Error('A model job is already running for this place.');
    const siteId = state.site?.id;
    if (!state.connected) await connect();
    if (state.destroyed || state.site?.id !== siteId) return;
    // An explicit supported period may differ from the global timeline; the
    // returned result retains its own dates and never changes the slider.
    state.action = action; state.tab = 'live'; runError = ''; state.status = '';
    makeRequest();
    if(options.payload){state.requestText=JSON.stringify(options.payload,null,2);state.requestError='';}
    else if (Number.isFinite(options.year)) {
      try { state.requestText = JSON.stringify(buildEnvironmentRequest(action, state.site, options.year), null, 2); state.requestError = ''; state.requestYear = options.year; }
      catch (error) { state.requestError = error.message; }
    }
    render();
    return runRequest({ throwOnError: true });
  }
  function click(event) {
    const el = event.target.closest?.('button'); if (!el || !shell.contains(el)) return;
    if (el.dataset.tab) { state.tab = el.dataset.tab; render(); el.focus(); return; }
    if (el.dataset.run) { void restoreRun(el.dataset.run); return; }
    switch (el.dataset.action) {
      case 'weather': chooseAction('series'); break;
      case 'air': chooseAction('air-quality'); break;
      case 'soil': chooseAction('land-water'); break;
      case 'water': chooseAction('water-quality'); break;
      case 'plume-job': chooseAction('plume-scenario'); break;
      case 'connect': void connect(); break;
      case 'stations': void searchStations(); break;
      case 'reset-request': makeRequest(); render(); break;
      case 'run': void runRequest(); break;
      case 'stop': jobController?.abort(); break;
      case 'trend': chooseAction('trend-analysis'); break;
      case 'facilities': if (state.libraryKind !== 'facilities') state.libraryQuery = ''; void browse('facilities'); break;
      case 'emissions': if (state.libraryKind !== 'emissions') state.libraryQuery = ''; void browse('emissions'); break;
      case 'search-library': void browse(state.libraryKind); break;
      case 'next-library': void browse(state.libraryKind, state.library.nextOffset); break;
      case 'download': { if (downloadUrl) URL.revokeObjectURL(downloadUrl); downloadUrl = URL.createObjectURL(new Blob([JSON.stringify(state.result, null, 2)], { type: 'application/json' })); const a = doc.createElement('a'); a.href = downloadUrl; a.download = `environment-${state.site.id}-${state.resultRun?.id || 'prepared'}.json`; a.click(); break; }
    }
  }
  function setStation(id) { state.selectedStation = id.trim(); try { const q = JSON.parse(state.requestText); q.stationId = state.selectedStation; state.requestText = JSON.stringify(q, null, 2); state.dirty = true; const input = content.querySelector('[data-env="request"]'); if (input) input.value = state.requestText; } catch { /* submission displays parse errors */ } }
  function change(event) {
    const el = event.target;
    switch (el.dataset.env) {
      case 'metric': state.metric = el.value; emit('cs:future-options', { metric: state.metric }); render(); break;
      case 'scenario': state.scenario = el.value; emit('cs:future-options', { scenario: state.scenario }); render(); break;
      case 'action': chooseAction(el.value); break;
      case 'series': state.seriesIndex = Number(el.value); if (state.action === 'trend-analysis') makeRequest(); render(); break;
      case 'plume-layer': layer('plume', el.checked); break;
      case 'water-layer': layer('water', el.checked); break;
      case 'weather-layer': layer('weather', el.checked); break;
      case 'station': case 'station-choice': setStation(el.value); break;
    }
  }
  const input = (event) => { if (event.target.dataset.env === 'request') { state.requestText = event.target.value; state.dirty = true; state.requestError = ''; updateStatus(); } if (event.target.dataset.env === 'library-query') state.libraryQuery = event.target.value; };
  const onSite = ({ detail }) => { if (detail?.site) void setSite(detail.site); };
  const onYear = ({ detail }) => { if (!detail?.siteId || detail.siteId === state.site?.id) setYear(detail.year); };
  const onFutureOptions = ({ detail }) => { if (['ssp245', 'ssp585'].includes(detail?.scenario)) state.scenario = detail.scenario; if (Object.hasOwn(metricNames, detail?.metric)) state.metric = detail.metric; if (state.tab === 'climate') render(); };
  const keydown = (event) => { if (event.target.getAttribute?.('role') !== 'tab' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; const tabs = [...shell.querySelectorAll('[data-tab]')], index = tabs.indexOf(event.target), next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length; event.preventDefault(); state.tab = tabs[next].dataset.tab; render(); tabs[next].focus(); };
  shell.addEventListener('click', click); shell.addEventListener('change', change); shell.addEventListener('input', input); shell.addEventListener('keydown', keydown); eventTarget.addEventListener('cs:site', onSite); eventTarget.addEventListener('cs:year', onYear); eventTarget.addEventListener('cs:future-options', onFutureOptions);
  makeRequest(); render(); void connect(); if (initialSite) void setSite(initialSite);
  return { setSite, setYear, runAction, get state() { return state; }, show(tab = 'climate') { state.tab = tab; shell.open = true; render(); }, openAction(action) { shell.open = true; chooseAction(action); shell.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, destroy() { state.destroyed = true; loadToken++; jobController?.abort(); discovery?.abort(); browseController?.abort(); stationController?.abort(); if (state.layer !== 'off') layer(state.layer, false); eventTarget.removeEventListener('cs:site', onSite); eventTarget.removeEventListener('cs:year', onYear); eventTarget.removeEventListener('cs:future-options', onFutureOptions); shell.remove(); if (downloadUrl) URL.revokeObjectURL(downloadUrl); } };
}

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { campusMarkerFromEvent, formatSiteMarkerLabel, normalizeCampusMarker, siteMarkerPresentation } from '../apps/web/js/site-marker.js';

const sites = JSON.parse(readFileSync(new URL('../data/cloudshadow/sites.json', import.meta.url))).sites;
const ashburn = sites.find((site) => site.id === 'ashburn');
const roof = Object.freeze({
  lon: -77.482734123, lat: 39.023781234,
  groundHeight: 94.32, roofHeight: 111.82,
  name: 'NTT VA9', sourceId: 'way/123456',
});

test('campus event preserves exact producer coordinates and absolute roof clearance', () => {
  const received = campusMarkerFromEvent({ siteId: 'ashburn', marker: roof }, sites);
  assert.deepEqual(received, { siteId: 'ashburn', marker: roof });
  assert.notEqual(received.marker, roof, 'cache value is a copy of the event');
  assert.equal(campusMarkerFromEvent({ siteId: 'unknown', marker: roof }, sites), null);
  assert.equal(campusMarkerFromEvent({ siteId: 'ashburn' }, sites), null);
  assert.equal(campusMarkerFromEvent(null, sites), null);
});

test('invalid locations/heights cannot turn a regional study anchor into a roof marker', () => {
  for (const invalid of [null, {}, { ...roof, lon: NaN }, { ...roof, lat: Infinity },
    { ...roof, lon: -180.1 }, { ...roof, lat: 90.1 }, { ...roof, lon: '-77.4' },
    { ...roof, groundHeight: undefined }, { ...roof, roofHeight: NaN },
    { ...roof, roofHeight: roof.groundHeight - 0.01 }]) {
    assert.equal(normalizeCampusMarker(invalid), null);
    const local = siteMarkerPresentation(ashburn, invalid, { active: true });
    assert.equal(local.show, false);
    assert.equal(local.anchored, false);
  }
  const belowSeaLevel = normalizeCampusMarker({ ...roof, groundHeight: -40, roofHeight: -25 });
  assert.equal(belowSeaLevel.roofHeight, -25, 'valid absolute heights may be negative');
});

test('local marker names the actual mapped facility, not regional capacity', () => {
  const marker = siteMarkerPresentation(ashburn, roof, { active: true, selectedSiteId: 'ashburn' });
  assert.equal(marker.show, true);
  assert.equal(marker.height, roof.roofHeight, 'producer already added two metres of clearance');
  assert.equal(marker.clampToGround, false);
  assert.equal(marker.lon, roof.lon);
  assert.equal(marker.lat, roof.lat);
  assert.equal(marker.label, 'NTT VA9 · Data Center Alley');
  assert.doesNotMatch(marker.label, /MW|5,000|5000/);
  assert.equal(marker.sourceId, roof.sourceId);
});

test('zooming out retains the mapped campus location and labels Ashburn capacity as regional', () => {
  const before = structuredClone(ashburn);
  const marker = siteMarkerPresentation(ashburn, roof);
  assert.equal(marker.show, true);
  assert.equal(marker.clampToGround, true);
  assert.equal(marker.height, 0);
  assert.equal(marker.lon, roof.lon);
  assert.equal(marker.lat, roof.lat);
  assert.equal(marker.label, 'Data Center Alley · 5,000 MW region-wide');
  assert.deepEqual(ashburn, before, 'scientific comparison coordinates must remain unchanged');
  assert.notEqual(marker.lat, ashburn.lat);
});

test('local mode hides unrelated sites and unprepared regional pins', () => {
  const other = sites.find((site) => site.id !== ashburn.id);
  assert.equal(siteMarkerPresentation(other, roof, { active: true, selectedSiteId: ashburn.id }).show, false);
  assert.equal(siteMarkerPresentation(ashburn, null, { active: true }).show, false);
  const regional = siteMarkerPresentation(ashburn, null);
  assert.equal(regional.show, true);
  assert.equal(regional.anchored, false);
  assert.equal(regional.lat, ashburn.lat);
  assert.equal(regional.lon, ashburn.lon);
});

test('all real site labels distinguish local facility identity from reported/planned site quantities', () => {
  for (const site of sites) {
    const local = formatSiteMarkerLabel(site, { ...roof, name: site.name }, true);
    assert.equal(local, site.name, 'matching source name is not repeated');
    assert.doesNotMatch(local, /MW/);
    const regional = formatSiteMarkerLabel(site, roof);
    if (site.ledger?.power?.mw) assert.match(regional, /(?:region-wide|site-wide|campus-wide)/);
    else assert.equal(regional, site.name);
  }
  assert.match(formatSiteMarkerLabel(sites.find((site) => site.id === 'abilene')), /planned campus-wide/);
  assert.equal(normalizeCampusMarker({ ...roof, name: '  ', sourceId: 123 }).name, 'Mapped data-center hall');
  assert.equal(normalizeCampusMarker({ ...roof, sourceId: 123 }).sourceId, '123');
});

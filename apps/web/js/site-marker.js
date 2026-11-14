// Exact campus coordinates come from the rendered footprint's ENU transform.
// Never estimate a roof location from the study area's latitude/longitude.
export function normalizeCampusMarker(marker) {
  if (!marker || !Number.isFinite(marker.lon) || !Number.isFinite(marker.lat)
    || Math.abs(marker.lon) > 180 || Math.abs(marker.lat) > 90
    || !Number.isFinite(marker.groundHeight) || !Number.isFinite(marker.roofHeight)
    || marker.roofHeight < marker.groundHeight) return null;
  return {
    lon: marker.lon, lat: marker.lat,
    groundHeight: marker.groundHeight,
    // The producer already includes its roof clearance. Do not add it twice.
    roofHeight: marker.roofHeight,
    name: typeof marker.name === 'string' && marker.name.trim() ? marker.name.trim() : 'Mapped data-center hall',
    sourceId: marker.sourceId == null ? '' : String(marker.sourceId),
  };
}

export function campusMarkerFromEvent(detail, sites) {
  if (!detail || !sites.some((site) => site.id === detail.siteId)) return null;
  const marker = normalizeCampusMarker(detail.marker);
  return marker ? { siteId: detail.siteId, marker } : null;
}

export function formatSiteMarkerLabel(site, marker, local = false) {
  if (local) {
    const name = marker?.name || 'Mapped data-center hall';
    return name.toLocaleLowerCase() === site.name.toLocaleLowerCase() ? name : `${name} · ${site.name}`;
  }
  const power = site.ledger?.power;
  if (!(Number.isFinite(power?.mw) && power.mw > 0)) return site.name;
  const mw = power.mw.toLocaleString('en-US');
  if (site.id === 'ashburn') return `${site.name} · ${mw} MW region-wide`;
  const scope = /planned/i.test(power.value || '') ? 'planned campus-wide' : 'reported site-wide';
  return `${site.name} · ${mw} MW ${scope}`;
}

export function siteMarkerPresentation(site, candidate, { active = false, selectedSiteId = site.id } = {}) {
  const marker = normalizeCampusMarker(candidate);
  const local = !!active;
  return {
    // An unknown study center is useful regional context, but is not a roof pin.
    show: !local || (selectedSiteId === site.id && !!marker),
    lon: marker?.lon ?? site.lon,
    lat: marker?.lat ?? site.lat,
    height: local && marker ? marker.roofHeight : 0,
    clampToGround: !local,
    label: formatSiteMarkerLabel(site, marker, local),
    anchored: !!marker,
    facilityName: marker?.name || '',
    sourceId: marker?.sourceId || '',
    groundHeight: marker?.groundHeight ?? null,
    roofHeight: marker?.roofHeight ?? null,
  };
}

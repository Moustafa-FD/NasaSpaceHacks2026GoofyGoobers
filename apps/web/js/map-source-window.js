// A selected year must never silently borrow a neighbouring year's observation.
export function sourceDateForYear(dates, year, desired = `${year}-07-15`) {
  const candidates = dates.filter((date) => Number(date.slice(0, 4)) === Number(year));
  if (!candidates.length) return null;
  const target = Date.parse(desired);
  return candidates.reduce((best, date) => Math.abs(Date.parse(date) - target) < Math.abs(Date.parse(best) - target) ? date : best);
}

export function mapRequestKey({ kind, center, a, b, baseline, change, compare }) {
  return JSON.stringify([kind, center.id || '', center.lat, center.lon, a?.layer, a?.date, b?.date, baseline?.date, !!change, !!compare]);
}

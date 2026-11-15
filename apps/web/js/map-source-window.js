// A selected year must never silently borrow a neighbouring year's observation.
export function sourceDateForYear(dates, year, desired = `${year}-07-15`) {
  const candidates = dates.filter((date) => Number(date.slice(0, 4)) === Number(year));
  if (!candidates.length) return null;
  const target = Date.parse(desired);
  return candidates.reduce((best, date) => Math.abs(Date.parse(date) - target) < Math.abs(Date.parse(best) - target) ? date : best);
}

/** For a year outside the record, the nearest year that has a map in the SAME season
 * (within maxDays of the desired month/day). Picking simply the latest date would show
 * e.g. an October vegetation map for a July view, which looks like sudden browning. */
export function seasonalFallbackDate(dates, desired, maxDays = 24) {
  const year = Number(desired.slice(0, 4)), monthDay = desired.slice(4);
  const years = [...new Set(dates.map((date) => Number(date.slice(0, 4))))].sort((a, b) => Math.abs(a - year) - Math.abs(b - year) || b - a);
  for (const candidate of years) {
    const target = `${candidate}${monthDay}`, date = sourceDateForYear(dates, candidate, target);
    if (date && Math.abs(Date.parse(date) - Date.parse(target)) <= maxDays * 864e5) return date;
  }
  return null;
}

export function mapRequestKey({ kind, center, a, b, baseline, change, compare }) {
  return JSON.stringify([kind, center.id || '', center.lat, center.lon, a?.layer, a?.date, b?.date, baseline?.date, !!change, !!compare]);
}

// Published water-only tariffs, not household bill observations or a future price model.
export const WATER_PRICE_DATA_URL = 'data/water-prices/index.json';
const cache = new WeakMap();
const finite = value => typeof value === 'number' && Number.isFinite(value);

export function loadWaterPriceData({ fetchImpl = fetch } = {}) {
  if (!cache.has(fetchImpl)) {
    const task = (async () => {
      const response = await fetchImpl(WATER_PRICE_DATA_URL);
      if (!response.ok) throw new Error('Published water prices are unavailable.');
      const data = await response.json();
      if (data?.schemaVersion !== 1 || !data.cities) throw new Error('Unrecognized water-price evidence.');
      return data;
    })();
    cache.set(fetchImpl, task);
    task.catch(() => { if (cache.get(fetchImpl) === task) cache.delete(fetchImpl); });
  }
  return cache.get(fetchImpl);
}

function tariffBill(record, monthlyGallons) {
  const months = record.billingMonths || 1, gallons = monthlyGallons * months;
  let variable = 0;
  if (record.incrementGallons) {
    variable = Math.ceil(Math.max(0, gallons - (record.includedGallons || 0)) / record.incrementGallons) * record.incrementChargeUsd;
  } else {
    let lower = 0;
    for (const tier of record.tiers || []) {
      const upper = tier.throughGallons ?? Infinity;
      variable += Math.max(0, Math.min(gallons, upper) - lower) / 1000 * tier.usdPerThousandGallons;
      lower = upper;
      if (gallons <= upper) break;
    }
  }
  return { bill: (record.fixedChargeUsd + variable) / months, fixed: record.fixedChargeUsd / months,
    unit: record.incrementGallons ? record.incrementChargeUsd * 1000 / record.incrementGallons
      : (record.tiers?.[0]?.usdPerThousandGallons ?? null), billingMonths: months };
}

export function waterPriceSnapshot(data, city, year, monthlyGallons = 3000) {
  const cityId = typeof city === 'string' ? city : city?.id, entry = data?.cities?.[cityId];
  const base = { cityId: cityId ?? null, year, provider: entry?.provider ?? null, scope: 'water only', monthlyGallons,
    forecastAvailable: false, baselineYear: null, baselineBillUsd: null, changePct: null,
    sourceUrl: entry?.sourceUrl ?? null, sourceTitle: entry?.sourceTitle ?? null };
  const missing = reason => ({ ...base, kind: 'unavailable', reason, monthlyBillUsd: null, fixedChargeUsd: null,
    unitPriceUsdPerThousandGallons: null, rateYear: null, effectiveDate: null, referenceNote: reason });
  if (!finite(monthlyGallons) || monthlyGallons < 0) return missing('Enter a non-negative monthly volume in US gallons.');
  if (!entry?.records?.length) return missing(entry?.reason || 'No verified residential water tariff for this mapped city.');
  if (!finite(year)) return missing('Select a year.');
  const records = entry.records.filter(r => finite(r.fixedChargeUsd)).sort((a, b) => a.rateYear - b.rateYear);
  const exact = records.find(r => r.rateYear === Math.floor(year) && r.effectiveDate && !r.referenceOnly);
  // An unmatched year gets a dated reference, never a held-forward historical/future bill.
  const record = exact || records.at(-1);
  if (!record) return missing('No complete verified water tariff.');
  const result = tariffBill(record, monthlyGallons), kind = exact ? 'reported' : 'reference';
  return { ...base, kind, rateYear: record.rateYear, effectiveDate: record.effectiveDate ?? null,
    monthlyBillUsd: result.bill, fixedChargeUsd: result.fixed, unitPriceUsdPerThousandGallons: result.unit,
    billingMonths: result.billingMonths, meterSize: record.meterSize ?? null,
    includedGallons: record.includedGallons ?? 0, incrementGallons: record.incrementGallons ?? null,
    incrementChargeUsd: record.incrementChargeUsd ?? null,
    sourceUrl: record.sourceUrl || entry.sourceUrl, sourceTitle: record.sourceTitle || entry.sourceTitle,
    adoptionDate: record.adoptionDate ?? null, scheduled: record.scheduled === true,
    exampleLabel: `${monthlyGallons.toLocaleString('en-US')} US gallons/month example; not an average household bill`,
    exclusions: 'Water only; excludes sewer, stormwater, taxes, deposits and non-recurring fees.',
    rateNote: record.note || '',
    reason: kind === 'reference' ? `No recorded tariff for ${Math.floor(year)}; showing ${record.rateYear == null ? 'an undated published' : `a published ${record.rateYear}`} reference.` : null,
    referenceNote: kind === 'reference'
      ? `${record.rateYear == null ? 'Published rate with date unspecified' : `Published ${record.rateYear} reference only`}${record.effectiveDate ? ` (effective ${record.effectiveDate})` : '; effective date not stated'}. This is not the price for ${Math.floor(year)} and is not a forecast.`
      : `${record.scheduled ? 'Approved scheduled' : 'Published'} ${record.rateYear} water tariff. Example at fixed use; no data-center cost attribution.`,
  };
}

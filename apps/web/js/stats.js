// Cloud Shadow - trend statistics (no dependencies)
// Mann-Kendall trend test, Sen's slope, deseasonalising, Welch t-test with
// autocorrelation-adjusted sample sizes. Everything the challenge asks for.

const Stats = (() => {
  const isNum = (v) => typeof v === "number" && isFinite(v);
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const variance = (a) => { const m = mean(a); return a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1); };

  // "YYYY-MM" -> decimal year at mid-month
  const decYear = (t) => { const [y, m] = t.split("-").map(Number); return y + (m - 0.5) / 12; };

  // Standard normal CDF (Abramowitz-Stegun 7.1.26 via erf)
  function normCdf(z) {
    const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
    return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
  }

  // Regularised incomplete beta (Numerical Recipes) for Student-t p-values
  function betacf(a, b, x) {
    let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap;
    if (Math.abs(d) < 1e-30) d = 1e-30; d = 1 / d; let h = d;
    for (let m = 1; m <= 200; m++) {
      const m2 = 2 * m;
      let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d; h *= d * c;
      aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
      d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30;
      d = 1 / d; const del = d * c; h *= del;
      if (Math.abs(del - 1) < 3e-7) break;
    }
    return h;
  }
  function lgamma(x) {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = x, tmp = x + 5.5; tmp -= (x + 0.5) * Math.log(tmp);
    let ser = 1.000000000190015; for (const k of c) ser += k / ++y;
    return -tmp + Math.log(2.5066282746310005 * ser / x);
  }
  function ibeta(a, b, x) {
    if (x <= 0) return 0; if (x >= 1) return 1;
    const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
    return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b;
  }
  // two-sided p for Student t
  const tPValue = (t, df) => ibeta(df / 2, 0.5, df / (df + t * t));
  // t critical for 95% CI (bisection)
  function tCrit(df, alpha = 0.05) {
    let lo = 0, hi = 50;
    for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; tPValue(mid, df) > alpha ? (lo = mid) : (hi = mid); }
    return (lo + hi) / 2;
  }

  // Remove the seasonal cycle: subtract each calendar month's long-run mean
  function deseasonalize(times, values) {
    const byMonth = Array.from({ length: 12 }, () => []);
    times.forEach((t, i) => { if (isNum(values[i])) byMonth[+t.slice(5, 7) - 1].push(values[i]); });
    const clim = byMonth.map((a) => (a.length ? mean(a) : null));
    return values.map((v, i) => (isNum(v) && clim[+times[i].slice(5, 7) - 1] != null ? v - clim[+times[i].slice(5, 7) - 1] : null));
  }

  // Annual means (only years with >= minMonths valid months)
  function annual(times, values, minMonths = 8) {
    const g = {};
    times.forEach((t, i) => { if (isNum(values[i])) (g[t.slice(0, 4)] ||= []).push(values[i]); });
    const years = Object.keys(g).filter((y) => g[y].length >= minMonths).sort();
    return { x: years.map((y) => +y + 0.5), y: years.map((y) => mean(g[y])), years: years.map(Number) };
  }

  // Mann-Kendall with tie correction + Sen's slope (per unit x)
  function mannKendall(x, y) {
    const n = y.length;
    if (n < 4) return { n, S: 0, Z: 0, p: 1, slope: NaN, intercept: NaN, tau: 0 };
    let S = 0; const slopes = [];
    for (let i = 0; i < n - 1; i++) for (let j = i + 1; j < n; j++) {
      S += Math.sign(y[j] - y[i]);
      if (x[j] !== x[i]) slopes.push((y[j] - y[i]) / (x[j] - x[i]));
    }
    const ties = {}; y.forEach((v) => (ties[v] = (ties[v] || 0) + 1));
    let tieSum = 0; Object.values(ties).forEach((t) => { if (t > 1) tieSum += t * (t - 1) * (2 * t + 5); });
    const varS = (n * (n - 1) * (2 * n + 5) - tieSum) / 18;
    const Z = S > 0 ? (S - 1) / Math.sqrt(varS) : S < 0 ? (S + 1) / Math.sqrt(varS) : 0;
    const p = 2 * (1 - normCdf(Math.abs(Z)));
    slopes.sort((a, b) => a - b);
    const slope = slopes.length % 2 ? slopes[(slopes.length - 1) / 2] : (slopes[slopes.length / 2 - 1] + slopes[slopes.length / 2]) / 2;
    const xs = [...x].sort((a, b) => a - b), ys = [...y].sort((a, b) => a - b);
    const med = (a) => (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2);
    const intercept = med(ys) - slope * med(xs);
    // 95% CI for Sen's slope (Gilbert 1987): ranks of the ordered pairwise slopes
    const N = slopes.length, Ca = 1.959964 * Math.sqrt(varS);
    const M1 = Math.round((N - Ca) / 2), M2 = Math.round((N + Ca) / 2);
    const slopeLo = slopes[Math.max(0, Math.min(N - 1, M1 - 1))], slopeHi = slopes[Math.max(0, Math.min(N - 1, M2))];
    return { n, S, Z, p, slope, intercept, slopeLo, slopeHi, pivotX: med(xs), pivotY: med(ys), tau: S / (n * (n - 1) / 2) };
  }

  const lag1 = (a) => {
    if (a.length < 3) return 0; const m = mean(a); let num = 0, den = 0;
    for (let i = 0; i < a.length; i++) { den += (a[i] - m) ** 2; if (i) num += (a[i] - m) * (a[i - 1] - m); }
    return den ? Math.max(0, num / den) : 0;
  };

  // Welch t-test on two samples; n_eff corrects for month-to-month autocorrelation
  function beforeAfter(a, b) {
    if (a.length < 3 || b.length < 3) return null;
    const effN = (s) => { const r = lag1(s); return Math.max(2, s.length * (1 - r) / (1 + r)); };
    const na = effN(a), nb = effN(b), va = variance(a), vb = variance(b);
    const se = Math.sqrt(va / na + vb / nb);
    const diff = mean(b) - mean(a);
    const t = diff / se;
    const df = (va / na + vb / nb) ** 2 / ((va / na) ** 2 / (na - 1) + (vb / nb) ** 2 / (nb - 1));
    const p = tPValue(Math.abs(t), df);
    const tc = tCrit(df);
    return { diff, lo: diff - tc * se, hi: diff + tc * se, t, df, p, nA: a.length, nB: b.length, nEffA: na, nEffB: nb };
  }

  // Full analysis for one variable at one site
  function analyze(series, onset) {
    const { t, site, ref } = series;
    const diff = site.map((v, i) => (isNum(v) && isNum(ref[i]) ? v - ref[i] : null));
    const siteA = deseasonalize(t, site), refA = deseasonalize(t, ref), diffA = deseasonalize(t, diff);

    const trendOf = (vals) => { const a = annual(t, vals); return { ...mannKendall(a.x, a.y), annual: a }; };
    const out = {
      t, site, ref, diff, siteA, refA, diffA,
      trendSite: trendOf(siteA), trendRef: trendOf(refA), trendDiff: trendOf(diffA),
      first: t.find((_, i) => isNum(site[i])), last: [...t].reverse().find((_, i) => isNum(site[t.length - 1 - i])),
    };
    if (onset) {
      // before: up to 3 years before onset; after: onset -> now (skip nothing - construction counts)
      const o = decYear(onset);
      const before = [], after = [];
      t.forEach((ti, i) => {
        if (!isNum(diffA[i])) return; const x = decYear(ti);
        if (x < o && x >= o - 3) before.push(diffA[i]); else if (x >= o) after.push(diffA[i]);
      });
      out.onset = onset;
      out.ba = beforeAfter(before, after);
    }
    return out;
  }

  // 12-month centred rolling mean, for readable charts
  // Only full windows: a partial window at the record's ends would be season-biased (e.g. summer-only).
  function rolling(values, w = 12, minValid = 9) {
    return values.map((_, i) => {
      if (i - w / 2 < 0 || i + w / 2 > values.length) return null;
      const s = values.slice(i - w / 2, i + w / 2).filter(isNum);
      return s.length >= minValid ? mean(s) : null;
    });
  }

  return { analyze, mannKendall, beforeAfter, deseasonalize, annual, rolling, decYear, isNum, mean };
})();

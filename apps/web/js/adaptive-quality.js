// Frame-time feedback only: no GPU readbacks, device guessing, or remote telemetry.
export const QUALITY_TIERS = ["low", "balanced", "high"];

export class AdaptiveQuality {
  constructor({ quality = "high", onChange = () => {}, onSample = () => {}, warmupMs = 3000, windowMs = 2000, cooldownMs = 10000, now = 0 } = {}) {
    this.quality = QUALITY_TIERS.includes(quality) ? quality : "high";
    this.onChange = onChange; this.onSample = onSample;
    this.warmupMs = warmupMs; this.windowMs = windowMs; this.cooldownMs = cooldownMs;
    this.lastChange = -Infinity; this.suspended = false; this.fps = null;
    this.reset(now);
  }
  reset(now = 0) {
    this.warmUntil = now + this.warmupMs;
    this.windowStart = null; this.frames = 0; this.slowWindows = 0; this.fastWindows = 0;
  }
  setQuality(quality, now) {
    if (!QUALITY_TIERS.includes(quality)) return;
    this.quality = quality;
    this.reset(now);
  }
  sample(now, eligible = true) {
    if (!Number.isFinite(now)) return;
    if (!eligible) { this.suspended = true; this.reset(now); return; }
    if (this.suspended) { this.suspended = false; this.reset(now); }
    if (now < this.warmUntil) return;
    if (this.windowStart == null) { this.windowStart = now; return; }
    const elapsed = now - this.windowStart;
    if (elapsed < 0) { this.reset(now); return; }
    this.frames++;
    if (elapsed < this.windowMs) return;
    this.fps = this.frames * 1000 / elapsed;
    this.windowStart = now; this.frames = 0;
    this.slowWindows = this.fps < 24 ? this.slowWindows + 1 : 0;
    this.fastWindows = this.fps > 48 ? this.fastWindows + 1 : 0;
    this.onSample({ quality: this.quality, fps: this.fps });
    if (now - this.lastChange < this.cooldownMs) return;
    const index = QUALITY_TIERS.indexOf(this.quality);
    const next = this.slowWindows >= 2 && index > 0 ? index - 1 : this.fastWindows >= 3 && index < 2 ? index + 1 : index;
    if (next === index) return;
    this.quality = QUALITY_TIERS[next]; this.lastChange = now;
    this.slowWindows = this.fastWindows = 0;
    this.onChange({ quality: this.quality, fps: this.fps });
  }
}

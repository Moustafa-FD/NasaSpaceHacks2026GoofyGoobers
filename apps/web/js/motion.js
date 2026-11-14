export const DEFAULT_MOTION_SPEED = 0.35;
let speed = DEFAULT_MOTION_SPEED;
try {
  const saved = localStorage.getItem('csMotionSpeed');
  if (saved !== null && Number.isFinite(+saved)) speed = Math.max(0, Math.min(2, +saved));
} catch { /* Storage is optional. */ }
export const getMotionSpeed = () => speed;
export function setMotionSpeed(value) {
  if (!Number.isFinite(+value)) return speed;
  speed = Math.max(0, Math.min(2, +value));
  try { localStorage.setItem('csMotionSpeed', String(speed)); } catch { /* Private browsing. */ }
  window.dispatchEvent(new CustomEvent('cs:motion-speed', { detail: { speed } }));
  return speed;
}

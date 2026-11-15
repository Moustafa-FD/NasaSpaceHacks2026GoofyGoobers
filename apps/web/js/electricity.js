// Household electricity is a separate EIA price view; NASA environmental maps keep their own units.
import { attachElectricityUI } from './electricity-ui.js';
import { attachElectricityMap } from './electricity-map.js';

const ui = attachElectricityUI();
let cs = null, map = null, active = false, savedLayer = null;

function syncScene(seedMap = false) {
  if (!cs) return;
  if (active) {
    if (savedLayer === null) savedLayer = cs.getMapLayer?.() || 'none';
    if (cs.getMapLayer?.() !== 'none') cs.setMapLayer('none');
  } else if (savedLayer !== null) {
    // A theme switch may already have chosen a different map: don't overwrite it.
    if (cs.getMapLayer?.() === 'none') cs.setMapLayer(savedLayer);
    savedLayer = null;
  }
  // Seed requests that arrived before the viewer was ready. Electricity never
  // changes the camera: the data center stays at the user's current close-up.
  if (seedMap) {
    map?.setActive(active);
  }
}

window.addEventListener('cs:electricity', ({ detail = {} }) => {
  if (typeof detail.active !== 'boolean') return;
  active = detail.active;
  document.body.classList.toggle('electricity-active', active);
  syncScene();
});

function ready(app) {
  cs = app;
  map = attachElectricityMap(cs.viewer);
  cs.electricity = { ui, map };
  syncScene(true);
}
if (window.CloudShadow) ready(window.CloudShadow);
else window.addEventListener('cs:ready', (event) => ready(event.detail), { once: true });

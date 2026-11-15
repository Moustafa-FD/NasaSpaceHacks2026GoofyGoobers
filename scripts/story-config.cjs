// Opening study site for storytelling. Set FOOTPRINT_STORY_SITE (environment or .env) to one
// of the ids in data/cloudshadow/sites.json, e.g. ashburn. The web app opens on it and lists
// it first; ?site= in the URL still overrides. Only this key is read from .env, so .env's
// PORT (used by the API) never changes the web server port.
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");

function readEnvKey(key) {
  if (process.env[key]) return process.env[key].trim();
  try {
    for (const line of fs.readFileSync(path.join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && m[1] === key) return m[2].replace(/^["']|["']$/g, "").trim();
    }
  } catch { /* no .env */ }
  return "";
}

/** { storySite: id | null, warning?: string } */
function storyConfig() {
  const wanted = readEnvKey("FOOTPRINT_STORY_SITE");
  if (!wanted) return { storySite: null };
  const ids = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "cloudshadow", "sites.json"), "utf8")).sites.map((s) => s.id);
  if (!ids.includes(wanted)) return { storySite: null, warning: `FOOTPRINT_STORY_SITE="${wanted}" is not one of: ${ids.join(", ")}. Using the default order.` };
  return { storySite: wanted };
}

module.exports = { storyConfig, readEnvKey };

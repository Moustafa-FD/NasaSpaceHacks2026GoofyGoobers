#!/usr/bin/env node
// Build the static web app for hosting (GitHub Pages, Netlify, any static host).
//   npm run web:build   ->  dist/web/   (apps/web/* + data/cloudshadow/* as dist/web/data/*)
// The browser app only reads static files, so no server is needed in production.
// (apps/web/server.cjs is only for local dev and the JSON API used by Unreal.)
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "dist", "web");

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const skip = (p) => p.endsWith(".cjs") || path.basename(p).startsWith(".");
fs.cpSync(path.join(ROOT, "apps", "web"), OUT, { recursive: true, filter: (src) => !skip(src) });
fs.cpSync(path.join(ROOT, "data", "cloudshadow"), path.join(OUT, "data"), { recursive: true, filter: (src) => !path.basename(src).startsWith(".") });
fs.writeFileSync(path.join(OUT, ".nojekyll"), ""); // let GitHub Pages serve every file as-is
// Opening study site (FOOTPRINT_STORY_SITE) is baked in at build time for static hosting.
const story = require("./story-config.cjs").storyConfig();
if (story.warning) console.warn(story.warning);
fs.writeFileSync(path.join(OUT, "config.json"), JSON.stringify({ storySite: story.storySite }) + "\n");
console.log(`opening site: ${story.storySite || "default"}`);

let files = 0, bytes = 0;
(function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); const s = fs.statSync(p); if (s.isDirectory()) walk(p); else { files++; bytes += s.size; } } })(OUT);
console.log(`built dist/web: ${files} files, ${(bytes / 1e6).toFixed(1)} MB`);

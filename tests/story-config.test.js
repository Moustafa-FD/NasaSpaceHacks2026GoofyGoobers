// FOOTPRINT_STORY_SITE picks the opening study site (server /config.json and static build).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { storyConfig } = require('../scripts/story-config.cjs');

test('valid site ids are accepted; unknown ids warn and fall back to the default order', (t) => {
  const before = process.env.FOOTPRINT_STORY_SITE;
  t.after(() => { if (before === undefined) delete process.env.FOOTPRINT_STORY_SITE; else process.env.FOOTPRINT_STORY_SITE = before; });
  for (const id of ['colossus1', 'colossus2', 'ashburn', 'abilene', 'thedalles']) {
    process.env.FOOTPRINT_STORY_SITE = id;
    assert.deepEqual(storyConfig(), { storySite: id });
  }
  process.env.FOOTPRINT_STORY_SITE = 'atlantis';
  const bad = storyConfig();
  assert.equal(bad.storySite, null);
  assert.match(bad.warning, /not one of/);
});

test('app reorders sites from config.json and the server and build expose it', () => {
  const app = readFileSync(new URL('../apps/web/js/app.js', import.meta.url), 'utf8');
  assert.match(app, /fetch\("config\.json"\)/);
  assert.match(app, /storySite \? \[storySite, \.\.\.sitesDoc\.sites/);
  assert.match(readFileSync(new URL('../apps/web/server.cjs', import.meta.url), 'utf8'), /"\/config\.json"/);
  assert.match(readFileSync(new URL('../scripts/build_web.cjs', import.meta.url), 'utf8'), /config\.json/);
});

import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {fetchPowerProjection} from '../apps/web/js/power-projection.js';
const root=new URL('../',import.meta.url),sites=JSON.parse(await readFile(new URL('data/cloudshadow/sites.json',root),'utf8')).sites;
const directory=new URL('data/cloudshadow/power-projections/',root);await mkdir(directory,{recursive:true});
const selected=process.argv.slice(2);
for(const site of sites.filter(site=>!selected.length||selected.includes(site.id))){
  const result=await fetchPowerProjection(site);
  await writeFile(new URL(site.id+'.json',directory),JSON.stringify(result));
  console.log(`${site.id}: ${Object.keys(result.scenarios).length} NASA pathways, 2015–2100 · ${fileURLToPath(directory)}`);
}

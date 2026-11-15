import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {decodeCities,populationText,nearestCity,cityDistance,selectLabelCandidates,citySource} from '../apps/web/js/city-labels.js';
const catalog=JSON.parse(readFileSync(new URL('../data/cloudshadow/cities.json',import.meta.url)));
const cities=decodeCities(catalog);
test('case-study populations retain exact census geography, year and source',()=>{
  const expected={Ashburn:46349,Memphis:633104,Southaven:54648,Abilene:125182,'The Dalles':16010};
  for(const [name,population] of Object.entries(expected)){
    const city=cities.find(c=>c.name===name&&c.id.startsWith('census-'));
    assert.equal(city.population,population);assert.equal(city.year,2020);
    assert.match(populationText(city),/2020 census/);assert.match(citySource(city),/^https:\/\/www.census.gov\//);
    assert.equal(nearestCity(cities,city).city.id,city.id);
  }
});
test('global metro estimates cannot masquerade as current city census counts or zeros',()=>{
  const city=cities.find(c=>c.source==='natural-earth'&&c.population>1000000);
  assert.match(populationText(city),/Metro est\..*year unavailable/);
  assert.equal(city.year,null);assert.equal(populationText({...city,population:null}),'Population unavailable');
  assert.match(populationText({...city,scope:'city-census',population:0,year:2020}),/^0 people/);
});
test('label selection is bounded, spans the dateline, and nearest places have a real distance limit',()=>{
  assert(cities.length>7000);assert(selectLabelCandidates(cities,{lat:39,lon:-77},1e7,48).length<=48);
  assert(cityDistance({lat:0,lon:179.99},{lat:0,lon:-179.99})<2300);
  assert.equal(nearestCity(cities,{lat:-80,lon:0},100),null);
  assert.deepEqual(decodeCities({schemaVersion:1,cities:[['bad','bad',NaN,0]]}),[]);
});

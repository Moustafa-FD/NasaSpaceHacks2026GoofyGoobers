// A consistent illustrative July sky, independent of the data-year cursor and
// the monotonically advancing animation clock. Direction is incoming ECEF light.
export function referenceSunDirection(site,mode='golden'){
  const radians=Math.PI/180,localHour=mode==='night'?23.5:18.6;
  const declination=23.1*radians,longitude=((Number(site?.lon)||0)-(localHour-12)*15)*radians;
  return [-Math.cos(declination)*Math.cos(longitude),-Math.cos(declination)*Math.sin(longitude),-Math.sin(declination)];
}

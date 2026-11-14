// Query the actual faceted land mesh so roads and their traffic share its surface.
// Source elevation is already baked into these glTF [east,height,-north] vertices.
export function createSurfaceHeightSampler(groups, fallback = () => 0) {
  const size=100,cells=new Map();
  for(const group of groups) {
    if(group.category!==3)continue;
    for(let k=0;k<group.indices.length;k+=3){
      const points=group.indices.slice(k,k+3).map((i)=>[group.positions[i*3],-group.positions[i*3+2],group.positions[i*3+1]]);
      const [a,b,c]=points,den=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1]);
      if(Math.abs(den)<1e-10)continue;
      const triangle={a,b,c,den};
      const west=Math.floor(Math.min(a[0],b[0],c[0])/size),east=Math.floor(Math.max(a[0],b[0],c[0])/size);
      const south=Math.floor(Math.min(a[1],b[1],c[1])/size),north=Math.floor(Math.max(a[1],b[1],c[1])/size);
      for(let x=west;x<=east;x++)for(let y=south;y<=north;y++){
        const key=x+','+y;if(!cells.has(key))cells.set(key,[]);cells.get(key).push(triangle);
      }
    }
  }
  return (x,y)=>{
    for(const {a,b,c,den} of cells.get(Math.floor(x/size)+','+Math.floor(y/size))||[]){
      const u=((b[1]-c[1])*(x-c[0])+(c[0]-b[0])*(y-c[1]))/den;
      const v=((c[1]-a[1])*(x-c[0])+(a[0]-c[0])*(y-c[1]))/den,w=1-u-v;
      if(u>=-1e-7&&v>=-1e-7&&w>=-1e-7)return u*a[2]+v*b[2]+w*c[2];
    }
    return fallback(x,y);
  };
}

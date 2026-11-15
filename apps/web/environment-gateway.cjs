// Same-origin, loopback-only bridge. Never forwards arbitrary hosts or credentials.
const http = require('node:http');
function environmentGateway({ port = Number(process.env.ENVIRONMENT_API_PORT || 3000) } = {}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid ENVIRONMENT_API_PORT');
  return (req, res, url) => {
    if (!url.pathname.startsWith('/api/environment/')) return false;
    const route = url.pathname.slice('/api/environment'.length);
    const allowed = route === '/health' || /^\/v1\/(domains|catalog|inventory|sources|facilities|emissions)$/.test(route) || /^\/v1\/runs(?:\/[a-f0-9-]{36}(?:\/results)?)?$/.test(route);
    if (!allowed || !['GET', 'POST'].includes(req.method) || (req.method === 'POST' && route !== '/v1/runs')) {
      res.writeHead(405, {'content-type':'application/json'}); res.end(JSON.stringify({error:{message:'Unsupported environmental route or method'}})); return true;
    }
    const upstream = http.request({hostname:'127.0.0.1',port,path:route+url.search,method:req.method,headers:{'content-type':'application/json'}}, response => {
      res.writeHead(response.statusCode, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      response.pipe(res);
    });
    upstream.setTimeout(30_000, () => upstream.destroy(new Error('Environmental gateway timed out')));
    upstream.on('error', () => { if(res.writableEnded||res.destroyed)return; if (!res.headersSent) res.writeHead(503, {'content-type':'application/json'}); res.end(JSON.stringify({error:{code:'API_OFFLINE',message:'Environmental service unavailable. Static NASA products remain available.'}})); });
    let size=0,rejected=false;
    req.on('data', chunk => { if(rejected)return;size+=chunk.length; if(size>65_536){ rejected=true;upstream.destroy(); if(!res.headersSent)res.writeHead(413); res.end(JSON.stringify({error:{message:'Request exceeds 64 KiB'}})); } else upstream.write(chunk); });
    req.on('end',()=>{if(size<=65_536)upstream.end();});
    req.on('aborted',()=>upstream.destroy());
    res.on('close',()=>{if(!res.writableEnded)upstream.destroy();});
    return true;
  };
}
module.exports={environmentGateway};

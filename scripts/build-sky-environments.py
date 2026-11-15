"""Prepare compact GPU sky images and ambient light from licensed CC0 EXRs.

Requires OpenEXR, numpy, Pillow (build time only). Original EXRs remain ignored
in tmp/sky-sources; the browser needs neither an EXR decoder nor float textures.
"""
import hashlib
import json
from pathlib import Path
import sys
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
if (ROOT / 'tmp/sky-python').exists():
    sys.path.insert(0, str(ROOT / 'tmp/sky-python'))
import numpy as np
import OpenEXR
from PIL import Image

ASSETS = {'clear': 'kloofendal_43d_clear',
          'cloudy': 'kloofendal_48d_partly_cloudy_puresky',
          'overcast': 'kloofendal_overcast'}
CACHE = ROOT / 'tmp/sky-sources'
OUT = ROOT / 'apps/web/assets/sky'

def request(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={
        'User-Agent': 'FootprintAtlas-local-asset-builder/1.0'}), timeout=60)

def main():
    CACHE.mkdir(parents=True, exist_ok=True)
    OUT.mkdir(parents=True, exist_ok=True)
    environments = []
    for key, name in ASSETS.items():
        metadata_path = CACHE / (name + '.json')
        if not metadata_path.exists():
            with request('https://api.polyhaven.com/files/' + name) as response:
                metadata_path.write_bytes(response.read())
        spec = json.loads(metadata_path.read_text())['hdri']['1k']['exr']
        exr_path = CACHE / (name + '.exr')
        if not exr_path.exists():
            with request(spec['url']) as response:
                exr_path.write_bytes(response.read())
        if hashlib.md5(exr_path.read_bytes()).hexdigest() != spec['md5']:
            raise ValueError('Source checksum mismatch: ' + name)
        with OpenEXR.File(str(exr_path)) as source:
            channels = source.channels()
            rgb = channels['RGB' if 'RGB' in channels else 'RGBA'].pixels[:,:,:3].astype(np.float32)
        rgb = np.nan_to_num(rgb, nan=0, posinf=0, neginf=0)
        rgb = np.maximum(rgb, 0)
        h, w = rgb.shape[:2]
        # Exclude photographic ground and hills at/below the skyline. The local
        # shader renders this only into empty sky pixels, never over the city.
        horizon = int(h * .44)
        band = rgb[max(0,horizon-4):horizon].mean(axis=(0,1))
        # A uniform haze color below the photographic skyline avoids stretching
        # horizon features into vertical columns if the camera looks downward.
        for y in range(max(0,horizon-12),h):
            blend = min(1, (y-(horizon-12))/12)
            rgb[y] = rgb[y]*(1-blend)+band*blend
        sky = rgb[:horizon]
        luminance = sky @ np.array([.2126,.7152,.0722],dtype=np.float32)
        exposure = .65 / max(.001, float(np.percentile(luminance, 65)))
        linear = rgb * exposure
        # ACES-like filmic curve followed by the sRGB transfer function.
        mapped = np.clip((linear*(2.51*linear+.03))/(linear*(2.43*linear+.59)+.14),0,1)
        srgb = np.where(mapped<=.0031308, mapped*12.92, 1.055*mapped**(1/2.4)-.055)
        image = Image.fromarray(np.uint8(np.clip(srgb*255,0,255))).resize((1024,512),Image.Resampling.LANCZOS)
        target = OUT / (key + '.jpg')
        image.save(target, quality=88, optimize=True)
        # Isotropic diffuse term from the linear HDR sky. Conservative ambient
        # chromaticity is enough for stylized matte models; this deliberately
        # does not claim prefiltered specular reflections or directional SH.
        ambient = np.minimum(sky*exposure, 4).mean(axis=(0,1))
        ambient *= .65 / max(.001,float(ambient @ np.array([.2126,.7152,.0722])))
        ambient = np.clip(ambient,.3,1.0)
        environments.append({'id':key,'image':f'assets/sky/{key}.jpg','width':1024,'height':512,
            'diffuseSH':[[round(float(x),6) for x in ambient]]+[[0,0,0] for _ in range(8)],
            'source':{'url':'https://polyhaven.com/a/'+name,'download':spec['url'],
                'author':'Greg Zaal','license':'CC0-1.0','originalFormat':'OpenEXR',
                'md5':spec['md5']},'bytes':target.stat().st_size})
        print(key, rgb.shape, target.stat().st_size, 'bytes')
    (OUT / 'environments.json').write_text(json.dumps({'schemaVersion':1,
        'note':'Artistic EXR-derived backgrounds selected using regional context; not observed cloud imagery. Isotropic HDR sky ambient color; no specular cubemap.',
        'environments':environments},indent=2)+'\n',encoding='utf-8')

if __name__ == '__main__':
    main()

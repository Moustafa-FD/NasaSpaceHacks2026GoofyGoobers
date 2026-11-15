"""Build Footprint Atlas's original, reusable low-poly architectural/vegetation kit.

Python standard library only. Each GLB uses glTF +Y up, +X width, +Z front,
ground at Y=0, and a centered X/Z bounding box. No external art is downloaded.
"""
from __future__ import annotations

import collections
import array
import json
import math
import pathlib
import struct
import sys
import zlib

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "apps" / "web" / "assets" / "low-poly"

COLORS = {
    "cream": "e5d3ac", "sage": "91a58d", "clay": "b87c64", "blue": "819cab",
    "ochre": "c9a56b", "brick": "a96651", "white": "e6e2d6", "wood": "8f6747",
    "slate": "566775", "terracotta": "9e5949", "roofgreen": "526e65", "roofdark": "404c57",
    "trim": "eee3cb", "glass": "345567", "glasslight": "648b99", "door": "634f43",
    "foundation": "a9aa9a", "metal": "7d8b89", "bark": "75543e", "leaf": "6b9064",
    "leaflight": "91ad72", "leafdark": "426c52", "leafgold": "bcad69", "shrub": "78975b",
    "flower": "d2a079", "red": "a95044", "solar": "354c67", "sign": "e2b675",
    "straw": "b99b55", "wheathead": "d3b763", "cropgreen": "7f9a4d",
    "younggreen": "9bb76b", "drycrop": "9e885f",
    "dcwall": "c1c8c8", "dcwallwarm": "bbb6a9", "dcblue": "42637a",
    "dcroof": "737b7b", "dclouvre": "4c5b60", "dcfan": "263a42",
    "dcsteel": "9ca8a7", "dcyellow": "d0ad57", "dcgravel": "a4a397",
    "grassblade": "7f9b56", "grasslight": "9db56b", "flowerpetal": "d3ae78",
}


def rgb(name):
    s = COLORS[name]
    return [int(s[i:i + 2], 16) / 255 for i in (0, 2, 4)]


def minus(a, b):
    return [a[i] - b[i] for i in range(3)]


def cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


class Mesh:
    def __init__(self, ident, kind, style):
        self.ident, self.kind, self.style = ident, kind, style
        self.groups = collections.defaultdict(lambda: {"positions": [], "normals": [], "indices": []})

    def poly(self, points, material, outward=None):
        normal = cross(minus(points[1], points[0]), minus(points[2], points[0]))
        if outward and sum(a * b for a, b in zip(normal, outward)) < 0:
            points = list(reversed(points))
            normal = [-a for a in normal]
        length = math.sqrt(sum(a * a for a in normal))
        if length < 1e-10:
            return
        normal = [a / length for a in normal]
        group = self.groups[material]
        start = len(group["positions"]) // 3
        for p in points:
            group["positions"].extend(round(a, 5) for a in p)
            group["normals"].extend(round(a, 6) for a in normal)
        for i in range(1, len(points) - 1):
            group["indices"].extend([start, start + i, start + i + 1])

    def box(self, x, y, z, w, h, d, material):
        a, b, c, e, f, g = x - w / 2, x + w / 2, y, y + h, z - d / 2, z + d / 2
        for face, normal in [
            ([(a,c,g),(b,c,g),(b,e,g),(a,e,g)], [0,0,1]),
            ([(b,c,f),(a,c,f),(a,e,f),(b,e,f)], [0,0,-1]),
            ([(b,c,g),(b,c,f),(b,e,f),(b,e,g)], [1,0,0]),
            ([(a,c,f),(a,c,g),(a,e,g),(a,e,f)], [-1,0,0]),
            ([(a,e,g),(b,e,g),(b,e,f),(a,e,f)], [0,1,0]),
            ([(a,c,f),(b,c,f),(b,c,g),(a,c,g)], [0,-1,0]),
        ]:
            self.poly(face, material, normal)

    def gable(self, x, z, w, d, y, rise, material, orientation="z"):
        def point(a, b, c):
            return [x + a, b, z + c] if orientation == "z" else [x + c, b, z + a]
        a, b, c, d0, e, f = [point(*p) for p in [
            (-w/2,y,-d/2),(w/2,y,-d/2),(0,y+rise,-d/2),
            (-w/2,y,d/2),(w/2,y,d/2),(0,y+rise,d/2),
        ]]
        center = point(0, y + rise/3, 0)
        for face in ([a,b,c],[d0,f,e],[a,c,f,d0],[b,e,f,c],[a,d0,e,b]):
            midpoint = [sum(p[i] for p in face)/len(face) for i in range(3)]
            self.poly(face, material, minus(midpoint, center))

    def hip(self, x, z, w, d, y, rise, material):
        ridge = max(0.15, (d - w) / 2)
        a,b,c,d0,e,f = [
            [x-w/2,y,z-d/2], [x+w/2,y,z-d/2], [x+w/2,y,z+d/2], [x-w/2,y,z+d/2],
            [x,y+rise,z-ridge], [x,y+rise,z+ridge],
        ]
        for face, outward in [([a,b,e],[0,1,-1]),([b,c,f,e],[1,1,0]),([c,d0,f],[0,1,1]),([d0,a,e,f],[-1,1,0]),([a,d0,c,b],[0,-1,0])]:
            self.poly(face, material, outward)

    def cylinder(self, x,y,z,r,h,material,sides=8,r2=None):
        r2 = r if r2 is None else r2
        bottom = [[x + r*math.cos(i*math.tau/sides),y,z + r*math.sin(i*math.tau/sides)] for i in range(sides)]
        top = [[x + r2*math.cos(i*math.tau/sides),y+h,z + r2*math.sin(i*math.tau/sides)] for i in range(sides)]
        for i in range(sides):
            j=(i+1)%sides
            face=[bottom[i],bottom[j],top[j]] if r2==0 else [bottom[i],bottom[j],top[j],top[i]]
            self.poly(face,material,[math.cos((i+.5)*math.tau/sides),0,math.sin((i+.5)*math.tau/sides)])
        self.poly(bottom,material,[0,-1,0])
        if r2 > 0:
            self.poly(top,material,[0,1,0])

    def foliage(self, x,y,z,rx,ry,rz,material,sides=7):
        # Triangulated two-ring crown; intentionally flat normals, not a smooth ball.
        rings=[]
        for yy, rr, twist in [(-.55,.62,0),(.05,1,.11),(.65,.63,0)]:
            rings.append([[x+rx*rr*math.cos(i*math.tau/sides+twist),y+ry*yy,z+rz*rr*math.sin(i*math.tau/sides+twist)] for i in range(sides)])
        bottom,top=[x,y-ry,z],[x,y+ry,z]
        for i in range(sides):
            j=(i+1)%sides
            for face in ([bottom,rings[0][j],rings[0][i]],[rings[0][i],rings[0][j],rings[1][i]],[rings[0][j],rings[1][j],rings[1][i]],[rings[1][i],rings[1][j],rings[2][i]],[rings[1][j],rings[2][j],rings[2][i]],[rings[2][i],rings[2][j],top]):
                mid=[sum(p[k] for p in face)/len(face) for k in range(3)]
                self.poly(face,material,minus(mid,[x,y,z]))

    def panel(self, u,y,w,h,k,side,material):
        def p(a,b):
            return {"front":[a,b,k],"back":[-a,b,-k],"right":[k,b,-a],"left":[-k,b,a]}[side]
        normal={"front":[0,0,1],"back":[0,0,-1],"right":[1,0,0],"left":[-1,0,0]}[side]
        self.poly([p(u-w/2,y),p(u+w/2,y),p(u+w/2,y+h),p(u-w/2,y+h)],material,normal)

    def window(self,u,y,k,side,w=1.25,h=1.35,light=False):
        self.panel(u,y,w+.17,h+.16,k+.018,side,"trim")
        self.panel(u,y+.08,w,h,k+.027,side,"glasslight" if light else "glass")
        self.panel(u,y+.08,.055,h,k+.035,side,"trim")
        self.panel(u,y+h*.52,w,.055,k+.035,side,"trim")

    def door(self,u,k,side="front",w=1.05,h=2.15):
        self.panel(u,.2,w+.18,h+.12,k+.021,side,"trim")
        self.panel(u,.2,w,h,k+.031,side,"door")
        self.panel(u,.2+h*.54,w*.55,h*.30,k+.041,side,"glass")
        self.panel(u+w*.34,1.1,.075,.075,k+.05,side,"sign")

    def normalize(self):
        p=[g["positions"] for g in self.groups.values()]
        lo=[min(min(a[i::3]) for a in p) for i in range(3)]
        hi=[max(max(a[i::3]) for a in p) for i in range(3)]
        center=[(lo[0]+hi[0])/2,lo[1],(lo[2]+hi[2])/2]
        for g in self.groups.values():
            g["positions"]=[round(v-center[i%3],5) for i,v in enumerate(g["positions"])]
        for canopy in getattr(self,"canopies",[]):
            canopy["x"]=round(canopy["x"]-center[0],5)
            canopy["z"]=round(canopy["z"]-center[2],5)
        self.size=[round(hi[i]-lo[i],5) for i in range(3)]
        self.bounds=[[-self.size[0]/2,0,-self.size[2]/2],[self.size[0]/2,self.size[1],self.size[2]/2]]
        return self


def base(mesh,w,d,h,wall):
    mesh.box(0,0,0,w+.14,.22,d+.14,"foundation")
    mesh.box(0,.2,0,w,h,d,wall)
    mesh.box(0,h+.1,0,w+.1,.18,d+.1,"trim")


def windows(mesh,w,d,h,floors=1,wide=False):
    # Keep each window's mullions as separate, thin geometry without expensive textures.
    for floor in range(floors):
        y=.95+floor*(h/floors)
        for side,length,k in [("front",w,d/2),("back",w,d/2),("left",d,w/2),("right",d,w/2)]:
            count=max(2,min(6,int(length/3.2)))
            for i in range(count):
                u=(i-(count-1)/2)*length/(count+.5)
                if side=="front" and floor==0 and abs(u)<1.5:
                    continue
                mesh.window(u,y,k,side,w=1.55 if wide else 1.15,h=1.35,light=(i+floor)%4==0)
    mesh.door(0,d/2)


def porch(mesh,w,d,h,roof="slate"):
    pw=min(w*.65,7.0)
    mesh.box(0,0,d/2+1,pw,.32,2.2,"foundation")
    mesh.box(0,2.6,d/2+1,pw+.3,.18,2.6,roof)
    for x in [-pw/2+.2,pw/2-.2]:
        mesh.box(x,.32,d/2+1.75,.17,2.3,.17,"trim")
        mesh.box(x,.25,d/2+1.75,.34,.35,.34,"cream")
    mesh.box(0,0,d/2+2.35,pw*.5,.14,.6,"foundation")


def chimney(mesh,w,d,h,rise):
    x=-w*.28
    mesh.box(x,h+rise*.40,-d*.2,.7,rise*.65+.8,.9,"brick")
    mesh.box(x,h+rise*1.05+.8,-d*.2,.85,.18,1.05,"roofdark")


def dormer(mesh,x,z,h,wall="cream",roof="slate"):
    mesh.box(x,h,z,1.6,1.3,1.8,wall)
    mesh.gable(x,z,1.95,2.05,h+1.3,.6,roof)
    # Front-facing dormer window is on the true model front, not the main facade.
    mesh.panel(x,h+.55,.9,.65,z+.912,"front","trim")
    mesh.panel(x,h+.63,.72,.49,z+.92,"front","glass")


def house(ident,style,w,d,floors,wall,roof="slate",rise=2.2):
    m=Mesh(ident,"house",style)
    h=2.9*floors
    base(m,w,d,h,wall)
    if style in ("hip","ranch_hip","modern_hip"):
        m.hip(0,0,w+.65,d+.65,h+.25,rise,roof)
    elif style=="flat":
        m.box(0,h+.25,0,w+.4,.3,d+.4,roof)
        m.box(w*.18,h+.55,-d*.15,w*.3,.6,d*.3,"metal")
    else:
        m.gable(0,0,w+.65,d+.65,h+.25,rise,roof)
    windows(m,w,d,h,floors)
    if style in ("porch","farmhouse","colonial","cross_gable","dormer"):
        porch(m,w,d,h,roof)
    if style in ("cottage","colonial","farmhouse","dormer","gable","cross_gable"):
        chimney(m,w,d,h,rise)
    if style in ("dormer","colonial"):
        for x in [-w*.25,w*.25]:
            roof_height=h+.25+rise*(1-abs(x)/((w+.65)/2))
            dormer(m,x,d*.24,roof_height-.65,wall,roof)
    if style=="cross_gable":
        m.box(w*.28,.2,d*.26,w*.62,h*.75,d*.65,wall)
        m.gable(w*.28,d*.26,d*.65+.5,w*.62+.6,h*.75+.2,1.5,roof,"x")
    if style in ("garage_left","garage_right","l_shape"):
        sign=-1 if style=="garage_left" else 1
        gw=w*.48; gx=sign*(w/2+gw/2-.1)
        m.box(gx,.1,0,gw,2.6,d*.72,wall)
        m.gable(gx,0,gw+.45,d*.72+.45,2.72,1.35,roof)
        m.panel(gx,.3,gw*.73,2.0,d*.36+.025,"front","trim")
        for y in [.65,1.1,1.55,2.0]:
            m.panel(gx,y,gw*.72,.035,d*.36+.04,"front","metal")
    if style=="ranch_hip":
        porch(m,w,d,h,roof)
    if style=="solar":
        for x in [-w*.2,w*.2]:
            for z in [-d*.18,d*.12]:
                # Match the actual pitched roof plane rather than intersecting it.
                def on_roof(xx,zz,offset):
                    return [xx,h+.25+rise*(1-abs(xx)/((w+.65)/2))+offset,zz]
                for margin,material,offset in [(0,"metal",.035),(.08,"solar",.045)]:
                    halfw=w*.125-margin; halfd=d*.11-margin
                    m.poly([on_roof(x-halfw,z-halfd,offset),on_roof(x+halfw,z-halfd,offset),on_roof(x+halfw,z+halfd,offset),on_roof(x-halfw,z+halfd,offset)],material,[0,1,0])
    return m.normalize()


def townhouse(ident,wall,units=3,modern=False):
    unit=5.2; w=unit*units; d=9; h=6.3
    m=Mesh(ident,"house","townhouse")
    base(m,w,d,h,wall)
    for n in range(units):
        x=(n-(units-1)/2)*unit
        if modern:
            m.box(x,h+.22,0,unit-.1,.3,d+.4,"roofdark")
            m.box(x,h+.52,-2,unit*.6,.65,2.1,"metal")
        else:
            m.gable(x,0,unit+.12,d+.5,h+.2,1.7,"slate")
        m.box(x-unit/2+.08,.2,0,.13,h,d+.06,"trim")
        m.door(x,d/2)
        for floor in range(2):
            for dx in [-1.45,1.45]:
                m.window(x+dx,1+floor*3.0,d/2,"front",.95,1.3)
        m.box(x,0,d/2+.35,1.3,.2,.7,"foundation")
    return m.normalize()


def block(ident,kind,w,d,floors,wall,style):
    h=3.15*floors
    m=Mesh(ident,kind,style)
    base(m,w,d,h,wall)
    windows(m,w,d,h,floors,wide=kind in ("office","shop"))
    m.box(0,h+.25,0,w+.45,.32,d+.45,"roofdark")
    # Parapet and rooftop plant give flat-roof silhouettes depth and scale.
    for x in [-w/2,w/2]:
        m.box(x,h+.35,0,.22,.55,d+.2,"trim")
    for z in [-d/2,d/2]:
        m.box(0,h+.35,z,w,.55,.22,"trim")
    for x in [-w*.22,w*.22]:
        m.box(x,h+.57,-d*.18,w*.18,.9,d*.23,"metal")
        m.box(x,h+1.47,-d*.18,w*.20,.1,d*.25,"slate")
    if style=="balconies":
        for floor in range(1,floors):
            for x in [-w*.29,w*.29]:
                y=3.15*floor+.3
                m.box(x,y,d/2+.8,3,.16,1.8,"foundation")
                m.box(x,y+.16,d/2+1.6,3,.8,.07,"trim")
                for dx in [-1.4,1.4]:
                    m.box(x+dx,y+.16,d/2+.8,.07,.8,1.6,"trim")
    if kind=="shop":
        count=max(2,int(w/4))
        for i in range(count):
            x=(i-(count-1)/2)*w/count
            m.panel(x,.45,w/count-.7,2,d/2+.04,"front","glasslight")
            m.box(x,2.75,d/2+.7,w/count-.15,.18,1.5,"sign" if i%2==0 else "roofgreen")
        m.panel(0,3.05,w*.72,.7,d/2+.045,"front","sign")
    if style=="glass":
        for z in [-d/2-.04,d/2+.04]:
            m.box(0,.4,z,w*.65,h-.4,.07,"glasslight")
        for x in [-w*.24,0,w*.24]:
            m.box(x,.4,d/2+.08,.12,h-.4,.1,"trim")
        for y in [3.3*i for i in range(1,floors)]:
            m.box(0,y,d/2+.08,w*.65,.12,.1,"trim")
    return m.normalize()


def commercial(ident,style,w,d,h,wall="white"):
    """Street-readable retail / office / transport silhouettes, in real metres."""
    kind="warehouse" if style in ("logistics","aircraft-hangar") else "office" if style in ("stepped","pavilion") else "shop"
    m=Mesh(ident,kind,style)
    base(m,w,d,h,wall)
    roof="roofdark"
    m.box(0,h+.25,0,w+.3,.3,d+.3,roof)
    for x in [-w/2,w/2]:
        m.box(x,h+.5,0,.22,.55,d+.2,"trim")
    for z in [-d/2,d/2]:
        m.box(0,h+.5,z,w,.55,.22,"trim")
    if style=="aircraft-hangar":
        m.gable(0,0,w+.4,d+.4,h+.3,2.7,"metal")
        m.panel(0,.22,w*.83,h*.78,d/2+.025,"front","dcsteel")
        for x in [-w*.3,-w*.1,w*.1,w*.3]:
            m.panel(x,.22,.11,h*.78,d/2+.04,"front","dclouvre")
            m.panel(x,h*.61,w*.12,h*.12,d/2+.05,"front","glasslight")
        m.door(w*.46,d/2,w=1.1)
    elif style=="logistics":
        for i in range(6):
            x=(i-2.5)*w/7
            m.panel(x,.6,3.2,4.0,d/2+.025,"front","metal")
            m.box(x,0,d/2+.8,3.8,.55,1.7,"foundation")
            m.box(x,4.7,d/2+.4,3.8,.15,1.0,"dcblue")
            for side in [-1,1]:
                m.cylinder(x+side*1.9,0,d/2+1.1,.13,.95,"dcyellow",5)
        for side in ["left","right"]:
            for z in [-d*.3,0,d*.3]:m.window(z,h*.62,w/2,side,2.5,1.0)
    else:
        frontage=min(10,max(3,int(w/5)))
        for i in range(frontage):
            x=(i-(frontage-1)/2)*w/(frontage+.3)
            m.panel(x,.35,w/(frontage+.5)-.3,min(h*.65,3.0),d/2+.03,"front","glasslight")
            m.panel(x,.35,.10,min(h*.65,3.0),d/2+.05,"front","trim")
        if style in ("stepped","pavilion"):
            windows(m,w,d,h,max(1,round(h/3.2)),True)
            m.box(-w*.12,h+.5,-d*.16,w*.60,3.0,d*.55,"glasslight")
            m.box(-w*.12,h+3.5,-d*.16,w*.62,.24,d*.57,roof)
            for x in [-w*.32,-w*.12,w*.08]:m.box(x,h+.5,d*.115,.14,3.0,.1,"trim")
        if style in ("market","retail-warehouse"):
            m.box(0,3.6,d/2+.5,w*.45,.8,1.1,"roofgreen" if style=="market" else "dcblue")
            m.box(0,3.5,d/2+1.7,w*.38,.22,3.0,"trim")
            for x in [-w*.17,w*.17]:m.box(x,0,d/2+2.7,.16,3.5,.16,"metal")
            for x in [-w*.25,-w*.12,0,w*.12,w*.25]:m.cylinder(x,0,d/2+3.1,.13,1.0,"dcyellow",5)
        elif style=="cafe":
            m.box(0,3.2,d/2+1.0,w*.9,.2,2.2,"terracotta")
            for x in [-w*.29,w*.29]:
                m.cylinder(x,0,d/2+2.2,.09,1.0,"metal",5)
                m.cylinder(x,1,d/2+2.2,.65,.1,"wood",6)
                for dx in [-.75,.75]:m.box(x+dx,0,d/2+2.2,.45,.5,.45,"wood")
        else:
            for x in [-w*.28,0,w*.28]:m.box(x,3.0,d/2+.7,w*.24,.18,1.6,"roofgreen")
        m.door(0,d/2,w=1.5,h=2.5)
        for x in [-w*.36,w*.36]:
            m.box(x,0,d/2+.5,1.6,.65,.7,"foundation")
            m.foliage(x,1.0,d/2+.5,.8,.5,.38,"shrub",5)
    if style!="aircraft-hangar":
        for x in [-w*.22,w*.22]:
            m.box(x,h+.55,-d*.20,2.9,.9,3.8,"metal")
            m.cylinder(x,h+1.45,-d*.20,.8,.06,"dcfan",8)
        # A small service yard stays inside the architectural bounding footprint.
        m.box(w*.35,0,-d/2+.6,1.5,1.2,1.0,"roofgreen")
        m.panel(-w*.27,.3,2.5,2.8,d/2+.025,"back","metal")
    return m.normalize()


def facility(ident,style,w,d):
    m=Mesh(ident,"shop" if style=="fuel" else "civic",style)
    h=6 if style=="fire_station" else 8 if style=="clinic" else 6.5
    if style=="fuel":
        m.box(0,0,0,w,.15,d,"foundation")
        m.box(0,.15,-d*.31,w*.82,3.5,d*.30,"cream")
        m.box(0,3.65,-d*.31,w*.85,.25,d*.32,"roofdark")
        for x in [-w*.25,0,w*.25]:m.panel(x,.6,w*.22,2.2,-d*.16+.025,"front","glasslight")
        m.box(0,4.8,d*.17,w*.92,.35,d*.47,"white")
        m.box(0,4.83,d*.40,w*.92,.35,.14,"dcblue")
        for x in [-w*.30,w*.30]:
            m.box(x,.15,d*.14,.25,4.7,.25,"metal")
            m.box(x,.15,d*.14,1.5,1.5,2.5,"dcblue")
            m.box(x,1.65,d*.14,1.5,.14,2.5,"trim")
    else:
        base(m,w,d,h,"brick" if style=="fire_station" else "white")
        m.box(0,h+.25,0,w+.4,.35,d+.4,"roofdark")
        if style=="fire_station":
            for x in [-w*.28,0,w*.28]:
                m.panel(x,.25,w*.23,4.6,d/2+.03,"front","red")
                m.panel(x,2.0,w*.19,1.3,d/2+.045,"front","glasslight")
                m.box(x,4.95,d/2+.35,w*.24,.16,.8,"trim")
        else:
            windows(m,w,d,h,2,True)
            m.box(0,3.0,d/2+1.2,w*.45,.25,2.8,"dcblue")
            for x in [-w*.2,w*.2]:m.box(x,0,d/2+2.3,.15,3,.15,"metal")
            if style=="clinic":
                m.panel(w*.30,5.7,.65,1.8,d/2+.04,"front","red")
                m.panel(w*.30,6.28,1.8,.65,d/2+.05,"front","red")
            if style=="bus_station":
                for x in [-w*.38,w*.38]:
                    m.box(x,2.8,d/2+2.2,w*.23,.15,4.5,"glasslight")
                    for z in [d/2+.3,d/2+4]:m.box(x,0,z,.1,2.8,.1,"metal")
            if style=="library":
                m.box(0,h+.6,0,w*.45,1.5,d*.55,"glasslight")
                m.box(0,h+2.1,0,w*.48,.25,d*.58,"roofdark")
        for x in [-w*.3,w*.3]:
            m.box(x,h+.6,-d*.28,2.2,1.1,2.5,"metal")
            m.cylinder(x,h+1.7,-d*.28,.65,.07,"dcfan",8)
    return m.normalize()


def industrial(ident,w,d,wall,style):
    m=Mesh(ident,"warehouse",style); h=6
    base(m,w,d,h,wall)
    if style=="sawtooth":
        for i in range(4):
            z=(i-1.5)*d/4
            m.gable(0,z,d/4+.1,w+.4,h+.2,1.2,"slate","x")
    else:
        m.gable(0,0,w+.6,d+.6,h+.2,2,"roofdark")
    for x in [-w*.28,0,w*.28]:
        m.panel(x,.35,w*.19,3.8,d/2+.025,"front","metal")
        m.box(x,0,d/2+.6,w*.22,.4,1.2,"foundation")
        for y in [1,2,3]:
            m.panel(x,y,w*.18,.04,d/2+.04,"front","slate")
    m.door(-w*.44,d/2,w=.9)
    for side in ["left","right"]:
        for z in [-d*.3,0,d*.3]:
            m.window(z,4.0,w/2,side,2,1)
    # Upright pilasters / ribs are visible from oblique aerial viewpoints.
    for x in [-w*.48,w*.48]:
        m.box(x,.2,d/2+.05,.17,h,.16,"trim")
    if style=="loading":
        m.box(w*.32,0,-d*.58,4.5,4,4.5,"brick")
        m.cylinder(w*.32,4,-d*.58,1.5,1.1,"metal",8)
    return m.normalize()


def barn(ident,wall,gambrel=False,silo=False):
    m=Mesh(ident,"farm","gambrel" if gambrel else "barn"); w,d,h=11,18,5.2
    base(m,w,d,h,wall)
    if gambrel:
        # Extruded five-segment barn roof with steep lower shoulders.
        profile=[(-w*.55,h),(-w*.35,h+2.8),(0,h+4),(w*.35,h+2.8),(w*.55,h)]
        for i in range(len(profile)-1):
            a,b=profile[i],profile[i+1]
            m.poly([[a[0],a[1],-d*.53],[b[0],b[1],-d*.53],[b[0],b[1],d*.53],[a[0],a[1],d*.53]],"roofdark",[(a[0]+b[0])/2,2,0])
        for z in [-d*.5,d*.5]:
            m.poly([[x,y,z] for x,y in profile],wall,[0,0,z])
    else:
        m.gable(0,0,w+.7,d+.7,h+.2,3.5,"slate")
    m.panel(0,.2,4.8,4.2,d/2+.04,"front","trim")
    m.panel(0,.25,4.45,3.95,d/2+.05,"front","wood")
    m.panel(0,.25,.12,3.95,d/2+.07,"front","trim")
    for y in [.3,4.0]:
        m.panel(0,y,4.45,.12,d/2+.07,"front","trim")
    m.window(0,5.7,d/2,"front",1.4,1.1)
    for side in ["left","right"]:
        for z in [-6,-2,2,6]:
            m.window(z,2,w/2,side,1.2,1.0)
    if silo:
        m.cylinder(9,0,-4,2.7,10,"metal",10)
        m.cylinder(9,10,-4,2.85,1.8,"slate",10,r2=0)
        for y in [2,4,6,8]:
            m.cylinder(9,y,-4,2.74,.10,"trim",10)
    return m.normalize()


def tree(ident,style,leaf="leaf",height=9):
    m=Mesh(ident,"tree",style)
    trunk=height*.45
    m.cylinder(0,0,0,height*.045,trunk,"bark",6,r2=height*.027)
    if style=="conifer":
        for i in range(3):
            y=height*(.18+i*.18); r=height*(.27-i*.045)
            m.cylinder(0,y,0,r,height*.46,leaf,7,r2=0)
    elif style=="poplar":
        m.foliage(0,height*.61,0,height*.15,height*.39,height*.17,leaf,6)
    elif style=="orchard":
        m.foliage(0,height*.64,0,height*.38,height*.36,height*.38,leaf,6)
        for x,z in [(-.9,.8),(.9,.6),(.1,-1)]:
            m.foliage(x,height*.54,z,.32,.32,.32,"flower",4)
    elif style=="dead":
        for sign in [-1,1]:
            # Tapered branch geometry, deliberately leafless for timeline substitutions.
            m.poly([[0,trunk*.5,-.12],[sign*height*.22,trunk*.95,0],[0,trunk*.7,.12]],"bark",[0,0,1])
            m.poly([[0,trunk*.5,.12],[sign*height*.22,trunk*.95,0],[0,trunk*.7,-.12]],"bark",[0,0,-1])
        m.cylinder(0,trunk,0,height*.026,height*.35,"bark",5,r2=0)
    elif style=="broad":
        m.foliage(-height*.11,height*.58,0,height*.28,height*.28,height*.32,leaf,6)
        m.foliage(height*.12,height*.72,height*.04,height*.29,height*.28,height*.30,"leaflight" if leaf=="leaf" else leaf,6)
    else:
        m.foliage(0,height*.65,0,height*.32,height*.35,height*.33,leaf,7)
    return m.normalize()


def shrub(ident,style,leaf="shrub"):
    m=Mesh(ident,"shrub",style)
    if style=="hedge":
        m.box(0,0,0,3.0,1.1,.85,leaf)
        m.foliage(-1,1,0,.7,.35,.55,leaf,5)
        m.foliage(1,1,0,.7,.35,.55,leaf,5)
    else:
        m.foliage(0,.65,0,.95,.65,.85,leaf,6)
        if style=="flowering":
            m.foliage(.2,1.2,.15,.42,.30,.42,"flower",5)
    return m.normalize()


def crop(ident,style):
    m=Mesh(ident,"crop",style)
    if style=="dry":
        for i in range(12):
            angle=i*2.39996
            x=math.cos(angle)*(.12+.033*i); z=math.sin(angle)*(.12+.033*i)
            m.cylinder(x,0,z,.018,.12+(i%3)*.035,"drycrop",3)
        return m.normalize()
    count=7 if "row" in ident else 5 if "seedling" in ident else 4
    for i in range(count):
        if "row" in ident:
            x=(i-(count-1)/2)*.55; z=((i%3)-1)*.16
        else:
            x=math.cos(i*2.39996)*(.16+.055*i); z=math.sin(i*2.39996)*(.16+.055*i)
        young=style=="young"; seedling="seedling" in ident
        h=(.16 if seedling else .65 if young else .88)+(i%3)*.045
        stem="younggreen" if seedling else "cropgreen" if young else "straw"
        m.cylinder(x,0,z,.019 if seedling else .024,h,stem,3)
        if not seedling:
            m.cylinder(x,h,z,.063,.19 if young else .25,stem if young else "wheathead",4,r2=.027)
        for side in [-1,1]:
            y=h*(.30 if side==-1 else .56)
            leaf=.12 if seedling else .23
            m.poly([[x,y,z],[x+side*leaf,y+leaf*.48,z+.05],[x+side*leaf*.45,y+.035,z+.075]],stem,[0,1,0])
            m.poly([[x,y,z],[x+side*leaf*.45,y+.035,z-.075],[x+side*leaf,y+leaf*.48,z-.05]],stem,[0,1,0])
    return m.normalize()


def cooling_unit(m,x,y,z,w=7,d=9):
    """Packaged roof chiller: radiator cabinet, dark fan discs, rims and blades."""
    m.box(x,y,z,w,1.45,d,"dcsteel")
    for side in [-1,1]:
        m.box(x+side*w*.48,y+.12,z,.12,1.1,d*.91,"dclouvre")
    for xx in [x-w*.23,x+w*.23]:
        m.cylinder(xx,y+1.45,z,min(w*.21,1.3),.18,"metal",8)
        r=min(w*.18,1.12)
        m.poly([[xx+r*math.cos(k*math.tau/8),y+1.64,z+r*math.sin(k*math.tau/8)] for k in range(8)],"dcfan",[0,1,0])
        m.box(xx,y+1.65,z,r*1.7,.025,.08,"dcsteel")
        m.box(xx,y+1.65,z,.08,.025,r*1.7,"dcsteel")


def generator_unit(m,x,z,w=3.2,d=6.5):
    m.box(x,0,z,w+.6,.25,d+.6,"foundation")
    m.box(x,.25,z,w,2.4,d,"dcwallwarm")
    m.box(x,2.65,z,w+.08,.16,d+.08,"metal")
    m.box(x,.65,z+d*.505,w*.78,1.5,.06,"dclouvre")
    for side in [-1,1]:
        m.box(x+side*w*.505,1.35,z,.06,.85,d*.63,"dclouvre")
    m.cylinder(x+w*.25,2.81,z-d*.30,.18,1.5,"roofdark",6)


def transformer_unit(m,x,z,w=3.2,d=4.5):
    m.box(x,0,z,w+.8,.30,d+.8,"foundation")
    m.box(x,.30,z,w,2.25,d,"dcwall")
    for side in [-1,1]:
        # Broad heat-dissipation fins are distinct from a plain electrical box.
        for zz in [z-d*.29,z,z+d*.29]:
            m.box(x+side*(w/2+.14),.62,zz,.32,1.4,d*.19,"metal")
    for xx in [x-w*.30,x,x+w*.30]:
        m.cylinder(xx,2.55,z,.17,.55,"door",5)
    m.box(x,3.10,z,w*.73,.10,.12,"dcsteel")


def fence(m,x,z,w,d,height=2.25):
    # Thin posts and two visible rails. No alpha textures or expensive chainlink.
    for zz in [z-d/2,z+d/2]:
        for y in [.6,height]:
            m.box(x,y,zz,w,.055,.055,"metal")
        for xx in [x-w/2,x,x+w/2]:
            m.box(xx,0,zz,.085,height+.12,.085,"metal")
    for xx in [x-w/2,x+w/2]:
        for y in [.6,height]:
            m.box(xx,y,z,.055,.055,d,"metal")
        m.box(xx,0,z,.085,height+.12,.085,"metal")


def server_hall(m,x,z,w,d,h,wall="dcwall",coolers=6,brick=False,ribs=6):
    m.box(x,0,z,w+.4,.28,d+.4,"foundation")
    m.box(x,.28,z,w,h,d,wall)
    m.box(x,h+.28,z,w+.2,.24,d+.2,"dcroof")
    for xx in [x-w/2,x+w/2]:
        m.box(xx,h+.52,z,.28,.65,d+.25,wall)
        m.box(xx,.5,z,.14,h-.2,d*.92,"dcblue" if not brick else "brick")
    for zz in [z-d/2,z+d/2]:
        m.box(x,h+.52,zz,w,.65,.28,wall)
    # Corrugated panel ribs and louver banks down the long industrial walls.
    for side in [-1,1]:
        xx=x+side*(w/2+.09)
        for i in range(1,ribs+1):
            zz=z+(i/(ribs+1)-.5)*d
            m.box(xx,.38,zz,.13,h-.2,.16,"dcsteel")
        m.box(xx,h*.48,z,.16,h*.33,d*.55,"dclouvre")
    doors=max(1,min(3,round(w/18)))
    for i in range(doors):
        xx=x+(i-(doors-1)/2)*w/(doors+.5)
        zz=z+d/2+.045
        m.panel(xx,.35,5.7,4.7,zz,"front","metal")
        m.panel(xx,.5,5.2,4.3,zz+.02,"front","dclouvre")
        for yy in [1.3,2.3,3.3,4.3]:
            m.panel(xx,yy,5.1,.045,zz+.04,"front","dcsteel")
        m.box(xx,0,z+d/2+.6,6,.45,1.2,"foundation")
    m.box(x-w*.33,5.4,z+d/2+1.0,9,.18,2.3,"dcblue")
    # Service door and one small staffed vestibule, not a residential facade.
    m.panel(x+w*.43,.3,1.35,2.7,z+d/2+.05,"front","door")
    m.box(x-w*.38,.28,z+d*.30,4.5,3.8,d*.16,"dcblue")
    m.box(x-w*.38,3.05,z+d*.38+.02,3.3,.65,.09,"glass")
    if coolers:
        rows=math.ceil(coolers/2)
        for i in range(coolers):
            xx=x+(-1 if i%2==0 else 1)*w*.22
            zz=z+((i//2+.5)/rows-.5)*d*.77
            cooling_unit(m,xx,h+.52,zz,min(7,w*.19),min(9,d/max(3,rows+1)))


def data_center(ident,style):
    m=Mesh(ident,"data-center",style)
    if style=="cloud-hall":
        server_hall(m,0,0,48,104,11.4,"dcwall",6)
        for z in [-24,-8,8]:
            generator_unit(m,28,z)
        transformer_unit(m,-29,-28)
    elif style=="hyperscale-campus":
        for x in [-22,22]:
            server_hall(m,x,0,34,104,12.6,"dcwall",3)
        m.box(0,.28,0,10,8.1,66,"dcblue")
        m.box(0,8.38,0,10.4,.22,66.4,"dcroof")
        generator_unit(m,-22,-61)
        generator_unit(m,22,-61)
    elif style=="brick-retrofit":
        server_hall(m,0,0,72,112,9.8,"brick",6,True)
        m.box(-20,.28,49,30,3.6,15,"brick")
        m.box(-20,3.88,49,30.4,.22,15.4,"dcroof")
        for z in [-28,-12,4]:
            generator_unit(m,42,z)
        # Exhaust stacks visually distinguish a repurposed industrial complex.
        for z in [-30,-14]:
            m.cylinder(45,0,z,.65,8.6,"metal",8)
            m.cylinder(45,8.6,z,.85,.22,"roofdark",8)
    elif style=="modular-pods":
        for x in [-16,0,16]:
            server_hall(m,x,0,12,36,5.1,"dcwallwarm",1,ribs=4)
        m.box(0,.3,-21,43,3.6,5,"dcblue")
        generator_unit(m,-12,25)
        generator_unit(m,12,25)
    elif style=="cooling-hall":
        server_hall(m,0,0,60,96,13.4,"dcwall",8)
        for z in [-31,0,31]:
            # Large vertical intake housings, with louvered sides and raised caps.
            m.box(-33,.28,z,6,9,13,"dcsteel")
            m.box(-36.05,1.2,z,.1,6.8,11,"dclouvre")
            m.box(-33,9.28,z,6.4,.3,13.4,"dcblue")
    elif style=="secure-service-hall":
        server_hall(m,0,-9,48,72,10.8,"dcwallwarm",4)
        m.box(0,0,42,49,.13,24,"dcgravel")
        for x in [-16,0,16]:
            generator_unit(m,x,39)
        transformer_unit(m,-17,48)
        transformer_unit(m,17,48)
        fence(m,0,42,51,26)
    elif style=="substation":
        m.role="infrastructure"
        m.box(0,0,0,31,.2,39,"dcgravel")
        for x in [-8,8]:
            for z in [-8,8]:
                transformer_unit(m,x,z)
        for x in [-12,0,12]:
            for z in [-13,13]:
                m.box(x,0,z,.24,6.4,.24,"dcsteel")
        for z in [-13,13]:
            m.box(0,6.3,z,24,.24,.24,"dcsteel")
        m.box(0,.2,-18,6,3.7,5,"dcwallwarm")
        m.box(0,3.9,-18,6.4,.2,5.4,"dcroof")
        fence(m,0,0,32,41)
    elif style=="generator-yard":
        m.role="infrastructure"
        m.box(0,0,0,27,.18,37,"dcgravel")
        for x in [-8,0,8]:
            for z in [-10,0,10]:
                generator_unit(m,x,z)
        m.box(0,.2,-20,8,4,5,"dcblue")
        m.box(0,4.2,-20,8.4,.2,5.4,"dcroof")
        fence(m,0,0,29,46)
    return m.normalize()


def forest_grove(ident="forest-grove", variant=0):
    # Authored irregular stands, rather than a jittered planting grid. Each has
    # nine real stems, an uneven edge and small interior gaps; different mixes
    # keep repeated instances from reading as identical rectangular tiles.
    layouts=[
        [(-7,-3.8),(-2.2,-7.4),(4.5,-6),(7.2,.1),(4.4,6.5),(-2.5,7.1),(-6.4,2.1),(-.5,-.5),(1.3,3.6)],
        [(-6.8,-5.8),(-.9,-6.9),(5.9,-3.9),(7.4,2.4),(2.8,7.2),(-3.6,6.1),(-7.2,.8),(-1.8,.2),(2.2,2.5)],
        [(-7.4,-1.8),(-4.1,-7.1),(2.4,-6.5),(7.2,-2.1),(5.6,4.3),(-.3,7.5),(-6.4,4.4),(-1.3,-1.4),(.8,3.2)],
        [(-7.1,-5),(-1.2,-7.2),(5.7,-5.2),(7.3,1.6),(2.6,6.7),(-4.2,7.3),(-7.4,1.3),(-2,-1.6),(1.7,1.8)],
    ]
    conifers=[{1,4,6},{0,3,5,8},{2,4,7},{1,3,6,8}][variant]
    m=Mesh(ident,"tree","grove")
    m.canopies=[]
    for i,(x,z) in enumerate(layouts[variant]):
        x*=1.10; z*=1.10
        h=8.5+((i*7+variant*3)%11)*.29
        m.cylinder(x,0,z,.17+(i%3)*.025,h*.43,"bark",3,r2=.11)
        if i in conifers:
            # Two intersecting tapered tiers retain a readable pine/spruce
            # silhouette at 28 triangles including the trunk.
            radius=2.35+((i+variant)%3)*.15
            m.cylinder(x,h*.19,z,radius,h*.55,"leafdark",6,r2=0)
            m.cylinder(x,h*.46,z,radius*.76,h*.54,"leaf" if i%2 else "leafdark",6,r2=0)
            m.canopies.append({"x":x,"z":z,"height":h,"rx":radius,"rz":radius,
                               "shape":"conifer","color":rgb("leafdark")})
        else:
            leaf=["leaf","leaflight","leafdark"][(i+variant*2)%3]
            radius=3.35+((i*3+variant)%5)*.11
            # Birch-like slender crowns and broad oak crowns intermix with
            # the conifers, with deliberately unequal horizontal radii.
            slender=(i+variant)%4==0
            m.foliage(x,h*.65,z,radius*(.74 if slender else 1),h*.35,
                      radius*(.83 if slender else .94),leaf,5)
            m.canopies.append({"x":x,"z":z,"height":h,"rx":radius*(.74 if slender else 1),
                               "rz":radius*(.83 if slender else .94),"shape":"broadleaf","color":rgb(leaf)})
    m.stemCount=9; m.canopyCount=9
    return m.normalize()


def meadow(ident,flowers=False):
    m=Mesh(ident,"grass","flowers" if flowers else "grass")
    count=24 if flowers else 32
    for i in range(count):
        x=((i%6)-2.5)*.65+math.sin(i*3.9)*.12
        z=((i//6)-2.5)*.65+math.cos(i*2.7)*.12
        h=.23+(i%4)*.065; w=.11
        material="grassblade" if i%3 else "grasslight"
        m.poly([[x-w,0,z],[x+w,0,z],[x+.055,h,z+.04]],material)
        m.poly([[x,0,z-w],[x,0,z+w],[x-.045,h*.91,z-.02]],material)
        if flowers and i%5==0:
            r=.075; yy=h*.9
            p=[[x-r,yy,z],[x+r,yy,z],[x,yy+.12,z],[x,yy+.05,z+.11]]
            for ids in [[0,1,2],[0,3,1],[1,3,2],[2,3,0]]:
                face=[p[k] for k in ids]; center=[x,yy+.04,z+.025]
                mid=[sum(v[j] for v in face)/3 for j in range(3)]
                m.poly(face,"flowerpetal",minus(mid,center))
    m.stemCount=count
    return m.normalize()


def wheat_patch():
    m=Mesh("wheat-field-patch","crop","wheatpatch")
    for i in range(25):
        x=(i%5-2)*1.6+math.sin(i*2.6)*.10
        z=(i//5-2)*1.6+math.cos(i*3.1)*.10
        h=.85+(i%4)*.07; w=.025
        m.poly([[x-w,0,z],[x+w,0,z],[x+w,h,z],[x-w,h,z]],"straw")
        m.poly([[x,0,z-w],[x,0,z+w],[x,h,z+w],[x,h,z-w]],"straw")
        r=.10; p=[[x-r,h,z],[x+r,h,z],[x,h+.28,z],[x,h+.12,z+.13]]
        for ids in [[0,1,2],[0,3,1],[1,3,2],[2,3,0]]:
            face=[p[k] for k in ids]; center=[x,h+.08,z+.03]
            mid=[sum(v[j] for v in face)/3 for j in range(3)]
            m.poly(face,"wheathead",minus(mid,center))
    m.stemCount=25
    return m.normalize()


def make_models():
    models=[]
    specs=[
        ("house-cottage-cream","cottage",7,9,1,"cream","terracotta",2.1),
        ("house-gable-sage","gable",8,10,1,"sage","slate",2.5),
        ("house-gable-blue","gable",9,11,1,"blue","roofdark",2.4),
        ("house-hip-clay","hip",10,12,1,"clay","slate",2.0),
        ("house-ranch-ochre","ranch_hip",15,9,1,"ochre","roofgreen",1.8),
        ("house-crossgable-white","cross_gable",10,12,2,"white","slate",2.8),
        ("house-two-storey-brick","gable",9,10,2,"brick","roofdark",2.6),
        ("house-colonial-cream","colonial",11,10,2,"cream","slate",2.7),
        ("house-dormer-blue","dormer",10,12,1,"blue","roofdark",3.0),
        ("house-garage-left","garage_left",9,11,2,"sage","slate",2.2),
        ("house-garage-right","garage_right",10,10,1,"cream","terracotta",2.5),
        ("house-porch-clay","porch",9,12,1,"clay","roofgreen",2.2),
        ("house-farmhouse-white","farmhouse",11,13,2,"white","roofdark",2.7),
        ("house-l-shaped","l_shape",9,12,1,"ochre","slate",2.2),
        ("house-modern-flat","flat",11,10,2,"white","roofdark",0),
        ("house-solar-sage","solar",10,11,1,"sage","slate",2.3),
    ]
    models.extend(house(*spec) for spec in specs)
    models.extend([townhouse("townhouse-brick", "brick"),townhouse("townhouse-cream","cream",4),townhouse("townhouse-modern","white",3,True)])
    models.extend([
        block("apartment-brick","apartment",20,15,3,"brick","parapet"),
        block("apartment-balconies","apartment",21,14,4,"cream","balconies"),
        block("apartment-courtyard-wing","apartment",27,13,3,"sage","parapet"),
        block("office-low","office",22,18,2,"cream","parapet"),
        block("office-midrise","office",20,18,5,"clay","parapet"),
        block("office-glass","office",24,19,4,"white","glass"),
        block("shop-corner","shop",13,11,2,"brick","awning"),
        block("shop-awning","shop",16,12,1,"cream","awning"),
        block("shop-strip","shop",30,13,1,"sage","awning"),
        industrial("warehouse-gabled",32,48,"cream","gable"),
        industrial("warehouse-sawtooth",36,45,"brick","sawtooth"),
        industrial("warehouse-loading",40,50,"metal","loading"),
        barn("barn-red","red"),barn("barn-gambrel","red",True),barn("barn-with-silo","cream",True,True),
        block("civic-school","civic",35,20,2,"brick","parapet"),
        block("civic-pavilion","civic",16,12,1,"wood","parapet"),
    ])
    models.extend([
        tree("tree-oak","broad","leaf",10),tree("tree-maple","round","leaflight",9),
        tree("tree-birch","round","leaflight",8),tree("tree-poplar","poplar","leaf",13),
        tree("tree-pine","conifer","leafdark",12),tree("tree-spruce","conifer","leaf",9),
        tree("tree-orchard","orchard","leaf",4.5),tree("tree-autumn","round","leafgold",8.5),
        tree("tree-dead","dead","leaf",9),shrub("shrub-round","round"),
        shrub("shrub-flowering","flowering"),shrub("shrub-hedge","hedge","leafdark"),
    ])
    # Append new families so existing model/mesh indices remain stable.
    models.extend([
        crop("wheat-clump-gold","wheat"),crop("wheat-clump-green","young"),
        crop("crop-row-green","young"),crop("crop-seedling","young"),crop("crop-stubble","dry"),
    ])
    models.extend(data_center(ident,style) for ident,style in [
        ("dc-cloud-hall","cloud-hall"),("dc-hyperscale-campus","hyperscale-campus"),
        ("dc-brick-retrofit","brick-retrofit"),("dc-modular-pods","modular-pods"),
        ("dc-cooling-hall","cooling-hall"),("dc-secure-service-hall","secure-service-hall"),
        ("dc-substation","substation"),("dc-generator-yard","generator-yard"),
    ])
    models.extend([forest_grove(),meadow("meadow-grass-patch"),wheat_patch(),meadow("meadow-flower-patch",True)])
    models.extend([
        commercial("shop-supermarket","market",48,36,6,"cream"),
        commercial("shop-retail-warehouse","retail-warehouse",64,48,7.5,"white"),
        commercial("shop-cafe-terrace","cafe",14,12,4,"brick"),
        commercial("shop-neighborhood-row","street-retail",32,17,5,"sage"),
        commercial("office-stepped-court","stepped",28,24,9.5,"white"),
        commercial("office-glass-pavilion","pavilion",34,21,6.5,"cream"),
        commercial("warehouse-logistics-docks","logistics",56,62,8,"metal"),
        commercial("airport-aircraft-hangar","aircraft-hangar",48,46,12,"cream"),
        facility("shop-fuel-canopy","fuel",26,25),
        facility("civic-fire-station","fire_station",30,22),
        facility("civic-medical-clinic","clinic",28,26),
        facility("civic-library-atrium","library",32,24),
        facility("civic-transit-hall","bus_station",42,24),
        commercial("shop-fresh-market","market",29,25,5.5,"brick"),
        commercial("office-retail-court","stepped",38,28,12.5,"sage"),
        industrial("warehouse-workshop",24,32,"ochre","loading"),
    ])
    # Append only: all previously published mesh/node indices remain stable.
    models.extend([
        forest_grove("forest-grove-oak-pine",1),
        forest_grove("forest-grove-birch-spruce",2),
        forest_grove("forest-grove-open-mixed",3),
    ])
    return models


def glb(models):
    doc={"asset":{"version":"2.0","generator":"Footprint Atlas original low-poly asset builder"},"scene":0,"scenes":[{"nodes":list(range(len(models)))}],"nodes":[],"meshes":[],"materials":[],"buffers":[{"byteLength":0}],"bufferViews":[],"accessors":[]}
    binary=bytearray(); materials={}
    for name in COLORS:
        materials[name]=len(doc["materials"])
        material_name = "wall_" + name if name in ("cream","sage","clay","blue","ochre","brick","white","wood","red") or name.startswith("dcwall") else name
        doc["materials"].append({"name":material_name,"pbrMetallicRoughness":{"baseColorFactor":rgb(name)+[1],"metallicFactor":.08 if name in ("glass","glasslight","metal","solar") else 0,"roughnessFactor":.45 if name in ("glass","glasslight","solar") else .92},"doubleSided":name in ("grassblade","grasslight","straw")})
    def accessor(values,component,kind,target,bounds=False):
        while len(binary)%4: binary.append(0)
        offset=len(binary)
        code={5126:"f",5123:"H",5125:"I"}[component]
        binary.extend(struct.pack("<"+str(len(values))+code,*values))
        view=len(doc["bufferViews"])
        doc["bufferViews"].append({"buffer":0,"byteOffset":offset,"byteLength":len(binary)-offset,"target":target})
        width={"SCALAR":1,"VEC3":3}[kind]
        a={"bufferView":view,"byteOffset":0,"componentType":component,"count":len(values)//width,"type":kind}
        if bounds:
            a["min"]=[min(values[i::width]) for i in range(width)]
            a["max"]=[max(values[i::width]) for i in range(width)]
        doc["accessors"].append(a)
        return len(doc["accessors"])-1
    for model in models:
        primitives=[]
        for name,g in model.groups.items():
            index_type=5123 if len(g["positions"])//3<65536 else 5125
            primitives.append({"attributes":{"POSITION":accessor(g["positions"],5126,"VEC3",34962,True),"NORMAL":accessor(g["normals"],5126,"VEC3",34962)},"indices":accessor(g["indices"],index_type,"SCALAR",34963,True),"material":materials[name],"mode":4})
        mesh=len(doc["meshes"])
        doc["meshes"].append({"name":model.ident,"primitives":primitives})
        doc["nodes"].append({"name":model.ident,"mesh":mesh,"extras":{"kind":model.kind,"style":model.style}})
    while len(binary)%4: binary.append(0)
    doc["buffers"][0]["byteLength"]=len(binary)
    header=json.dumps(doc,separators=(",",":"),allow_nan=False).encode()
    header+=b" "*((-len(header))%4)
    total=12+8+len(header)+8+len(binary)
    return struct.pack("<III",0x46546C67,2,total)+struct.pack("<II",len(header),0x4E4F534A)+header+struct.pack("<II",len(binary),0x004E4942)+binary


def validate_glb(blob):
    magic,version,total=struct.unpack_from("<III",blob)
    assert magic==0x46546C67 and version==2 and total==len(blob)
    size,kind=struct.unpack_from("<II",blob,12)
    assert kind==0x4E4F534A
    doc=json.loads(blob[20:20+size]); bin_offset=28+size
    binary=blob[bin_offset:]
    assert len(binary)==doc["buffers"][0]["byteLength"]
    decoded=[]
    for a in doc["accessors"]:
        view=doc["bufferViews"][a["bufferView"]]
        width={"SCALAR":1,"VEC3":3}[a["type"]]; code={5126:"f",5123:"H",5125:"I"}[a["componentType"]]
        start=view.get("byteOffset",0)+a.get("byteOffset",0)
        count=a["count"]*width
        assert start+count*struct.calcsize(code)<=len(binary)
        assert count*struct.calcsize(code)==view["byteLength"]
        values=struct.unpack_from("<"+str(count)+code,binary,start)
        assert all(math.isfinite(v) for v in values)
        if "min" in a:
            for i in range(width):
                assert abs(min(values[i::width])-a["min"][i])<1e-4
                assert abs(max(values[i::width])-a["max"][i])<1e-4
        decoded.append(values)
    for mesh in doc["meshes"]:
        for p in mesh["primitives"]:
            positions=decoded[p["attributes"]["POSITION"]]
            normals=decoded[p["attributes"]["NORMAL"]]
            indices=decoded[p["indices"]]
            assert len(normals)==len(positions) and len(indices)%3==0
            assert max(indices)<len(positions)//3 and min(indices)>=0
            assert min(positions[1::3])>=-1e-5
            for i in range(0,len(indices),3):
                points=[positions[j*3:j*3+3] for j in indices[i:i+3]]
                face_normal=cross(minus(points[1],points[0]),minus(points[2],points[0]))
                assert sum(v*v for v in face_normal)>1e-12, "Degenerate triangle"
                vertex_normal=normals[indices[i]*3:indices[i]*3+3]
                assert sum(a*b for a,b in zip(face_normal,vertex_normal))>0, "Winding disagrees with normal"
            for i in range(0,len(normals),3):
                assert abs(sum(n*n for n in normals[i:i+3])-1)<1e-4
    return doc


def preview_svg(models):
    # A deterministic orthographic contact sheet for silhouette and palette QA.
    width=1800; cellw=300; cellh=225; rows=math.ceil(len(models)/6)
    out=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{rows*cellh}" viewBox="0 0 {width} {rows*cellh}"><rect width="100%" height="100%" fill="#e7eddf"/>']
    for n,m in enumerate(models):
        col,row=n%6,n//6; ox=col*cellw; oy=row*cellh
        out.append(f'<rect x="{ox+5}" y="{oy+5}" width="290" height="215" rx="12" fill="#f4f4e9"/>')
        faces=[]; projected=[]
        def project(p):
            x,y,z=p
            return ((x-z)*.7071, (x+z)*.35355-y, (x+z)*.6124+y*.5)
        for mat,g in m.groups.items():
            pts=[g["positions"][i:i+3] for i in range(0,len(g["positions"]),3)]
            for i in range(0,len(g["indices"]),3):
                ids=g["indices"][i:i+3]; p=[project(pts[j]) for j in ids]
                a,b,c=p
                # Screen Y increases downwards.
                if (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])>0:
                    continue
                normal=g["normals"][ids[0]*3:ids[0]*3+3]
                shade=.70+.30*max(0,normal[1]*.8-normal[0]*.3+normal[2]*.5)
                color="#"+"".join(f"{min(255,int(v*255*shade)):02x}" for v in rgb(mat))
                faces.append((sum(a[2] for a in p)/3,p,color)); projected.extend(p)
        xs=[p[0] for p in projected]; ys=[p[1] for p in projected]
        scale=min(250/max(max(xs)-min(xs),.1),165/max(max(ys)-min(ys),.1))
        cx=(max(xs)+min(xs))/2; cy=(max(ys)+min(ys))/2
        for depth,p,color in sorted(faces,key=lambda a:a[0]):
            points=" ".join(f"{ox+150+(a[0]-cx)*scale:.2f},{oy+96+(a[1]-cy)*scale:.2f}" for a in p)
            out.append(f'<polygon points="{points}" fill="{color}"/>')
        out.append(f'<text x="{ox+150}" y="{oy+203}" fill="#3d4d42" font-size="11" font-family="sans-serif" text-anchor="middle">{m.ident}</text>')
    out.append("</svg>")
    return "".join(out)


def preview_png(models):
    """Optional depth-tested contact sheet, rendered with only the standard library.

    SVG's painter ordering can overlap the small facade details. This raster
    renderer verifies silhouettes using a per-pixel depth buffer like WebGL.
    The matching SVG contains the model-name labels.
    """
    width=1800; cw=300; ch=225; height=math.ceil(len(models)/6)*ch
    background=bytes.fromhex("e7eddf"); card=bytes.fromhex("f4f4e9")
    pixels=bytearray(background*(width*height))
    depth=array.array("f",[-math.inf])*(width*height)
    def project(p):
        x,y,z=p
        return ((x-z)*.7071,(x+z)*.35355-y,(x+z)*.6124+y*.5)
    for n,m in enumerate(models):
        ox=(n%6)*cw; oy=(n//6)*ch
        for y in range(oy+5,oy+ch-5):
            start=(y*width+ox+5)*3
            pixels[start:start+(cw-10)*3]=card*(cw-10)
        projected=[]; faces=[]
        for mat,g in m.groups.items():
            pts=[project(g["positions"][i:i+3]) for i in range(0,len(g["positions"]),3)]
            projected.extend(pts)
            for i in range(0,len(g["indices"]),3):
                ids=g["indices"][i:i+3]; face=[pts[j] for j in ids]
                a,b,c=face
                if (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])>0:
                    continue
                normal=g["normals"][ids[0]*3:ids[0]*3+3]
                shade=.70+.30*max(0,normal[1]*.8-normal[0]*.3+normal[2]*.5)
                color=bytes(min(255,int(v*255*shade)) for v in rgb(mat))
                faces.append((face,color))
        xs=[p[0] for p in projected]; ys=[p[1] for p in projected]
        scale=min(250/max(max(xs)-min(xs),.1),165/max(max(ys)-min(ys),.1))
        cx=(max(xs)+min(xs))/2; cy=(max(ys)+min(ys))/2
        for face,color in faces:
            a,b,c=[(ox+150+(p[0]-cx)*scale,oy+96+(p[1]-cy)*scale,p[2]) for p in face]
            denominator=(b[1]-c[1])*(a[0]-c[0])+(c[0]-b[0])*(a[1]-c[1])
            if abs(denominator)<1e-9:
                continue
            left=max(ox+5,int(math.floor(min(a[0],b[0],c[0])))); right=min(ox+cw-6,int(math.ceil(max(a[0],b[0],c[0]))))
            top=max(oy+5,int(math.floor(min(a[1],b[1],c[1])))); bottom=min(oy+ch-6,int(math.ceil(max(a[1],b[1],c[1]))))
            du=(b[1]-c[1])/denominator; dv=(c[1]-a[1])/denominator
            for y in range(top,bottom+1):
                u=((b[1]-c[1])*(left+.5-c[0])+(c[0]-b[0])*(y+.5-c[1]))/denominator
                v=((c[1]-a[1])*(left+.5-c[0])+(a[0]-c[0])*(y+.5-c[1]))/denominator
                for x in range(left,right+1):
                    w=1-u-v
                    if u>=-1e-6 and v>=-1e-6 and w>=-1e-6:
                        zz=u*a[2]+v*b[2]+w*c[2]; index=y*width+x
                        if zz>depth[index]:
                            depth[index]=zz; pixels[index*3:index*3+3]=color
                    u+=du; v+=dv
    def chunk(kind,body):
        return struct.pack(">I",len(body))+kind+body+struct.pack(">I",zlib.crc32(kind+body)&0xffffffff)
    raw=b"".join(b"\0"+pixels[y*width*3:(y+1)*width*3] for y in range(height))
    png=b"\x89PNG\r\n\x1a\n"+chunk(b"IHDR",struct.pack(">IIBBBBB",width,height,8,2,0,0,0))+chunk(b"IDAT",zlib.compress(raw,9))+chunk(b"IEND",b"")
    (OUT/"preview.png").write_bytes(png)


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    models=make_models(); assert len({m.ident for m in models})==len(models)
    manifest={"version":1,"provenance":"Original procedural meshes authored for Footprint Atlas; illustrative architectural assets, not surveyed buildings.","axes":{"up":"Y","width":"X","depth":"Z","front":"+Z","origin":"center of X/Z bounds at ground Y=0"},"kitUrl":"assets/low-poly/kit.glb","models":[]}
    templates={"version":1,"materials":{k:{"color":rgb(k),"roughness":.45 if k in ("glass","glasslight","solar") else .92} for k in COLORS},"models":{}}
    for i,m in enumerate(models):
        triangles=sum(len(g["indices"])//3 for g in m.groups.values())
        meta={"id":m.ident,"kind":m.kind,"style":m.style,"role":getattr(m,"role","primary"),"width":m.size[0],"depth":m.size[2],"height":m.size[1],"bounds":m.bounds,"meshIndex":i,"nodeIndex":i,"triangles":triangles,"url":f"assets/low-poly/{m.ident}.glb"}
        for key in ("stemCount","canopyCount","canopies"):
            if hasattr(m,key): meta[key]=getattr(m,key)
        manifest["models"].append(meta)
        templates["models"][m.ident]={**meta,"groups":dict(m.groups)}
        blob=glb([m]); validate_glb(blob)
        (OUT/f"{m.ident}.glb").write_bytes(blob)
    kit=glb(models); validate_glb(kit); (OUT/"kit.glb").write_bytes(kit)
    (OUT/"manifest.json").write_text(json.dumps(manifest,separators=(",",":"),allow_nan=False),encoding="utf8")
    (OUT/"templates.json").write_text(json.dumps(templates,separators=(",",":"),allow_nan=False),encoding="utf8")
    (OUT/"preview.svg").write_text(preview_svg(models),encoding="utf8")
    if "--preview-png" in sys.argv:
        preview_png(models)
    counts=dict(collections.Counter(m.kind for m in models))
    print(json.dumps({"models":len(models),"kinds":counts,"triangles":sum(m["triangles"] for m in manifest["models"]),"kitBytes":len(kit),"totalBytes":sum(p.stat().st_size for p in OUT.iterdir() if p.is_file()),"validation":"All generated GLBs: headers, chunk sizes, accessor bounds, finite values, index ranges, unit normals and ground alignment passed."},indent=2))


if __name__=="__main__":
    main()

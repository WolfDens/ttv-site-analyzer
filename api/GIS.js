// api/gis.js — TTV GIS auto-fill proxy (Charlotte / Mecklenburg)
// Server-side fetch avoids the browser CORS block. Deploy on Vercel: drop at repo
// /api/gis.js, push to main, then hit  /api/gis?address=2723%20Dellinger%20Dr
// Add &debug=1 to see the raw ArcGIS responses.
//
// One service covers everything (NC State Plane ft, wkid 2264):
//   0 Parcels · 1 Master Address Points · 10 Zoning
//   13 Watershed Districts · 14 Overlay Watershed · 32 Water Quality Buffer Review Areas · 12 Historic Districts
const BASE = 'https://gis.charlottenc.gov/arcgis/rest/services/Accela/Accela/MapServer';
const SR = 2264;
const LAYER = { parcels:0, address:1, zoning:10, historic:12, watershedDist:13, overlayWatershed:14, wqBuffer:32 };

async function aj(url){ const r = await fetch(url); if(!r.ok) throw new Error('HTTP '+r.status+' '+url); return r.json(); }

// cache field metadata per layer for the life of the request
const _fields = {};
async function fields(id){ if(_fields[id]) return _fields[id]; const m = await aj(`${BASE}/${id}?f=json`); _fields[id] = (m.fields||[]); return _fields[id]; }
async function pickField(id, rx, prefer){
  const fs = (await fields(id)).filter(f=>/string/i.test(f.type)).map(f=>f.name);
  const hit = fs.filter(n=>rx.test(n));
  if(prefer){ const p = hit.find(n=>prefer.test(n)); if(p) return p; }
  return hit[0] || null;
}

function shoelaceSqft(geom){
  if(!geom||!geom.rings||!geom.rings.length) return null;
  let total=0;
  geom.rings.forEach((ring,ri)=>{ let a=0; for(let i=0;i<ring.length-1;i++){ a += ring[i][0]*ring[i+1][1]-ring[i+1][0]*ring[i][1]; } a=Math.abs(a/2); total += (ri===0?a:-a); });
  return total;
}
function centroid(geom){ const r=geom&&geom.rings&&geom.rings[0]; if(!r) return null; let x=0,y=0; r.forEach(p=>{x+=p[0];y+=p[1];}); return {x:x/r.length, y:y/r.length}; }
function bboxWxD(geom){ const r=geom&&geom.rings&&geom.rings[0]; if(!r) return null; const xs=r.map(p=>p[0]),ys=r.map(p=>p[1]); return { w:Math.round(Math.max(...xs)-Math.min(...xs)), d:Math.round(Math.max(...ys)-Math.min(...ys)) }; }
function findAttr(attrs, rx){ if(!attrs) return null; for(const [k,v] of Object.entries(attrs)){ if(rx.test(k) && v!=null && v!=='') return {field:k, value:v}; } return null; }

async function spatialAt(id, pt, outFields='*'){
  const geom = encodeURIComponent(JSON.stringify({ x:pt.x, y:pt.y, spatialReference:{wkid:SR} }));
  const url = `${BASE}/${id}/query?geometry=${geom}&geometryType=esriGeometryPoint&inSR=${SR}&spatialRel=esriSpatialRelIntersects&outFields=${outFields}&returnGeometry=false&f=json`;
  const j = await aj(url);
  return { hit: !!(j.features&&j.features.length), attrs: j.features&&j.features[0]&&j.features[0].attributes || null, url };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','s-maxage=86400, stale-while-revalidate');
  const address = (req.query.address||'').trim();
  const debug = req.query.debug==='1';
  if(!address){ res.status(400).json({error:'pass ?address='}); return; }

  const out = { address, ok:false, parcel:null, zoning:null, watershed:null, buffers:null, historic:null, notes:[], errors:[] };
  const raw = {};
  try{
    // 1) geocode via Master Address Points
    const addrField = await pickField(LAYER.address, /address|addr/i, /full|num|site/i);
    const toks = address.toUpperCase().replace(/[.,]/g,'').split(/\s+/).filter(Boolean);
    const num = toks[0]||'', street = toks[1]||'';
    let pt=null, matched=null;
    if(addrField){
      const where = encodeURIComponent(`UPPER(${addrField}) LIKE '%${num}%' AND UPPER(${addrField}) LIKE '%${street}%'`);
      const url = `${BASE}/${LAYER.address}/query?where=${where}&outFields=*&returnGeometry=true&outSR=${SR}&f=json`;
      const j = await aj(url); raw.address = debug?j:undefined;
      if(j.features&&j.features.length){ const f=j.features[0]; pt=f.geometry; matched=findAttr(f.attributes, /address|addr/i); }
      else out.notes.push(`No address-point match on ${addrField}`);
    } else out.notes.push('No address field detected on Master Address Points');

    // 2) parcel by point (geometry + area); fallback: parcel by address text
    let parcelFeat=null, parcelURL=null;
    if(pt){
      const geom = encodeURIComponent(JSON.stringify({x:pt.x,y:pt.y,spatialReference:{wkid:SR}}));
      parcelURL = `${BASE}/${LAYER.parcels}/query?geometry=${geom}&geometryType=esriGeometryPoint&inSR=${SR}&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=${SR}&f=json`;
      const j = await aj(parcelURL); raw.parcel = debug?j:undefined;
      if(j.features&&j.features.length) parcelFeat=j.features[0];
    }
    if(!parcelFeat){
      const pAddr = await pickField(LAYER.parcels, /address|addr|location|situs/i, /full|site|situs/i);
      if(pAddr){
        const where = encodeURIComponent(`UPPER(${pAddr}) LIKE '%${num}%' AND UPPER(${pAddr}) LIKE '%${street}%'`);
        parcelURL = `${BASE}/${LAYER.parcels}/query?where=${where}&outFields=*&returnGeometry=true&outSR=${SR}&f=json`;
        const j = await aj(parcelURL); raw.parcelByAddr = debug?j:undefined;
        if(j.features&&j.features.length){ parcelFeat=j.features[0]; if(!pt) pt=centroid(parcelFeat.geometry); }
      }
    }
    if(parcelFeat){
      const g=parcelFeat.geometry, sqft=shoelaceSqft(g), bb=bboxWxD(g);
      const areaAttr=findAttr(parcelFeat.attributes,/st_?area|shape__?area|gis_?area|^area$|acre/i);
      const pidAttr=findAttr(parcelFeat.attributes,/pid|parcel|taxpid|gpin/i);
      out.parcel = {
        area_sf: sqft?Math.round(sqft):null,
        area_ac: sqft?+(sqft/43560).toFixed(3):null,
        bbox_w_ft: bb&&bb.w, bbox_d_ft: bb&&bb.d,
        area_attr: areaAttr, pid: pidAttr&&pidAttr.value, matched_address: matched&&matched.value,
        attrs: parcelFeat.attributes
      };
      if(!pt) pt=centroid(g);
    } else out.notes.push('No parcel found for address');

    // 3) overlays at the parcel point
    if(pt){
      try{ const z=await spatialAt(LAYER.zoning,pt); const zv=findAttr(z.attrs,/zone|zoning|class|district|abbr/i); out.zoning={ value: zv&&zv.value||null, field: zv&&zv.field||null, attrs:z.attrs }; raw.zoning=debug?z:undefined; }
      catch(e){ out.errors.push('zoning: '+e.message); }

      try{
        const wd=await spatialAt(LAYER.watershedDist,pt), ow=await spatialAt(LAYER.overlayWatershed,pt);
        out.watershed={ district: findAttr(wd.attrs,/name|wshed|watershed|class/i)?.value||null, overlay: findAttr(ow.attrs,/name|class|type/i)?.value||null, district_attrs:wd.attrs, overlay_attrs:ow.attrs };
        raw.watershed=debug?{wd,ow}:undefined;
      }catch(e){ out.errors.push('watershed: '+e.message); }

      try{ const b=await spatialAt(LAYER.wqBuffer,pt); out.buffers={ intersects:b.hit, name: findAttr(b.attrs,/name|type|class|buffer/i)?.value||null, attrs:b.attrs }; raw.buffer=debug?b:undefined; }
      catch(e){ out.errors.push('wqBuffer: '+e.message); }

      try{ const h=await spatialAt(LAYER.historic,pt); out.historic={ in_district:h.hit, name: findAttr(h.attrs,/name|district/i)?.value||null }; }
      catch(e){ out.errors.push('historic: '+e.message); }
    }

    out.note_easements = 'No easement layer in this service — verify easements on the recorded plat.';
    out.ok = !!(out.parcel || out.zoning);
    if(debug) out.raw = raw;
    res.status(200).json(out);
  }catch(e){
    out.errors.push('fatal: '+e.message);
    res.status(200).json(out);
  }
}

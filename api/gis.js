// api/gis.js — TTV GIS auto-fill proxy (Charlotte / Mecklenburg)  v3
// v3: right-of-way edge detection — classifies each parcel edge as facing a
// neighboring parcel (interior lot line) or no parcel (street/alley ROW), and
// picks the front edge (ROW edge nearest the address point). Edge indices are
// aligned to the de-duplicated outer ring (closing point removed), matching the
// client lot editor's edge order.
// Server-side fetch avoids the browser CORS block. Deploy on Vercel at /api/gis.js,
// push to main, then hit  /api/gis?address=2723%20Dellinger%20Dr&debug=1
//
// Verified against 2723 Dellinger (PID 04118526): area 77,575 sf, zoning N1-B,
// PCSO district Central Catawba. v2 fixes the matched-address field, returns the
// parcel polygon, swaps the bogus "buffer" (layer 32 was a staff review area) for
// the real SWIM/Water-Quality-Buffer layer, and maps the PCO district to its BUA rule.
const BASE = 'https://gis.charlottenc.gov/arcgis/rest/services/Accela/Accela/MapServer';
const SR = 2264;
const LAYER = { parcels:0, address:1, zoning:10, historic:12, pcoDistrict:13, overlayWatershed:14, reviewArea:32 };
// Real SWIM / Water Quality Buffer geometry (City Open Data hosted feature layer),
// resolved at runtime from its ArcGIS Online item so we don't hardcode the org URL.
const WQ_BUFFER_ITEM = 'cf66446f36244e2498aa9b3f8e704b84';

// Post-Construction Stormwater Ordinance district -> built-upon-area rule of thumb.
const BUA_RULE = {
  'Central Catawba': 'Over 5,000 sf BUA triggers the stormwater ordinance; keep under 24% of lot area (verify).',
};

async function aj(url){ const r = await fetch(url); if(!r.ok) throw new Error('HTTP '+r.status+' '+url); return r.json(); }
const _fields = {};
async function fields(id){ if(_fields[id]) return _fields[id]; const m = await aj(`${BASE}/${id}?f=json`); _fields[id] = (m.fields||[]); return _fields[id]; }
async function pickField(id, rx, prefer){
  const fs = (await fields(id)).filter(f=>/string/i.test(f.type)).map(f=>f.name);
  const hit = fs.filter(n=>rx.test(n));
  if(prefer){ const p = hit.find(n=>prefer.test(n)); if(p) return p; }
  return hit[0] || null;
}
function shoelaceSqft(g){ if(!g||!g.rings||!g.rings.length) return null; let t=0; g.rings.forEach((r,ri)=>{ let a=0; for(let i=0;i<r.length-1;i++){ a+=r[i][0]*r[i+1][1]-r[i+1][0]*r[i][1]; } a=Math.abs(a/2); t+=(ri===0?a:-a); }); return t; }
function centroid(g){ const r=g&&g.rings&&g.rings[0]; if(!r) return null; let x=0,y=0; r.forEach(p=>{x+=p[0];y+=p[1];}); return {x:x/r.length,y:y/r.length}; }
function pointInRing(px,py,ring){ // ray cast; ring = [[x,y],...] (closing dup ok)
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const xi=ring[i][0],yi=ring[i][1],xj=ring[j][0],yj=ring[j][1];
    if(((yi>py)!==(yj>py)) && (px < (xj-xi)*(py-yi)/(yj-yi)+xi)) inside=!inside;
  }
  return inside;
}
function stripClose(ring){ if(ring.length>2){const a=ring[0],b=ring[ring.length-1]; if(a[0]===b[0]&&a[1]===b[1]) return ring.slice(0,-1);} return ring.slice(); }
// Classify each edge of `ring0` (closed dup removed) by offsetting its midpoint
// outward ~OFFSET ft and testing containment in any neighbor ring.
function classifyEdges(ring0, neighborRings, addrPt){
  const OFFSET=10, ring=stripClose(ring0), n=ring.length;
  const edges=[];
  for(let i=0;i<n;i++){
    const a=ring[i], b=ring[(i+1)%n];
    const mx=(a[0]+b[0])/2, my=(a[1]+b[1])/2;
    const dx=b[0]-a[0], dy=b[1]-a[1], len=Math.hypot(dx,dy)||1;
    const nx=dy/len, ny=-dx/len; // unit normal
    // outward = the offset point that lands OUTSIDE the subject ring
    let ox=mx+nx*OFFSET, oy=my+ny*OFFSET;
    if(pointInRing(ox,oy,ring)){ ox=mx-nx*OFFSET; oy=my-ny*OFFSET; }
    const inNeighbor = neighborRings.some(r=>pointInRing(ox,oy,r));
    const distAddr = addrPt? Math.hypot(mx-addrPt.x,my-addrPt.y) : null;
    edges.push({ i, len_ft:Math.round(len), row:!inNeighbor, mid:[Math.round(mx),Math.round(my)], dist_addr_ft:distAddr!=null?Math.round(distAddr):null });
  }
  const rowEdges=edges.filter(e=>e.row && e.len_ft>=8);
  let front=null;
  if(rowEdges.length){
    front=(addrPt? rowEdges.slice().sort((a,b)=>a.dist_addr_ft-b.dist_addr_ft)
                 : rowEdges.slice().sort((a,b)=>b.len_ft-a.len_ft))[0].i;
  }
  return { edges, row:edges.map(e=>e.row), front_index:front, row_count:rowEdges.length };
}
function bboxWxD(g){ const r=g&&g.rings&&g.rings[0]; if(!r) return null; const xs=r.map(p=>p[0]),ys=r.map(p=>p[1]); return { w:Math.round(Math.max(...xs)-Math.min(...xs)), d:Math.round(Math.max(...ys)-Math.min(...ys)) }; }
function findAttr(a, rx){ if(!a) return null; for(const [k,v] of Object.entries(a)){ if(rx.test(k)&&v!=null&&v!=='') return {field:k,value:v}; } return null; }
async function spatialAt(layerUrl, pt, outFields='*'){
  const geom = encodeURIComponent(JSON.stringify({ x:pt.x, y:pt.y, spatialReference:{wkid:SR} }));
  const url = `${layerUrl}/query?geometry=${geom}&geometryType=esriGeometryPoint&inSR=${SR}&spatialRel=esriSpatialRelIntersects&outFields=${outFields}&returnGeometry=false&f=json`;
  const j = await aj(url);
  return { hit: !!(j.features&&j.features.length), feats:(j.features||[]), attrs:(j.features&&j.features[0]&&j.features[0].attributes)||null, url };
}

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','s-maxage=86400, stale-while-revalidate');
  const address = (req.query.address||'').trim();
  const debug = req.query.debug==='1';
  if(!address){ res.status(400).json({error:'pass ?address='}); return; }

  const out = { address, ok:false, parcel:null, zoning:null, watershed:null, swim_buffer:null, review_area:null, historic:null, notes:[], errors:[] };
  const raw = {};
  try{
    // 1) geocode via Master Address Points
    const addrField = (await pickField(LAYER.address, /full_address|address/i, /full/i)) || 'full_address';
    const toks = address.toUpperCase().replace(/[.,]/g,'').split(/\s+/).filter(Boolean);
    const num = toks[0]||'', street = toks[1]||'';
    let pt=null, matched=null;
    try{
      const where = encodeURIComponent(`UPPER(${addrField}) LIKE '%${num}%' AND UPPER(${addrField}) LIKE '%${street}%'`);
      const url = `${BASE}/${LAYER.address}/query?where=${where}&outFields=*&returnGeometry=true&outSR=${SR}&f=json`;
      const j = await aj(url); raw.address = debug?j:undefined;
      if(j.features&&j.features.length){ const f=j.features[0]; pt=f.geometry; matched = f.attributes.full_address || f.attributes.address || ((findAttr(f.attributes,/full_address|^address$/i)||{}).value) || null; }
      else out.notes.push(`No address-point match on ${addrField}`);
    }catch(e){ out.errors.push('geocode: '+e.message); }

    // 2) parcel by point (geometry + area)
    let parcelFeat=null;
    if(pt){
      try{
        const geom = encodeURIComponent(JSON.stringify({x:pt.x,y:pt.y,spatialReference:{wkid:SR}}));
        const url = `${BASE}/${LAYER.parcels}/query?geometry=${geom}&geometryType=esriGeometryPoint&inSR=${SR}&spatialRel=esriSpatialRelIntersects&outFields=*&returnGeometry=true&outSR=${SR}&f=json`;
        const j = await aj(url); raw.parcel = debug?j:undefined;
        if(j.features&&j.features.length) parcelFeat=j.features[0];
      }catch(e){ out.errors.push('parcel: '+e.message); }
    }
    if(parcelFeat){
      const g=parcelFeat.geometry, sqft=shoelaceSqft(g), bb=bboxWxD(g);
      out.parcel = {
        area_sf: sqft?Math.round(sqft):null,
        area_ac: sqft?+(sqft/43560).toFixed(3):null,
        area_attr: findAttr(parcelFeat.attributes,/st_?area/i),
        bbox_w_ft: bb&&bb.w, bbox_d_ft: bb&&bb.d,
        bbox_note: 'Bounding box of the polygon - NOT frontage x depth for irregular lots. Use the polygon below.',
        pid: (findAttr(parcelFeat.attributes,/^pid$/i)||{}).value,
        nc_pin: (findAttr(parcelFeat.attributes,/nc_?pin/i)||{}).value,
        matched_address: matched,
        is_likely_parent: (sqft!=null && sqft>20000) ? 'Large parcel - for a subdivision deal this is the PARENT; enter the intended sublot manually.' : null,
        geometry: g,
        attrs: parcelFeat.attributes
      };
      if(!pt) pt=centroid(g);
      // v3: right-of-way edge classification via neighboring parcels
      try{
        const ring0=g.rings&&g.rings[0];
        if(ring0&&ring0.length>=4){
          const xs=ring0.map(p=>p[0]), ys=ring0.map(p=>p[1]), PAD=40;
          const env={xmin:Math.min(...xs)-PAD,ymin:Math.min(...ys)-PAD,xmax:Math.max(...xs)+PAD,ymax:Math.max(...ys)+PAD,spatialReference:{wkid:SR}};
          const url=`${BASE}/${LAYER.parcels}/query?geometry=${encodeURIComponent(JSON.stringify(env))}&geometryType=esriGeometryEnvelope&inSR=${SR}&spatialRel=esriSpatialRelIntersects&outFields=PID&returnGeometry=true&outSR=${SR}&f=json`;
          const nj=await aj(url); raw.neighbors=debug?{count:(nj.features||[]).length}:undefined;
          const selfPid=out.parcel.pid, selfOID=parcelFeat.attributes&&parcelFeat.attributes.OBJECTID;
          const neighborRings=[];
          (nj.features||[]).forEach(f=>{
            const isSelf=(f.attributes&&((selfPid&&f.attributes.PID===selfPid)||(selfOID&&f.attributes.OBJECTID===selfOID)));
            if(!isSelf&&f.geometry&&f.geometry.rings) f.geometry.rings.forEach(r=>neighborRings.push(r));
          });
          const info=classifyEdges(ring0,neighborRings,pt);
          out.parcel.edges={ row:info.row, front_index:info.front_index, row_count:info.row_count,
            detail:info.edges, neighbors_checked:neighborRings.length,
            note: info.row_count===0?'No street-facing edge detected - front left unset, assign in the editor.'
                 :info.row_count>1?'Multiple street/alley-facing edges (corner or alley lot) - front set nearest the address point; confirm in the editor.'
                 :'Front edge set facing right-of-way.' };
        }
      }catch(e){ out.errors.push('edges: '+e.message); }
    } else if(pt){ out.notes.push('No parcel polygon at the geocoded point'); }

    // 3) overlays at the parcel point
    if(pt){
      try{ const z=await spatialAt(`${BASE}/${LAYER.zoning}`,pt); const zv=findAttr(z.attrs,/zonedes|zone|class|district/i); out.zoning={ value:(z.attrs&&z.attrs.ZoneDes)||(zv&&zv.value)||null, class:(z.attrs&&z.attrs.ZoneClass)||null, overlay:(z.attrs&&z.attrs.Overlay)||null, field:'ZoneDes', attrs:z.attrs }; raw.zoning=debug?z:undefined; }
      catch(e){ out.errors.push('zoning: '+e.message); }

      try{
        const wd=await spatialAt(`${BASE}/${LAYER.pcoDistrict}`,pt), ow=await spatialAt(`${BASE}/${LAYER.overlayWatershed}`,pt);
        const dist=(wd.attrs&&wd.attrs.PCO_Name)||((findAttr(wd.attrs,/pco|name|watershed/i)||{}).value)||null;
        out.watershed={ pco_district:dist, basin:(wd.attrs&&wd.attrs.Basin)||null, bua_rule:dist?(BUA_RULE[dist]||('Confirm BUA threshold for '+dist+' district.')):null, overlay:(ow.attrs&&(ow.attrs.Name||(findAttr(ow.attrs,/name|class/i)||{}).value))||null };
        raw.watershed=debug?{wd,ow}:undefined;
      }catch(e){ out.errors.push('watershed: '+e.message); }

      // 3b) REAL SWIM / Water Quality buffer - resolve hosted layer from its AGO item, then spatial query
      try{
        const item = await aj(`https://www.arcgis.com/sharing/rest/content/items/${WQ_BUFFER_ITEM}?f=json`);
        raw.wqItem = debug?{url:item.url,type:item.type}:undefined;
        if(item && item.url){
          const layerUrl = /\/\d+$/.test(item.url) ? item.url : item.url + '/0'; // item.url may already include /0
          const b = await spatialAt(layerUrl, pt);
          out.swim_buffer = { intersects:b.hit, types: b.feats.map(f=>(findAttr(f.attributes,/type|buffer|swim|class|name/i)||{}).value).filter(Boolean), service:item.url, attrs:b.attrs };
          raw.swim=debug?b:undefined;
        } else out.notes.push('Could not resolve Water Quality Buffer service URL from AGO item');
      }catch(e){ out.errors.push('swim_buffer: '+e.message); }

      // staff review area (administrative only - NOT a buffer)
      try{ const ra=await spatialAt(`${BASE}/${LAYER.reviewArea}`,pt); out.review_area={ reviewer:(ra.attrs&&ra.attrs.Reviewer)||null, contact:(ra.attrs&&ra.attrs.Contact)||null, note:'WQ-buffer staff review assignment - administrative, not a buffer on the parcel.' }; }
      catch(e){ /* non-critical */ }

      try{ const h=await spatialAt(`${BASE}/${LAYER.historic}`,pt); out.historic={ in_district:h.hit, name:((findAttr(h.attrs,/name|district/i)||{}).value)||null }; }
      catch(e){ out.errors.push('historic: '+e.message); }
    }

    out.note_easements = 'No private-easement layer here - verify easements on the recorded plat. (Storm-water easements are a separate Open Data layer if needed.)';
    out.ok = !!(out.parcel || out.zoning);
    if(debug) out.raw = raw;
    res.status(200).json(out);
  }catch(e){ out.errors.push('fatal: '+e.message); res.status(200).json(out); }
}

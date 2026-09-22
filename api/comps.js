// api/comps.js — TTV new-construction comps (Charlotte / Mecklenburg)  v1
//
// Phase 2 of the underwriting flow: given a subject parcel, return the recent NEW-BUILD sales
// around it and a suggested retail $/sf, following the Deal Analyst SOP's own comping rules.
//
// Source: Mecklenburg County's public ArcGIS servers — no key, no signup.
//   TaxParcelSales     -> every recorded transfer with the assessor's sale-validity code
//   TaxParcel_camadata -> year built, heated area, beds/baths, grade, lat/lng for each parcel
// The two are joined on PID, because the sales layer carries no building attributes.
//
// SOP rules encoded here (Deal Analyst SOP, LAND DEALS / STEP 3):
//   - comps built 2020+ give market context; comps built 2025+ are the "solid" set
//   - compute BOTH absolute sold prices and average $/sf
//   - cap the ARV at the highest sold comp — never let $/sf math run past a real sale
//   - 0-1 solid comps, or luxury-tier ARV (> $1M), is a red flag to surface, not to hide
//
// Mecklenburg-only by design, same as api/gis.js. Other counties fall back to DealMachine.
// Deploy on Vercel; hit /api/comps?pid=08915115&sf=1854&radius=0.5
const MECK = 'https://meckgis.mecklenburgcountync.gov/server/rest/services';
const SR = 2264;                 // NC State Plane ft — the county's native projection
const MI_FT = 5280;
const SALES_LAYER = `${MECK}/TaxParcelSales/MapServer/0`;
const CAMA_LAYER  = `${MECK}/TaxParcel_camadata/MapServer/0`;
const PARCEL_LAYER= `${MECK}/TaxParcelBoundaries/MapServer/0`;
// Newly built parcels often carry no situs address in CAMA yet, so fall back to the county's
// Master Address Points, which are assigned as soon as the lot is recorded.
const MAT_LAYER   = `${MECK}/MasterAddressPoints/MapServer/0`;

// Sale-validity codes. Blank = no disqualification (arm's length). Z = builder sale, which is
// exactly the new-build resale TTV is pricing — the assessor excludes those from ratio studies,
// but for us they are the best comps on the board. Every other code is a disqualified transfer
// (multi-parcel conveyance, related parties, foreclosure, <=$3,000, etc.).
const MARKET_VALIDITY = ['', 'Z'];
// Residential land-use codes worth comping against a new single-family / townhome build.
const RES_USE = /^R(1\d\d|2\d\d|3\d\d)$/;

// ArcGIS answers a bad field or where-clause with HTTP 200 and an {error:...} body, so check for it.
async function ajPost(url, params){
  const body = new URLSearchParams(params).toString();
  const r = await fetch(url, {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, body});
  if(!r.ok) throw new Error('HTTP '+r.status+' '+url);
  const j = await r.json();
  if(j && j.error) throw new Error('ArcGIS '+(j.error.code||'')+': '+(j.error.message||''));
  return j;
}
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : null; };
function median(a){ if(!a.length) return null; const s=[...a].sort((x,y)=>x-y); const m=s.length>>1;
  return s.length%2 ? s[m] : +((s[m-1]+s[m])/2).toFixed(2); }
function ringCentroid(rings){
  const r = rings && rings[0]; if(!r || !r.length) return null;
  let x=0,y=0; r.forEach(p=>{x+=p[0];y+=p[1];});
  return {x:x/r.length, y:y/r.length};
}
// Great-circle miles. camadata stores latitude in `xcoord` and longitude in `ycoord` — the field
// names are backwards in the source data, which is worth knowing before "fixing" this.
function milesBetween(lat1,lng1,lat2,lng2){
  const R=3958.8, toRad=d=>d*Math.PI/180;
  const dLat=toRad(lat2-lat1), dLng=toRad(lng2-lng1);
  const a=Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function isoDate(ms){ return (typeof ms==='number' && ms>0 && ms<4e12) ? new Date(ms).toISOString().slice(0,10) : null; }

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Cache-Control','s-maxage=3600, stale-while-revalidate');

  const q = req.query || {};
  const pid = (q.pid||'').trim();
  const radius = Math.min(Math.max(parseFloat(q.radius)||0.5, 0.1), 2);        // miles
  const months = Math.min(Math.max(parseInt(q.months)||24, 3), 60);
  const minYear = parseInt(q.minYear) || 2020;                                  // context tier
  const solidYear = parseInt(q.solidYear) || 2025;                              // "solid comp" tier
  const minPrice = parseInt(q.minPrice) || 100000;                              // drop lot/teardown transfers
  const subjectSf = parseFloat(q.sf) || null;                                   // plan sf, for the ARV suggestion

  const out = { subject:null, params:{pid,radius,months,minYear,solidYear,minPrice,subjectSf},
                comps:[], summary:null, arv:null, flags:[], notes:[], errors:[] };
  if(!pid){ res.status(400).json({error:'pass ?pid= (Mecklenburg parcel id)'}); return; }

  try{
    // 1) subject parcel: centre point for the search envelope, plus its own record for context
    let centre=null, subjLat=null, subjLng=null;
    try{
      const pj = await ajPost(`${PARCEL_LAYER}/query`, {where:`pid='${pid}'`, outFields:'pid,gisacres',
        returnGeometry:'true', outSR:String(SR), f:'json'});
      const f = (pj.features||[])[0];
      if(f && f.geometry) centre = ringCentroid(f.geometry.rings);
      if(f) out.subject = {pid, acres:f.attributes && f.attributes.gisacres || null};
    }catch(e){ out.errors.push('subject_parcel: '+e.message); }
    if(!centre){ out.errors.push('No parcel geometry for PID '+pid+' — cannot centre the search.');
      res.status(200).json(out); return; }

    try{
      const cj = await ajPost(`${CAMA_LAYER}/query`, {where:`pid='${pid}'`,
        outFields:'pid,address,xcoord,ycoord,yearbuilt,heatedarea,neighbordesc,landuse_description',
        returnGeometry:'false', f:'json'});
      const a = (cj.features||[])[0] && cj.features[0].attributes;
      if(a){ subjLat=num(a.xcoord); subjLng=num(a.ycoord);
        out.subject = Object.assign(out.subject||{pid}, {address:a.address||null,
          neighborhood:a.neighbordesc||null, existing_year_built:a.yearbuilt||null,
          existing_heated_sf:a.heatedarea||null, land_use:a.landuse_description||null}); }
    }catch(e){ out.errors.push('subject_cama: '+e.message); }

    // 2) every recorded sale in the envelope over the window
    const halfFt = radius*MI_FT;
    const env = JSON.stringify({xmin:centre.x-halfFt, ymin:centre.y-halfFt,
                                xmax:centre.x+halfFt, ymax:centre.y+halfFt, spatialReference:{wkid:SR}});
    const since = new Date(Date.now() - months*30.44*86400000).toISOString().slice(0,10);
    const sj = await ajPost(`${SALES_LAYER}/query`, {
      geometry:env, geometryType:'esriGeometryEnvelope', inSR:String(SR),
      spatialRel:'esriSpatialRelIntersects',
      where:`saledate >= DATE '${since}' AND saleprice > ${minPrice}`,
      outFields:'parcelid,saleprice,saledate,salesvalidity,landuse,soldasvacantflag,naldesc',
      returnGeometry:'false', f:'json'});
    const allSales = (sj.features||[]).map(f=>f.attributes);
    out.notes.push(`${allSales.length} recorded sales in ${radius} mi since ${since}`);

    // 3) keep arm's-length + builder sales of residential parcels, newest row per parcel
    const byParcel = new Map();
    allSales.forEach(a=>{
      const v = (a.salesvalidity||'').trim().toUpperCase();
      if(!MARKET_VALIDITY.includes(v)) return;
      if(a.landuse && !RES_USE.test(a.landuse)) return;
      if((a.soldasvacantflag||'').trim().toUpperCase()==='Y') return;   // land sale, not a finished home
      const prev = byParcel.get(a.parcelid);
      if(!prev || (a.saledate||0) > (prev.saledate||0)) byParcel.set(a.parcelid, a);
    });
    const market = [...byParcel.values()];
    out.notes.push(`${market.length} market-valid residential sales (blank or Z) on distinct parcels`);
    if(!market.length){ out.summary={count:0}; res.status(200).json(out); return; }

    // 4) join the assessor record — the sales layer has no building attributes at all
    const pids = market.map(a=>a.parcelid);
    const cama = new Map();
    for(let i=0;i<pids.length;i+=60){
      const chunk = pids.slice(i,i+60);
      const where = 'pid IN ('+chunk.map(p=>`'${p}'`).join(',')+')';
      try{
        const j = await ajPost(`${CAMA_LAYER}/query`, {where,
          outFields:'pid,address,yearbuilt,heatedarea,bedrooms,fullbath,halfbath,grade,'
                   +'landuse_description,xcoord,ycoord,gisacres,neighbordesc,bldgtype',
          returnGeometry:'false', f:'json'});
        (j.features||[]).forEach(f=>cama.set(f.attributes.pid, f.attributes));
      }catch(e){ out.errors.push('cama_join: '+e.message); }
    }

    // 4b) fill in addresses the assessor record is missing (common on brand-new lots)
    const missing = pids.filter(p=>{ const c=cama.get(p); return c && !(c.address||'').trim(); });
    if(missing.length){
      for(let i=0;i<missing.length;i+=60){
        const chunk = missing.slice(i,i+60);
        const where = 'num_parent_parcel IN ('+chunk.map(p=>`'${p}'`).join(',')+')';
        try{
          const j = await ajPost(`${MAT_LAYER}/query`, {where,
            outFields:'num_parent_parcel,full_address', returnGeometry:'false', f:'json'});
          (j.features||[]).forEach(f=>{
            const a=f.attributes, c=cama.get(a.num_parent_parcel);
            if(c && !(c.address||'').trim() && a.full_address) c.address = a.full_address;
          });
        }catch(e){ out.errors.push('address_fallback: '+e.message); }
      }
    }

    // 5) build the comp rows
    const rows = [];
    market.forEach(a=>{
      const c = cama.get(a.parcelid); if(!c) return;
      const sf = num(c.heatedarea), yb = c.yearbuilt || null;
      const lat = num(c.xcoord), lng = num(c.ycoord);
      const dist = (lat!=null && lng!=null && subjLat!=null && subjLng!=null)
        ? +milesBetween(subjLat,subjLng,lat,lng).toFixed(2) : null;
      rows.push({
        pid:a.parcelid, address:c.address||null,
        sale_price:a.saleprice, sale_date:isoDate(a.saledate),
        validity:(a.salesvalidity||'').trim() || null,
        builder_sale:(a.salesvalidity||'').trim().toUpperCase()==='Z',
        year_built:yb, heated_sf:sf,
        psf: (sf && sf>0) ? +(a.saleprice/sf).toFixed(2) : null,
        beds:c.bedrooms||null, baths:((c.fullbath||0)+0.5*(c.halfbath||0))||null,
        grade:c.grade||null, type:c.bldgtype||c.landuse_description||null,
        lot_acres:c.gisacres!=null ? +Number(c.gisacres).toFixed(3) : null,
        neighborhood:c.neighbordesc||null,
        distance_mi:dist,
        tier: (yb && yb>=solidYear) ? 'solid' : (yb && yb>=minYear) ? 'context' : 'older'
      });
    });
    rows.sort((a,b)=> (a.distance_mi??99) - (b.distance_mi??99));
    out.comps = rows;

    // 6) summarise each tier. Two methods, per the SOP: $/sf and absolute sold price.
    const usable = r => r.psf!=null && r.heated_sf>0;
    const solid = rows.filter(r=>r.tier==='solid' && usable(r));
    const context = rows.filter(r=>(r.tier==='solid'||r.tier==='context') && usable(r));
    const older = rows.filter(r=>r.tier==='older' && usable(r));
    const stat = set => set.length ? {
      count:set.length,
      median_psf:median(set.map(r=>r.psf)),
      avg_psf:+(set.reduce((t,r)=>t+r.psf,0)/set.length).toFixed(2),
      min_psf:Math.min(...set.map(r=>r.psf)), max_psf:Math.max(...set.map(r=>r.psf)),
      highest_sold:Math.max(...set.map(r=>r.sale_price)),
      median_sf:median(set.map(r=>r.heated_sf)),
      avg_distance_mi:+(set.reduce((t,r)=>t+(r.distance_mi||0),0)/set.length).toFixed(2)
    } : {count:0};
    out.summary = {solid:stat(solid), new_build:stat(context), older:stat(older),
      total_rows:rows.length, builder_sales:rows.filter(r=>r.builder_sale).length};

    // 7) suggested ARV from the plan's square footage, capped at the highest real sale
    const basis = solid.length>=2 ? {set:solid, label:`solid comps (built ${solidYear}+)`}
                : context.length ? {set:context, label:`new-build comps (built ${minYear}+)`} : null;
    if(basis && subjectSf){
      const mpsf = median(basis.set.map(r=>r.psf));
      const raw = mpsf*subjectSf;
      const cap = Math.max(...basis.set.map(r=>r.sale_price));
      const capped = raw > cap;
      out.arv = {
        basis:basis.label, comps_used:basis.set.length, median_psf:mpsf,
        subject_sf:subjectSf,
        arv_by_psf:Math.round(raw),
        highest_sold_comp:cap,
        arv:Math.round(capped?cap:raw),
        capped,
        retail_psf:+((capped?cap:raw)/subjectSf).toFixed(2),
        note: capped
          ? 'Capped at the highest sold comp — the $/sf math ran past every real sale nearby (SOP: never assume a bigger house sells for more).'
          : 'Median $/sf of the comp set × the plan square footage.'
      };
    } else if(basis && !subjectSf){
      out.notes.push('Pass ?sf= (the plan’s heated square footage) to get a suggested ARV.');
    }

    // 8) flags the SOP wants surfaced loudly rather than buried
    if(solid.length<=1) out.flags.push(`Only ${solid.length} solid comp${solid.length===1?'':'s'} (built ${solidYear}+) — thin evidence, widen the radius or the window and say so on the sheet.`);
    if(context.length && Math.max(...context.map(r=>r.sale_price))>1000000) out.flags.push('Luxury-tier comp above $1M in the set — outside the normal buy box, flag before underwriting further.');
    if(basis && basis.set.length && (Math.max(...basis.set.map(r=>r.psf)) / Math.min(...basis.set.map(r=>r.psf))) > 1.6) out.flags.push('Comp $/sf spread is wide (>60% high-to-low) — the pocket is not uniform, pick the comps by hand.');
    if(out.arv && out.arv.capped) out.flags.push('ARV capped at the highest sold comp.');

    res.status(200).json(out);
  }catch(e){
    out.errors.push('fatal: '+e.message);
    res.status(200).json(out);
  }
}

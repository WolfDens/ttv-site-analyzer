// api/permits.js — TTV Permitting Dashboard data proxy  v1
// Serves the permit-state JSON that the TTV Permit Listener (scheduled Claude task)
// maintains in Google Drive ("ttv-permit-state.json", link-shared read-only).
// The dashboard (/permits.html) fetches this instead of shipping data baked into
// the static HTML. Server-side fetch avoids the browser CORS block on Drive, and
// means daily status updates happen in Drive only — the listener never touches git.
//
// Access: requires ?k=<sha256 of the team passcode> — the same hash the page's
// gate computes, so data is only returned to a client that has passed the gate.
// (The hash is visible in the public HTML, so this is a deterrent consistent with
// the gate itself, not a hard boundary; Mecklenburg permit statuses are public
// record. Don't put non-public data in the permit-state file.)
//
// The Drive FILE ID below is deliberately committed — it points at a link-shared
// file holding the same data the board renders, so it is not a secret. If the file
// ever moves, set the PERMITS_FILE_ID env var on Vercel instead of editing code.
const FILE_ID = process.env.PERMITS_FILE_ID || '1BKJf7_fDSw8nKBogxU2rD6vC5WqrbrPC';
const GATE_HASH = '9b748ce71c59791771ab14a3de4bb0a2822eac70555d3e292ac7160af8fa1cc6'; // keep in sync with permits.html

export default async function handler(req, res){
  res.setHeader('Access-Control-Allow-Origin','*');
  if((req.query.k || '') !== GATE_HASH){ res.status(401).json({error:'unauthorized'}); return; }
  try{
    const r = await fetch(`https://drive.google.com/uc?export=download&id=${FILE_ID}`, {redirect:'follow'});
    if(!r.ok) throw new Error('drive HTTP '+r.status);
    const text = await r.text();
    let data;
    try{ data = JSON.parse(text); }
    catch(_){ throw new Error('drive returned non-JSON (file sharing changed?)'); }
    if(!data || !Array.isArray(data.projects)) throw new Error('unexpected payload shape');
    res.setHeader('Cache-Control','s-maxage=300, stale-while-revalidate=3600'); // 5-min edge cache
    res.status(200).json(data);
  }catch(e){
    res.setHeader('Cache-Control','no-store');
    res.status(502).json({error:String(e && e.message || e)});
  }
}

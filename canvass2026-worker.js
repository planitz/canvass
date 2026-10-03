const esc = s => String(s ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const json = (x,s=200)=>new Response(JSON.stringify(x),{status:s,headers:{"content-type":"application/json"}});
const voteExpr = {
  P22:"v.p22_voted=1", G22:"v.g22_voted=1", P24:"v.p24_voted=1",
  G24:"v.g24_voted=1", P26:"v.p26_voted=1", G26:"v.g26_voted=1",
  None:"v.p22_voted=0 AND v.g22_voted=0 AND v.p24_voted=0 AND v.g24_voted=0 AND v.p26_voted=0 AND v.g26_voted=0"
};
function where(u, phone=false, email=false){
  const q=u.searchParams, w=[], b=[];
  if(q.get("street")){w.push("v.street=?");b.push(q.get("street"))}
  if(q.get("precinct")){w.push("v.precinct=?");b.push(q.get("precinct"))}
  if(q.get("voted") && voteExpr[q.get("voted")]) w.push(voteExpr[q.get("voted")]);
  if(q.get("method")){
    const e=q.get("voted")==="G26"?"g26":"p26";
    w.push(`v.${e}_method=?`);b.push(q.get("method"));
  }
  if(q.get("supporter")==="1") w.push("COALESCE(c.supporter,0)=1");
  if(q.get("parity")==="even") w.push("CAST(v.house_number AS INTEGER)%2=0");
  if(q.get("parity")==="odd") w.push("CAST(v.house_number AS INTEGER)%2=1");
  if(q.get("q")){
    const z="%"+q.get("q")+"%"; w.push("(v.first_name LIKE ? OR v.last_name LIKE ? OR v.household_address LIKE ? OR v.phone LIKE ? OR v.email LIKE ?)");
    b.push(z,z,z,z,z);
  }
  if(phone) w.push("v.phone IS NOT NULL AND TRIM(v.phone)<>'' AND COALESCE(c.bad_phone,0)=0");
  if(email) w.push("v.email IS NOT NULL AND TRIM(v.email)<>''");
  return {sql:w.length?" WHERE "+w.join(" AND "):"", binds:b};
}
const baseSelect = `SELECT v.*,COALESCE(c.knock_lit,0) knock_lit,COALESCE(c.talked,0) talked,
COALESCE(c.supporter,0) supporter,COALESCE(c.follow_up,0) follow_up,COALESCE(c.bad_phone,0) bad_phone,
COALESCE(c.do_not_contact,0) do_not_contact,COALESCE(c.intends_mail,0) intends_mail,
COALESCE(c.intends_early,0) intends_early,COALESCE(c.intends_polls,0) intends_polls,c.notes campaign_notes
FROM voters v LEFT JOIN campaign_activity c ON c.voter_id=v.voter_id`;

async function api(req,env,u){
  const p=u.pathname;
  const importAuth = () => {
    const token=req.headers.get("x-import-secret")||"";
    return !!env.IMPORT_SECRET && token===env.IMPORT_SECRET;
  };
  if(p==="/api/import/status"){
    if(!importAuth()) return json({error:"Unauthorized"},401);
    const r=await env.DB.prepare("SELECT COUNT(*) count FROM voters").first();
    return json({count:r.count,open:r.count===0});
  }
  if(p==="/api/import/batch" && req.method==="POST"){
    if(!importAuth()) return json({error:"Unauthorized"},401);
    const existing=await env.DB.prepare("SELECT COUNT(*) count FROM voters").first();
    const body=await req.json(), rows=body.rows, expected=Number(body.expected_count_before);
    if(!Number.isInteger(expected)||expected<0||expected>7333) return json({error:"Invalid batch sequence."},400);
    if(Number(existing.count)!==expected) return json({error:"Import sequence mismatch.",count:existing.count,expected},409);
    if(existing.count>=7333) return json({error:"Import already complete.",count:existing.count},409);
    if(!Array.isArray(rows)||rows.length<1||rows.length>75||existing.count+rows.length>7333) return json({error:"Invalid batch size."},400);
    const cols=["voter_id","registration_status","first_name","middle_name","last_name","suffix","date_of_birth","house_number","street","unit","household_address","city","zip","precinct","ward","ward_district","party","registration_date","effective_date","status_change_date","phone","email","p22_voted","p22_method","g22_voted","g22_method","p24_voted","p24_method","g24_voted","g24_method","p26_voted","p26_method","g26_voted","g26_method","g26_mail_record","g26_mail_request_date","g26_mail_application_status","g26_mail_application_rejection","g26_mail_sos_mail_date","g26_mail_boe_received_date","g26_mail_status","g26_mail_ballot_deficiency","g26_voted_at_local_board","last_vote_date","last_election","last_vote_method","official_source","match_confidence","data_quality_flags"];
    const sql="INSERT INTO voters("+cols.join(",")+") VALUES("+cols.map(()=>"?").join(",")+")";
    await env.DB.batch(rows.map(r=>env.DB.prepare(sql).bind(...cols.map(c=>r[c]===undefined||r[c]===""?null:r[c]))));
    return json({ok:true,inserted:rows.length});
  }
  if(p==="/api/import/finish" && req.method==="POST"){
    if(!importAuth()) return json({error:"Unauthorized"},401);
    const r=await env.DB.prepare("SELECT COUNT(*) count FROM voters").first();
    if(r.count!==7333) return json({error:"Expected exactly 7333 voters.",count:r.count},409);
    const p26=await env.DB.prepare("SELECT SUM(p26_voted) n FROM voters").first();
    if(Number(p26.n)!==1491) return json({error:"P26 verification failed.",p26:p26.n},409);
    await env.DB.prepare("INSERT INTO data_imports(import_type,source_name,row_count,notes) VALUES('voters','Ward10_NEW_APP_IMPORT_2026-10-03.csv',7333,'Authenticated browser import; reconciled master')").run();
    return json({ok:true,count:r.count,p26:p26.n});
  }
  if(p==="/api/meta"){
    const [streets,precincts]=await Promise.all([
      env.DB.prepare("SELECT DISTINCT street FROM voters ORDER BY street").all(),
      env.DB.prepare("SELECT precinct,COUNT(*) count FROM voters GROUP BY precinct ORDER BY precinct").all()
    ]);
    return json({streets:streets.results.map(x=>x.street),precincts:precincts.results});
  }
  if(p==="/api/voters"){
    const mode=u.searchParams.get("mode")||"canvass", x=where(u,mode==="text",mode==="email");
    const desc=u.searchParams.get("dir")==="desc"?"DESC":"ASC";
    const order=mode==="canvass"?` ORDER BY CAST(v.house_number AS INTEGER) ${desc},v.house_number ${desc},v.unit,v.last_name,v.first_name`:" ORDER BY v.street,CAST(v.house_number AS INTEGER),v.unit,v.last_name";
    const st=env.DB.prepare(baseSelect+x.sql+order+" LIMIT 1000").bind(...x.binds);
    const data=await st.all();
    return json(data.results);
  }
  if(p==="/api/summary"){
    const x=where(u);
    const sql=`SELECT COUNT(*) total_voters,SUM(v.p26_voted) primary_voters,
      COUNT(DISTINCT v.street||'|'||v.house_number) total_houses,
      COUNT(DISTINCT v.street||'|'||v.house_number||'|'||COALESCE(v.unit,'')) total_doors
      FROM voters v LEFT JOIN campaign_activity c ON c.voter_id=v.voter_id${x.sql}`;
    return json(await env.DB.prepare(sql).bind(...x.binds).first());
  }
  if(p==="/api/field-plan"){
    const x=where(u), sort={complete:"percent_complete",primary:"primary_voters",all:"all_voters",none:"none_voters"}[u.searchParams.get("sort")]||"street";
    const dir=u.searchParams.get("dir")==="desc"?"DESC":"ASC";
    const sql=`SELECT v.street,COUNT(*) all_voters,SUM(v.p26_voted) primary_voters,
      SUM(CASE WHEN v.p22_voted=0 AND v.g22_voted=0 AND v.p24_voted=0 AND v.g24_voted=0 AND v.p26_voted=0 AND v.g26_voted=0 THEN 1 ELSE 0 END) none_voters,
      COUNT(DISTINCT v.house_number) total_houses,
      COUNT(DISTINCT v.house_number||'|'||COALESCE(v.unit,'')) total_doors,
      SUM(COALESCE(c.knock_lit,0)) completed,
      ROUND(100.0*SUM(COALESCE(c.knock_lit,0))/COUNT(*),1) percent_complete
      FROM voters v LEFT JOIN campaign_activity c ON c.voter_id=v.voter_id${x.sql} GROUP BY v.street ORDER BY ${sort} ${dir}`;
    return json((await env.DB.prepare(sql).bind(...x.binds).all()).results);
  }
  if(p==="/api/activity" && req.method==="POST"){
    const d=await req.json(), allowed=["knock_lit","talked","supporter","follow_up","bad_phone","do_not_contact","intends_mail","intends_early","intends_polls","notes"];
    if(!d.voter_id || !allowed.includes(d.field)) return json({error:"bad request"},400);
    const value=d.field==="notes"?String(d.value??""):(d.value?1:0);
    await env.DB.prepare(`INSERT INTO campaign_activity(voter_id,${d.field},updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(voter_id) DO UPDATE SET ${d.field}=excluded.${d.field},updated_at=CURRENT_TIMESTAMP`).bind(d.voter_id,value).run();
    await env.DB.prepare("INSERT INTO activity_log(voter_id,action_type,action_value) VALUES(?,?,?)").bind(d.voter_id,d.field.toUpperCase(),String(value)).run();
    return json({ok:true});
  }
  return json({error:"not found"},404);
}
function importPage(){
return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>canvass2026 secure import</title><style>body{font:16px system-ui;max-width:760px;margin:35px auto;padding:20px}input,button{font-size:16px;padding:10px;margin:6px 0;width:100%}button{font-weight:700}pre{background:#f4f6f8;padding:12px;white-space:pre-wrap} .houseGroup{margin:10px 12px;border:1px solid #cfd8e3;border-radius:12px;background:#fff;overflow:hidden}.houseHeader{padding:9px 12px;font-weight:900;font-size:17px;background:#eef3f8;border-bottom:1px solid #d9e0e8}.houseHeader span,.doorGroup{margin:0;background:#fff;overflow:hidden;border-bottom:1px solid #d9e0e8}.doorGroup:last-child{border-bottom:0}.doorHeader{padding:8px 12px;font-weight:800;font-size:16px;background:#f5f7fa;border-bottom:1px solid #e1e6ec}.doorHeader span{font-size:11px;font-weight:600;color:#6b7b8f;margin-left:5px}.doorGroup .row{margin:0;border:0;border-radius:0;border-bottom:1px solid #edf0f3}.doorGroup .row:last-child{border-bottom:0}.voterInDoor .name{font-weight:700} .searchRow{display:flex;gap:8px;align-items:center;padding:8px 20px;background:#fff;border-bottom:1px solid #ddd}.searchRow input{flex:1;min-width:0}.searchRow .clearBtn{flex-shrink:0} .voterDetail{display:flex;align-items:center;gap:6px;margin-top:4px;min-width:0}.voterDetail .meta{flex:1;min-width:0;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.content .row{padding:9px 10px}</style></head><body><h1>Secure canvass2026 import</h1><p>The secret stays in this browser request and is not stored in the voter database.</p><input id="secret" type="password" placeholder="IMPORT_SECRET"><input id="file" type="file" accept=".csv"><button id="go">Import clean voter CSV</button><pre id="out">Ready.</pre><script>
const out=document.querySelector("#out");
function parseCSV(t){let a=[],r=[],v="",q=false;for(let i=0;i<t.length;i++){let c=t[i];if(q){if(c=='"'&&t[i+1]=='"'){v+='"';i++}else if(c=='"')q=false;else v+=c}else if(c=='"')q=true;else if(c==","){r.push(v);v=""}else if(c=="\\n"){r.push(v.replace(/\\r$/,""));a.push(r);r=[];v=""}else v+=c}if(v||r.length){r.push(v);a.push(r)}return a}
async function call(url,secret,opt={}){opt.headers={...(opt.headers||{}),"x-import-secret":secret};let r=await fetch(url,opt),z=await r.json();if(!r.ok)throw new Error(JSON.stringify(z));return z}
document.querySelector("#go").onclick=async()=>{try{let secret=document.querySelector("#secret").value,file=document.querySelector("#file").files[0];if(!secret||!file)throw new Error("Enter the secret and choose the clean CSV.");let st=await call("/api/import/status",secret);if(!st.open)throw new Error("Database already contains "+st.count+" voters; import is locked.");let a=parseCSV(await file.text()),h=a.shift();if(a.length!==7333)throw new Error("Expected 7,333 rows but this CSV has "+a.length+".");out.textContent="Validated 7,333 rows. Importing…";let total=0;for(let i=0;i<a.length;i+=75){let rows=a.slice(i,i+75).map(x=>Object.fromEntries(h.map((k,j)=>[k,x[j]??""])));let z=await call("/api/import/batch",secret,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({rows,expected_count_before:total})});total+=z.inserted;out.textContent="Imported "+total+" / 7,333";}let z=await call("/api/import/finish",secret,{method:"POST"});out.textContent="COMPLETE — "+z.count+" voters; P26 verification: "+z.p26+".";}catch(e){out.textContent="STOPPED — "+e.message}}
</script></body></html>`}
function page(){
return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ward 10 Canvass 2026</title><style>
*{box-sizing:border-box}body{margin:0;font:14px system-ui;background:#f5f7fa;color:#172033}header{background:#0A1F44;color:white;padding:14px 16px}h1{font-size:20px;margin:0}.tabs,.filters,.summary{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:2px;padding:7px 8px;background:white;border-bottom:1px solid #ddd;white-space:nowrap;width:100%;box-sizing:border-box}.tabs button{font-weight:700}.active{background:#0A1F44!important;color:white}button,select,input{min-height:38px;border:1px solid #bbc3cf;border-radius:7px;background:white;padding:7px 10px}.filters{display:flex;flex-direction:column;align-items:stretch;gap:10px;padding:12px 16px;background:#fff}.filters .filterGroup{width:100%;display:flex;gap:6px;flex-wrap:wrap;align-items:center}.filters .filterLabel{width:100%}.streetSelect{width:100%;max-width:350px}.filters input{flex:1;min-width:160px}.filterGroup{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.filterLabel{width:100%;font-size:12px;font-weight:700;color:#6b7b8f;text-transform:uppercase;letter-spacing:.05em}.filterBtn.selected{background:#e8f4ff;border-color:#1687e8;color:#0878d1;font-weight:800}.filterBtn{font-weight:700}.streetSelect{min-width:180px}.clearBtn{color:#0878d1;font-weight:800}.summary b{font-size:13px!important}.summary span{display:block;min-width:0;text-align:center;font-size:13px!important;white-space:nowrap}.content{padding:10px}.row{background:white;border:1px solid #dde2e8;border-radius:9px;margin:7px 0;padding:10px}.addr{font-weight:800}.name{font-size:16px;margin:0}.nameLine{display:flex;align-items:baseline;gap:6px;min-width:0}.addrName{display:flex;align-items:baseline;gap:8px;flex:1;min-width:0}.addrName .addr{font-size:15px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:43%}.addrName .name{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}.addrName .addr{flex-shrink:0}.addrName .name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.addrName .addr,.addrName .name{font-size:13px;overflow:hidden;text-overflow:ellipsis}.nameActions{display:flex;gap:3px;flex-shrink:0;margin-left:auto}.nameActions button{padding:1px 2px;min-width:28px;width:28px;height:28px}.nameActions .followBtn{padding:1px 2px;min-width:28px;width:28px;font-size:15px;line-height:1}.meta{color:#5d6878;font-size:12px;margin-top:4px}.detailLine{display:flex;align-items:center;gap:6px;margin-top:6px;min-width:0}.detailLine .meta{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.actions{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}.actions button.on,.nameActions button.on{background:#A6CE39!important;border-color:#789b1d!important;color:#0A1F44!important;box-shadow:inset 0 0 0 2px #789b1d}.street{display:grid;grid-template-columns:2fr repeat(5,1fr);gap:6px;align-items:center}.noteWrap{display:none;margin-top:6px}.noteWrap.open{display:block}.note{width:100%}.noteBtn{font-size:18px!important;padding:3px 7px!important}.danger.on{background:#ffd1d1}.toolbar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}@media(max-width:650px){.street{grid-template-columns:1.5fr repeat(2,1fr)}.street span:nth-child(n+4){font-size:11px}}
</style></head><body><header><h1>Ward 10 Canvass 2026</h1></header>
<div class="tabs"><button type="button" data-tab="canvass" class="active">Canvass</button><button type="button" data-tab="field">Field Plan</button><button type="button" data-tab="text">Text / Call</button><button type="button" data-tab="email">Email</button></div>
<div class="filters">
<div class="filterGroup"><span class="filterLabel">Street</span><select id="street" class="streetSelect"><option value="">All Streets</option></select></div>
<div class="filterGroup" data-filter="voted"><span class="filterLabel">Voted</span><button type="button" class="filterBtn" data-value="G26">G26</button><button type="button" class="filterBtn" data-value="P26">P26</button><button type="button" class="filterBtn" data-value="G24">G24</button><button type="button" class="filterBtn" data-value="P24">P24</button><button type="button" class="filterBtn" data-value="G22">G22</button><button type="button" class="filterBtn" data-value="P22">P22</button><button type="button" class="filterBtn" data-value="None">None</button></div>
<div class="filterGroup" data-filter="method"><span class="filterLabel">P/G 26 Method</span><button type="button" class="filterBtn" data-value="Mail">Mail</button><button type="button" class="filterBtn" data-value="Early">Early</button><button type="button" class="filterBtn" data-value="Polls">Polls</button></div>
<div class="filterGroup" data-filter="precinct"><span class="filterLabel">Precinct</span><button type="button" class="filterBtn" data-value="2827">2827</button><button type="button" class="filterBtn" data-value="2828">2828</button><button type="button" class="filterBtn" data-value="2832">2832</button><button type="button" class="filterBtn" data-value="2833">2833</button></div>
<div class="filterGroup" data-filter="supporter"><span class="filterLabel">Campaign</span><button type="button" class="filterBtn" data-value="1">Supporters</button></div>
<input type="hidden" id="voted"><input type="hidden" id="method"><input type="hidden" id="precinct"><input type="hidden" id="supporter">
</div>
<div class="toolbar canvassTools"><button type="button" id="collapseFiltersBtn">Collapse Filters</button><button type="button" class="sortBtn selected" data-dir="asc"># ↑</button><button type="button" class="sortBtn" data-dir="desc"># ↓</button><button type="button" class="parityBtn" data-parity="even">Even</button><button type="button" class="parityBtn" data-parity="odd">Odd</button></div>
<div class="searchRow"><input id="search" placeholder="Search name, address, phone, email"><button type="button" id="clearFiltersBtn" class="clearBtn">Clear</button></div>
<div id="summary" class="summary"></div><main id="content" class="content"></main>
<script>
let tab="canvass"; const $=x=>document.querySelector(x), filters=["street","voted","method","precinct","supporter"];
async function meta(){let m=await getJSON("/api/meta");let street=$("#street");street.innerHTML='<option value="">All Streets</option>';m.streets.forEach(x=>{let o=document.createElement("option");o.value=x;o.textContent=x;street.appendChild(o)});return m}
function qs(){let p=new URLSearchParams;filters.forEach(x=>{let v=$("#"+x).value;if(v)p.set(x,v)});if($("#search").value)p.set("q",$("#search").value);if(window.houseDir)p.set("dir",window.houseDir);if(window.parity)p.set("parity",window.parity);return p}
function pickFilter(btn){let g=btn.closest("[data-filter]"),id=g.dataset.filter,input=$("#"+id),same=input.value===btn.dataset.value;g.querySelectorAll(".filterBtn").forEach(x=>x.classList.remove("selected"));input.value=same?"":btn.dataset.value;if(!same)btn.classList.add("selected");load()}
function clearFilters(){filters.forEach(x=>$("#"+x).value="");$("#search").value="";document.querySelectorAll(".filterBtn").forEach(x=>x.classList.remove("selected"));load()}
async function getJSON(url){let r=await fetch(url),z=await r.json();if(!r.ok||z.error)throw new Error(z.error||("Request failed "+r.status));return z}
async function load(){try{let p=qs();if(tab==="field")return await field(p);p.set("mode",tab);let [rows,s]=await Promise.all([getJSON("/api/voters?"+p),getJSON("/api/summary?"+qs())]);$("#summary").innerHTML='<span><b>'+s.primary_voters+'</b> P-26</span><span><b>'+s.total_voters+'</b> V</span><span><b>'+s.total_doors+'</b> D</span><span><b>'+s.total_houses+'</b> H</span>';if(!Array.isArray(rows))throw new Error("Voter results were not returned as a list");$("#content").innerHTML=rows.length?rows.map(v=>card(v,false)).join(""):"No results for these filters."}catch(e){$("#content").innerHTML='<div class="row"><b>Load error</b><div class="meta">'+esc(e.message)+'</div></div>';console.error(e)}}
function groupDoors(rows){let houses=new Map;rows.forEach(v=>{let hk=[v.street,v.house_number].join("|"),unit=(v.unit||"").trim();if(!houses.has(hk))houses.set(hk,{address:v.house_number+" "+v.street,doors:new Map});let h=houses.get(hk),dk=unit||"__NO_UNIT__";if(!h.doors.has(dk))h.doors.set(dk,[]);h.doors.get(dk).push(v)});return [...houses.values()].map(houseCard).join("")}
function houseCard(h){let total=[...h.doors.values()].reduce((n,x)=>n+x.length,0);return '<section class="houseGroup"><div class="houseHeader">'+esc(h.address)+' <span>'+total+' voter'+(total===1?'':'s')+'</span></div>'+[...h.doors.entries()].map(([unit,vs])=>doorCard(unit,vs)).join("")+'</section>'}
function doorCard(unit,vs){let label=unit==="__NO_UNIT__"?"Main / no unit":unit;return '<div class="doorGroup"><div class="doorHeader">'+esc(label)+' <span>'+vs.length+' voter'+(vs.length===1?'':'s')+'</span></div>'+vs.map(v=>card(v,true)).join("")+'</div>'}
function card(v,grouped=false){let contact=tab==="text"?'<div class="actions"><button type="button" data-go="sms" data-contact="'+esc(v.phone||"")+'">Text</button><button type="button" data-go="tel" data-contact="'+esc(v.phone||"")+'">Call</button></div>':tab==="email"?'<div class="actions"><button type="button" data-go="mailto" data-contact="'+esc(v.email||"")+'">Email</button></div>':"";
return '<div class="row"><div class="nameLine"><div class="addrName"><div class="addr">'+esc(v.house_number+" "+v.street+(v.unit?" · "+v.unit:""))+'</div><div class="name">'+esc(v.first_name+" "+v.last_name)+'</div></div></div><div class="voterDetail"><div class="meta">'+esc(v.precinct)+(v.p26_voted?' · P26 '+esc(v.p26_method):'')+(v.phone?" · "+esc(v.phone):"")+'</div><div class="nameActions">'+btn(v,"knock_lit","✔️","knockBtn")+btn(v,"talked","💬","talkBtn")+btn(v,"supporter","⭐","supporterBtn")+btn(v,"follow_up","❗","followBtn")+'</div></div>'+contact+'<div class="actions">'+(tab==="text"?btn(v,"bad_phone","✕ Bad #","danger")+btn(v,"do_not_contact","Stop","danger")+btn(v,"intends_mail","Mail")+btn(v,"intends_early","Early")+btn(v,"intends_polls","Polls"):"")+'</div><div class="noteWrap" data-note-wrap="'+esc(v.voter_id)+'"><input class="note" data-voter="'+esc(v.voter_id)+'" value="'+esc(v.campaign_notes||"")+'" placeholder="Notes"></div></div>'}
function btn(v,f,l,c=""){return '<button type="button" class="'+c+(v[f]?" on":"")+'" data-action="toggle" data-voter="'+esc(v.voter_id)+'" data-field="'+esc(f)+'">'+l+'</button>'}
async function toggle(el,id,f){let value=!el.classList.contains("on");await setv(id,f,value);el.classList.toggle("on",value)}
async function setv(id,field,value){let r=await fetch("/api/activity",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({voter_id:id,field,value})});let z=await r.json();if(!r.ok||z.error)throw new Error(z.error||("Save failed "+r.status));return z}
async function field(p){p.set("sort","complete");p.set("dir","desc");let rows=await getJSON("/api/field-plan?"+p);$("#summary").innerHTML="";$("#content").innerHTML='<div class="toolbar"><button type="button" data-fieldsort="complete">% Complete</button><button type="button" data-fieldsort="primary">P26 Voters</button><button type="button" data-fieldsort="all">All Voters</button><button type="button" data-fieldsort="none">None Voters</button></div>'+rows.map(x=>'<div class="row street"><b>'+esc(x.street)+'</b><span>'+x.percent_complete+'% complete</span><span>'+x.primary_voters+' P26</span><span>'+x.all_voters+' voters</span><span>'+x.total_doors+' doors</span><span>'+x.total_houses+' houses</span></div>').join("")}
async function fieldSort(s){let p=qs();p.set("sort",s);p.set("dir","desc");let rows=await getJSON("/api/field-plan?"+p);$("#content").querySelectorAll(".row").forEach(x=>x.remove());$("#content").insertAdjacentHTML("beforeend",rows.map(x=>'<div class="row street"><b>'+esc(x.street)+'</b><span>'+x.percent_complete+'% complete</span><span>'+x.primary_voters+' P26</span><span>'+x.all_voters+' voters</span><span>'+x.total_doors+' doors</span><span>'+x.total_houses+' houses</span></div>').join(""))}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function switchTab(next,el){document.querySelectorAll(".tabs button").forEach(x=>x.classList.remove("active"));el.classList.add("active");tab=next;load()}
document.querySelectorAll(".tabs button").forEach(b=>b.addEventListener("click",()=>switchTab(b.dataset.tab,b)));
document.querySelectorAll(".filterBtn").forEach(b=>b.addEventListener("click",()=>pickFilter(b)));
$("#clearFiltersBtn").addEventListener("click",clearFilters);
$("#street").addEventListener("change",load);
window.houseDir="asc";window.parity="";
document.querySelectorAll(".sortBtn").forEach(b=>b.addEventListener("click",()=>{window.houseDir=b.dataset.dir;document.querySelectorAll(".sortBtn").forEach(x=>x.classList.toggle("selected",x===b));load()}));
document.querySelectorAll(".parityBtn").forEach(b=>b.addEventListener("click",()=>{window.parity=window.parity===b.dataset.parity?"":b.dataset.parity;document.querySelectorAll(".parityBtn").forEach(x=>x.classList.toggle("selected",x.dataset.parity===window.parity));load()}));
$("#collapseFiltersBtn").addEventListener("click",()=>{let box=document.querySelector(".filters"),hidden=box.style.display==="none";box.style.display=hidden?"flex":"none";$("#collapseFiltersBtn").textContent=hidden?"Collapse Filters":"Show Filters"});let t;$("#search").addEventListener("input",()=>{clearTimeout(t);t=setTimeout(load,250)});
document.addEventListener("click",async e=>{let g=e.target.closest("[data-go]");if(g){location.href=g.dataset.go+":"+g.dataset.contact;return}let n=e.target.closest('[data-action="note"]');if(n){let w=document.querySelector('[data-note-wrap="'+CSS.escape(n.dataset.voter)+'"]');if(w){w.classList.toggle("open");if(w.classList.contains("open"))w.querySelector(".note")?.focus()}return}let a=e.target.closest('[data-action="toggle"]');if(a){await toggle(a,a.dataset.voter,a.dataset.field);return}let fs=e.target.closest("[data-fieldsort]");if(fs){await fieldSort(fs.dataset.fieldsort)}});
document.addEventListener("change",e=>{if(e.target.matches(".note"))setv(e.target.dataset.voter,"notes",e.target.value)});
(async()=>{try{$("#content").textContent="Loading voters…";await meta();await load()}catch(e){$("#content").innerHTML='<div class="row"><b>App load error</b><div class="meta">'+esc(e.message)+'</div></div>';console.error(e)}})();
</script></body></html>`}
export default {async fetch(req,env){const u=new URL(req.url);try{if(u.pathname.startsWith("/api/"))return await api(req,env,u);if(u.pathname==="/import")return new Response(importPage(),{headers:{"content-type":"text/html;charset=utf-8","cache-control":"no-store"}});return new Response(page(),{headers:{"content-type":"text/html;charset=utf-8","cache-control":"no-store, no-cache, must-revalidate","pragma":"no-cache"}})}catch(e){return json({error:String(e?.message||e)},500)}}};

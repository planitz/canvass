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
COALESCE(c.intends_early,0) intends_early,COALESCE(c.intends_polls,0) intends_polls,COALESCE(c.intends_no_vote,0) intends_no_vote,c.notes campaign_notes,(SELECT MAX(created_at) FROM activity_log al WHERE al.voter_id=v.voter_id AND al.action_type='CALL') last_call_at,(SELECT MAX(created_at) FROM activity_log al WHERE al.voter_id=v.voter_id AND al.action_type='TEXT') last_text_at
FROM voters v LEFT JOIN campaign_activity c ON c.voter_id=v.voter_id`;

async function api(req,env,u){
  const p=u.pathname;
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
    const x=where(u,u.searchParams.get("mode")==="text");
    const sql=u.searchParams.get("mode")==="text"?`SELECT COUNT(*) phone_count FROM voters v LEFT JOIN campaign_activity c ON c.voter_id=v.voter_id${x.sql}`:`SELECT
      COUNT(*) total_voters,
      SUM(CASE WHEN v.p26_voted=1 THEN 1 ELSE 0 END) primary_voters,
      COUNT(DISTINCT v.house_number||'|'||v.street||'|'||COALESCE(v.unit,'')) total_doors,
      COUNT(DISTINCT v.house_number||'|'||v.street) total_houses
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
    const d=await req.json(), allowed=["knock_lit","talked","supporter","follow_up","bad_phone","do_not_contact","intends_mail","intends_early","intends_polls","intends_no_vote","notes"];
    if(!d.voter_id || !allowed.includes(d.field)) return json({error:"bad request"},400);
    const value=d.field==="notes"?String(d.value??""):(d.value?1:0);if(value&&["intends_mail","intends_early","intends_polls","intends_no_vote"].includes(d.field))await env.DB.prepare("INSERT INTO campaign_activity(voter_id,updated_at) VALUES(?,CURRENT_TIMESTAMP) ON CONFLICT(voter_id) DO UPDATE SET intends_mail=0,intends_early=0,intends_polls=0,intends_no_vote=0,updated_at=CURRENT_TIMESTAMP").bind(d.voter_id).run();
    await env.DB.prepare(`INSERT INTO campaign_activity(voter_id,${d.field},updated_at) VALUES(?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(voter_id) DO UPDATE SET ${d.field}=excluded.${d.field},updated_at=CURRENT_TIMESTAMP`).bind(d.voter_id,value).run();
    await env.DB.prepare("INSERT INTO activity_log(voter_id,action_type,action_value) VALUES(?,?,?)").bind(d.voter_id,d.field.toUpperCase(),String(value)).run();
    return json({ok:true});
  }
  if(p==="/api/contact" && req.method==="POST"){const d=await req.json();if(!d.voter_id||!["CALL","TEXT"].includes(d.type))return json({error:"bad request"},400);await env.DB.prepare("INSERT INTO activity_log(voter_id,action_type,action_value,note) VALUES(?,?,?,?)").bind(d.voter_id,d.type,d.provider||"phone",d.type==="TEXT"?(d.message||""):null).run();return json({ok:true})}
  if(p==="/api/contact" && req.method==="PATCH"){const d=await req.json();if(!d.id||!d.voter_id||!["CALL","TEXT"].includes(d.type)||!/^\\d{4}-\\d{2}-\\d{2}$/.test(d.date||""))return json({error:"bad request"},400);await env.DB.prepare("UPDATE activity_log SET action_type=?,created_at=? WHERE id=? AND voter_id=? AND action_type IN ('CALL','TEXT')").bind(d.type,d.date+" 12:00:00",d.id,d.voter_id).run();return json({ok:true})}
  if(p==="/api/contact" && req.method==="DELETE"){const d=await req.json();await env.DB.prepare("DELETE FROM activity_log WHERE id=? AND voter_id=? AND action_type IN ('CALL','TEXT')").bind(d.id,d.voter_id).run();return json({ok:true})}
  if(p==="/api/contact-history"){const id=u.searchParams.get("voter_id");return json((await env.DB.prepare("SELECT id,action_type,action_value,note,created_at FROM activity_log WHERE voter_id=? AND action_type IN ('CALL','TEXT') ORDER BY created_at DESC,id DESC").bind(id).all()).results)}
  return json({error:"not found"},404);
}
function page(){
return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ward 10 Canvass 2026</title><style>
*{box-sizing:border-box}body{margin:0;font:14px system-ui;background:#f5f7fa;color:#172033}header{background:#0A1F44;color:white;padding:14px 16px}h1{font-size:20px;margin:0}.tabs,.filters,.summary{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:2px;padding:7px 8px;background:white;border-bottom:1px solid #ddd;white-space:nowrap;width:100%;box-sizing:border-box}.tabs button{font-weight:700}.active{background:#0A1F44!important;color:white}button,select,input{min-height:38px;border:1px solid #bbc3cf;border-radius:7px;background:white;padding:7px 10px}.filters{display:flex;flex-direction:column;align-items:stretch;gap:10px;padding:12px 16px;background:#fff}.filters .filterGroup{width:100%;display:flex;gap:6px;flex-wrap:wrap;align-items:center}.filters .filterLabel{width:100%}.streetSelect{width:100%;max-width:350px}.filters input{flex:1;min-width:160px}.filterGroup{display:flex;gap:6px;flex-wrap:wrap;align-items:center}.filterLabel{width:100%;font-size:12px;font-weight:700;color:#6b7b8f;text-transform:uppercase;letter-spacing:.05em}.filterBtn.selected{background:#e8f4ff;border-color:#1687e8;color:#0878d1;font-weight:800}.filterBtn{font-weight:700}.streetSelect{min-width:180px}.clearBtn{color:#0878d1;font-weight:800}.summary b{font-size:13px!important}.summary span{display:block;min-width:0;text-align:center;font-size:13px!important;white-space:nowrap}.content{padding:10px}.row{background:white;border:1px solid #dde2e8;border-radius:9px;margin:7px 0;padding:10px}.addr{font-weight:800}.name{font-size:16px;margin:0}.nameLine{display:flex;align-items:baseline;gap:6px;min-width:0}.addrName{display:flex;align-items:baseline;gap:8px;flex:1;min-width:0}.addrName .addr{font-size:15px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:43%}.addrName .name{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}.addrName .addr{flex-shrink:0}.addrName .name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.addrName .addr,.addrName .name{font-size:13px;overflow:hidden;text-overflow:ellipsis}.nameActions{display:flex;gap:3px;flex-shrink:0;margin-left:auto}.nameActions button{padding:1px 2px;min-width:28px;width:28px;height:28px}.nameActions .followBtn{padding:1px 2px;min-width:28px;width:28px;font-size:15px;line-height:1}.meta{color:#5d6878;font-size:12px;margin-top:4px}.detailLine{display:flex;align-items:center;gap:6px;margin-top:6px;min-width:0}.detailLine .meta{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.actions{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}.actions button.on,.nameActions button.on{background:#A6CE39!important;border-color:#789b1d!important;color:#0A1F44!important;box-shadow:inset 0 0 0 2px #789b1d}.street{display:grid;grid-template-columns:2fr repeat(5,1fr);gap:6px;align-items:center}.noteWrap{display:none;margin-top:6px}.noteWrap.open{display:block}.note{width:100%}.noteBtn{font-size:18px!important;padding:3px 7px!important}.danger.on{background:#ffd1d1}.toolbar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}@media(max-width:650px){.street{grid-template-columns:1.5fr repeat(2,1fr)}.street span:nth-child(n+4){font-size:11px}}

/* clean mobile layout */
body.canvassTab .precinctFilter{display:none!important}
.tabs{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:3px!important;padding:7px 8px!important}
.filters{display:block!important;padding:12px 16px!important;white-space:normal!important}
.filters .filterGroup{display:flex!important;width:100%!important;gap:6px!important;flex-wrap:wrap!important;align-items:center!important;margin:0 0 10px!important}
.filters .filterLabel{display:block!important;width:100%!important;margin:0 0 2px!important}
.filters .filterBtn{width:auto!important;min-width:58px!important;min-height:38px!important}.filters [data-filter="voted"]{flex-wrap:nowrap!important;gap:4px!important}.filters [data-filter="voted"] .filterBtn{min-width:0!important;flex:1 1 0!important;padding:6px 3px!important;font-size:12px!important}
.filters .streetSelect{display:block!important;width:100%!important;max-width:none!important}
.toolbar.canvassTools{display:flex!important;gap:5px!important;flex-wrap:nowrap!important;margin:0!important;padding:7px 0!important;overflow-x:auto!important}
.toolbar.canvassTools button{flex:0 0 auto!important;padding:6px 9px!important}
.searchRow{display:flex!important;gap:5px!important;padding:7px 0!important}.searchRow input{flex:1!important;min-width:0!important}
.summary{display:grid!important;grid-template-columns:repeat(4,minmax(0,1fr))!important;gap:2px!important;padding:7px 8px!important;white-space:nowrap!important}
.summary span,.summary b{font-size:13px!important}
.content{padding:8px!important}.content .row{padding:7px 10px 4px!important;margin:5px 0!important}
.nameLine{display:flex!important;min-width:0!important}.addrName{display:flex!important;align-items:baseline!important;gap:8px!important;width:100%!important;min-width:0!important}
.addrName .addr{font-size:12px!important;font-weight:800!important;max-width:45%!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
.addrName .name{font-size:12px!important;min-width:0!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
.voterDetail{display:flex!important;align-items:center!important;gap:5px!important;margin-top:2px!important;min-width:0!important;margin-bottom:0!important}
.voterDetail .meta{flex:1!important;min-width:0!important;font-size:12px!important;margin:0!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}
.nameActions{display:flex!important;gap:3px!important;flex:0 0 auto!important;margin-left:auto!important}
.nameActions button{width:28px!important;min-width:28px!important;height:28px!important;min-height:28px!important;padding:0!important}

body.canvassTab .precinctFilter{display:none!important}
.filters [data-filter="voted"]{display:grid!important;grid-template-columns:repeat(7,minmax(0,1fr))!important;gap:4px!important;width:100%!important}
.filters [data-filter="voted"] .filterLabel{grid-column:1/-1!important}
.filters [data-filter="voted"] .filterBtn{display:block!important;width:100%!important;min-width:0!important;height:38px!important;min-height:38px!important;padding:4px 1px!important;font-size:11px!important;line-height:1!important;overflow:hidden!important}
.row.primaryVoter{border-left:6px solid #dc3545!important;padding-left:5px!important}
.voteBadge{display:inline-block!important;padding:2px 5px!important;border-radius:5px!important;font-size:10px!important;font-weight:800!important;line-height:1.2!important;margin-left:4px!important}
.voteBadge.badgeEarly{background:#ffd84d!important;color:#3a2b00!important}
.voteBadge.badgeMail{background:#7b3fb5!important;color:#fff!important}
.row.g26Mail{box-shadow:inset 0 0 0 2px #7b3fb5!important;background:#fbf7ff!important}

/* outreach + compact campaign filter */
.filters{display:flex!important;flex-direction:row!important;flex-wrap:wrap!important;column-gap:6px!important}
.filters [data-filter="voted"],.filters .filterGroup:first-child{flex:0 0 100%!important}
.filters [data-filter="method"]{flex:1 1 calc(75% - 3px)!important;width:auto!important}
.filters [data-filter="supporter"]{flex:0 0 calc(25% - 3px)!important;width:auto!important;align-content:flex-end!important}
.filters [data-filter="supporter"] .filterLabel{visibility:hidden!important}
.filters [data-filter="supporter"] .filterBtn{width:100%!important;min-width:0!important}
#textTools{display:none;padding:10px 16px;background:#fff;border-bottom:1px solid #ddd}
#textTools .outreachLabel{font-weight:900;color:#d71920;font-size:13px;letter-spacing:.04em;margin-bottom:5px}
#provider{width:100%;background:#dfff00;border:2px solid #111;color:#111;font-weight:900;font-size:15px}
#message{width:100%;min-height:64px;margin-top:7px;padding:8px;border:1px solid #bbc3cf;border-radius:7px;font:14px system-ui}
#clearMessage{margin-top:5px;font-weight:800}
.supporterBtn.on{background:#d93636!important;color:#fff!important;border-color:#a51f1f!important}.earlyChoice.on{background:#ffd84d!important;color:#332800!important}.mailChoice.on{background:#7b3fb5!important;color:#fff!important}.pollsChoice.on{background:#39a852!important;color:#fff!important}.noChoice.on{background:#d93636!important;color:#fff!important}.supporterBtn.on{background:#d93636!important;color:#fff!important}.actions button{font-weight:800}.statusActions{display:flex!important;flex-wrap:nowrap!important;gap:3px!important;overflow-x:auto!important}.statusActions button{min-width:0!important;padding:5px 6px!important;white-space:nowrap!important;font-weight:800!important}.filters [data-filter="method"]{flex:1 1 auto!important}.filters [data-filter="supporter"]{flex:0 0 auto!important}.filters [data-filter="supporter"] .filterLabel{visibility:hidden!important}@media(max-width:650px){input,select,textarea{font-size:16px!important}.note{font-size:16px!important}#search{font-size:16px!important}#message{font-size:16px!important}}@media(max-width:650px){.toolbar.canvassTools,.searchRow{padding-left:12px!important;padding-right:12px!important}.summary{padding-left:12px!important;padding-right:12px!important}.summary span,.summary b{font-size:12px!important}.summary span{padding:2px 1px!important}}body:not(.canvassTab) .textAllActions{display:flex!important;flex-wrap:nowrap!important;gap:3px!important;overflow-x:auto!important;margin-top:7px!important;padding-bottom:2px!important}.textAllActions button{flex:0 1 auto!important;min-width:0!important;min-height:36px!important;padding:4px 6px!important;font-weight:800!important;white-space:nowrap!important}.textAllActions .contactIcon{width:38px!important;flex:0 0 38px!important;padding:3px!important;font-size:18px!important}.textAllActions .danger{width:36px!important;flex:0 0 36px!important;padding:3px!important}.textAllActions .earlyChoice{width:50px!important}.textAllActions .mailChoice{width:43px!important}.textAllActions .pollsChoice{width:45px!important}.textAllActions .noChoice{width:68px!important;font-size:11px!important}</style></head><body><header><h1>Ward 10 Canvass 2026</h1></header>
<div class="tabs"><button type="button" data-tab="canvass" class="active">Canvass</button><button type="button" data-tab="field">Field Plan</button><button type="button" data-tab="text">Text / Call</button><button type="button" data-tab="email">Email</button></div>
<div class="filters">
<div class="filterGroup"><span class="filterLabel">Street</span><select id="street" class="streetSelect"><option value="">All Streets</option></select></div>
<div class="filterGroup" data-filter="voted"><span class="filterLabel">Voted</span><button type="button" class="filterBtn" data-value="G26">G26</button><button type="button" class="filterBtn" data-value="P26">P26</button><button type="button" class="filterBtn" data-value="G24">G24</button><button type="button" class="filterBtn" data-value="P24">P24</button><button type="button" class="filterBtn" data-value="G22">G22</button><button type="button" class="filterBtn" data-value="P22">P22</button><button type="button" class="filterBtn" data-value="None">None</button></div>
<div class="filterGroup" data-filter="method"><span class="filterLabel">P/G 26 Method</span><button type="button" class="filterBtn" data-value="Mail">Mail</button><button type="button" class="filterBtn" data-value="Early">Early</button><button type="button" class="filterBtn" data-value="Polls">Polls</button></div>
<div class="filterGroup precinctFilter" data-filter="precinct"><span class="filterLabel">Precinct</span><button type="button" class="filterBtn" data-value="2827">2827</button><button type="button" class="filterBtn" data-value="2828">2828</button><button type="button" class="filterBtn" data-value="2832">2832</button><button type="button" class="filterBtn" data-value="2833">2833</button></div>
<div class="filterGroup" data-filter="supporter"><span class="filterLabel">Campaign</span><button type="button" class="filterBtn" data-value="1">Supporters</button></div>
<input type="hidden" id="voted"><input type="hidden" id="method"><input type="hidden" id="precinct"><input type="hidden" id="supporter">
</div>
<div class="toolbar canvassTools"><button type="button" id="collapseFiltersBtn">Collapse Filters</button><button type="button" class="sortBtn selected" data-dir="asc"># ↑</button><button type="button" class="sortBtn" data-dir="desc"># ↓</button><button type="button" class="parityBtn" data-parity="even">Even</button><button type="button" class="parityBtn" data-parity="odd">Odd</button></div>
<div class="searchRow"><input id="search" placeholder="Search name, address, phone, email"><button type="button" id="clearFiltersBtn" class="clearBtn">Clear</button></div>
<div id="textTools"><div class="outreachLabel">SELECT OUTREACH METHOD</div><select id="provider"><option value="phone">Phone</option><option value="quo">Quo</option><option value="google">Google Voice</option></select><textarea id="message" placeholder="Message to use for texts"></textarea><button type="button" id="clearMessage">Clear Message</button></div><div id="summary" class="summary"></div><main id="content" class="content"></main>
<script>
let tab="canvass"; const $=x=>document.querySelector(x), filters=["street","voted","method","precinct","supporter"];
async function meta(){let m=await getJSON("/api/meta");let street=$("#street");street.innerHTML='<option value="">All Streets</option>';m.streets.forEach(x=>{let o=document.createElement("option");o.value=x;o.textContent=x;street.appendChild(o)});return m}
function qs(){let p=new URLSearchParams;filters.forEach(x=>{let v=$("#"+x).value;if(v)p.set(x,v)});if($("#search").value)p.set("q",$("#search").value);if(window.houseDir)p.set("dir",window.houseDir);if(window.parity)p.set("parity",window.parity);return p}
function pickFilter(btn){let g=btn.closest("[data-filter]"),id=g.dataset.filter,input=$("#"+id),same=input.value===btn.dataset.value;g.querySelectorAll(".filterBtn").forEach(x=>x.classList.remove("selected"));input.value=same?"":btn.dataset.value;if(!same)btn.classList.add("selected");load()}
function clearFilters(){filters.forEach(x=>$("#"+x).value="");$("#search").value="";document.querySelectorAll(".filterBtn").forEach(x=>x.classList.remove("selected"));load()}
async function getJSON(url){let r=await fetch(url),z=await r.json();if(!r.ok||z.error)throw new Error(z.error||("Request failed "+r.status));return z}
async function load(){try{let p=qs();if(tab==="field")return await field(p);p.set("mode",tab);let [rows,s]=await Promise.all([getJSON("/api/voters?"+p),getJSON("/api/summary?"+(()=>{let z=qs();if(tab==="text")z.set("mode","text");return z})())]);$("#summary").innerHTML=tab==="text"?'<span style="grid-column:1/-1"><b>'+Number(s.phone_count||0)+'</b> Phone Numbers</span>':tab==="canvass"?'<span><b>'+Number(s.primary_voters||0)+'</b> Primary</span><span><b>'+Number(s.total_voters||0)+'</b> Voters</span><span><b>'+Number(s.total_doors||0)+'</b> Doors</span><span><b>'+Number(s.total_houses||0)+'</b> Houses</span>':"";if(!Array.isArray(rows))throw new Error("Voter results were not returned as a list");$("#content").innerHTML=rows.length?rows.map(card).join(""):"No results for these filters."}catch(e){$("#content").innerHTML='<div class="row"><b>Load error</b><div class="meta">'+esc(e.message)+'</div></div>';console.error(e)}}
function card(v){let contact=tab==="text"?'<div class="actions textAllActions"><button type="button" class="contactIcon" aria-label="Text" title="Text" data-go="sms" data-voter="'+esc(v.voter_id)+'" data-contact="'+esc(v.phone||"")+'">💬</button><button type="button" class="contactIcon" aria-label="Call" title="Call" data-go="tel" data-voter="'+esc(v.voter_id)+'" data-contact="'+esc(v.phone||"")+'">📞</button>'+btn(v,"bad_phone","📵","danger compactStatus")+btn(v,"do_not_contact","📵","danger compactStatus")+btn(v,"intends_early","Early","earlyChoice compactStatus")+btn(v,"intends_mail","Mail","mailChoice compactStatus")+btn(v,"intends_polls","Polls","pollsChoice compactStatus")+btn(v,"intends_no_vote","NO VOTE","noChoice compactStatus")+'</div>':tab==="email"?'<div class="actions"><button type="button" data-go="mailto" data-contact="'+esc(v.email||"")+'">Email</button></div>':"";
let badges="";if(v.p26_voted&&v.p26_method==="Early")badges+='<span class="voteBadge badgeEarly">P26 Early</span>';if(v.p26_voted&&v.p26_method==="Mail")badges+='<span class="voteBadge badgeMail">P26 Mail</span>';if(v.g26_mail_record)badges+='<span class="voteBadge badgeMail">G26 Mail</span>';
let rowClass="row"+(v.p26_voted?" primaryVoter":"")+(v.g26_mail_record?" g26Mail":"");
return '<div class="'+rowClass+'"><div class="nameLine"><div class="addrName"><div class="addr">'+esc(v.house_number+" "+v.street+(v.unit?" · "+v.unit:""))+'</div><div class="name">'+esc(v.first_name+" "+v.last_name)+'</div></div></div><div class="voterDetail"><div class="meta">'+esc(v.precinct)+badges+(v.phone?" · "+esc(v.phone):"")+'</div><div class="nameActions">'+btn(v,"knock_lit",v.knock_lit?"✅":"☑️","knockBtn")+btn(v,"talked","🗣️","talkBtn")+btn(v,"supporter","⭐","supporterBtn")+btn(v,"follow_up","❗","followBtn")+'<button type="button" class="noteBtn" data-action="note" data-voter="'+esc(v.voter_id)+'">📝</button>'+'</div></div>'+contact<div class="noteWrap" data-note-wrap="'+esc(v.voter_id)+'"><input class="note" data-voter="'+esc(v.voter_id)+'" value="'+esc(v.campaign_notes||"")+'" placeholder="Notes"></div></div>'}
function btn(v,f,l,c=""){return '<button type="button" class="'+c+(v[f]?" on":"")+'" data-action="toggle" data-voter="'+esc(v.voter_id)+'" data-field="'+esc(f)+'">'+l+'</button>'}
async function toggle(el,id,f){let value=!el.classList.contains("on");await setv(id,f,value);el.classList.toggle("on",value)}
async function setv(id,field,value){let r=await fetch("/api/activity",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({voter_id:id,field,value})});let z=await r.json();if(!r.ok||z.error)throw new Error(z.error||("Save failed "+r.status));return z}
async function field(p){p.set("sort","complete");p.set("dir","desc");let rows=await getJSON("/api/field-plan?"+p);$("#summary").innerHTML="";$("#content").innerHTML='<div class="toolbar"><button type="button" data-fieldsort="complete">% Complete</button><button type="button" data-fieldsort="primary">P26 Voters</button><button type="button" data-fieldsort="all">All Voters</button><button type="button" data-fieldsort="none">None Voters</button></div>'+rows.map(x=>'<div class="row street"><b>'+esc(x.street)+'</b><span>'+x.percent_complete+'% complete</span><span>'+x.primary_voters+' P26</span><span>'+x.all_voters+' voters</span><span>'+x.total_doors+' doors</span><span>'+x.total_houses+' houses</span></div>').join("")}
async function fieldSort(s){let p=qs();p.set("sort",s);p.set("dir","desc");let rows=await getJSON("/api/field-plan?"+p);$("#content").querySelectorAll(".row").forEach(x=>x.remove());$("#content").insertAdjacentHTML("beforeend",rows.map(x=>'<div class="row street"><b>'+esc(x.street)+'</b><span>'+x.percent_complete+'% complete</span><span>'+x.primary_voters+' P26</span><span>'+x.all_voters+' voters</span><span>'+x.total_doors+' doors</span><span>'+x.total_houses+' houses</span></div>').join(""))}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function switchTab(next,el){document.querySelectorAll(".tabs button").forEach(x=>x.classList.remove("active"));el.classList.add("active");tab=next;document.body.classList.toggle("canvassTab",tab==="canvass");document.querySelector("#textTools").style.display=tab==="text"?"block":"none";document.querySelector(".canvassTools").style.display=tab==="canvass"?"flex":"none";load()}
document.querySelectorAll(".tabs button").forEach(b=>b.addEventListener("click",()=>switchTab(b.dataset.tab,b)));
document.querySelectorAll(".filterBtn").forEach(b=>b.addEventListener("click",()=>pickFilter(b)));
$("#clearFiltersBtn").addEventListener("click",clearFilters);$("#clearMessage").addEventListener("click",()=>{$("#message").value=""});
$("#street").addEventListener("change",load);
window.houseDir="asc";window.parity="";
document.querySelectorAll(".sortBtn").forEach(b=>b.addEventListener("click",()=>{window.houseDir=b.dataset.dir;document.querySelectorAll(".sortBtn").forEach(x=>x.classList.toggle("selected",x===b));load()}));
document.querySelectorAll(".parityBtn").forEach(b=>b.addEventListener("click",()=>{window.parity=window.parity===b.dataset.parity?"":b.dataset.parity;document.querySelectorAll(".parityBtn").forEach(x=>x.classList.toggle("selected",x.dataset.parity===window.parity));load()}));
$("#collapseFiltersBtn").addEventListener("click",()=>{let box=document.querySelector(".filters"),hidden=box.style.display==="none";box.style.display=hidden?"flex":"none";$("#collapseFiltersBtn").textContent=hidden?"Collapse Filters":"Show Filters"});let t;$("#search").addEventListener("input",()=>{clearTimeout(t);t=setTimeout(load,250)});
document.addEventListener("click",async e=>{let g=e.target.closest("[data-go]");if(g){location.href=g.dataset.go+":"+g.dataset.contact;return}let n=e.target.closest('[data-action="note"]');if(n){let w=document.querySelector('[data-note-wrap="'+CSS.escape(n.dataset.voter)+'"]');if(w){w.classList.toggle("open");if(w.classList.contains("open"))w.querySelector(".note")?.focus()}return}let a=e.target.closest('[data-action="toggle"]');if(a){await toggle(a,a.dataset.voter,a.dataset.field);return}let fs=e.target.closest("[data-fieldsort]");if(fs){await fieldSort(fs.dataset.fieldsort)}});
document.addEventListener("change",e=>{if(e.target.matches(".note"))setv(e.target.dataset.voter,"notes",e.target.value)});
(async()=>{try{$("#content").textContent="Loading voters…";await meta();await load()}catch(e){$("#content").innerHTML='<div class="row"><b>App load error</b><div class="meta">'+esc(e.message)+'</div></div>';console.error(e)}})();
</script></body></html>`}
export default {async fetch(req,env){const u=new URL(req.url);try{if(u.pathname.startsWith("/api/"))return await api(req,env,u);return new Response(page(),{headers:{"content-type":"text/html;charset=utf-8","cache-control":"no-store, no-cache, must-revalidate","pragma":"no-cache"}})}catch(e){return json({error:String(e?.message||e)},500)}}};

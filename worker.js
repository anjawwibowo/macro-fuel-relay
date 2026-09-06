const SOURCES={
  bi_rate:"https://www.bi.go.id/id/statistik/indikator/bi-rate.aspx",
  us10y:"https://home.treasury.gov/resource-center/data-chart-center/interest-rates/TextView?type=daily_treasury_yield_curve&field_tdr_date_value=2026",
  bls_cpi:"https://download.bls.gov/pub/time.series/CU/cu.data.1.AllItems",
  bls_employment:"https://download.bls.gov/pub/time.series/CE/ce.data.00a.TotalNonfarm.Employment",
  fomc:"https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
  jisdor:"https://www.bi.go.id/biwebservice/wskursbi.asmx/getSubKursJisdor1",
  srbi:"https://www.bi.go.id/id/fungsi-utama/moneter/operasi-moneter/Default.aspx"
};
const ROUTES={
  "/fuel/bi_rate":"bi_rate","/fuel/us10y":"us10y","/fuel/bls_cpi":"bls_cpi",
  "/fuel/bls_employment":"bls_employment","/fuel/fomc":"fomc",
  "/fuel/jisdor":"jisdor","/fuel/srbi":"srbi"
};
async function sha256(s){
  const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");
}
export default{async fetch(req,env){
  const u=new URL(req.url);
  if(req.method!=="GET")return new Response("Method Not Allowed",{status:405});
  if(u.pathname==="/health")return Response.json({ok:true,service:"macro-fuel-relay",version:"0.2.2"});
  const id=ROUTES[u.pathname];
  if(!id)return Response.json({ok:false,error:"route_not_allowed"},{status:404});
  if(env.RELAY_TOKEN&&req.headers.get("Authorization")!==`Bearer ${env.RELAY_TOKEN}`)
    return Response.json({ok:false,error:"unauthorized"},{status:401});
  const url=SOURCES[id],t=new Date().toISOString();
  try{
    const r=await fetch(url,{headers:{"User-Agent":"TRADER-SOTOY-MACRO-FUEL-RELAY/0.2.2"}});
    const body=await r.text();
    return Response.json({
      ok:r.ok,source_id:id,dataset_id:id,source_url:url,status_code:r.status,
      acquired_at:t,body_bytes:new TextEncoder().encode(body).length,
      body_sha256:await sha256(body),content_type:r.headers.get("content-type")||"",body
    },{status:r.ok?200:502});
  }catch(e){
    return Response.json({ok:false,source_id:id,dataset_id:id,source_url:url,
      acquired_at:t,error:"upstream_fetch_failed"},{status:502});
  }
}};

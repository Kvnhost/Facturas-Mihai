const TABLES = new Set(["clients","invoices","invoice_items","company_settings","audit_log"]);
const COLS = {
 clients:new Set(["id","name","tax_id","address","postal_code","city","province","created_by","created_at","updated_at"]),
 invoices:new Set(["id","invoice_number","client_id","issue_date","due_date","payment_method","status","description","base_amount","vat_rate","vat_amount","total_amount","notes","bank_holder","bank_iban","created_by","created_at","updated_at"]),
 invoice_items:new Set(["id","invoice_id","description","quantity","unit_price","vat_rate","line_total","vat_amount","sort_order"]),
 company_settings:new Set(["id","company_name","legal_name","owner_name","tax_id","address","additional_address","postal_code","city","province","phone","email","website","logo_url","bank_holder","bank_iban","footer_text","settings_json","updated_at"]),
 audit_log:new Set(["id","user_id","action","entity_type","entity_id","details","created_at"])
};
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json; charset=utf-8","cache-control":"no-store",...headers}});
const cookieName="rgl_session";
function cookie(req){const s=req.headers.get("Cookie")||"";return s.split(";").map(x=>x.trim()).find(x=>x.startsWith(cookieName+"="))?.split("=")[1]||"";}
function safeEqual(a,b){if(a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0;}
async function hashPassword(p,salt){const enc=new TextEncoder();const key=await crypto.subtle.importKey("raw",enc.encode(p),"PBKDF2",false,["deriveBits"]);const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt:enc.encode(salt),iterations:180000,hash:"SHA-256"},key,256);return [...new Uint8Array(bits)].map(x=>x.toString(16).padStart(2,"0")).join("");}
async function sessionUser(req,env){const id=cookie(req);if(!id)return null;const row=await env.DB.prepare("SELECT id FROM sessions WHERE id=? AND expires_at>?").bind(id,Math.floor(Date.now()/1000)).first();return row?{id:"admin",email:env.ADMIN_EMAIL}:null;}
async function api(req,env){
 const url=new URL(req.url),path=url.pathname;
 if(req.method==="OPTIONS")return new Response(null,{status:204,headers:{"Access-Control-Allow-Origin":url.origin,"Access-Control-Allow-Credentials":"true","Access-Control-Allow-Headers":"content-type","Access-Control-Allow-Methods":"GET,POST,OPTIONS"}});
 if(path==="/api/health")return json({ok:true,service:"RGL Mihai API",database:"D1"});
 if(path==="/api/login"&&req.method==="POST"){
  const b=await req.json();if(!env.ADMIN_EMAIL||!env.ADMIN_PASSWORD) return json({error:"Falta configurar ADMIN_EMAIL y ADMIN_PASSWORD en los secretos de Workers."},503);
  if(!safeEqual(String(b.email||"").toLowerCase(),String(env.ADMIN_EMAIL).toLowerCase())||!safeEqual(String(b.password||""),String(env.ADMIN_PASSWORD)))return json({error:"Correo o contraseña incorrectos."},401);
  const id=crypto.randomUUID(),now=Math.floor(Date.now()/1000);await env.DB.prepare("INSERT INTO sessions(id,expires_at,created_at) VALUES(?,?,?)").bind(id,now+60*60*24*14,now).run();
  return json({user:{id:"admin",email:env.ADMIN_EMAIL}},200,{"Set-Cookie":`${cookieName}=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=1209600`});
 }
 if(path==="/api/logout"&&req.method==="POST"){const id=cookie(req);if(id)await env.DB.prepare("DELETE FROM sessions WHERE id=?").bind(id).run();return json({ok:true},200,{"Set-Cookie":`${cookieName}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`});}
 if(path==="/api/me"){return json({user:await sessionUser(req,env)});}
 if(path==="/api/query"&&req.method==="POST"){
  const user=await sessionUser(req,env);if(!user)return json({error:"Sesión caducada. Vuelve a iniciar sesión."},401);
  const b=await req.json(),t=b.table;if(!TABLES.has(t))return json({error:"Tabla no permitida."},400);
  const allowed=COLS[t],action=b.action||"select",filters=Array.isArray(b.filters)?b.filters:[];
  for(const f of filters)if(!allowed.has(f.column)||f.op!=="eq")return json({error:"Filtro no permitido."},400);
  const where=filters.length?" WHERE "+filters.map(f=>`${f.column} = ?`).join(" AND "):"";
  const vals=filters.map(f=>f.value);
  if(action==="select"){
   if(b.order&&(!allowed.has(b.order.column)))return json({error:"Orden no permitido."},400);
   let sql=`SELECT * FROM ${t}${where}`;if(b.order)sql+=` ORDER BY ${b.order.column} ${b.order.ascending===false?"DESC":"ASC"}`;
   sql+=" LIMIT ?";const rows=await env.DB.prepare(sql).bind(...vals,Math.min(Math.max(Number(b.limit)||100,1),1000)).all();
   let data=rows.results||[];
   if(t==="invoices"&&String(b.columns||"").includes("clients(*)")){data=await Promise.all(data.map(async r=>({...r,clients:await env.DB.prepare("SELECT * FROM clients WHERE id=?").bind(r.client_id).first()})));}
   return json({data});
  }
  if(action==="insert"){
   const rows=Array.isArray(b.payload)?b.payload:[b.payload];if(!rows.length)return json({data:[]});
   const results=[];
   for(const row of rows){if(!row||Object.keys(row).some(k=>!allowed.has(k)))return json({error:"Campo no permitido."},400);
    const keys=Object.keys(row);if(!keys.length)return json({error:"No hay datos."},400);
    const sql=`INSERT INTO ${t} (${keys.join(",")}) VALUES (${keys.map(()=>"?").join(",")})`;
    const r=await env.DB.prepare(sql).bind(...keys.map(k=>["details","settings_json"].includes(k)&&row[k]!==null&&typeof row[k]==="object"?JSON.stringify(row[k]):row[k])).run();const id=r.meta?.last_row_id;
    results.push(id?await env.DB.prepare(`SELECT * FROM ${t} WHERE id=?`).bind(id).first():null);
   }return json({data:Array.isArray(b.payload)?results:results[0]});
  }
  if(action==="update"){
   const row=b.payload||{};const keys=Object.keys(row);if(!keys.length||keys.some(k=>!allowed.has(k)))return json({error:"Campos de actualización no válidos."},400);
   if(!filters.length)return json({error:"Actualización sin filtro bloqueada."},400);
   await env.DB.prepare(`UPDATE ${t} SET ${keys.map(k=>k+"=?").join(",")} ${where}`).bind(...keys.map(k=>["details","settings_json"].includes(k)&&row[k]!==null&&typeof row[k]==="object"?JSON.stringify(row[k]):row[k]),...vals).run();
   const rows=await env.DB.prepare(`SELECT * FROM ${t}${where} LIMIT 1000`).bind(...vals).all();return json({data:rows.results?.[0]||null});
  }
  if(action==="delete"){
   if(!filters.length)return json({error:"Borrado sin filtro bloqueado."},400);
   if(t==="clients"){const f=filters.find(x=>x.column==="id");if(f){const linked=await env.DB.prepare("SELECT id FROM invoices WHERE client_id=? LIMIT 1").bind(f.value).first();if(linked)return json({error:"No se puede borrar un cliente con facturas vinculadas."},409);}}
   await env.DB.prepare(`DELETE FROM ${t}${where}`).bind(...vals).run();return json({data:null});
  }
  return json({error:"Operación no permitida."},400);
 }
 return null;
}
export default {async fetch(req,env,ctx){
 const url=new URL(req.url);if(url.pathname.startsWith("/api/")){try{return (await api(req,env))||json({error:"No encontrado"},404);}catch(e){return json({error:e.message||"Error interno"},500);}}
 return env.ASSETS.fetch(req);
}};

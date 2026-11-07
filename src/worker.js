const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};
const json = (data, status=200) => new Response(JSON.stringify(data), {status, headers:corsHeaders});
const uid = () => crypto.randomUUID();
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
async function sign(value, secret) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), {name:"HMAC",hash:"SHA-256"}, false, ["sign"]);
  return b64(await crypto.subtle.sign("HMAC", key, enc.encode(value))).replaceAll("+","-").replaceAll("/","_").replaceAll("=","");
}
async function authorized(request, env) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i,"") || "";
  if (!token || !env.SESSION_SECRET) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return false;
  const expected = await sign(payload, env.SESSION_SECRET);
  if (signature !== expected) return false;
  try { const data = JSON.parse(atob(payload)); return data.exp > Date.now(); } catch { return false; }
}
async function route(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (request.method === "OPTIONS") return new Response(null,{headers:corsHeaders});
  if (path === "/api/health") return json({ok:true, service:"RGL MIHAI API", database:!!env.DB});
  if (path === "/api/login" && request.method === "POST") {
    if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return json({error:"Faltan los secretos ADMIN_PASSWORD o SESSION_SECRET en Cloudflare."},500);
    const body = await request.json().catch(()=>({}));
    if (typeof body.password !== "string" || body.password !== env.ADMIN_PASSWORD) return json({error:"Contraseña incorrecta."},401);
    const payload = btoa(JSON.stringify({exp:Date.now()+8*60*60*1000}));
    return json({token:payload+"."+await sign(payload,env.SESSION_SECRET),expiresIn:28800});
  }
  if (!path.startsWith("/api/")) return env.ASSETS.fetch(request);
  if (!(await authorized(request,env))) return json({error:"Sesión no válida. Vuelve a iniciar sesión."},401);
  try {
    if (path === "/api/clients" && request.method === "GET") {
      const {results=[]}=await env.DB.prepare("SELECT * FROM clients ORDER BY name").all(); return json(results);
    }
    if (path === "/api/clients" && request.method === "POST") {
      const b=await request.json(); if(!b.name?.trim()) return json({error:"El nombre del cliente es obligatorio."},400);
      const id=uid();
      await env.DB.prepare(`INSERT INTO clients (id,name,tax_id,address,postal_code,city,province,email,phone) VALUES (?,?,?,?,?,?,?,?,?)`)
        .bind(id,b.name,b.tax_id||"",b.address||"",b.postal_code||"",b.city||"",b.province||"",b.email||"",b.phone||"").run();
      return json({id,ok:true},201);
    }
    if (path === "/api/invoices" && request.method === "GET") {
      const {results=[]}=await env.DB.prepare(`SELECT i.*, c.name AS client_name FROM invoices i LEFT JOIN clients c ON c.id=i.client_id ORDER BY i.invoice_number DESC`).all();
      return json(results);
    }
    if (path === "/api/invoices" && request.method === "POST") {
      const b=await request.json();
      if(!b.issue_date || !Array.isArray(b.items) || !b.items.length) return json({error:"Indica fecha y al menos una línea de factura."},400);
      const items=b.items.map(x=>({description:String(x.description||"").trim(),quantity:Number(x.quantity)||1,unit_price:Number(x.unit_price)||0,vat_rate:Number(x.vat_rate??21)}));
      if(items.some(x=>!x.description)) return json({error:"Todas las líneas deben tener concepto."},400);
      const base=items.reduce((s,x)=>s+x.quantity*x.unit_price,0);
      const vat=items.reduce((s,x)=>s+x.quantity*x.unit_price*x.vat_rate/100,0);
      const total=base+vat, id=uid();
      const max=await env.DB.prepare("SELECT COALESCE(MAX(invoice_number),0)+1 AS n FROM invoices").first();
      const number=Number(max?.n||1);
      await env.DB.prepare(`INSERT INTO invoices (id,invoice_number,client_id,issue_date,due_date,payment_method,status,description,base_amount,vat_rate,vat_amount,total_amount,notes,bank_holder,bank_iban) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .bind(id,number,b.client_id||null,b.issue_date,b.due_date||"",b.payment_method||"",b.status||"issued",items.map(x=>x.description).join("; "),base,21,vat,total,b.notes||"",b.bank_holder||"",b.bank_iban||"").run();
      for(const item of items) await env.DB.prepare("INSERT INTO invoice_items (id,invoice_id,description,quantity,unit_price,vat_rate,line_total) VALUES (?,?,?,?,?,?,?)")
        .bind(uid(),id,item.description,item.quantity,item.unit_price,item.vat_rate,item.quantity*item.unit_price*(1+item.vat_rate/100)).run();
      return json({ok:true,id,invoice_number:number,base_amount:base,vat_amount:vat,total_amount:total},201);
    }
    const match=path.match(/^\\/api\\/invoices\\/([^/]+)$/);
    if(match && request.method==="GET") {
      const invoice=await env.DB.prepare("SELECT i.*,c.name AS client_name,c.tax_id,c.address,c.postal_code,c.city,c.province FROM invoices i LEFT JOIN clients c ON c.id=i.client_id WHERE i.id=?").bind(match[1]).first();
      if(!invoice) return json({error:"Factura no encontrada."},404);
      const {results=[]}=await env.DB.prepare("SELECT * FROM invoice_items WHERE invoice_id=?").bind(match[1]).all();
      return json({...invoice,items:results});
    }
    if(match && request.method==="DELETE") {
      await env.DB.prepare("DELETE FROM invoice_items WHERE invoice_id=?").bind(match[1]).run();
      await env.DB.prepare("DELETE FROM invoices WHERE id=?").bind(match[1]).run(); return json({ok:true});
    }
    return json({error:"Endpoint no encontrado",path},404);
  } catch(e) { return json({error:"Error interno de la API",detail:String(e?.message||e)},500); }
}
export default { async fetch(request,env) { return route(request,env); } };

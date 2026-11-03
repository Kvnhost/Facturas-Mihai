export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Cabeceras CORS para permitir la comunicación con el frontend
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Enrutamiento de la API
      if (path.startsWith("/api/")) {
        return await handleApi(request, env, path, corsHeaders);
      }

      // Servir assets estáticos mediante el binding de Cloudflare Pages/Assets
      return await env.ASSETS.fetch(request);
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }
};

async function handleApi(request, env, path, corsHeaders) {
  const method = request.method;

  // Gestión de Clientes
  if (path === "/api/clients") {
    if (method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM clients ORDER BY id DESC").all();
      return Response.json(results, { headers: corsHeaders });
    }
    if (method === "POST") {
      const data = await request.json();
      const { name, nif, address, phone, email } = data;
      const res = await env.DB.prepare(
        "INSERT INTO clients (name, nif, address, phone, email) VALUES (?, ?, ?, ?, ?)"
      ).bind(name, nif, address, phone, email).run();
      return Response.json({ success: true, id: res.meta.last_row_id }, { headers: corsHeaders });
    }
  }

  // Gestión de Facturas
  if (path === "/api/invoices") {
    if (method === "GET") {
      const { results } = await env.DB.prepare("SELECT * FROM invoices ORDER BY id DESC").all();
      return Response.json(results, { headers: corsHeaders });
    }
    if (method === "POST") {
      const data = await request.json();
      const { number, date, client_name, client_nif, client_address, subtotal, vat, total, items, notes } = data;
      const res = await env.DB.prepare(
        "INSERT INTO invoices (number, date, client_name, client_nif, client_address, subtotal, vat, total, items, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(number, date, client_name, client_nif, client_address, subtotal, vat, total, JSON.stringify(items), notes).run();
      return Response.json({ success: true, id: res.meta.last_row_id }, { headers: corsHeaders });
    }
  }

  return new Response(JSON.stringify({ error: "Endpoint no encontrado" }), {
    status: 404,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

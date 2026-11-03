
/*
 * ============================================================
 * RGL MIHAI - CLOUDFLARE WORKER
 * Backend principal de facturación
 * Cloudflare Workers + D1 + Assets
 * ============================================================
 */

const TABLES = new Set([
  "clients",
  "invoices",
  "invoice_items",
  "company_settings",
  "audit_log"
]);

const COLS = {
  clients: new Set([
    "id", "name", "tax_id", "address", "postal_code",
    "city", "province", "created_by", "created_at", "updated_at"
  ]),

  invoices: new Set([
    "id", "invoice_number", "client_id", "issue_date",
    "due_date", "payment_method", "status", "description",
    "base_amount", "vat_rate", "vat_amount", "total_amount",
    "notes", "bank_holder", "bank_iban", "created_by",
    "created_at", "updated_at"
  ]),

  invoice_items: new Set([
    "id", "invoice_id", "description", "quantity",
    "unit_price", "vat_rate", "line_total", "vat_amount",
    "sort_order"
  ]),

  company_settings: new Set([
    "id", "company_name", "legal_name", "owner_name",
    "tax_id", "address", "additional_address",
    "postal_code", "city", "province", "phone",
    "email", "website", "logo_url", "bank_holder",
    "bank_iban", "footer_text", "settings_json",
    "updated_at"
  ]),

  audit_log: new Set([
    "id", "user_id", "action", "entity_type",
    "entity_id", "details", "created_at"
  ])
};

const COOKIE_NAME = "rgl_session";
const SESSION_DURATION = 60 * 60 * 24 * 14;
const MAX_LIMIT = 1000;
const MAX_BODY_SIZE = 1024 * 1024;

/* ============================================================
   RESPUESTAS
============================================================ */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store, private",
      "X-Content-Type-Options": "nosniff",
      ...headers
    }
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

/* ============================================================
   SEGURIDAD
============================================================ */

function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a));
  const y = new TextEncoder().encode(String(b));

  let diff = x.length ^ y.length;
  const length = Math.max(x.length, y.length);

  for (let i = 0; i < length; i++) {
    diff |= (x[i] || 0) ^ (y[i] || 0);
  }

  return diff === 0;
}

function getCookie(req) {
  const cookies = req.headers.get("Cookie") || "";

  const entry = cookies
    .split(";")
    .map(value => value.trim())
    .find(value => value.startsWith(COOKIE_NAME + "="));

  return entry ? entry.slice(COOKIE_NAME.length + 1) : "";
}

function sessionCookie(id) {
  return `${COOKIE_NAME}=${id}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSION_DURATION}`;
}

function expiredCookie() {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
}

async function sessionUser(req, env) {
  const id = getCookie(req);

  if (!id || !env.DB) return null;

  const now = Math.floor(Date.now() / 1000);

  const session = await env.DB.prepare(
    "SELECT id FROM sessions WHERE id = ? AND expires_at > ?"
  )
    .bind(id, now)
    .first();

  if (!session) return null;

  return {
    id: "admin",
    email: env.ADMIN_EMAIL
  };
}

/* ============================================================
   VALIDACIÓN DE PETICIONES
============================================================ */

async function readBody(req) {
  const contentLength = Number(req.headers.get("Content-Length") || 0);

  if (contentLength > MAX_BODY_SIZE) {
    throw new Error("La petición es demasiado grande.");
  }

  const text = await req.text();

  if (text.length > MAX_BODY_SIZE) {
    throw new Error("La petición es demasiado grande.");
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error("El formato de los datos enviados no es válido.");
  }
}

function normalizeValue(column, value) {
  if (
    ["details", "settings_json"].includes(column) &&
    value !== null &&
    typeof value === "object"
  ) {
    return JSON.stringify(value);
  }

  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }

  return value;
}

function validTable(table) {
  return typeof table === "string" && TABLES.has(table);
}

function validFilters(filters, allowed) {
  if (!Array.isArray(filters)) return false;

  return filters.every(filter =>
    filter &&
    allowed.has(filter.column) &&
    filter.op === "eq"
  );
}

/* ============================================================
   AUTENTICACIÓN
============================================================ */

async function login(req, env) {
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    return error(
      "Falta configurar ADMIN_EMAIL y ADMIN_PASSWORD en Cloudflare Workers.",
      503
    );
  }

  const body = await readBody(req);

  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");

  const validEmail = safeEqual(
    email,
    String(env.ADMIN_EMAIL).trim().toLowerCase()
  );

  const validPassword = safeEqual(
    password,
    String(env.ADMIN_PASSWORD)
  );

  if (!validEmail || !validPassword) {
    return error("Correo o contraseña incorrectos.", 401);
  }

  const now = Math.floor(Date.now() / 1000);
  const id = crypto.randomUUID();

  await env.DB.prepare(
    "INSERT INTO sessions (id, expires_at, created_at) VALUES (?, ?, ?)"
  )
    .bind(id, now + SESSION_DURATION, now)
    .run();

  return json(
    {
      user: {
        id: "admin",
        email: env.ADMIN_EMAIL
      }
    },
    200,
    {
      "Set-Cookie": sessionCookie(id)
    }
  );
}

async function logout(req, env) {
  const id = getCookie(req);

  if (id) {
    await env.DB.prepare(
      "DELETE FROM sessions WHERE id = ?"
    )
      .bind(id)
      .run();
  }

  return json(
    { ok: true },
    200,
    {
      "Set-Cookie": expiredCookie()
    }
  );
}

/* ============================================================
   CONSULTAS SELECT
============================================================ */

function parseColumns(columns, table) {
  const value = String(columns || "*").trim();

  if (value === "*") return null;

  const selected = value
    .split(",")
    .map(column => column.trim())
    .filter(Boolean);

  const result = [];

  for (const column of selected) {
    if (column === "clients(*)" && table === "invoices") {
      continue;
    }

    if (!COLS[table].has(column)) {
      throw new Error(`Columna no permitida: ${column}`);
    }

    result.push(column);
  }

  return result.length ? result : null;
}

async function selectQuery(env, body, table, filters) {
  const allowed = COLS[table];

  let sql = "SELECT ";

  const columns = parseColumns(body.columns, table);

  sql += columns
    ? columns.join(", ")
    : "*";

  sql += ` FROM ${table}`;

  const where = filters.length
    ? " WHERE " + filters.map(f => `${f.column} = ?`).join(" AND ")
    : "";

  sql += where;

  const order = body.order;

  if (order) {
    if (
      !order ||
      !allowed.has(order.column)
    ) {
      return error("Orden de consulta no permitido.", 400);
    }

    sql += ` ORDER BY ${order.column} ${
      order.ascending === false ? "DESC" : "ASC"
    }`;
  }

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.floor(Number(body.limit) || 100))
  );

  sql += " LIMIT ?";

  const result = await env.DB.prepare(sql)
    .bind(
      ...filters.map(f => normalizeValue(f.column, f.value)),
      limit
    )
    .all();

  let data = result.results || [];

  // Compatibilidad con la relación invoices -> clients.
  if (
    table === "invoices" &&
    String(body.columns || "").includes("clients(*)")
  ) {
    data = await Promise.all(
      data.map(async invoice => {
        const client = await env.DB.prepare(
          "SELECT * FROM clients WHERE id = ?"
        )
          .bind(invoice.client_id)
          .first();

        return {
          ...invoice,
          clients: client || null
        };
      })
    );
  }

  return json({ data });
}

/* ============================================================
   INSERT
============================================================ */

async function insertQuery(env, body, table) {
  const allowed = COLS[table];

  const rows = Array.isArray(body.payload)
    ? body.payload
    : [body.payload];

  if (!rows.length || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
    return error("No hay datos válidos para guardar.", 400);
  }

  const results = [];

  for (const row of rows) {
    const keys = Object.keys(row);

    if (!keys.length) {
      return error("No hay datos para guardar.", 400);
    }

    if (keys.some(key => !allowed.has(key))) {
      return error("Se ha enviado un campo no permitido.", 400);
    }

    const sql = `
      INSERT INTO ${table} (${keys.join(", ")})
      VALUES (${keys.map(() => "?").join(", ")})
      RETURNING *
    `;

    const result = await env.DB.prepare(sql)
      .bind(...keys.map(key => normalizeValue(key, row[key])))
      .all();

    results.push(result.results?.[0] || null);
  }

  return json({
    data: Array.isArray(body.payload)
      ? results
      : results[0]
  });
}

/* ============================================================
   UPDATE
============================================================ */

async function updateQuery(env, body, table, filters) {
  const allowed = COLS[table];
  const row = body.payload;

  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return error("Los datos de actualización no son válidos.", 400);
  }

  const keys = Object.keys(row);

  if (!keys.length || keys.some(key => !allowed.has(key))) {
    return error("Campos de actualización no válidos.", 400);
  }

  if (!filters.length) {
    return error("Actualización sin filtro bloqueada.", 400);
  }

  const where = filters
    .map(f => `${f.column} = ?`)
    .join(" AND ");

  const sql = `
    UPDATE ${table}
    SET ${keys.map(key => `${key} = ?`).join(", ")}
    WHERE ${where}
    RETURNING *
  `;

  const result = await env.DB.prepare(sql)
    .bind(
      ...keys.map(key => normalizeValue(key, row[key])),
      ...filters.map(f => normalizeValue(f.column, f.value))
    )
    .all();

  const rows = result.results || [];

  return json({
    data: rows[0] || null
  });
}

/* ============================================================
   DELETE
============================================================ */

async function deleteQuery(env, table, filters) {
  if (!filters.length) {
    return error("Borrado sin filtro bloqueado.", 400);
  }

  // Evitar borrar clientes que tengan facturas.
  if (table === "clients") {
    const idFilter = filters.find(f => f.column === "id");

    if (idFilter) {
      const linked = await env.DB.prepare(
        "SELECT id FROM invoices WHERE client_id = ? LIMIT 1"
      )
        .bind(idFilter.value)
        .first();

      if (linked) {
        return error(
          "No se puede borrar un cliente con facturas vinculadas.",
          409
        );
      }
    }
  }

  const where = filters
    .map(f => `${f.column} = ?`)
    .join(" AND ");

  await env.DB.prepare(
    `DELETE FROM ${table} WHERE ${where}`
  )
    .bind(...filters.map(f => normalizeValue(f.column, f.value)))
    .run();

  return json({ data: null });
}

/* ============================================================
   API DE CONSULTAS
============================================================ */

async function queryAPI(req, env) {
  const user = await sessionUser(req, env);

  if (!user) {
    return error(
      "Sesión caducada. Vuelve a iniciar sesión.",
      401
    );
  }

  const body = await readBody(req);
  const table = body.table;

  if (!validTable(table)) {
    return error("Tabla no permitida.", 400);
  }

  const allowed = COLS[table];
  const action = body.action || "select";
  const filters = body.filters || [];

  if (!validFilters(filters, allowed)) {
    return error("Los filtros enviados no son válidos.", 400);
  }

  switch (action) {
    case "select":
      return selectQuery(env, body, table, filters);

    case "insert":
      return insertQuery(env, body, table);

    case "update":
      return updateQuery(env, body, table, filters);

    case "delete":
      return deleteQuery(env, table, filters);

    default:
      return error("Operación no permitida.", 400);
  }
}

/* ============================================================
   ENRUTADOR PRINCIPAL
============================================================ */

async function api(req, env) {
  const url = new URL(req.url);
  const path = url.pathname;

  if (!env.DB) {
    return error("La base de datos D1 no está configurada.", 503);
  }

  if (path === "/api/health" && req.method === "GET") {
    try {
      await env.DB.prepare("SELECT 1").first();

      return json({
        ok: true,
        service: "RGL Mihai API",
        database: "D1",
        status: "connected"
      });
    } catch {
      return error("No se puede conectar con la base de datos.", 503);
    }
  }

  if (path === "/api/login" && req.method === "POST") {
    return login(req, env);
  }

  if (path === "/api/logout" && req.method === "POST") {
    return logout(req, env);
  }

  if (path === "/api/me" && req.method === "GET") {
    return json({
      user: await sessionUser(req, env)
    });
  }

  if (path === "/api/query" && req.method === "POST") {
    return queryAPI(req, env);
  }

  return null;
}

/* ============================================================
   WORKER
============================================================ */

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);

    if (url.pathname.startsWith("/api/")) {
      try {
        const response = await api(req, env);

        if (response) return response;

        return error("Ruta API no encontrada.", 404);

      } catch (err) {
        console.error("[RGL API]", err);

        return error(
          "Error interno del servidor. Revisa los registros de Cloudflare.",
          500
        );
      }
    }

    try {
      return await env.ASSETS.fetch(req);
    } catch (err) {
      console.error("[RGL ASSETS]", err);

      return new Response(
        "No se han podido cargar los archivos de la aplicación.",
        { status: 503 }
      );
    }
  }
};

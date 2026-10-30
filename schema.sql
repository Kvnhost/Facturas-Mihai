-- RGL Mihai · Cloudflare D1 · base limpia
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS company_settings (
 id INTEGER PRIMARY KEY CHECK(id=1),
 company_name TEXT, legal_name TEXT, owner_name TEXT, tax_id TEXT, address TEXT, additional_address TEXT, postal_code TEXT,
 city TEXT, province TEXT, phone TEXT, email TEXT, website TEXT, logo_url TEXT,
 bank_holder TEXT, bank_iban TEXT, footer_text TEXT, settings_json TEXT,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS clients (
 id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, tax_id TEXT, address TEXT,
 postal_code TEXT, city TEXT, province TEXT, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
 updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(name);
CREATE TABLE IF NOT EXISTS invoices (
 id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_number INTEGER, client_id INTEGER NOT NULL,
 issue_date TEXT NOT NULL, due_date TEXT, payment_method TEXT, status TEXT NOT NULL DEFAULT 'draft',
 description TEXT, base_amount REAL DEFAULT 0, vat_rate REAL, vat_amount REAL DEFAULT 0,
 total_amount REAL DEFAULT 0, notes TEXT, bank_holder TEXT, bank_iban TEXT,
 created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
 FOREIGN KEY(client_id) REFERENCES clients(id)
);
CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices(invoice_number);
CREATE INDEX IF NOT EXISTS idx_invoices_client ON invoices(client_id);
CREATE TABLE IF NOT EXISTS invoice_items (
 id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER NOT NULL, description TEXT NOT NULL,
 quantity REAL DEFAULT 1, unit_price REAL DEFAULT 0, vat_rate REAL DEFAULT 21, line_total REAL DEFAULT 0, vat_amount REAL DEFAULT 0, sort_order INTEGER DEFAULT 0,
 FOREIGN KEY(invoice_id) REFERENCES invoices(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS audit_log (
 id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT NOT NULL,
 entity_type TEXT, entity_id INTEGER, details TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
 id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
-- Datos base editables; el despliegue puede sobreescribirlos mediante variables COMPANY_*.
INSERT OR IGNORE INTO company_settings(id,company_name,legal_name,owner_name,tax_id,address,postal_code,city,phone,email)
VALUES(1,'RGL MIHAI','Reformas Generales & Limpieza Mihai','Mihai Hostinariu','X6690Q141Q','C/ Deseminado N°3387','46160','Llíria','+34 666 210 205','Rglmihai@hotmail.com');

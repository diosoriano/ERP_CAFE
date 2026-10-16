from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import hmac
import json
import os
import re
import sqlite3


PROJECT_DIR = Path(__file__).resolve().parent
DATABASE_PATH = Path(
    os.environ.get("CAFE_POS_DATABASE", str(PROJECT_DIR / "backup.db"))
).expanduser().resolve()
ACCESS_PIN = os.environ.get("CAFE_POS_PIN", "0000")
SERVER_PORT = int(os.environ.get("CAFE_POS_PORT", "8080"))
ALLOWED_PAYMENTS = {"Pix", "Cartão", "Dinheiro"}
PUBLIC_FILES = {"/", "/index.html", "/styles.css", "/app.js"}


def connect_database():
    connection = sqlite3.connect(DATABASE_PATH, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


def initialize_database():
    with connect_database() as connection:
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS sales (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_number TEXT NOT NULL,
                payment TEXT NOT NULL,
                total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
                sold_at TEXT NOT NULL,
                sold_on TEXT NOT NULL,
                month_key TEXT NOT NULL,
                year INTEGER NOT NULL,
                cash_received_cents INTEGER,
                change_cents INTEGER
            );

            CREATE TABLE IF NOT EXISTS sale_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
                product_id TEXT NOT NULL,
                product_name TEXT NOT NULL,
                quantity INTEGER NOT NULL CHECK (quantity > 0),
                unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
                line_total_cents INTEGER NOT NULL CHECK (line_total_cents >= 0)
            );

            CREATE INDEX IF NOT EXISTS idx_sales_sold_on ON sales(sold_on);
            CREATE INDEX IF NOT EXISTS idx_sales_month_key ON sales(month_key);
            CREATE INDEX IF NOT EXISTS idx_sales_year ON sales(year);
            CREATE INDEX IF NOT EXISTS idx_sale_items_sale_id ON sale_items(sale_id);
            """
        )
        columns = {
            row["name"] for row in connection.execute("PRAGMA table_info(sales)")
        }
        if "cash_received_cents" not in columns:
            connection.execute("ALTER TABLE sales ADD COLUMN cash_received_cents INTEGER")
        if "change_cents" not in columns:
            connection.execute("ALTER TABLE sales ADD COLUMN change_cents INTEGER")


def amount_to_cents(value):
    try:
        amount = Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        raise ValueError("Valor de produto inválido.") from None
    if not amount.is_finite() or amount < 0:
        raise ValueError("O preço deve ser um valor positivo.")
    return int(amount * 100)


def normalize_items(raw_items):
    if not isinstance(raw_items, list) or not raw_items or len(raw_items) > 100:
        raise ValueError("O pedido precisa ter entre 1 e 100 itens.")

    items = []
    for item in raw_items:
        if not isinstance(item, dict):
            raise ValueError("Item de venda inválido.")
        product_id = item.get("id")
        product_name = item.get("name")
        quantity = item.get("quantity")
        if not isinstance(product_id, str) or not product_id.strip():
            raise ValueError("Identificador de produto inválido.")
        if not isinstance(product_name, str) or not product_name.strip():
            raise ValueError("Nome de produto inválido.")
        if isinstance(quantity, bool) or not isinstance(quantity, int) or not 1 <= quantity <= 10000:
            raise ValueError("Quantidade de produto inválida.")

        unit_price_cents = amount_to_cents(item.get("price"))
        items.append({
            "id": product_id.strip()[:100],
            "name": product_name.strip()[:200],
            "quantity": quantity,
            "unit_price_cents": unit_price_cents,
            "line_total_cents": unit_price_cents * quantity,
        })
    return items


def sale_to_dict(row, items):
    return {
        "id": row["id"],
        "number": row["order_number"],
        "payment": row["payment"],
        "total": row["total_cents"] / 100,
        "cashReceived": None if row["cash_received_cents"] is None else row["cash_received_cents"] / 100,
        "change": None if row["change_cents"] is None else row["change_cents"] / 100,
        "time": row["sold_at"],
        "date": row["sold_on"],
        "month": row["month_key"],
        "year": row["year"],
        "items": [
            {
                "id": item["product_id"],
                "name": item["product_name"],
                "quantity": item["quantity"],
                "price": item["unit_price_cents"] / 100,
                "lineTotal": item["line_total_cents"] / 100,
            }
            for item in items
        ],
    }


class CafeHandler(SimpleHTTPRequestHandler):
    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Tamanho da solicitação inválido.") from None
        if size <= 0 or size > 1_000_000:
            raise ValueError("A solicitação está vazia ou excede o limite permitido.")
        try:
            return json.loads(self.rfile.read(size))
        except (json.JSONDecodeError, UnicodeDecodeError):
            raise ValueError("O conteúdo da solicitação não é um JSON válido.") from None

    def pin_is_valid(self):
        provided_pin = self.headers.get("X-Access-Pin", "")
        return hmac.compare_digest(provided_pin, ACCESS_PIN)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/summary":
            self.get_summary()
            return
        if parsed.path == "/api/sales":
            self.get_sales(parse_qs(parsed.query))
            return
        if parsed.path in PUBLIC_FILES:
            self.path = "/index.html" if parsed.path == "/" else parsed.path
            super().do_GET()
            return
        self.send_error(404, "Arquivo não encontrado.")

    def get_sales(self, query):
        if not self.pin_is_valid():
            self.send_json(401, {"error": "Acesso não autorizado."})
            return

        period = query.get("period", ["day"])[0]
        value = query.get("value", [datetime.now().date().isoformat()])[0]
        if period == "day" and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            where, parameter = "sold_on = ?", value
        elif period == "month" and re.fullmatch(r"\d{4}-\d{2}", value):
            where, parameter = "month_key = ?", value
        elif period == "year" and re.fullmatch(r"\d{4}", value):
            where, parameter = "year = ?", int(value)
        else:
            self.send_json(400, {"error": "Período de consulta inválido."})
            return

        with connect_database() as connection:
            rows = connection.execute(
                f"SELECT * FROM sales WHERE {where} ORDER BY id DESC", (parameter,)
            ).fetchall()
            result = []
            for row in rows:
                items = connection.execute(
                    "SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id", (row["id"],)
                ).fetchall()
                result.append(sale_to_dict(row, items))
        self.send_json(200, {"sales": result, "period": period, "value": value})

    def get_summary(self):
        today = datetime.now().date().isoformat()
        with connect_database() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS count, COALESCE(SUM(total_cents), 0) AS total "
                "FROM sales WHERE sold_on = ?",
                (today,),
            ).fetchone()
        total = row["total"] / 100
        self.send_json(200, {
            "date": today,
            "salesCount": row["count"],
            "salesTotal": total,
            "average": total / row["count"] if row["count"] else 0,
        })

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/auth":
            self.authenticate()
        elif parsed.path == "/api/sales":
            self.create_sale()
        else:
            self.send_error(404, "Rota não encontrada.")

    def authenticate(self):
        try:
            payload = self.read_json()
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return
        provided_pin = payload.get("pin", "") if isinstance(payload, dict) else ""
        if not isinstance(provided_pin, str) or not hmac.compare_digest(provided_pin, ACCESS_PIN):
            self.send_json(401, {"error": "Senha incorreta."})
            return
        self.send_json(200, {"authorized": True})

    def create_sale(self):
        try:
            payload = self.read_json()
            if not isinstance(payload, dict):
                raise ValueError("Dados da venda inválidos.")
            payment = payload.get("payment")
            if not isinstance(payment, str) or payment not in ALLOWED_PAYMENTS:
                raise ValueError("Forma de pagamento inválida.")
            items = normalize_items(payload.get("items"))
            total_cents = sum(item["line_total_cents"] for item in items)
            cash_received_cents = None
            change_cents = None
            if payment == "Dinheiro":
                cash_received_cents = amount_to_cents(payload.get("cashReceived"))
                if cash_received_cents < total_cents:
                    raise ValueError("O valor recebido é menor que o total da venda.")
                change_cents = cash_received_cents - total_cents
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
            return

        now = datetime.now().astimezone()
        sold_at = now.isoformat(timespec="seconds")
        sold_on = now.date().isoformat()
        month_key = now.strftime("%Y-%m")
        year = now.year
        try:
            with connect_database() as connection:
                connection.execute("BEGIN IMMEDIATE")
                daily_count = connection.execute(
                    "SELECT COUNT(*) FROM sales WHERE sold_on = ?", (sold_on,)
                ).fetchone()[0]
                order_number = f"#{daily_count + 1:03d}"
                cursor = connection.execute(
                    """INSERT INTO sales
                              (order_number, payment, total_cents, sold_at, sold_on, month_key, year,
                                cash_received_cents, change_cents)
                              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                          (order_number, payment, total_cents, sold_at, sold_on, month_key, year,
                            cash_received_cents, change_cents),
                )
                sale_id = cursor.lastrowid
                connection.executemany(
                    """INSERT INTO sale_items
                       (sale_id, product_id, product_name, quantity, unit_price_cents, line_total_cents)
                       VALUES (?, ?, ?, ?, ?, ?)""",
                    [
                        (sale_id, item["id"], item["name"], item["quantity"],
                         item["unit_price_cents"], item["line_total_cents"])
                        for item in items
                    ],
                )
                row = connection.execute("SELECT * FROM sales WHERE id = ?", (sale_id,)).fetchone()
                saved_items = connection.execute(
                    "SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id", (sale_id,)
                ).fetchall()
            self.send_json(201, {"sale": sale_to_dict(row, saved_items)})
        except sqlite3.Error:
            self.send_json(500, {"error": "Não foi possível gravar a venda no banco local."})

    def do_DELETE(self):
        if urlparse(self.path).path != "/api/sales":
            self.send_error(404, "Rota não encontrada.")
            return
        if not self.pin_is_valid():
            self.send_json(401, {"error": "Acesso não autorizado."})
            return
        with connect_database() as connection:
            connection.execute("DELETE FROM sales")
        self.send_json(200, {"deleted": True})

    def log_message(self, format, *args):
        print(f"[{self.log_date_time_string()}] {format % args}")


def main():
    initialize_database()
    handler = partial(CafeHandler, directory=str(PROJECT_DIR))
    server = ThreadingHTTPServer(("127.0.0.1", SERVER_PORT), handler)
    print(f"PDV disponível em http://127.0.0.1:{SERVER_PORT}")
    print(f"Banco local: {DATABASE_PATH}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor encerrado.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

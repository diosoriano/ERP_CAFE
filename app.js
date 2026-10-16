const products = [
  { id: "espresso", name: "Espresso", detail: "Duplo · 60 ml", category: "Cafés", price: 8, image: "photo-1510707577719-ae7c14805e3a", tag: "Clássico" },
  { id: "cappuccino", name: "Cappuccino", detail: "Leite vaporizado · 180 ml", category: "Cafés", price: 14, image: "photo-1572442388796-11668a67e53d", tag: "Favorito" },
  { id: "latte", name: "Latte", detail: "Espresso · leite · 240 ml", category: "Cafés", price: 15, image: "photo-1461023058943-07fcbe16d735", tag: "" },
  { id: "coado", name: "Café coado", detail: "Origem do dia · 200 ml", category: "Cafés", price: 10, image: "photo-1495474472287-4d71bcdd2085", tag: "Do dia" },
  { id: "iced", name: "Cold brew", detail: "Infusão a frio · 300 ml", category: "Gelados", price: 16, image: "photo-1517701604599-bb29b565090c", tag: "Gelado" },
  { id: "matcha", name: "Matcha latte", detail: "Matcha · leite · 240 ml", category: "Gelados", price: 18, image: "photo-1515823064-d6e0c04616a7", tag: "" },
  { id: "croissant", name: "Croissant", detail: "Manteiga · feito na casa", category: "Comidas", price: 12, image: "photo-1555507036-ab1f4038808a", tag: "Fresco" },
  { id: "bolo", name: "Bolo de cenoura", detail: "Cobertura de chocolate · fatia", category: "Comidas", price: 13, image: "photo-1578985545062-69928b1d9587", tag: "" },
  { id: "pao", name: "Pão de queijo", detail: "3 unidades · quentinho", category: "Comidas", price: 9, image: "photo-1509440159596-0249088772ff", tag: "" },
  { id: "cookie", name: "Cookie artesanal", detail: "Chocolate meio amargo", category: "Comidas", price: 11, image: "photo-1499636136210-6f4ee915583e", tag: "" },
  { id: "suco", name: "Suco de laranja", detail: "Natural · 300 ml", category: "Gelados", price: 12, image: "photo-1600271886742-f049cd451bba", tag: "Natural" },
  { id: "cha", name: "Chá da casa", detail: "Infusão artesanal · 250 ml", category: "Chás", price: 10, image: "photo-1544787219-7f47ccb76574", tag: "" }
];
const currency = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateKey = new Date().toLocaleDateString("sv-SE");
const pixKey = "dioamaral@gmail.com";
const pixRecipientName = "DIOGO";
const pixRecipientCity = "Niterói";
let state = { salesCount: 0, salesTotal: 0 };
let cart = new Map();
let activeCategory = "Todos";
let payment = "Pix";
let toastTimer;
let protectedAction = null;
let activeAccessPin = null;
let currentPixPayload = "";

async function requestAPI(url, options = {}) {
  let response;
  try {
    response = await fetch(url, options);
  } catch {
    throw new Error("Não foi possível conectar ao banco local. Inicie o servidor do PDV.");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Não foi possível concluir a solicitação.");
  return payload;
}
function money(value) { return currency.format(value); }
function escapeHTML(value) { return String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[character]); }
function imageURL(id) { return `https://images.unsplash.com/${id}?auto=format&fit=crop&w=640&q=80`; }
function emvField(id, value) { return `${id}${String(value.length).padStart(2, "0")}${value}`; }
function pixText(value, maxLength) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}
function crc16(payload) {
  let crc = 0xffff;
  for (const character of payload) {
    crc ^= character.charCodeAt(0) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}
function buildPixPayload(totalCents) {
  const amount = (totalCents / 100).toFixed(2);
  const orderId = `GRAO${dateKey.replace(/-/g, "")}${String(state.salesCount + 1).padStart(4, "0")}`;
  const merchantAccount = emvField("00", "BR.GOV.BCB.PIX") + emvField("01", pixKey);
  const additionalData = emvField("05", orderId);
  const payload = [
    emvField("00", "01"),
    emvField("01", "11"),
    emvField("26", merchantAccount),
    emvField("52", "0000"),
    emvField("53", "986"),
    emvField("54", amount),
    emvField("58", "BR"),
    emvField("59", pixText(pixRecipientName, 25)),
    emvField("60", pixText(pixRecipientCity, 15)),
    emvField("62", additionalData),
  ].join("");
  const payloadWithCrcField = `${payload}6304`;
  return `${payloadWithCrcField}${crc16(payloadWithCrcField)}`;
}
function renderPixManager(totalCents) {
  const manager = document.getElementById("pixManager");
  manager.hidden = payment !== "Pix" || totalCents === 0;
  currentPixPayload = "";
  if (manager.hidden) return;

  const qrContainer = document.getElementById("pixQRCode");
  qrContainer.replaceChildren();
  if (typeof QRCode === "undefined") {
    showToast("Não foi possível carregar o gerador do QR Pix.");
    return;
  }
  currentPixPayload = buildPixPayload(totalCents);
  new QRCode(qrContainer, {
    text: currentPixPayload,
    width: 160,
    height: 160,
    colorDark: "#17241b",
    colorLight: "#ffffff",
    correctLevel: QRCode.CorrectLevel.M,
  });
}

function renderCategories() {
  const categories = ["Todos", ...new Set(products.map(product => product.category))];
  document.getElementById("categories").innerHTML = categories.map(category => `<button class="category${category === activeCategory ? " active" : ""}" data-category="${escapeHTML(category)}">${escapeHTML(category)}</button>`).join("");
}
function renderProducts() {
  const query = document.getElementById("searchInput").value.trim().toLocaleLowerCase("pt-BR");
  const visible = products.filter(product => (activeCategory === "Todos" || product.category === activeCategory) && `${product.name} ${product.detail} ${product.category}`.toLocaleLowerCase("pt-BR").includes(query));
  const grid = document.getElementById("productGrid");
  if (!visible.length) { grid.innerHTML = '<div class="empty-products">Nenhum produto encontrado.</div>'; return; }
  grid.innerHTML = visible.map(product => `<article class="product" tabindex="0" role="button" aria-label="Adicionar ${escapeHTML(product.name)} ao pedido" data-product="${product.id}"><div class="product-image"><img src="${imageURL(product.image)}" alt="${escapeHTML(product.name)}" loading="lazy">${product.tag ? `<span class="product-tag">${escapeHTML(product.tag)}</span>` : ""}</div><div class="product-info"><div><span class="product-name">${escapeHTML(product.name)}</span><span class="product-detail">${escapeHTML(product.detail)}</span></div><span class="product-price">${money(product.price)}</span></div></article>`).join("");
}
function cartTotalCents() {
  return [...cart.entries()].reduce((sum, [id, quantity]) => {
    const product = products.find(item => item.id === id);
    return sum + Math.round(product.price * 100) * quantity;
  }, 0);
}
function cashReceivedCents() {
  const value = document.getElementById("cashReceived").value;
  if (!value) return null;
  const amount = Number(value);
  return Number.isFinite(amount) && amount >= 0 ? Math.round(amount * 100) : null;
}
function renderCashManager(totalCents) {
  const manager = document.getElementById("cashManager");
  manager.hidden = payment !== "Dinheiro";
  if (manager.hidden) return;

  const receivedCents = cashReceivedCents();
  const enoughCash = receivedCents !== null && receivedCents >= totalCents;
  document.getElementById("cashChangeAmount").textContent = money(
    Math.max(0, (receivedCents ?? 0) - totalCents) / 100,
  );
  const message = document.getElementById("cashMessage");
  message.textContent = receivedCents === null
    ? "Informe o valor recebido."
    : enoughCash ? "Troco para devolver." : "Valor recebido insuficiente.";
  message.classList.toggle("insufficient", receivedCents !== null && !enoughCash);

  const presets = [...new Set([totalCents, 2000, 5000, 10000])]
    .filter(amount => totalCents > 0 && amount >= totalCents);
  document.getElementById("cashPresets").innerHTML = presets.map(amount =>
    `<button class="cash-preset" type="button" data-cash-cents="${amount}">${amount === totalCents ? "Exato" : money(amount / 100)}</button>`,
  ).join("");
}
function renderCart() {
  const entries = [...cart.entries()];
  const container = document.getElementById("cartItems");
  if (!entries.length) container.innerHTML = '<div class="cart-empty"><span>＋</span><p>Adicione produtos do cardápio<br>para começar um pedido</p></div>';
  else container.innerHTML = entries.map(([id, quantity]) => {
    const product = products.find(item => item.id === id);
    return `<div class="cart-row"><div><span class="cart-item-name">${escapeHTML(product.name)}</span><span class="cart-item-price">${money(product.price)} cada</span><div class="quantity"><button data-quantity="${id}" data-change="-1" aria-label="Remover uma unidade de ${escapeHTML(product.name)}">−</button><span>${quantity}</span><button data-quantity="${id}" data-change="1" aria-label="Adicionar uma unidade de ${escapeHTML(product.name)}">+</button></div></div><span class="row-total">${money(product.price * quantity)}</span></div>`;
  }).join("");
  const count = entries.reduce((sum, [, quantity]) => sum + quantity, 0);
  const totalCents = cartTotalCents();
  document.getElementById("cartCount").textContent = count;
  document.getElementById("subtotal").textContent = money(totalCents / 100);
  document.getElementById("total").textContent = money(totalCents / 100);
  renderPixManager(totalCents);
  renderCashManager(totalCents);
  const receivedCents = cashReceivedCents();
  document.getElementById("finishSale").disabled = count === 0
    || (payment === "Dinheiro" && (receivedCents === null || receivedCents < totalCents));
}
function renderMetrics() {
  document.getElementById("salesAmount").textContent = money(state.salesTotal);
  document.getElementById("salesCount").textContent = state.salesCount;
  document.getElementById("averageSale").textContent = money(state.salesCount ? state.salesTotal / state.salesCount : 0);
}
function nextOrderNumber() { return `#${String(state.salesCount + 1).padStart(3, "0")}`; }
function setOrderMeta() {
  document.getElementById("orderNumber").textContent = nextOrderNumber();
  document.getElementById("orderTime").textContent = new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}
function addProduct(id) { cart.set(id, (cart.get(id) || 0) + 1); renderCart(); }
function changeQuantity(id, amount) {
  const next = (cart.get(id) || 0) + amount;
  if (next <= 0) cart.delete(id); else cart.set(id, next);
  renderCart();
}
function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
}
async function completeSale() {
  if (!cart.size) return;
  const totalCents = cartTotalCents();
  const receivedCents = payment === "Dinheiro" ? cashReceivedCents() : null;
  if (payment === "Dinheiro" && (receivedCents === null || receivedCents < totalCents)) return;
  const items = [...cart.entries()].map(([id, quantity]) => {
    const product = products.find(item => item.id === id);
    return { id, name: product.name, quantity, price: product.price };
  });
  try {
    const { sale } = await requestAPI("/api/sales", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        payment,
        items,
        cashReceived: receivedCents === null ? null : receivedCents / 100,
      }),
    });
    state.salesCount += 1;
    state.salesTotal += sale.total;
    cart.clear();
    document.getElementById("cashReceived").value = "";
    renderCart();
    renderMetrics();
    setOrderMeta();
    showToast(`Venda ${sale.number} gravada · ${money(sale.total)} no ${sale.payment}`);
  } catch (error) {
    showToast(error.message);
  }
}
function renderSales(sales) {
  const list = document.getElementById("salesList");
  list.innerHTML = sales.length ? sales.map(sale => {
    const time = new Date(sale.time).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    const quantity = sale.items.reduce((sum, item) => sum + item.quantity, 0);
    const items = sale.items.map(item => `<div class="sale-item"><span>${escapeHTML(item.name)} × ${item.quantity}</span><span class="sale-item-total">${money(item.lineTotal)}</span></div>`).join("");
    const cashDetails = sale.payment === "Dinheiro" && sale.cashReceived !== null
      ? `<small>Recebido ${money(sale.cashReceived)} · Troco ${money(sale.change)}</small>`
      : "";
    return `<div class="sale-entry"><div class="sale-summary"><div><strong>${escapeHTML(sale.number)} · ${quantity} ${quantity === 1 ? "item" : "itens"}</strong><small>${time} · ${escapeHTML(sale.payment)}</small>${cashDetails}</div><span class="sale-amount">${money(sale.total)}</span></div><div class="sale-items">${items}</div></div>`;
  }).join("") : '<div class="no-sales">Nenhuma venda registrada hoje.</div>';
  const total = sales.reduce((sum, sale) => sum + sale.total, 0);
  document.getElementById("salesPeriodSummary").textContent = `${sales.length} ${sales.length === 1 ? "venda" : "vendas"} · ${money(total)}`;
}
async function openSales(pin = activeAccessPin) {
  activeAccessPin = pin;
  document.getElementById("salesDialog").classList.add("open");
  document.getElementById("closeSales").focus();
  const period = document.getElementById("salesPeriod").value;
  const value = document.getElementById("salesPeriodValue").value;
  const query = new URLSearchParams({ period, value });
  try {
    const { sales } = await requestAPI(`/api/sales?${query}`, { headers: { "X-Access-Pin": pin } });
    renderSales(sales);
  } catch (error) {
    document.getElementById("salesList").innerHTML = '<div class="no-sales">Não foi possível carregar as vendas.</div>';
    showToast(error.message);
  }
}
function closeSales() {
  document.getElementById("salesDialog").classList.remove("open");
  activeAccessPin = null;
}
function updateSalesPeriodInput() {
  const period = document.getElementById("salesPeriod").value;
  const input = document.getElementById("salesPeriodValue");
  const today = new Date().toLocaleDateString("sv-SE");
  input.type = period === "month" ? "month" : period === "year" ? "number" : "date";
  input.value = period === "month" ? today.slice(0, 7) : period === "year" ? today.slice(0, 4) : today;
  if (period === "year") {
    input.min = "2000";
    input.max = String(new Date().getFullYear());
    input.step = "1";
  } else {
    input.removeAttribute("min");
    input.removeAttribute("max");
    input.removeAttribute("step");
  }
}
function requestProtectedAction(action) {
  protectedAction = action;
  document.getElementById("pinInput").value = "";
  document.getElementById("pinError").hidden = true;
  document.getElementById("pinDialog").classList.add("open");
  document.getElementById("pinInput").focus();
}
function closePin() {
  document.getElementById("pinDialog").classList.remove("open");
  protectedAction = null;
}
async function clearSalesHistory(pin) {
  if (!confirm("Apagar o histórico de vendas deste navegador? Esta ação não pode ser desfeita.")) return;
  try {
    await requestAPI("/api/sales", { method: "DELETE", headers: { "X-Access-Pin": pin } });
    state.salesCount = 0;
    state.salesTotal = 0;
    renderMetrics();
    setOrderMeta();
    showToast("Histórico de vendas apagado");
  } catch (error) {
    showToast(error.message);
  }
}

document.getElementById("categories").addEventListener("click", event => {
  const button = event.target.closest("[data-category]");
  if (!button) return;
  activeCategory = button.dataset.category;
  renderCategories();
  renderProducts();
});
document.getElementById("productGrid").addEventListener("click", event => {
  const product = event.target.closest("[data-product]");
  if (product) addProduct(product.dataset.product);
});
document.getElementById("productGrid").addEventListener("keydown", event => {
  const product = event.target.closest("[data-product]");
  if (product && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); addProduct(product.dataset.product); }
});
document.getElementById("cartItems").addEventListener("click", event => {
  const button = event.target.closest("[data-quantity]");
  if (button) changeQuantity(button.dataset.quantity, Number(button.dataset.change));
});
document.getElementById("searchInput").addEventListener("input", renderProducts);
document.getElementById("clearCart").addEventListener("click", () => {
  cart.clear();
  document.getElementById("cashReceived").value = "";
  renderCart();
});
document.getElementById("finishSale").addEventListener("click", completeSale);
document.getElementById("paymentOptions").addEventListener("click", event => {
  const button = event.target.closest("[data-payment]");
  if (!button) return;
  if (button.dataset.payment !== payment) document.getElementById("cashReceived").value = "";
  payment = button.dataset.payment;
  document.querySelectorAll(".payment-option").forEach(option => option.classList.toggle("active", option === button));
  renderCart();
});
document.getElementById("cashReceived").addEventListener("input", renderCart);
document.getElementById("cashPresets").addEventListener("click", event => {
  const button = event.target.closest("[data-cash-cents]");
  if (!button) return;
  document.getElementById("cashReceived").value = (Number(button.dataset.cashCents) / 100).toFixed(2);
  renderCart();
});
document.getElementById("copyPixCode").addEventListener("click", async () => {
  if (!currentPixPayload) return;
  try {
    await navigator.clipboard.writeText(currentPixPayload);
    showToast("Código Pix copiado.");
  } catch {
    showToast("Não foi possível copiar o código Pix.");
  }
});
document.getElementById("salesNav").addEventListener("click", () => requestProtectedAction("sales"));
document.getElementById("headerSales").addEventListener("click", () => requestProtectedAction("sales"));
document.getElementById("salesPeriod").addEventListener("change", () => {
  updateSalesPeriodInput();
  if (document.getElementById("salesDialog").classList.contains("open")) openSales();
});
document.getElementById("salesPeriodValue").addEventListener("change", () => {
  if (document.getElementById("salesDialog").classList.contains("open")) openSales();
});
document.getElementById("closeSales").addEventListener("click", closeSales);
document.getElementById("salesDialog").addEventListener("click", event => { if (event.target.id === "salesDialog") closeSales(); });
document.getElementById("resetButton").addEventListener("click", () => requestProtectedAction("reset"));
document.getElementById("cancelPin").addEventListener("click", closePin);
document.getElementById("pinForm").addEventListener("submit", async event => {
  event.preventDefault();
  const pin = document.getElementById("pinInput").value;
  try {
    await requestAPI("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pin }),
    });
  } catch (error) {
    if (error.message === "Senha incorreta.") {
      document.getElementById("pinError").hidden = false;
      document.getElementById("pinInput").focus();
    } else {
      showToast(error.message);
    }
    return;
  }
  const action = protectedAction;
  closePin();
  if (action === "sales") await openSales(pin);
  if (action === "reset") await clearSalesHistory(pin);
});
document.addEventListener("keydown", event => { if (event.key === "Escape") { closeSales(); closePin(); } });

async function initializeApp() {
  document.getElementById("currentDate").textContent = new Intl.DateTimeFormat("pt-BR", { weekday: "long", day: "numeric", month: "long" }).format(new Date());
  updateSalesPeriodInput();
  renderCategories();
  renderProducts();
  renderCart();
  renderMetrics();
  setOrderMeta();
  try {
    const summary = await requestAPI("/api/summary");
    state.salesCount = summary.salesCount;
    state.salesTotal = summary.salesTotal;
    renderMetrics();
    setOrderMeta();
  } catch (error) {
    showToast(error.message);
  }
}

initializeApp();

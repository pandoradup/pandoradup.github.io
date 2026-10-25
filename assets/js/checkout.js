const money = value => new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0
}).format(value);
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
})[character]);
const STORE_PICKUP = "Retiro en el local [Castelli 695, 8000 Bahía Blanca, Provincia de Buenos Aires]";

let cart = [];
try {
  cart = JSON.parse(localStorage.getItem("pandoraCart")) || [];
} catch {
  cart = [];
}

function groupCart(items) {
  return Object.values(items.reduce((groups, product) => {
  const key = `${product.id}::${product.size || ""}`;
  if (!groups[key]) groups[key] = { ...product, quantity: 0 };
  groups[key].quantity += 1;
  return groups;
  }, {}));
}

let groupedItems = groupCart(cart);
let promotions = window.PromotionEngine.parse(localStorage.getItem("pandoraPromotions"));
let promotionPricing = window.PromotionEngine.calculate(cart, cart, promotions);
let subtotal = promotionPricing.total;
let selectedPayment = "";
let total = subtotal;

function renderSummary() {
  document.querySelector("[data-summary-items]").innerHTML = groupedItems.map(item => `
    <article class="summary-item">
      <img src="${item.image || item.image_url}" alt="">
      <div><h3>${item.name}</h3><p>${item.size ? `Talle: ${escapeHtml(item.size)} · ` : ""}Cantidad: ${item.quantity}</p></div>
      <strong>${money(item.price * item.quantity)}</strong>
    </article>
  `).join("");
  document.querySelector("[data-subtotal]").textContent = money(promotionPricing.subtotal);
  document.querySelector("[data-total]").textContent = money(total);
  const promotionSummary = document.querySelector("[data-promotion-summary]");
  promotionSummary.classList.toggle("hidden", promotionPricing.applications.length === 0);
  promotionSummary.innerHTML = promotionPricing.applications.map(application =>
    `<p><span>Promo: ${escapeHtml(application.name)}${application.applications > 1 ? ` ×${application.applications}` : ""}</span><strong>${application.gift ? `${escapeHtml(application.gift)} de regalo` : `-${money(application.saving)}`}</strong></p>`
  ).join("");
}

function updatePayment(payment) {
  selectedPayment = payment || "";
  total = subtotal;
  document.querySelector("[data-total]").textContent = money(total);
}

function syncPaymentAvailability(delivery) {
  const cashInput = document.querySelector('input[name="payment"][value="Efectivo"]');
  const cashCard = document.querySelector("[data-cash-payment]");
  const cashAvailable = delivery === STORE_PICKUP;
  cashCard.classList.toggle("hidden", !cashAvailable);
  cashInput.disabled = !cashAvailable;
  if (!cashAvailable && cashInput.checked) {
    cashInput.checked = false;
    updatePayment("");
  }
}

function buildReceipt(form, orderNumber) {
  const itemLines = groupedItems
    .map(item => `- ${item.name}${item.size ? ` · Talle ${item.size}` : ""} x${item.quantity}: ${money(item.price * item.quantity)}`)
    .join("\n");
  const delivery = form.get("delivery");
  const deliveryDetails = delivery !== STORE_PICKUP
    ? `${delivery}: ${form.get("address")}, ${form.get("city")} (${form.get("postal_code")})`
    : delivery;
  const notesLine = form.get("notes")?.trim()
    ? `\nObservaciones: ${form.get("notes").trim()}`
    : "";
  const promotionLines = promotionPricing.applications.length
    ? `\nPROMOCIONES\n${promotionPricing.applications.map(application =>
        `- ${application.name}${application.applications > 1 ? ` x${application.applications}` : ""}: ${application.gift ? `${application.gift} de regalo` : `-${money(application.saving)}`}`
      ).join("\n")}\n`
    : "";
  return `PANDORA.DUP — RESUMEN DEL PEDIDO
Pedido: ${orderNumber}

CLIENTE
Nombre: ${form.get("name")} ${form.get("surname")}
${delivery !== STORE_PICKUP ? `Documento: ${form.get("document")}\n` : ""}Teléfono: ${form.get("phone")}
Email: ${form.get("email")}

PRODUCTOS
${itemLines}
${promotionLines}

Subtotal productos: ${money(promotionPricing.subtotal)}
Descuento promociones: -${money(promotionPricing.discount)}
TOTAL: ${money(total)}
Entrega: ${deliveryDetails}
Forma de pago: ${selectedPayment}
${notesLine}`;
}

async function saveOrder(form, orderNumber) {
  const { createSupabaseClient, isSupabaseConfigured } = await import("./supabase-client.js");
  if (!isSupabaseConfigured) return;
  const client = await createSupabaseClient();
  const [{ data: currentProducts, error: productsError }, { data: promotionSetting, error: promotionError }] =
    await Promise.all([
      client.rpc("get_store_products"),
      client.from("site_content").select("value").eq("key", "promotions_config").maybeSingle()
    ]);
  if (productsError) throw productsError;
  if (promotionError) throw promotionError;
  const productMap = new Map((currentProducts || []).map(product => [String(product.id), product]));
  const unavailableItems = cart.filter(item => !productMap.has(String(item.id)));
  if (unavailableItems.length) {
    throw new Error(`Producto no disponible: ${[...new Set(unavailableItems.map(item => item.name))].join(", ")}`);
  }
  cart = cart.map(item => ({ ...item, ...(productMap.get(String(item.id)) || {}) }));
  groupedItems = groupCart(cart);
  const { data: hasStock, error: stockError } = await client.rpc("validate_cart_stock", {
    p_items: groupedItems.map(item => ({
      id: item.id,
      size: item.size || null,
      quantity: item.quantity
    }))
  });
  if (stockError || !hasStock) {
    throw new Error("No hay stock suficiente para completar el pedido. Revisá la bolsa y volvé a intentar.");
  }
  promotions = window.PromotionEngine.parse(promotionSetting?.value);
  promotionPricing = window.PromotionEngine.calculate(cart, currentProducts || [], promotions);
  subtotal = promotionPricing.total;
  updatePayment(selectedPayment);
  renderSummary();
  const delivery = form.get("delivery");
  const { error } = await client.from("orders").insert({
    order_number: orderNumber,
    customer_name: `${form.get("name")} ${form.get("surname")}`.trim(),
    email: form.get("email"),
    phone: form.get("phone"),
    document: delivery !== STORE_PICKUP ? form.get("document") : "",
    delivery_method: delivery,
    address: delivery !== STORE_PICKUP ? form.get("address") : null,
    city: delivery !== STORE_PICKUP ? form.get("city") : null,
    postal_code: delivery !== STORE_PICKUP ? form.get("postal_code") : null,
    payment_method: selectedPayment,
    notes: form.get("notes") || null,
    subtotal: promotionPricing.subtotal,
    discount: promotionPricing.discount,
    total: promotionPricing.total,
    items: groupedItems.map(item => ({
      id: item.id,
      name: item.name,
      price: Number(item.price),
      quantity: item.quantity,
      size: item.size || null
    })),
    status: "pending"
  });
  if (error) throw error;
  try {
    const { error: notificationError } = await client.functions.invoke("order-notification", {
      body: { orderNumber }
    });
    if (notificationError) console.warn("El pedido se guardó, pero no se pudo enviar el aviso.", notificationError);
  } catch (notificationError) {
    console.warn("El pedido se guardó, pero no se pudo enviar el aviso.", notificationError);
  }
}

if (!cart.length) {
  document.querySelector("[data-checkout-data]").classList.add("hidden");
  document.querySelector(".order-summary").classList.add("hidden");
  document.querySelector("[data-empty-checkout]").classList.remove("hidden");
} else {
  renderSummary();
}

document.querySelectorAll('input[name="payment"]').forEach(input => {
  input.addEventListener("change", () => updatePayment(input.value));
});

function openStep(stepNumber) {
  document.querySelectorAll("[data-step-content]").forEach(content => {
    content.classList.toggle("hidden", content.dataset.stepContent !== String(stepNumber));
  });
  document.querySelectorAll("[data-step]").forEach(step => {
    step.classList.toggle("active", step.dataset.step === String(stepNumber));
  });
}

function validateStep(step) {
  const controls = [...step.querySelectorAll("input, select, textarea")]
    .filter(control => !control.closest(".hidden"));
  const invalid = controls.find(control => !control.checkValidity());
  if (invalid) {
    invalid.reportValidity();
    return false;
  }
  return true;
}

function isStepComplete(step) {
  const controls = [...step.querySelectorAll("input, select, textarea")]
    .filter(control => !control.closest(".hidden"));
  return controls.every(control => control.checkValidity());
}

function updateStepButtons() {
  document.querySelectorAll("[data-step]").forEach(step => {
    const button = step.querySelector("[data-next-step], .confirm-button");
    if (button) button.disabled = !isStepComplete(step);
  });
}

document.querySelector("[data-order-form]").addEventListener("input", updateStepButtons);
document.querySelector("[data-order-form]").addEventListener("change", updateStepButtons);

function syncDeliveryFields(delivery) {
    const needsAddress = Boolean(delivery) && delivery !== STORE_PICKUP;
    const isAndreani = delivery === "Envío por correo Andreani";
    document.querySelector("[data-address-fields]").classList.toggle("hidden", !needsAddress);
    document.querySelector("[data-andreani-tools]").classList.toggle("hidden", !isAndreani);
    ["document", "address", "city", "postal_code"].forEach(name => {
      document.querySelector(`[name="${name}"]`).required = needsAddress;
    });
    document.querySelector('[name="document"]').disabled = !needsAddress;
    syncPaymentAvailability(delivery);
    updateStepButtons();
}

document.querySelectorAll('input[name="delivery"]').forEach(input => {
  input.addEventListener("change", () => {
    syncDeliveryFields(input.value);
  });
});

syncDeliveryFields(document.querySelector('input[name="delivery"]:checked')?.value);
updateStepButtons();
setTimeout(updateStepButtons, 400);
setTimeout(updateStepButtons, 1200);
window.addEventListener("pageshow", updateStepButtons);

document.querySelectorAll("[data-next-step]").forEach(button => {
  button.addEventListener("click", () => {
    const currentStep = button.closest("[data-step]");
    if (!validateStep(currentStep)) return;
    const form = document.querySelector("[data-order-form]");
    const number = currentStep.dataset.step;
    if (number === "1") {
      document.querySelector('[data-step-summary="1"]').textContent =
        `${form.elements.name.value} ${form.elements.surname.value} · ${form.elements.email.value}`;
    }
    if (number === "2") {
      document.querySelector('[data-step-summary="2"]').textContent =
        form.elements.delivery.value;
    }
    currentStep.classList.add("completed");
    currentStep.querySelector("[data-edit-step]")?.classList.remove("hidden");
    openStep(button.dataset.nextStep);
  });
});

document.querySelectorAll("[data-edit-step]").forEach(button => {
  button.addEventListener("click", () => openStep(button.dataset.editStep));
});

function generateOrderNumber() {
  // Rejection sampling keeps every four-digit suffix equally likely.
  const random = new Uint32Array(1);
  do { crypto.getRandomValues(random); } while (random[0] >= 4294960000);
  return `PAN${String(random[0] % 10000).padStart(4, "0")}AR`;
}

document.querySelector("[data-order-form]").addEventListener("submit", async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  updatePayment(form.get("payment"));
  let orderNumber = generateOrderNumber();
  const submitButton = event.currentTarget.querySelector('[type="submit"]');
  submitButton.disabled = true;
  document.querySelector("[data-order-message]").textContent = "Registrando pedido...";
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await saveOrder(form, orderNumber);
        break;
      } catch (error) {
        // A uniqueness conflict means no order was saved; retry with a new number.
        if (error.code !== "23505" || attempt >= 2) throw error;
        orderNumber = generateOrderNumber();
      }
    }
  } catch (error) {
    console.error("No se pudo registrar el pedido:", error);
    submitButton.disabled = false;
    const unavailableMatch = String(error.message).match(/Producto no disponible:\s*(.+)/i);
    document.querySelector("[data-order-message]").textContent = unavailableMatch
      ? `${unavailableMatch[1]} ya no está disponible. Volvé al carrito, eliminá ese producto y elegilo nuevamente.`
      : /stock insuficiente/i.test(error.message)
        ? "Cambió la disponibilidad de uno de los productos. Volvé al carrito y ajustá las cantidades."
        : /producto inexistente|no tiene componentes/i.test(error.message)
          ? "Uno de los productos cambió. Volvé al carrito, eliminálo y agregalo nuevamente."
          : `No pudimos registrar el pedido: ${error.message || "error desconocido"}`;
    return;
  }
  document.querySelector("[data-receipt-text]").textContent = buildReceipt(form, orderNumber);
  document.querySelector("[data-checkout-data]").classList.add("hidden");
  document.querySelector(".order-summary").classList.add("hidden");
  document.querySelector("[data-receipt]").classList.remove("hidden");
  localStorage.removeItem("pandoraCart");
  window.scrollTo({ top: 0, behavior: "smooth" });
});

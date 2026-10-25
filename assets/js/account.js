import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./supabase-config.js";

const form = document.querySelector("[data-tracking-form]");
const message = document.querySelector("[data-tracking-message]");
const result = document.querySelector("[data-tracking-result]");
const states = {
  pending: ["Pedido recibido", "Recibimos tu pedido. Nos comunicaremos con vos para coordinar el pago y la entrega."],
  contacted: ["Contactado", "Ya nos pusimos en contacto con vos para coordinar tu pedido."],
  completed: ["Completado", "Tu pedido fue marcado como completado."],
  cancelled: ["Cancelado", "Tu pedido fue cancelado. Si tenés alguna duda, escribinos por WhatsApp."],
};

form.addEventListener("submit", async event => {
  event.preventDefault();
  const number = form.elements.orderNumber.value.trim().toUpperCase();
  form.elements.orderNumber.value = number;
  result.classList.add("hidden");
  message.classList.remove("error");
  if (!/^(?:PAN(?:[0-9]{4}|[0-9]{8})AR|[A-F0-9]{8})$/.test(number)) {
    message.textContent = "Ingresá el número completo de tu comprobante, por ejemplo PAN1234AR.";
    message.classList.add("error");
    return;
  }
  const button = form.querySelector("button");
  button.disabled = true;
  form.setAttribute("aria-busy", "true");
  message.textContent = "Consultando tu pedido…";
  try {
    const response = await fetch(`${SUPABASE_URL}/functions/v1/order-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_PUBLISHABLE_KEY },
      body: JSON.stringify({ orderNumber: number }),
      signal: AbortSignal.timeout(15000),
      cache: "no-store",
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 404) throw new Error("No encontramos ese pedido. Revisá el número de tu comprobante.");
      throw new Error("No pudimos consultar tu pedido. Intentá nuevamente en unos minutos.");
    }
    const state = states[data.status];
    if (!state || data.orderNumber !== number) throw new Error("No pudimos consultar tu pedido. Intentá nuevamente.");
    document.querySelector("[data-tracking-number]").textContent = `PEDIDO ${number}`;
    document.querySelector("[data-tracking-status]").textContent = state[0];
    document.querySelector("[data-tracking-description]").textContent = state[1];
    result.classList.remove("hidden");
    message.textContent = "";
  } catch (error) {
    message.textContent = error.name === "TimeoutError" || error instanceof TypeError
      ? "No pudimos conectar. Revisá tu conexión e intentá nuevamente."
      : error.message;
    message.classList.add("error");
  } finally {
    button.disabled = false;
    form.setAttribute("aria-busy", "false");
  }
});

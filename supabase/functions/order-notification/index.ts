const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const SELLER_EMAIL = Deno.env.get("SELLER_EMAIL");
const FROM_EMAIL = Deno.env.get("FROM_EMAIL") || "Pandora DUP <onboarding@resend.dev>";
const CUSTOMER_FROM_EMAIL = Deno.env.get("CUSTOMER_FROM_EMAIL") || FROM_EMAIL;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const allowedOrigins = new Set(["https://pandoradup.github.io", "https://constanzamacri.github.io"]);
const customerEmailConfigured = Boolean(RESEND_API_KEY && CUSTOMER_FROM_EMAIL && !/@resend\.dev(?:>|\s|$)/i.test(CUSTOMER_FROM_EMAIL));
const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, character => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
}[character] || character));
const money = (value: unknown) => new Intl.NumberFormat("es-AR", {
  style: "currency", currency: "ARS", maximumFractionDigits: 0
}).format(Number(value) || 0);

type Order = Record<string, unknown> & { items?: Record<string, unknown>[] };
export function orderDetails(order: Order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const products = items.map(item => `<li>${escapeHtml(item.name)}${item.size ? ` · Talle ${escapeHtml(item.size)}` : ""} × ${escapeHtml(item.quantity)} — ${escapeHtml(money(Number(item.price) * Number(item.quantity)))}</li>`).join("");
  const address = order.address
    ? `${order.address}, ${order.city || ""}${order.postal_code ? ` (${order.postal_code})` : ""}`
    : "Retiro en el local · Castelli 695, Bahía Blanca";
  const date = order.created_at ? new Date(String(order.created_at)).toLocaleString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }) : "";
  return `<p><strong>Pedido:</strong> ${escapeHtml(order.order_number)}</p>
    ${date ? `<p><strong>Fecha:</strong> ${escapeHtml(date)}</p>` : ""}
    <h2>Tus datos</h2>
    <p><strong>Nombre:</strong> ${escapeHtml(order.customer_name)}</p>
    ${order.document ? `<p><strong>Documento:</strong> ${escapeHtml(order.document)}</p>` : ""}
    <p><strong>Teléfono:</strong> ${escapeHtml(order.phone)}</p>
    <p><strong>Email:</strong> ${escapeHtml(order.email)}</p>
    <h2>Productos</h2><ul>${products}</ul>
    <p><strong>Subtotal:</strong> ${escapeHtml(money(order.subtotal))}</p>
    <p><strong>Descuento:</strong> ${escapeHtml(money(order.discount))}</p>
    <p><strong>Total del pedido:</strong> ${escapeHtml(money(order.total))}</p>
    <h2>Entrega y pago</h2>
    <p><strong>Entrega:</strong> ${escapeHtml(order.delivery_method)}</p>
    <p><strong>Dirección:</strong> ${escapeHtml(address)}</p>
    ${order.address ? "<p>El costo del envío se coordina por separado.</p>" : ""}
    <p><strong>Forma de pago:</strong> ${escapeHtml(order.payment_method)}</p>
    <p><strong>Observaciones:</strong> ${escapeHtml(order.notes || "Sin observaciones")}</p>`;
}

export async function handleRequest(request: Request) {
  const origin = request.headers.get("origin");
  const headers = {
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Origin",
    ...(origin && allowedOrigins.has(origin) ? { "Access-Control-Allow-Origin": origin } : {})
  };
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return respond({ error: "Method not allowed" }, 405);
  let payload;
  try { payload = await request.json(); } catch { return respond({ error: "Invalid request" }, 400); }
  // Read-only readiness check: exposes no credentials, addresses or order data.
  if (payload?.checkConfiguration === true) return respond({ customerEmailConfigured });
  if (!RESEND_API_KEY || !SELLER_EMAIL || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return respond({ error: "Missing email configuration" }, 500);
  }
  const orderNumber = typeof payload?.orderNumber === "string" ? payload.orderNumber.trim().toUpperCase() : "";
  if (!/^(?:PAN(?:[0-9]{4}|[0-9]{8})AR|[A-F0-9]{8})$/.test(orderNumber)) return respond({ error: "Invalid order number" }, 400);
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const results: Record<string, string> = {};
  for (const recipient of ["seller", "customer"] as const) {
    if (recipient === "customer" && !customerEmailConfigured) {
      results.customer = "sender_not_configured";
      console.error("Customer confirmation requires a verified sending domain.");
      continue;
    }
    const column = recipient === "seller" ? "notification_sent_at" : "customer_confirmation_sent_at";
    const claimedAt = new Date().toISOString();
    const { data: order, error } = await client.from("orders")
      .update({ [column]: claimedAt }).eq("order_number", orderNumber)
      .is(column, null).select("*").maybeSingle();
    if (error) { results[recipient] = "lookup_failed"; continue; }
    if (!order) { results[recipient] = "already_sent_or_not_found"; continue; }
    try {
      if (recipient === "customer" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(order.email || "")) throw new Error("Invalid stored email");
      const details = orderDetails(order);
      const isCustomer = recipient === "customer";
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}`,
          "Idempotency-Key": `order-${order.id}-${recipient}-v1` },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          from: isCustomer ? CUSTOMER_FROM_EMAIL : FROM_EMAIL,
          to: [isCustomer ? order.email : SELLER_EMAIL],
          ...(isCustomer ? { reply_to: SELLER_EMAIL } : {}),
          subject: isCustomer ? `Recibimos tu pedido ${order.order_number} — Pandora DUP` : `Nueva compra ${order.order_number} — ${order.customer_name}`,
          html: isCustomer
            ? `<h1>¡Gracias por tu compra!</h1><p>Hola ${escapeHtml(order.customer_name)}, recibimos tu pedido. Guardá este correo con el detalle de tu compra.</p>${details}<p>La recepción del pedido no confirma la acreditación del pago. Nos comunicaremos para coordinar el pago y la entrega.</p><p><a href="https://pandoradup.github.io/account.html">Consultar el estado de mi pedido</a> con el número <strong>${escapeHtml(order.order_number)}</strong>.</p>`
            : `<h1>Nueva compra en Pandora DUP</h1>${details}`
        })
      });
      if (!response.ok) {
        console.error(`Order ${recipient} notification rejected: HTTP ${response.status}`);
        throw new Error("Email provider rejected notification");
      }
      await response.text();
      results[recipient] = "sent";
    } catch {
      await client.from("orders").update({ [column]: null }).eq("order_number", orderNumber).eq(column, claimedAt);
      results[recipient] = "failed";
    }
  }
  const failed = Object.values(results).some(result => ["failed", "lookup_failed", "sender_not_configured"].includes(result));
  return respond({ notifications: results }, failed ? 502 : 200);
}
Deno.serve(handleRequest);

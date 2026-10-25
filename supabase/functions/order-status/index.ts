// Public lookup by exact order number. Never return customer data or order items.
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

export async function handleRequest(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (req.method !== "POST") return respond({ error: "Método no permitido." }, 405);
  try {
    const reader = req.body?.getReader();
    if (!reader) return respond({ error: "Ingresá el número de pedido." }, 400);
    let body = "";
    let bytes = 0;
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024) {
        await reader.cancel();
        return respond({ error: "Solicitud demasiado grande." }, 413);
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    let input;
    try { input = JSON.parse(body); } catch { return respond({ error: "Solicitud inválida." }, 400); }
    const number = typeof input?.orderNumber === "string" ? input.orderNumber.trim().toUpperCase() : "";
    if (!/^[A-F0-9]{8}$/.test(number)) return respond({ error: "Ingresá los 8 caracteres del número de pedido." }, 400);

    const url = new URL("/rest/v1/orders", Deno.env.get("SUPABASE_URL"));
    url.searchParams.set("select", "status");
    url.searchParams.set("order_number", `eq.${number}`);
    url.searchParams.set("limit", "1");
    const secretKeys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const key = secretKeys.default || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!key) throw new Error("Missing server configuration");
    const authHeaders: Record<string, string> = { apikey: key };
    if (!key.startsWith("sb_secret_")) authHeaders.Authorization = `Bearer ${key}`;
    const result = await fetch(url, { headers: authHeaders, signal: AbortSignal.timeout(8000) });
    if (!result.ok) throw new Error("Order lookup unavailable");
    const rows = await result.json();
    if (!rows.length) return respond({ error: "No encontramos ese pedido. Revisá el número de tu comprobante." }, 404);
    const status = rows[0].status;
    if (!["pending", "contacted", "completed", "cancelled"].includes(status)) throw new Error("Unknown status");
    return respond({ orderNumber: number, status });
  } catch {
    return respond({ error: "No pudimos consultar tu pedido. Intentá nuevamente en unos minutos." }, 503);
  }
}

Deno.serve(handleRequest);

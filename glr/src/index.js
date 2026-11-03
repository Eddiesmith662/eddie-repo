/*
 * VSPEED GLR league site (vspeedlivetiming.app/glr). First version: a placeholder page and a health check that
 * confirms the database is connected. Results, drivers, sign-in and uploads come next.
 */
const html = body => new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>VSPEED GLR</title><style>
body{margin:0;background:#141416;color:#eee;font:15px/1.5 system-ui,Segoe UI,Arial,sans-serif;display:flex;justify-content:center;padding:40px 16px}
main{max-width:560px;width:100%}h1{font-size:20px;margin:0 0 14px;border-left:4px solid #FF0D40;padding-left:10px}.hint{color:#999}</style></head>
<body><main>${body}</main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    if (path === "/glr/health") {
      let db = "not connected";
      try { db = (await env.DB.prepare("SELECT 1 AS ok").first()).ok === 1 ? "connected" : "unexpected answer"; } catch (e) { db = "error: " + e.message; }
      return new Response(JSON.stringify({ ok: db === "connected", db }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    if (path === "/glr") return html('<h1>VSPEED GLR</h1><p class="hint">League results and standings are on the way.</p>');
    return html('<h1>Not found</h1><p class="hint">Check the link.</p>');
  },
};

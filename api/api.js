const CLIENT_ID     = process.env.CA_CLIENT_ID;
const CLIENT_SECRET = process.env.CA_CLIENT_SECRET;
const REDIRECT_URI  = process.env.CA_REDIRECT_URI;
const TOKEN_URL     = "https://auth.contaazul.com/oauth2/token";
const AUTH_URL      = "https://auth.contaazul.com/oauth2/authorize";
const API_BASE      = "https://api-v2.contaazul.com";
const SCOPE         = "openid profile aws.cognito.signin.user.admin";

const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseCookies(header = "") {
  return Object.fromEntries(
    (header || "").split(";").map(c => {
      const [k, ...v] = c.trim().split("=");
      return [k.trim(), v.join("=")];
    }).filter(([k]) => k)
  );
}

function getTokenFromCookie(cookieHeader) {
  try {
    const cookies = parseCookies(cookieHeader);
    if (!cookies.ca_token) return null;
    return JSON.parse(Buffer.from(cookies.ca_token, "base64").toString());
  } catch { return null; }
}

function getTokenFromEnv() {
  try {
    const raw = process.env.CA_TOKEN_DATA;
    if (!raw) return null;
    return JSON.parse(Buffer.from(raw, "base64").toString());
  } catch { return null; }
}

async function resolveToken(cookieHeader) {
  const fromCookie = getTokenFromCookie(cookieHeader);
  if (fromCookie) return { token: fromCookie, source: "cookie" };
  const fromEnv = getTokenFromEnv();
  if (fromEnv) return { token: fromEnv, source: "env" };
  return null;
}

async function saveTokenToEnv(payload) {
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId    = process.env.VERCEL_TEAM_ID || "";
  const apiToken  = process.env.VERCEL_API_TOKEN;
  if (!projectId || !apiToken) {
    console.warn("VERCEL_PROJECT_ID ou VERCEL_API_TOKEN ausente");
    return false;
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
  const teamParam = teamId ? `?teamId=${teamId}` : "";
  try {
    const resp = await fetch(
      `https://api.vercel.com/v10/projects/${projectId}/env${teamParam}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          key: "CA_TOKEN_DATA",
          value: encoded,
          type: "encrypted",
          target: ["production", "preview", "development"],
        }),
      }
    );
    if (resp.status === 409) {
      // Já existe — busca o ID e atualiza
      const listResp = await fetch(
        `https://api.vercel.com/v10/projects/${projectId}/env${teamParam}`,
        { headers: { "Authorization": `Bearer ${apiToken}` } }
      );
      const list = await listResp.json();
      const existing = (list.envs || []).find(e => e.key === "CA_TOKEN_DATA");
      if (existing) {
        const patchResp = await fetch(
          `https://api.vercel.com/v10/projects/${projectId}/env/${existing.id}${teamParam}`,
          {
            method: "PATCH",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${apiToken}`,
            },
            body: JSON.stringify({ value: encoded }),
          }
        );
        if (patchResp.ok) { console.log("Token atualizado no env Vercel"); return true; }
      }
    }
    if (resp.ok) { console.log("Token salvo no env Vercel"); return true; }
    console.error("Falha ao salvar token:", resp.status);
    return false;
  } catch (e) {
    console.error("saveTokenToEnv error:", e.message);
    return false;
  }
}

async function refreshAccessToken(refresh_token) {
  const body = new URLSearchParams({
    grant_type: "refresh_token", refresh_token,
    client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
  });
  const resp = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!resp.ok) return null;
  const t = await resp.json();
  return {
    access_token:  t.access_token,
    refresh_token: t.refresh_token || refresh_token,
    expires_at:    Date.now() + (t.expires_in || 3600) * 1000,
  };
}

async function caGet(path, access_token, params = {}, retries = 3) {
  const url = new URL(API_BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    if (resp.status === 429) { await sleep(Math.pow(2, attempt) * 1000); continue; }
    if (!resp.ok) throw new Error(`CA API ${resp.status}: ${await resp.text()}`);
    return resp.json();
  }
  throw new Error("Rate limit persistente");
}

async function fetchAll(path, token, extraParams = {}) {
  const items = [];
  let pagina = 1;
  while (true) {
    if (pagina > 1) await sleep(120);
    const data = await caGet(path, token, { pagina, tamanho_pagina: 100, ...extraParams });
    const list = data.itens || data.lista || data.content || data.items || [];
    if (!Array.isArray(list) || list.length === 0) break;
    items.push(...list);
    const total = data.itens_totais || data.total || 0;
    if (items.length >= total || list.length < 100) break;
    pagina++;
  }
  return items;
}

async function fetchFinancialData(access_token) {
  const now   = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);
  const fmt   = d => d.toISOString().slice(0, 10);
  const params = {
    data_vencimento_de:   fmt(start),
    data_vencimento_ate:  fmt(now),
    data_competencia_de:  fmt(start),
    data_competencia_ate: fmt(now),
  };
  const cr = await fetchAll("/v1/financeiro/eventos-financeiros/contas-a-receber/buscar", access_token, params);
  await sleep(300);
  const cp = await fetchAll("/v1/financeiro/eventos-financeiros/contas-a-pagar/buscar", access_token, params);
  return { cr, cp };
}

// ── Vercel handler ─────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");

  if (req.method === "OPTIONS") return res.status(204).end();

  const action = (req.query || {}).action;
  const cookieHeader = req.headers.cookie || "";

  if (action === "auth_url") {
    const url = `${AUTH_URL}?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=${encodeURIComponent(SCOPE)}&state=dashboard`;
    return res.status(200).json({ url });
  }

  if (action === "check") {
    const resolved = await resolveToken(cookieHeader);
    return res.status(200).json({ authenticated: !!resolved });
  }

  if (action === "logout") {
    res.setHeader("Set-Cookie", "ca_token=; Path=/; HttpOnly; Secure; Max-Age=0");
    return res.status(200).json({ ok: true });
  }

  const resolved = await resolveToken(cookieHeader);
  if (!resolved) return res.status(401).json({ error: "unauthenticated" });

  let { token, source } = resolved;

  if (Date.now() > token.expires_at - 60_000) {
    const refreshed = await refreshAccessToken(token.refresh_token);
    if (!refreshed) return res.status(401).json({ error: "token_expired" });
    token = refreshed;
    await saveTokenToEnv(token);
    if (source === "cookie") {
      const encoded = Buffer.from(JSON.stringify(token)).toString("base64");
      res.setHeader("Set-Cookie", `ca_token=${encoded}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
    }
  }

  try {
    const data = await fetchFinancialData(token.access_token);
    return res.status(200).json(data);
  } catch (err) {
    console.error("API error:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

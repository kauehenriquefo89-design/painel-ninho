const CLIENT_ID     = process.env.CA_CLIENT_ID;
const CLIENT_SECRET = process.env.CA_CLIENT_SECRET;
const REDIRECT_URI  = process.env.CA_REDIRECT_URI;
const TOKEN_URL     = "https://auth.contaazul.com/oauth2/token";
const AUTH_URL      = "https://auth.contaazul.com/oauth2/authorize";
const API_BASE      = "https://api-v2.contaazul.com";
const SCOPE         = "openid profile aws.cognito.signin.user.admin";

const GITHUB_OWNER = "kauehenriquefo89-design";
const GITHUB_REPO  = "painel-ninho";
const GITHUB_TOKEN_FILE = "data/token.json";
const GITHUB_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_TOKEN_FILE}`;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── GitHub token storage ───────────────────────────────────────────────────
async function getTokenFromGitHub() {
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) return null;
  try {
    const resp = await fetch(GITHUB_API, {
      headers: { "Authorization": `Bearer ${ghToken}`, "Accept": "application/vnd.github+json" }
    });
    if (!resp.ok) return null;
    const file = await resp.json();
    const content = Buffer.from(file.content, "base64").toString("utf8");
    return { token: JSON.parse(content), sha: file.sha };
  } catch { return null; }
}

async function saveTokenToGitHub(payload, sha) {
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) return false;
  const content = Buffer.from(JSON.stringify(payload)).toString("base64");
  try {
    const body = { message: "Atualiza token CA", content, ...(sha ? { sha } : {}) };
    const resp = await fetch(GITHUB_API, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${ghToken}`, "Accept": "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return resp.ok || resp.status === 201;
  } catch { return false; }
}

// ── Cookie token ───────────────────────────────────────────────────────────
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

// ── Resolve token: cookie > github ────────────────────────────────────────
async function resolveToken(cookieHeader) {
  const fromCookie = getTokenFromCookie(cookieHeader);
  if (fromCookie) return { token: fromCookie, source: "cookie", sha: null };
  const fromGH = await getTokenFromGitHub();
  if (fromGH) return { token: fromGH.token, source: "github", sha: fromGH.sha };
  return null;
}

// ── Refresh ────────────────────────────────────────────────────────────────
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

// ── CA API ─────────────────────────────────────────────────────────────────
async function caGet(path, access_token, params = {}, retries = 3) {
  const url = new URL(API_BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(url.toString(), { headers: { Authorization: `Bearer ${access_token}` } });
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
  // Busca 1: por data_competencia (DRE — regime competência)
  const paramsByComp = {
    data_competencia_de:  fmt(start),
    data_competencia_ate: fmt(now),
  };
  // Busca 2: por data_vencimento (Fluxo de Caixa — regime caixa)
  const paramsByVenc = {
    data_vencimento_de: fmt(start),
    data_vencimento_ate: fmt(now),
  };

  // Executa buscas sequencialmente para evitar rate limit
  const crComp = await fetchAll("/v1/financeiro/eventos-financeiros/contas-a-receber/buscar", access_token, paramsByComp);
  await sleep(200);
  const crVenc = await fetchAll("/v1/financeiro/eventos-financeiros/contas-a-receber/buscar", access_token, paramsByVenc);
  await sleep(200);
  const cpComp = await fetchAll("/v1/financeiro/eventos-financeiros/contas-a-pagar/buscar", access_token, paramsByComp);
  await sleep(200);
  const cpVenc = await fetchAll("/v1/financeiro/eventos-financeiros/contas-a-pagar/buscar", access_token, paramsByVenc);

  // UNION deduplicado por ID
  const mergeById = (a, b) => {
    const map = new Map();
    [...a, ...b].forEach(item => { if(item.id) map.set(item.id, item); });
    return Array.from(map.values());
  };

  const cr = mergeById(crComp, crVenc);
  const cp = mergeById(cpComp, cpVenc);
  return { cr, cp };
}

// ── Handler ────────────────────────────────────────────────────────────────
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

  let { token, source, sha } = resolved;

  if (Date.now() > token.expires_at - 60_000) {
    const refreshed = await refreshAccessToken(token.refresh_token);
    if (!refreshed) return res.status(401).json({ error: "token_expired" });
    token = refreshed;
    // Atualiza no GitHub (não precisa de redeploy)
    const current = await getTokenFromGitHub();
    await saveTokenToGitHub(token, current?.sha || sha);
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

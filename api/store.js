// store.js — dados do Excel via GitHub, com controle de acesso por unidade.
// Env vars (Vercel): ACCESS_KEY_FULL (Lapa+VM), ACCESS_KEY_VM (só VM).
// Se NENHUMA estiver definida, o acesso é liberado (compatível com o comportamento antigo).
const GITHUB_OWNER = "kauehenriquefo89-design";
const GITHUB_REPO  = "painel-ninho";
const GITHUB_BASE  = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents`;

const EXCEL_FILE = { lapa: "data/excel.json", vm: "data/excel-vm.json" };
function excelApi(unit) { return `${GITHUB_BASE}/${EXCEL_FILE[unit] || EXCEL_FILE.lapa}`; }

// ── Controle de acesso ──────────────────────────────────────────────────────
function accessLevel(req) {
  const full = process.env.ACCESS_KEY_FULL || "";
  const vm   = process.env.ACCESS_KEY_VM   || "";
  if (!full && !vm) return "full"; // nenhuma senha configurada -> libera (compat)
  const key = (req.headers && req.headers["x-access-key"]) || (req.query && req.query.key) || "";
  if (full && key === full) return "full";
  if (vm && key === vm) return "vm";
  return null;
}
function accessConfigured() {
  return !!(process.env.ACCESS_KEY_FULL || process.env.ACCESS_KEY_VM);
}

async function getFromGitHub(apiUrl) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  try {
    const resp = await fetch(apiUrl, { headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.github+json" } });
    if (resp.status === 404) return null;
    if (!resp.ok) return null;
    const file = await resp.json();
    const content = Buffer.from(file.content, "base64").toString("utf8");
    return { data: JSON.parse(content), sha: file.sha };
  } catch { return null; }
}

async function saveToGitHub(apiUrl, payload, sha, message) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return false;
  const content = Buffer.from(JSON.stringify(payload)).toString("base64");
  try {
    const body = { message: message || "Atualiza dados", content, ...(sha ? { sha } : {}) };
    const resp = await fetch(apiUrl, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return resp.ok || resp.status === 201;
  } catch { return false; }
}

const GITHUB_OFX_API = `${GITHUB_BASE}/data/ofx.json`;
async function getOFXFromGitHub() { return getFromGitHub(GITHUB_OFX_API); }
async function saveOFXToGitHub(payload, sha) { return saveToGitHub(GITHUB_OFX_API, payload, sha, "Atualiza extrato OFX"); }

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-access-key");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(204).end();

  const q = req.query || {};
  const action = q.action || "load";
  const unit = (q.unit || "lapa").toLowerCase();
  const level = accessLevel(req); // "full" | "vm" | null

  // Endpoint de verificacao de acesso (usado pela tela de login)
  if (action === "access") {
    return res.status(200).json({ level, configured: accessConfigured() });
  }

  // Quem pode acessar o que:
  //  - dados da Lapa (unit padrao) + OFX  -> so "full"
  //  - dados da VM (unit=vm)              -> "vm" ou "full"
  const isOfx = action === "load_ofx" || action === "save_ofx";
  const isVM = unit === "vm" && !isOfx;
  const requiredOk = isVM ? (level === "vm" || level === "full") : (level === "full");
  if (!requiredOk) return res.status(403).json({ error: "forbidden" });

  const apiUrl = excelApi(unit);

  if (req.method === "GET" && action === "load") {
    const result = await getFromGitHub(apiUrl);
    if (!result) return res.status(404).json({ error: "Nenhum dado salvo ainda" });
    return res.status(200).json(result.data);
  }

  if (req.method === "GET" && action === "info") {
    const result = await getFromGitHub(apiUrl);
    if (!result) return res.status(200).json({ exists: false });
    const d = result.data;
    return res.status(200).json({ exists: true, uploadedAt: d.uploadedAt, totalRows: d.totalRows, meses: d.meses, fileName: d.fileName, hasDespesas: Array.isArray(d.cpRows) });
  }

  if (req.method === "POST" && action === "save") {
    let payload;
    try { payload = req.body || {}; } catch { return res.status(400).json({ error: "JSON invalido" }); }
    const { atRows, cpRows, exRows, saldoIni, fileName } = payload;
    if (!atRows || !Array.isArray(atRows) || atRows.length === 0)
      return res.status(400).json({ error: "atRows vazio" });
    const meses = [...new Set(atRows.map(r => r.mes).filter(Boolean))].sort();
    const toSave = { atRows, totalRows: atRows.length, meses, fileName: fileName || (unit === "vm" ? "Painel - Vila Mariana.xlsx" : "Base.xlsx"), uploadedAt: new Date().toISOString() };
    if (Array.isArray(cpRows)) toSave.cpRows = cpRows;
    if (Array.isArray(exRows)) toSave.exRows = exRows;              // extrato bancario (fluxo diario)
    if (typeof saldoIni === "number") toSave.saldoIni = saldoIni;   // saldo bancario inicial
    const existing = await getFromGitHub(apiUrl);
    const ok = await saveToGitHub(apiUrl, toSave, existing && existing.sha || null, `Atualiza dados Excel (${unit})`);
    if (ok) return res.status(200).json({ ok: true, unit, totalRows: atRows.length, cpRows: (cpRows || []).length, exRows: (exRows || []).length, meses });
    return res.status(500).json({ error: "Falha ao salvar no GitHub" });
  }

  if (req.method === "GET" && action === "load_ofx") {
    const result = await getOFXFromGitHub();
    if (!result) return res.status(404).json({ error: "Nenhum extrato OFX salvo" });
    return res.status(200).json(result.data);
  }

  if (req.method === "POST" && action === "save_ofx") {
    let payload;
    try { payload = req.body || {}; } catch { return res.status(400).json({ error: "JSON invalido" }); }
    if (!payload.transactions || !payload.transactions.length)
      return res.status(400).json({ error: "transactions vazio" });
    const existing = await getOFXFromGitHub();
    const ok = await saveOFXToGitHub(payload, existing && existing.sha || null);
    if (ok) return res.status(200).json({ ok: true, total: payload.transactions.length });
    return res.status(500).json({ error: "Falha ao salvar OFX no GitHub" });
  }

  return res.status(405).json({ error: "Metodo nao permitido" });
};

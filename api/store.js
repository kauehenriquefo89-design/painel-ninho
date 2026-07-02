// store.js — salva e serve dados do Excel via GitHub (arquivos data/excel*.json no repositório)
// Suporta múltiplas unidades via ?unit=  →  Lapa: data/excel.json | Vila Mariana: data/excel-vm.json
const GITHUB_OWNER = "kauehenriquefo89-design";
const GITHUB_REPO  = "painel-ninho";
const GITHUB_BASE  = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents`;

// Mapa de unidade → arquivo. Só unidades conhecidas são aceitas (evita path injection).
const EXCEL_FILE = {
  lapa: "data/excel.json",
  vm:   "data/excel-vm.json",
};

function excelApi(unit) {
  const file = EXCEL_FILE[unit] || EXCEL_FILE.lapa;
  return `${GITHUB_BASE}/${file}`;
}

async function getFromGitHub(apiUrl) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  try {
    const resp = await fetch(apiUrl, {
      headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.github+json" }
    });
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
      headers: {
        "Authorization": `Bearer ${token}`,
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    return resp.ok || resp.status === 201;
  } catch { return false; }
}

const GITHUB_OFX_API = `${GITHUB_BASE}/data/ofx.json`;

async function getOFXFromGitHub() { return getFromGitHub(GITHUB_OFX_API); }
async function saveOFXToGitHub(payload, sha) {
  return saveToGitHub(GITHUB_OFX_API, payload, sha, "Atualiza extrato OFX");
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(204).end();

  const q = req.query || {};
  const action = q.action || "load";
  const unit = (q.unit || "lapa").toLowerCase();
  const apiUrl = excelApi(unit);

  // LOAD — retorna o dataset da unidade (Lapa: só atRows | VM: atRows + cpRows)
  if (req.method === "GET" && action === "load") {
    const result = await getFromGitHub(apiUrl);
    if (!result) return res.status(404).json({ error: "Nenhum dado salvo ainda" });
    return res.status(200).json(result.data);
  }

  // INFO
  if (req.method === "GET" && action === "info") {
    const result = await getFromGitHub(apiUrl);
    if (!result) return res.status(200).json({ exists: false });
    const d = result.data;
    return res.status(200).json({ exists: true, uploadedAt: d.uploadedAt, totalRows: d.totalRows, meses: d.meses, fileName: d.fileName, hasDespesas: Array.isArray(d.cpRows) });
  }

  // SAVE — grava o dataset da unidade
  if (req.method === "POST" && action === "save") {
    let payload;
    try { payload = req.body || {}; } catch { return res.status(400).json({ error: "JSON inválido" }); }

    const { atRows, cpRows, fileName } = payload;
    if (!atRows || !Array.isArray(atRows) || atRows.length === 0)
      return res.status(400).json({ error: "atRows vazio" });

    const meses = [...new Set(atRows.map(r => r.mes).filter(Boolean))].sort();
    const toSave = {
      atRows,
      totalRows: atRows.length,
      meses,
      fileName: fileName || (unit === "vm" ? "Painel - Vila Mariana.xlsx" : "Base.xlsx"),
      uploadedAt: new Date().toISOString()
    };
    // A Vila Mariana também guarda as despesas (a Lapa pega despesa do Conta Azul)
    if (Array.isArray(cpRows)) toSave.cpRows = cpRows;

    const existing = await getFromGitHub(apiUrl);
    const sha = existing?.sha || null;

    const ok = await saveToGitHub(apiUrl, toSave, sha, `Atualiza dados Excel (${unit})`);
    if (ok) return res.status(200).json({ ok: true, unit, totalRows: atRows.length, cpRows: (cpRows || []).length, meses });
    return res.status(500).json({ error: "Falha ao salvar no GitHub" });
  }

  // LOAD OFX
  if (req.method === "GET" && action === "load_ofx") {
    const result = await getOFXFromGitHub();
    if (!result) return res.status(404).json({ error: "Nenhum extrato OFX salvo" });
    return res.status(200).json(result.data);
  }

  // SAVE OFX
  if (req.method === "POST" && action === "save_ofx") {
    let payload;
    try { payload = req.body || {}; } catch { return res.status(400).json({ error: "JSON inválido" }); }
    if (!payload.transactions || !payload.transactions.length)
      return res.status(400).json({ error: "transactions vazio" });
    const existing = await getOFXFromGitHub();
    const sha = existing?.sha || null;
    const ok = await saveOFXToGitHub(payload, sha);
    if (ok) return res.status(200).json({ ok: true, total: payload.transactions.length });
    return res.status(500).json({ error: "Falha ao salvar OFX no GitHub" });
  }

  return res.status(405).json({ error: "Método não permitido" });
};

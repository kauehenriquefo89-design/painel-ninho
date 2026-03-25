const GITHUB_OWNER = "kauehenriquefo89-design";
const GITHUB_REPO  = "painel-ninho";
const GITHUB_FILE  = "data/excel.json";
const GITHUB_API   = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`;

async function getFromGitHub() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return null;
  try {
    const resp = await fetch(GITHUB_API, {
      headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.github+json" }
    });
    if (resp.status === 404) return null;
    if (!resp.ok) return null;
    const file = await resp.json();
    const content = Buffer.from(file.content, "base64").toString("utf8");
    return { data: JSON.parse(content), sha: file.sha };
  } catch { return null; }
}

async function saveToGitHub(payload, sha) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) return false;
  const content = Buffer.from(JSON.stringify(payload)).toString("base64");
  try {
    const body = { message: "Atualiza dados Excel", content, ...(sha ? { sha } : {}) };
    const resp = await fetch(GITHUB_API, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${token}`, "Accept": "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return resp.ok || resp.status === 201;
  } catch { return false; }
}

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(204).end();

  const action = (req.query || {}).action || "load";

  if (req.method === "GET" && action === "load") {
    const result = await getFromGitHub();
    if (!result) return res.status(404).json({ error: "Nenhum dado salvo ainda" });
    return res.status(200).json(result.data);
  }

  if (req.method === "GET" && action === "info") {
    const result = await getFromGitHub();
    if (!result) return res.status(200).json({ exists: false });
    const d = result.data;
    return res.status(200).json({ exists: true, uploadedAt: d.uploadedAt, totalRows: d.totalRows, meses: d.meses, fileName: d.fileName });
  }

  if (req.method === "POST" && action === "save") {
    let payload;
    try { payload = req.body || {}; } catch { return res.status(400).json({ error: "JSON inválido" }); }
    const { atRows, fileName } = payload;
    if (!atRows || !Array.isArray(atRows) || atRows.length === 0)
      return res.status(400).json({ error: "atRows vazio" });
    const meses = [...new Set(atRows.map(r => r.mes).filter(Boolean))].sort();
    const toSave = { atRows, totalRows: atRows.length, meses, fileName: fileName || "Base.xlsx", uploadedAt: new Date().toISOString() };
    const existing = await getFromGitHub();
    const sha = existing?.sha || null;
    const ok = await saveToGitHub(toSave, sha);
    if (ok) return res.status(200).json({ ok: true, totalRows: atRows.length, meses });
    return res.status(500).json({ error: "Falha ao salvar no GitHub" });
  }

  return res.status(405).json({ error: "Método não permitido" });
};

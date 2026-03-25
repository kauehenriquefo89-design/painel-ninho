module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(204).end();

  const action = (req.query || {}).action || "load";

  // LOAD — retorna dados do Excel salvos em env var
  if (req.method === "GET" && action === "load") {
    const raw = process.env.EXCEL_DATA;
    if (!raw) return res.status(404).json({ error: "Nenhum dado salvo ainda" });
    try {
      return res.status(200).json(JSON.parse(Buffer.from(raw, "base64").toString()));
    } catch { return res.status(500).json({ error: "Dados corrompidos" }); }
  }

  // INFO
  if (req.method === "GET" && action === "info") {
    const raw = process.env.EXCEL_DATA;
    if (!raw) return res.status(200).json({ exists: false });
    try {
      const d = JSON.parse(Buffer.from(raw, "base64").toString());
      return res.status(200).json({ exists: true, uploadedAt: d.uploadedAt, totalRows: d.totalRows, meses: d.meses, fileName: d.fileName });
    } catch { return res.status(200).json({ exists: false }); }
  }

  // SAVE — salva dados do Excel via Vercel API
  if (req.method === "POST" && action === "save") {
    let payload;
    try { payload = req.body || {}; } catch { return res.status(400).json({ error: "JSON inválido" }); }

    const { atRows, fileName } = payload;
    if (!atRows || !Array.isArray(atRows) || atRows.length === 0)
      return res.status(400).json({ error: "atRows vazio" });

    const projectId = process.env.VERCEL_PROJECT_ID;
    const teamId    = process.env.VERCEL_TEAM_ID || "";
    const apiToken  = process.env.VERCEL_API_TOKEN;
    if (!projectId || !apiToken)
      return res.status(503).json({ error: "VERCEL_PROJECT_ID ou VERCEL_API_TOKEN ausente" });

    const meses = [...new Set(atRows.map(r => r.mes).filter(Boolean))].sort();
    const toSave = JSON.stringify({ atRows, totalRows: atRows.length, meses, fileName: fileName || "Base.xlsx", uploadedAt: new Date().toISOString() });
    const encoded = Buffer.from(toSave).toString("base64");
    const teamParam = teamId ? `?teamId=${teamId}` : "";

    try {
      let resp = await fetch(`https://api.vercel.com/v10/projects/${projectId}/env${teamParam}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiToken}` },
        body: JSON.stringify({ key: "EXCEL_DATA", value: encoded, type: "encrypted", target: ["production","preview","development"] }),
      });
      if (resp.status === 409) {
        const list = await (await fetch(`https://api.vercel.com/v10/projects/${projectId}/env${teamParam}`, {
          headers: { "Authorization": `Bearer ${apiToken}` }
        })).json();
        const ex = (list.envs || []).find(e => e.key === "EXCEL_DATA");
        if (ex) {
          resp = await fetch(`https://api.vercel.com/v10/projects/${projectId}/env/${ex.id}${teamParam}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiToken}` },
            body: JSON.stringify({ value: encoded }),
          });
        }
      }
      if (resp.ok) return res.status(200).json({ ok: true, totalRows: atRows.length, meses });
      return res.status(500).json({ error: "Falha ao salvar" });
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  return res.status(405).json({ error: "Método não permitido" });
};

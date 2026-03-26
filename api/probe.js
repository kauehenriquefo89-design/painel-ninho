// probe.js — endpoint temporário para descobrir campos disponíveis no CA
// Acesse: /api/probe para ver os resultados

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Content-Type", "application/json");

  const TOKEN_URL = "https://auth.contaazul.com/oauth2/token";
  const BASE = "https://api-v2.contaazul.com";

  // Pega token do GitHub (mesmo esquema do api.js)
  const GITHUB_OWNER = "kauehenriquefo89-design";
  const GITHUB_REPO  = "painel-ninho";
  const GITHUB_FILE  = "data/token.json";
  const GITHUB_API   = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`;

  let token = null;
  try {
    const ghToken = process.env.GITHUB_TOKEN;
    const r = await fetch(GITHUB_API, { headers: { "Authorization": `Bearer ${ghToken}`, "Accept": "application/vnd.github+json" } });
    if (r.ok) {
      const f = await r.json();
      const payload = JSON.parse(Buffer.from(f.content, "base64").toString("utf8"));
      token = payload.access_token;
    }
  } catch(e) { return res.status(500).json({ error: "Erro ao buscar token: " + e.message }); }

  if (!token) return res.status(401).json({ error: "Token não encontrado" });

  const results = {};

  async function probe(name, path, params = {}) {
    const url = new URL(BASE + path);
    Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
    try {
      const r = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        const d = await r.json();
        const items = d.itens || d.lista || d.content || d.items || (Array.isArray(d) ? d : [d]);
        const first = items[0];
        results[name] = {
          status: r.status,
          total: d.itens_totais || d.total || items.length,
          fields: first ? Object.keys(first) : [],
          date_fields: first ? Object.entries(first).filter(([k]) => k.includes('data') || k.includes('date')).reduce((a,[k,v]) => ({...a,[k]:v}), {}) : {},
          sample: first || null
        };
      } else {
        const txt = await r.text();
        results[name] = { status: r.status, error: txt.slice(0, 300) };
      }
    } catch(e) {
      results[name] = { status: 0, error: e.message };
    }
  }

  const now = new Date().toISOString().slice(0,10);
  const start = "2026-01-01";

  // Testa endpoints disponíveis
  await probe("cr_buscar", "/v1/financeiro/eventos-financeiros/contas-a-receber/buscar", {
    data_vencimento_de: start, data_vencimento_ate: now, pagina: 1, tamanho_pagina: 1
  });
  await probe("cp_buscar", "/v1/financeiro/eventos-financeiros/contas-a-pagar/buscar", {
    data_vencimento_de: start, data_vencimento_ate: now, pagina: 1, tamanho_pagina: 1
  });
  await probe("baixas_cr", "/v1/financeiro/baixas-de-contas-a-receber", {
    data_pagamento_de: start, data_pagamento_ate: now, pagina: 1, tamanho_pagina: 1
  });
  await probe("baixas_cp", "/v1/financeiro/baixas-de-contas-a-pagar", {
    data_pagamento_de: start, data_pagamento_ate: now, pagina: 1, tamanho_pagina: 1
  });
  await probe("extrato", "/v1/financeiro/extratos", {
    data_de: start, data_ate: now, pagina: 1, tamanho_pagina: 1
  });

  return res.status(200).json(results);
};

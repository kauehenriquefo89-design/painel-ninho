// pluggy.js — integração com Pluggy para extrato bancário real
// GET  ?action=connect_token  → gera token para abrir o widget
// GET  ?action=items          → lista contas conectadas
// GET  ?action=transactions   → busca transações com data real
// POST ?action=save_item      → salva itemId após conexão

const PLUGGY_BASE = "https://api.pluggy.ai";
const GITHUB_OWNER = "kauehenriquefo89-design";
const GITHUB_REPO  = "painel-ninho";
const GITHUB_ITEMS_FILE = "data/pluggy-items.json";
const GITHUB_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_ITEMS_FILE}`;

// ── Auth: gera API Key do Pluggy ──────────────────────────────────────────
async function getPluggyApiKey() {
  const clientId = process.env.PLUGGY_CLIENT_ID;
  const clientSecret = process.env.PLUGGY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("PLUGGY_CLIENT_ID ou PLUGGY_CLIENT_SECRET não configurado nas variáveis de ambiente");
  }
  const resp = await fetch(`${PLUGGY_BASE}/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientId, clientSecret }),
  });
  if (!resp.ok) {
    const txt = await resp.text();
    throw new Error(`Pluggy auth failed: ${resp.status} — ${txt.slice(0,300)}`);
  }
  const d = await resp.json();
  if (!d.apiKey) throw new Error(`Pluggy auth: apiKey ausente na resposta: ${JSON.stringify(d)}`);
  return d.apiKey;
}

// ── GitHub: salva/carrega itemIds ─────────────────────────────────────────
async function getItemsFromGitHub() {
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) return null;
  try {
    const r = await fetch(GITHUB_API, {
      headers: { "Authorization": `Bearer ${ghToken}`, "Accept": "application/vnd.github+json" }
    });
    if (r.status === 404) return { items: [] };
    if (!r.ok) return null;
    const f = await r.json();
    return JSON.parse(Buffer.from(f.content, "base64").toString("utf8"));
  } catch { return null; }
}

async function saveItemsToGitHub(data) {
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) return false;
  let sha = null;
  try {
    const r = await fetch(GITHUB_API, { headers: { "Authorization": `Bearer ${ghToken}`, "Accept": "application/vnd.github+json" } });
    if (r.ok) { const f = await r.json(); sha = f.sha; }
  } catch {}
  const content = Buffer.from(JSON.stringify(data)).toString("base64");
  try {
    const resp = await fetch(GITHUB_API, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${ghToken}`, "Accept": "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify({ message: "Atualiza Pluggy items", content, ...(sha ? { sha } : {}) })
    });
    return resp.ok || resp.status === 201;
  } catch { return false; }
}

// ── Handler ────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Content-Type", "application/json");
  if (req.method === "OPTIONS") return res.status(204).end();

  const action = (req.query || {}).action;

  // ── connect_token: gera token para o widget ──────────────────────────────
  if (action === "connect_token") {
    try {
      const apiKey = await getPluggyApiKey();
      const resp = await fetch(`${PLUGGY_BASE}/connect_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
        body: JSON.stringify({}),
      });
      if (!resp.ok) throw new Error(`connect_token failed: ${await resp.text()}`);
      const d = await resp.json();
      return res.status(200).json({ accessToken: d.accessToken });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── save_item: salva itemId após conexão via widget ──────────────────────
  if (req.method === "POST" && action === "save_item") {
    const body = req.body || {};
    const { itemId } = body;
    if (!itemId) return res.status(400).json({ error: "itemId obrigatório" });
    const existing = await getItemsFromGitHub() || { items: [] };
    if (!existing.items.includes(itemId)) {
      existing.items.push(itemId);
    }
    await saveItemsToGitHub(existing);
    return res.status(200).json({ ok: true });
  }

  // ── transactions: busca transações com data real ─────────────────────────
  if (action === "transactions") {
    try {
      const apiKey = await getPluggyApiKey();
      const stored = await getItemsFromGitHub();
      if (!stored || !stored.items || stored.items.length === 0) {
        return res.status(404).json({ error: "Nenhuma conta bancária conectada" });
      }

      const from = req.query.from || new Date(new Date().getFullYear(), new Date().getMonth() - 11, 1).toISOString().slice(0,10);
      const to   = req.query.to   || new Date().toISOString().slice(0,10);

      // Para cada item, busca as contas e depois as transações
      const allTransactions = [];
      for (const itemId of stored.items) {
        // Busca contas do item
        const accResp = await fetch(`${PLUGGY_BASE}/accounts?itemId=${itemId}`, {
          headers: { "X-API-KEY": apiKey }
        });
        if (!accResp.ok) continue;
        const accData = await accResp.json();
        const accounts = accData.results || [];

        for (const acc of accounts) {
          // Busca transações da conta
          let page = 1, hasMore = true;
          while (hasMore) {
            const txResp = await fetch(
              `${PLUGGY_BASE}/transactions?accountId=${acc.id}&from=${from}&to=${to}&pageSize=500&page=${page}`,
              { headers: { "X-API-KEY": apiKey } }
            );
            if (!txResp.ok) break;
            const txData = await txResp.json();
            const txs = txData.results || [];
            allTransactions.push(...txs.map(tx => ({
              id: tx.id,
              date: tx.date,           // DATA REAL da transação
              amount: tx.amount,       // positivo = crédito, negativo = débito
              description: tx.description,
              type: tx.type,           // CREDIT ou DEBIT
              category: tx.category,
              accountId: acc.id,
              accountName: acc.name,
            })));
            hasMore = txData.total > page * 500;
            page++;
            if (page > 10) break;
          }
        }
      }

      return res.status(200).json({
        transactions: allTransactions,
        total: allTransactions.length,
        from, to
      });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── status: verifica se há conta conectada ───────────────────────────────
  if (action === "status") {
    const stored = await getItemsFromGitHub();
    const connected = stored && stored.items && stored.items.length > 0;
    return res.status(200).json({ connected, items: stored?.items || [] });
  }

  return res.status(405).json({ error: "Ação não reconhecida" });
};

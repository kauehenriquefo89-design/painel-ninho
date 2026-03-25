const CLIENT_ID     = process.env.CA_CLIENT_ID;
const CLIENT_SECRET = process.env.CA_CLIENT_SECRET;
const REDIRECT_URI  = process.env.CA_REDIRECT_URI;
const TOKEN_URL     = "https://auth.contaazul.com/oauth2/token";

const GITHUB_OWNER = "kauehenriquefo89-design";
const GITHUB_REPO  = "painel-ninho";
const GITHUB_FILE  = "data/token.json";
const GITHUB_API   = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_FILE}`;

async function saveTokenToGitHub(payload) {
  const ghToken = process.env.GITHUB_TOKEN;
  if (!ghToken) return false;
  let sha = null;
  try {
    const r = await fetch(GITHUB_API, { headers: { "Authorization": `Bearer ${ghToken}`, "Accept": "application/vnd.github+json" } });
    if (r.ok) { const f = await r.json(); sha = f.sha; }
  } catch {}
  const content = Buffer.from(JSON.stringify(payload)).toString("base64");
  try {
    const body = { message: "Atualiza token CA", content, ...(sha ? { sha } : {}) };
    const resp = await fetch(GITHUB_API, {
      method: "PUT",
      headers: { "Authorization": `Bearer ${ghToken}`, "Accept": "application/vnd.github+json", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return resp.ok || resp.status === 201;
  } catch (e) { console.error(e.message); return false; }
}

module.exports = async (req, res) => {
  const { code, error } = req.query || {};
  if (error) return res.redirect("/?auth=denied");
  if (!code)  return res.redirect("/?auth=missing_code");

  try {
    const body = new URLSearchParams({
      grant_type: "authorization_code", code,
      redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
    });
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!resp.ok) { console.error("Token error:", await resp.text()); return res.redirect("/?auth=token_error"); }

    const tokens  = await resp.json();
    const payload = {
      access_token:  tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at:    Date.now() + (tokens.expires_in || 3600) * 1000,
    };

    await saveTokenToGitHub(payload);

    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
    res.setHeader("Set-Cookie", `ca_token=${encoded}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
    return res.redirect("/");
  } catch (err) {
    console.error("Callback error:", err);
    return res.redirect("/?auth=server_error");
  }
};

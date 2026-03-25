const CLIENT_ID     = process.env.CA_CLIENT_ID;
const CLIENT_SECRET = process.env.CA_CLIENT_SECRET;
const REDIRECT_URI  = process.env.CA_REDIRECT_URI;
const TOKEN_URL     = "https://auth.contaazul.com/oauth2/token";

async function saveTokenToEnv(payload) {
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId    = process.env.VERCEL_TEAM_ID || "";
  const apiToken  = process.env.VERCEL_API_TOKEN;
  if (!projectId || !apiToken) { console.warn("Env vars ausentes"); return false; }
  const encoded   = Buffer.from(JSON.stringify(payload)).toString("base64");
  const teamParam = teamId ? `?teamId=${teamId}` : "";
  try {
    let resp = await fetch(`https://api.vercel.com/v10/projects/${projectId}/env${teamParam}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiToken}` },
      body: JSON.stringify({ key: "CA_TOKEN_DATA", value: encoded, type: "encrypted", target: ["production","preview","development"] }),
    });
    if (resp.status === 409) {
      const list = await (await fetch(`https://api.vercel.com/v10/projects/${projectId}/env${teamParam}`, {
        headers: { "Authorization": `Bearer ${apiToken}` }
      })).json();
      const ex = (list.envs || []).find(e => e.key === "CA_TOKEN_DATA");
      if (ex) {
        resp = await fetch(`https://api.vercel.com/v10/projects/${projectId}/env/${ex.id}${teamParam}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiToken}` },
          body: JSON.stringify({ value: encoded }),
        });
      }
    }
    console.log("Token salvo:", resp.ok);
    return resp.ok;
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

    await saveTokenToEnv(payload);

    const encoded = Buffer.from(JSON.stringify(payload)).toString("base64");
    res.setHeader("Set-Cookie", `ca_token=${encoded}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
    return res.redirect("/");
  } catch (err) {
    console.error("Callback error:", err);
    return res.redirect("/?auth=server_error");
  }
};

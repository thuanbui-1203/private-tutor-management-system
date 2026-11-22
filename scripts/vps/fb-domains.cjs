/* eslint-disable @typescript-eslint/no-require-imports -- plain CommonJS script run with node */
// Usage: node fb-domains.cjs <keyfile> [domain-to-add]
const { cert } = require(require.resolve('firebase-admin/app', { paths: [process.cwd()] }));
const [key, add] = process.argv.slice(2);
const sa = require(key);
(async () => {
  const { access_token } = await cert(sa).getAccessToken();
  const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${sa.project_id}/config`;
  const h = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };
  const cfg = await (await fetch(url, { headers: h })).json();
  if (cfg.error) throw new Error(JSON.stringify(cfg.error));
  let domains = cfg.authorizedDomains ?? [];
  console.log('before:', domains.join(', '));
  if (add && !domains.includes(add)) {
    domains = [...domains, add];
    const r = await (
      await fetch(`${url}?updateMask=authorizedDomains`, {
        method: 'PATCH',
        headers: h,
        body: JSON.stringify({ authorizedDomains: domains }),
      })
    ).json();
    if (r.error) throw new Error(JSON.stringify(r.error));
    console.log('after: ', r.authorizedDomains.join(', '));
  }
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});

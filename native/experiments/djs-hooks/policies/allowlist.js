// Header-only policy: host allowlist, header rewrite, secret placeholder check.
const ALLOWED = ["api.example.com", "*.github.com", "registry.npmjs.org"];
// placeholder -> hosts it may be sent to
const SECRETS = { GONDOLIN_SECRET_GH_TOKEN: ["api.github.com"] };

function hostAllowed(host) {
  return ALLOWED.some((p) => (p.startsWith("*.") ? host.endsWith(p.slice(1)) : host === p));
}

async function onRequest(req) {
  const url = new URL(req.url);
  if (!hostAllowed(url.hostname)) {
    return new Response(`blocked: ${url.hostname}`, { status: 403 });
  }
  for (const [name, value] of req.headers) {
    for (const [placeholder, hosts] of Object.entries(SECRETS)) {
      if (value.includes(placeholder) && !hosts.includes(url.hostname)) {
        return new Response(`secret ${placeholder} not allowed in ${name} for ${url.hostname}`, {
          status: 403,
        });
      }
    }
  }
  req.headers.set("x-gondolin-policy", "v1");
  req.headers.delete("x-debug-token");
  return req;
}

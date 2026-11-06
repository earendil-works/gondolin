// Body policy: inspects JSON uploads. Reads a clone so the original body can
// still be forwarded (the WHATWG rule the node engine enforces too).
async function onRequest(req) {
  if (req.method !== "POST") return undefined;
  const text = await req.clone().text();
  if (text.includes("DROP TABLE")) {
    return Response.json({ error: "rejected by policy" }, { status: 400 });
  }
  return undefined;
}

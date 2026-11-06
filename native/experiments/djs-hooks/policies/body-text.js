// Reads the body as text and ignores it: the cost of moving 64 KiB in.
async function onRequest(req) {
  await req.clone().text();
}

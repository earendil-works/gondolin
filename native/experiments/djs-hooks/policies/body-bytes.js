// Reads the body as a Uint8Array and ignores it.
async function onRequest(req) {
  await req.clone().bytes();
}

/**
 * Run a Browser Use agent against Chromium isolated inside Gondolin.
 *
 * Build the example image first:
 *   node host/bin/gondolin.ts build \
 *     --config host/examples/chromium.json \
 *     --tag browser-use:latest
 *
 * Then run (requires `uv` on the host):
 *   OPENAI_API_KEY=... node host/examples/browser-use.ts
 *
 * Set `BROWSER_USE_IMAGE` to use a different image and `OPENAI_MODEL` to pick
 * a different model.
 */

import { once } from "node:events";
import { spawn } from "node:child_process";

import { VM } from "../src/vm/core.ts";

const CDP_PORT = 9222;
const CDP_TIMEOUT_MS = 15_000;
const IMAGE = process.env.BROWSER_USE_IMAGE ?? "browser-use:latest";

const browserUseAgent = String.raw`
import asyncio
import os
import sys

from browser_use import Agent
from browser_use.browser import BrowserProfile, BrowserSession
from browser_use.llm import ChatOpenAI


async def main() -> None:
    cdp_url = sys.argv[1]
    browser = BrowserSession(
        browser_profile=BrowserProfile(cdp_url=cdp_url, is_local=False)
    )
    agent = Agent(
        task="Open https://example.com and return its heading.",
        llm=ChatOpenAI(model=os.getenv("OPENAI_MODEL", "gpt-5.6-luna")),
        browser_session=browser,
    )
    history = await agent.run(max_steps=4)
    result = history.final_result() or ""
    print(f"Browser Use result: {result}")
    if "Example Domain" not in result:
        raise RuntimeError("Browser Use did not return the expected heading")


asyncio.run(main())
`;

async function waitForCdp(cdpUrl: string): Promise<void> {
  const deadline = Date.now() + CDP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${cdpUrl}/json/version`);
      if (response.ok) return;
    } catch {
      // Chromium is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Chromium CDP did not become ready at ${cdpUrl}`);
}

async function main(): Promise<void> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required");
  }

  const vm = await VM.create({ sandbox: { imagePath: IMAGE } });
  let ingress: Awaited<ReturnType<typeof vm.enableIngress>> | undefined;
  let closing = false;
  let chromiumError: unknown;

  try {
    ingress = await vm.enableIngress({
      listenHost: "127.0.0.1",
      listenPort: 0,
    });
    vm.setIngressRoutes([{ prefix: "/", port: CDP_PORT, stripPrefix: false }]);

    const chromium = vm.exec(
      [
        "/usr/bin/chromium",
        "--headless",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        // Ingress only reaches guest loopback services.
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${CDP_PORT}`,
        "--user-data-dir=/tmp/browser-use-profile",
        "about:blank",
      ],
      { buffer: false },
    );
    void chromium.catch((error) => {
      if (!closing) chromiumError = error;
    });

    await waitForCdp(ingress.url);
    if (chromiumError) throw chromiumError;
    console.log(`Gondolin Chromium CDP: ${ingress.url}`);

    const child = spawn(
      "uv",
      [
        "run",
        "--with",
        "browser-use",
        "--with",
        "openai",
        "python",
        "-c",
        browserUseAgent,
        ingress.url,
      ],
      { env: process.env, stdio: "inherit" },
    );
    const [code] = (await once(child, "exit")) as [number | null];
    if (code !== 0) throw new Error(`Browser Use exited with code ${code}`);
  } finally {
    closing = true;
    await ingress?.close();
    await vm.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

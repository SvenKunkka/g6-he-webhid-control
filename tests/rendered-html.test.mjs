import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the G6 HE control lab", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>G6 HE Control Lab<\/title>/i);
  assert.match(html, /连接 G6 HE/);
  assert.match(html, /DPI 曲线/);
  assert.match(html, /回报率/);
  assert.match(html, /20K FPS/);
  assert.match(html, /按键映射/);
  assert.match(html, /死机恢复/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("keeps HID writes target-scoped and guarded", async () => {
  const source = await readFile(
    new URL("../app/components/G6Console.tsx", import.meta.url),
    "utf8",
  );

  assert.match(source, /const VID = 0x3434/);
  assert.match(source, /const PID = 0xd086/);
  assert.match(source, /usagePage === 0xffc1/);
  assert.match(source, /需要唯一一只 G6 HE/);
  assert.match(source, /fps20kSupport=false/);
  assert.match(source, /已阻止越界写入/);
  assert.match(source, /sendFeatureReport/);
  assert.doesNotMatch(source, /sendReport\(/);
});

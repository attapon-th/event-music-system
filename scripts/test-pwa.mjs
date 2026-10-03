// Check real icon assets and the installation script without an external service.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { PNG } from "pngjs";

const publicDir = new URL("../public/", import.meta.url);
const read = file => readFileSync(new URL(file, publicDir));
const manifest = JSON.parse(read("manifest.webmanifest"));
assert.equal(manifest.name, "คิวเพลิน");
assert.equal(manifest.id, "/");
assert.equal(manifest.start_url, "/");
assert.equal(manifest.scope, "/");
assert.equal(manifest.display, "standalone");
for (const icon of manifest.icons) {
  const png = PNG.sync.read(read(icon.src.slice(1)));
  assert.equal(icon.sizes, `${png.width}x${png.height}`);
  if (icon.purpose === "maskable") {
    assert.equal(png.width, 512);
    for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
      const i = (y * png.width + x) * 4;
      assert.equal(png.data[i + 3], 255, "Maskable icons have a full opaque background");
      if (png.data[i] > 150) assert.ok(Math.hypot(x - 256, y - 256) <= 512 * .4, "Logo stays in the maskable safe circle");
    }
  }
}
assert.equal(PNG.sync.read(read("icons/qp-180.png")).width, 180);
const ico = read("favicon.ico");
assert.equal(ico.readUInt16LE(2), 1);
assert.equal(ico.readUInt16LE(4), 2);
for (const [i, size] of [16, 32].entries()) {
  const entry = 6 + i * 16;
  const offset = ico.readUInt32LE(entry + 12);
  const length = ico.readUInt32LE(entry + 8);
  assert.equal(PNG.sync.read(ico.subarray(offset, offset + length)).width, size);
}
for (const page of ["host", "guest", "admin"]) {
  const html = read(`${page}.html`).toString();
  assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/);
  assert.match(html, /rel="apple-touch-icon" href="\/icons\/qp-180.png"/);
  assert.match(html, /rel="icon".*href="\/icons\/qp.svg"/);
  if (page === "host") {
    assert.match(html, /src="\/session.js"[\s\S]*src="\/pwa.js"/);
  } else {
    assert.doesNotMatch(html, /src="\/pwa.js"/);
  }
}
const source = ["i18n.js", "pwa.js"].map(file => read(file).toString()).join("\n");
assert.doesNotMatch(source, /serviceWorker/);
function page({ ios = false, ipad = false, standalone = false, welcome = true } = {}) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, textContent: "", open: false,
      querySelector: () => node(`${id}:label`),
      append(child) { child.parentElement = this; },
      showModal() { this.open = true; }, close() { this.open = false; },
    });
    return nodes.get(id);
  };
  const listeners = {};
  const media = { matches: standalone, addEventListener(type, fn) { this.change = fn; } };
  const context = createContext({
    matchMedia: () => media, addEventListener: (type, fn) => listeners[type] = fn,
    navigator: { userAgent: ios ? "iPhone Safari" : "Chrome", platform: ipad ? "MacIntel" : "", maxTouchPoints: ipad ? 5 : 0 },
    document: { createElement: () => node("tools"), getElementById: id => id === "room-welcome" && !welcome ? null : node(id), querySelectorAll: () => [] },
  });
  runInContext(source, context);
  return { node, listeners, media };
}
const desktop = page();
assert.equal(desktop.node("tools").hidden, true);
let prompted = 0;
let prevented = false;
desktop.listeners.beforeinstallprompt({ preventDefault() { prevented = true; }, async prompt() { prompted++; }, userChoice: Promise.resolve({ outcome: "accepted" }) });
assert.equal(prevented, true);
assert.equal(desktop.node("tools").hidden, false);
assert.equal(desktop.node("tools").parentElement, desktop.node("room-welcome"), "Install UI belongs to the welcome screen and inherits its room visibility");
await desktop.node("install-app").onclick();
assert.equal(prompted, 1);
await desktop.node("install-app").onclick();
assert.equal(prompted, 1, "Install prompts cannot be reused");
desktop.listeners.appinstalled();
assert.equal(desktop.node("tools").hidden, true);
const failed = page();
failed.listeners.beforeinstallprompt({ preventDefault() {}, async prompt() { throw new Error("unavailable"); } });
await failed.node("install-app").onclick();
assert.equal(failed.node("tools").hidden, false, "Installation errors remain visible after the prompt is consumed");
assert.match(failed.node("install-status").textContent, /browser/);
assert.equal(failed.node("install-app").hidden, true);
for (const options of [{ ios: true }, { ipad: true }]) {
  const ios = page(options);
  assert.equal(ios.node("tools").hidden, false);
  await ios.node("install-app").onclick();
  assert.equal(ios.node("install-help").open, true);
  ios.listeners.appinstalled();
  assert.equal(ios.node("install-help").open, false);
  assert.equal(ios.node("tools").hidden, true);
}
const installed = page({ standalone: true, ios: true });
assert.equal(installed.node("tools").hidden, true);
assert.equal(page({ welcome: false }).listeners.beforeinstallprompt, undefined, "Other pages do not register installation UI");
console.log("PASS: SVG/ICO/PNG sizes, maskable safe area, manifest identity, welcome-only install UI, Chromium install prompt, iPhone/iPad home-screen help, standalone visibility (DOM simulated).");

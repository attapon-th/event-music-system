// Optional real Chromium regression suite, using the existing ws dependency for CDP.
// Run: BROWSER_BIN=/path/to/chromium node scripts/test-browser.mjs
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, cpSync, symlinkSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import WebSocket from 'ws';

const root = resolve(import.meta.dirname, '..');
const cache = join(homedir(), '.cache/ms-playwright');
const cached = existsSync(cache) ? readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort().reverse().map(name => join(cache, name, 'chrome-linux64/chrome')) : [];
const binary = [process.env.BROWSER_BIN, '/usr/bin/chromium', '/usr/bin/chromium-browser', ...cached].find(file => file && existsSync(file));
assert.ok(binary, 'Set BROWSER_BIN to an installed Chromium executable');
const temp = mkdtempSync(join(tmpdir(), 'music-ui-test-'));
const artifacts = process.env.BROWSER_ARTIFACTS || join(tmpdir(), 'music-ui-screenshots');
mkdirSync(artifacts, { recursive: true });
for (const file of ['server.js', 'src', 'public', 'package.json']) cpSync(join(root, file), join(temp, file), { recursive: true });
cpSync(join(root, 'scripts/fixtures/youtube-ui.mjs'), join(temp, 'youtube-ui.mjs'));
symlinkSync(join(root, 'node_modules'), join(temp, 'node_modules'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function port() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const number = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return number;
}
async function until(fn, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) { if (await fn()) return; await delay(50); }
  throw new Error(`Timed out: ${label}`);
}
class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.errors = [];
    ws.on('close', () => { for (const request of this.pending.values()) request.reject(new Error('CDP connection closed')); this.pending.clear(); });
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      if (msg.id) {
        const request = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (!request) return;
        if (msg.error) request.reject(new Error(msg.error.message)); else request.resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') this.errors.push(msg.params.exceptionDetails);
      else if (msg.method === 'Inspector.detached') ws.close();
      else if (msg.method === 'Fetch.requestPaused') this.call('Fetch.fulfillRequest', { requestId: msg.params.requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: 'image/svg+xml' }], body: readFileSync(join(root, 'public/icons/qp.svg')).toString('base64') });
    });
  }
  static async connect(url) { const ws = new WebSocket(url); await once(ws, 'open'); return new CDP(ws); }
  call(method, params = {}) { if (this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP connection closed')); return new Promise((resolve, reject) => { const id = ++this.seq; const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000); this.pending.set(id, { resolve: result => {clearTimeout(timer);resolve(result);}, reject: error => {clearTimeout(timer);reject(error);} }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expression) {
    const result = await this.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  wait(expression) { return until(() => this.eval(expression), expression); }
  async click(selector, touch = false) {
    await this.call('Page.bringToFront');
    const box = await this.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    if (touch) {
      await this.call('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: box.x, y: box.y }] });
      await this.call('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await this.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box });
      await this.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box });
    }
  }
  async key(key, code = key) {
    await this.call('Input.dispatchKeyEvent', { type: 'keyDown', key, code, ...(key === 'Enter' ? {text:'\r',unmodifiedText:'\r'} : {}), windowsVirtualKeyCode: { Enter: 13, Escape: 27, Tab: 9, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 }[key] });
    await this.call('Input.dispatchKeyEvent', { type: 'keyUp', key, code });
  }
  async viewport(width) {
    await this.call('Emulation.setDeviceMetricsOverride', { width, height: width >= 768 ? 900 : 760, deviceScaleFactor: 1, mobile: width < 768 });
    await this.call('Emulation.setTouchEmulationEnabled', { enabled: width < 768 });
  }
  async screenshot(name) {
    const result = await this.call('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(artifacts, name + '.png'), Buffer.from(result.data, 'base64'));
  }
}
const clients = [];
let app, chrome;
try {
  const appPort = await port();
  const debugPort = await port();
  const base = `http://127.0.0.1:${appPort}`;
  app = spawn(process.execPath, ['--import', './youtube-ui.mjs', 'server.js'], { cwd: temp, env: { ...process.env, PORT: String(appPort), HOST_IP: '127.0.0.1', PUBLIC_URL: base }, stdio: ['ignore', 'ignore', 'pipe'] });
  let serverErrors = '';
  app.stderr.on('data', chunk => { serverErrors += chunk; });
  await until(async () => { if (app.exitCode !== null) throw new Error(serverErrors); try { return (await fetch(base + '/guest')).ok; } catch { return false; } }, 'server startup');
  chrome = spawn(binary, ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--no-first-run', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(temp, 'chrome')}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserErrors = '';
  chrome.stderr.on('data', chunk => { browserErrors += chunk; });
  const debug = `http://127.0.0.1:${debugPort}`;
  let version;
  await until(async () => { if (chrome.exitCode !== null) throw new Error(browserErrors); try { version = await (await fetch(debug + '/json/version')).json(); return true; } catch { return false; } }, 'Chromium startup');
  const browser = await CDP.connect(version.webSocketDebuggerUrl);
  clients.push(browser);
  async function page(path, joined = true, existingContext) {
    const browserContextId = existingContext || (await browser.call('Target.createBrowserContext')).browserContextId;
    const { targetId } = await browser.call('Target.createTarget', { url: 'about:blank', browserContextId });
    const targets = await (await fetch(debug + '/json/list')).json();
    const client = await CDP.connect(targets.find(item => item.id === targetId).webSocketDebuggerUrl);
    clients.push(client);
    client.browserContextId = browserContextId; client.targetId = targetId;
    await client.call('Page.enable'); await client.call('Runtime.enable');
    await client.call('Fetch.enable', { patterns: [{ urlPattern: 'https://ui-test.invalid/*' }] });
    await client.call('Page.addScriptToEvaluateOnNewDocument', { source: 'window.testSockets = []; const NativeSocket = window.WebSocket; window.WebSocket = class extends NativeSocket { constructor(...args) { super(...args); window.testSockets.push(this); } };' });
    await client.viewport(375);
    await client.call('Page.navigate', { url: base + path });
    await client.wait(joined
      ? 'document.body?.dataset.roomActive === "true" && document.querySelector("#connection")?.dataset.status === "connected"'
      : 'document.querySelector("#room-join") && document.body?.dataset.roomActive === "false"');
    return client;
  }
  const created = await (await fetch(base + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: '1236' }) })).json();
  assert.ok(created.token);
  const admin = await page(`/a?room=123&session=${created.sessionId}`);
  const guest = await page(`/guest?room=123&session=${created.sessionId}`);
  assert.equal(await admin.eval('document.querySelector("#queue-panel").hidden'), false);
  assert.equal(await guest.eval('document.querySelector("#search-panel").hidden'), false);
  assert.equal(await guest.eval('document.querySelector("#admin-settings, .admin-controls, .drag-handle, .queue-more")'), null);
  for (const client of [admin, guest]) {
    assert.equal(await client.eval('document.querySelector("#request-title").closest("header") !== null'), true);
    assert.equal(await client.eval('document.querySelectorAll(".search-modes button svg").length'), 3);
    assert.equal(await client.eval('document.querySelector("#nickname-credit").textContent.includes("by")'), true);
  }
  await guest.wait('document.querySelectorAll("#results li").length === 5');
  await admin.click('#admin-settings');
  assert.equal(await admin.eval('document.querySelector("#settings-drawer").open'), true);
  assert.equal(await admin.eval('document.querySelector("#admin-clear").hidden'), true);
  await admin.click('#admin-auto-queue');
  await admin.wait('!adminState.autoQueue');
  for (const seconds of [10, 15, 30, 60, 0]) {
    await admin.click('#admin-cooldown');
    await admin.wait(`adminRoom.cooldownSeconds === ${seconds}`);
  }
  await admin.key('Escape');
  await admin.wait('!document.querySelector("#settings-drawer").open');
  assert.equal(await admin.eval('document.activeElement.id'), 'admin-settings');
  // Real requests from Guest update Admin's now-playing and queue through WS.
  for (let i = 0; i < 5; i++) {
    await guest.click(`#results li:nth-child(${i + 1}) .add-btn`, true);
    await guest.wait(`document.querySelector('#results li:nth-child(${i + 1}) .add-btn').textContent === '✓'`);
  }
  await admin.wait('adminState.queue.length === 4');
  assert.equal(await guest.eval('Number(document.querySelector("#queue-count").textContent)'), 4);
  assert.match(await guest.eval('document.querySelector("#now-playing .np-sub").textContent'), /เพิ่มโดย/);
  await admin.click('#admin-pause'); await admin.wait('adminState.paused');
  await guest.wait('document.querySelector("#now-playing").classList.contains("paused")');
  assert.equal(await admin.eval('document.querySelector("#admin-pause").hidden'), true);
  await admin.click('#admin-play'); await admin.wait('!adminState.paused');
  await admin.click('#admin-volume-toggle');
  await admin.eval('document.querySelector("#admin-volume").value = 35; document.querySelector("#admin-volume").dispatchEvent(new Event("input", {bubbles:true}))');
  await admin.wait('adminState.volume === 35');
  await admin.key('Escape');
  assert.equal(await admin.eval('document.querySelector("#volume-panel").hidden'), true);
  // Responsive layout, bottom safe space, touch targets, and menu boundaries.
  for (const width of [320, 375, 768, 1440]) {
    for (const [name, client] of [['admin', admin], ['guest', guest]]) {
      await client.viewport(width);
      for (const tab of name === 'admin' ? ['queue', 'search', 'participants'] : ['search', 'queue']) {
        await client.click(`#${tab}-tab`, width < 768);
        const metrics = await client.eval(`(() => {
          const nav = document.querySelector('.page-tabs').getBoundingClientRect();
          const controls = [...document.querySelectorAll('button, input[type=range]')].filter(el => el.getClientRects().length);
          return { width: innerWidth, scroll: document.documentElement.scrollWidth,
            navBottom: nav.bottom, height: innerHeight,
            small: controls.filter(el => {const r=el.getBoundingClientRect();return r.width<43.9||r.height<43.9}).map(el=>el.id||el.className),
            padding: parseFloat(getComputedStyle(document.body).paddingBottom), navHeight: nav.height };
        })()`);
        assert.ok(metrics.scroll <= metrics.width, `${name}/${tab}/${width}: horizontal overflow ${JSON.stringify(metrics)}`);
        assert.ok(metrics.navBottom <= metrics.height + 1);
        assert.ok(metrics.padding > metrics.navHeight);
        assert.deepEqual(metrics.small, [], `${name}/${tab}/${width}: touch targets`);
      }
      await client.click(name === 'admin' ? '#queue-tab' : '#search-tab');
      await client.screenshot(`${name}-${width}`);
    }
    await admin.click('#queue li:first-child .queue-more', width < 768);
    const bounds = await admin.eval('(() => {const r=document.querySelector("#queue-menu").getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:innerWidth,height:innerHeight};})()');
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width && bounds.top >= 0 && bounds.bottom <= bounds.height, `Menu outside viewport: ${JSON.stringify(bounds)}`);
    await admin.key('ArrowDown');
    assert.equal(await admin.eval('document.activeElement.dataset.queueAction'), 'moveDown');
    await admin.key('Escape');
    assert.equal(await admin.eval('document.activeElement.className'), 'queue-more');
  }
  await admin.viewport(375); await guest.viewport(375);
  const first = await admin.eval('adminState.queue[0].id');
  await admin.click('#queue li:first-child .queue-more');
  await admin.click('#queue-menu [data-queue-action=moveDown]');
  await admin.wait(`adminState.queue[1].id === ${JSON.stringify(first)}`);
  await guest.click('#queue-tab');
  await guest.wait(`lastQueueState.queue[1].id === ${JSON.stringify(first)}`);
  // Real pointer drag sends a complete permutation.
  const oldOrder = await admin.eval('adminState.queue.map(item => item.id)');
  const points = await admin.eval('(() => { const rows=[...document.querySelectorAll("#queue li")]; const a=rows[0].querySelector(".drag-handle").getBoundingClientRect(); const b=rows[2].getBoundingClientRect(); return {x:a.x+a.width/2,y:a.y+a.height/2,to:b.bottom-4};})()');
  await admin.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, x: points.x, y: points.y });
  await admin.call('Input.dispatchMouseEvent', { type: 'mouseMoved', button: 'left', buttons: 1, x: points.x, y: points.to });
  await admin.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, x: points.x, y: points.to });
  await admin.wait(`adminState.queue[2].id === ${JSON.stringify(oldOrder[0])}`);
  await admin.click('#queue li:first-child .queue-more'); await admin.click('#queue-menu [data-queue-action=remove]');
  await admin.wait('adminState.queue.length === 3');
  await guest.wait('lastQueueState.queue.length === 3');
  const next = await admin.eval('adminState.queue[0].id');
  await admin.click('#queue li:first-child .queue-more'); await admin.click('#queue-menu [data-queue-action=playNow]');
  await admin.wait(`adminState.nowPlaying.id === ${JSON.stringify(next)}`);
  await admin.click('#admin-skip');
  await admin.wait(`adminState.nowPlaying.id !== ${JSON.stringify(next)}`);
  // Search modes, Enter, paging, clear, shuffle, and server rejection feedback.
  await guest.click('#search-tab');
  await guest.click('#q'); await guest.call('Input.insertText', { text: 'เพลงรัก' }); await guest.key('Enter');
  await guest.wait('document.querySelectorAll("#results li").length === 5 && document.querySelector("#suggestions-section").classList.contains("hidden") && document.querySelector("#results li .r-title").textContent.startsWith("เพลงรัก") && document.querySelector("#results").getAttribute("aria-busy") === "false"');
  await guest.click('#more');
  assert.equal(await guest.eval('document.querySelectorAll("#results li").length'), 10);
  await guest.eval('document.querySelector("#results li:nth-child(10)").scrollIntoView({block:"center"})');
  const scrollBeforeAdd = await guest.eval('scrollY');
  await guest.click('#results li:nth-child(10) .add-btn', true);
  await guest.wait('document.querySelector("#results li:nth-child(10) .add-btn").textContent === "✓"');
  assert.ok(Math.abs((await guest.eval('scrollY')) - scrollBeforeAdd) < 2, 'Adding does not reset the search scroll');
  await guest.click('#mode-karaoke'); await guest.wait('searchMode === "karaoke" && document.querySelectorAll("#results li").length === 5');
  await guest.click('#mode-songs'); await guest.wait('searchMode === "songs" && document.querySelectorAll("#results li").length === 5');
  for (const [query, expected] of [['ไม่พบ', 'ไม่พบเพลง'], ['ผิดพลาด', 'ค้นหาไม่สำเร็จ กรุณาลองใหม่']]) {
    await guest.eval(`document.querySelector('#q').value = ${JSON.stringify(query)}; document.querySelector('#q').dispatchEvent(new Event('input', {bubbles:true}));`);
    await guest.click('#search-btn');
    await guest.wait(`document.querySelector('#status').textContent.includes(${JSON.stringify(expected)}) && document.querySelector('#results').getAttribute('aria-busy') === 'false'`);
  }
  await guest.click('#clear-search'); await guest.wait('document.querySelector("#q").value === "" && !document.querySelector("#suggestions-section").classList.contains("hidden")');
  await guest.click('#shuffle'); await guest.wait('document.querySelectorAll("#results li").length === 5');
  // Refresh retains nickname and room; no new player or playback state is fabricated.
  const nickname = await guest.eval('document.querySelector("#request-title").textContent');
  await guest.eval('window.reloadMarker = true');
  await guest.call('Page.reload');
  await guest.wait('!window.reloadMarker && document.querySelector("#connection")?.dataset.status === "connected"');
  assert.equal(await guest.eval('document.querySelector("#request-title").textContent'), nickname);
  // Duplicate and cooldown feedback comes from the real server rules.
  while (await guest.eval('!document.querySelector("#more").classList.contains("hidden")')) await guest.click('#more');
  const duplicateId = await guest.eval('lastQueueState.nowPlaying.videoId');
  const duplicateSelector = `#results .add-btn[data-video-id="${duplicateId}"]`;
  await guest.click(duplicateSelector, true);
  await guest.wait('[...document.querySelectorAll(".toast.bad")].some(el => el.textContent.includes("เพลงนี้อยู่ในคิวแล้ว"))');
  assert.equal(await guest.eval(`document.querySelector(${JSON.stringify(duplicateSelector)}).disabled`), false);
  await admin.click('#admin-settings'); await admin.click('#admin-cooldown');
  await admin.wait('adminRoom.cooldownSeconds === 5'); await admin.key('Escape');
  await delay(5100); // The previous request also uses the newly enabled room cooldown.
  const newIds = await guest.eval('[...document.querySelectorAll("#results .add-btn")].map(el => el.dataset.videoId).filter(id => id !== lastQueueState.nowPlaying.videoId && !lastQueueState.queue.some(item => item.videoId === id)).slice(0,2)');
  await guest.click(`#results .add-btn[data-video-id="${newIds[0]}"]`, true);
  await guest.wait(`document.querySelector('#results .add-btn[data-video-id="${newIds[0]}"]').textContent === '✓'`);
  await guest.click(`#results .add-btn[data-video-id="${newIds[1]}"]`, true);
  await guest.wait('[...document.querySelectorAll(".toast.bad")].some(el => el.textContent.includes("กรุณารอ"))');
  // Closing the real WebSocket exercises offline controls and authenticated retry.
  await admin.click('#queue li:first-child .queue-more'); await admin.click('#queue-menu [data-queue-action=remove]');
  await admin.eval('window.testSockets.at(-1).close()');
  await admin.wait('document.querySelector("#connection").dataset.status === "offline"');
  assert.equal(await admin.eval('document.querySelector("#admin-pause").disabled'), true);
  await admin.wait('document.querySelector("#connection").dataset.status === "connected" && adminAuthenticated');
  // Grant/revoke uses real participant controls and the existing role redirects.
  await admin.click('#participants-tab');
  await admin.click('#participants-list button[title="ให้สิทธิ์ควบคุม"]');
  await guest.wait('location.pathname === "/a" && document.querySelector("#connection")?.dataset.status === "connected" && typeof adminAuthenticated !== "undefined" && adminAuthenticated');
  assert.equal(await guest.eval('document.querySelector("#participants-tab").hidden'), false);
  await admin.click('#participants-list button[title="ยกเลิกสิทธิ์ควบคุม"]');
  await guest.wait('location.pathname === "/guest" && document.querySelector("#connection")?.dataset.status === "connected"');
  assert.equal(await guest.eval('document.querySelector(".admin-controls, #participants-tab")'), null);
  assert.equal(await guest.eval('document.querySelector("#request-title").textContent'), nickname);
  await admin.call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  assert.equal(await admin.eval('getComputedStyle(document.querySelector(".eq span")).animationName'), 'none');
  const admission = await page('/guest', false);
  await admission.viewport(320);
  assert.equal(await admission.eval('document.documentElement.scrollWidth <= innerWidth'), true);
  await admission.screenshot('join-320');
  await admission.click('#room-code', true); await admission.call('Input.insertText', {text:'123'}); await admission.key('Enter');
  await admission.wait('document.body?.dataset.roomActive === "true" && document.querySelector("#connection")?.dataset.status === "connected"');
  assert.equal(await admission.eval('document.querySelector("#search-panel").hidden'), false);
  // Real server snapshots share the automatic batch while user requests keep priority.
  await admin.click('#queue-tab');
  while (await admin.eval('adminState.queue.length > 0')) {
    const id = await admin.eval('adminState.nowPlaying.id');
    await admin.click('#admin-skip');
    await admin.wait(`adminState.nowPlaying.id !== ${JSON.stringify(id)}`);
  }
  await admin.click('#admin-settings');
  for (const seconds of [10, 15, 30, 60, 0]) {
    await admin.click('#admin-cooldown'); await admin.wait(`adminRoom.cooldownSeconds === ${seconds}`);
  }
  await admin.click('#admin-auto-queue');
  await admin.wait('adminState.autoQueue && adminState.autoQueueItems.length === 5');
  await guest.wait('lastQueueState.autoQueueItems.length === 5');
  await admin.key('Escape');
  assert.deepEqual(await admin.eval('adminState.autoQueueItems'), await guest.eval('lastQueueState.autoQueueItems'));
  assert.deepEqual(await guest.eval('lastQueueState.autoQueueItems.map(item=>item.title.split(" · ")[0])'), [1,2,3,4,5].map(n=>`เพลงอัตโนมัติ ${n}`));
  await guest.click('#queue-tab');
  assert.equal(await guest.eval('document.querySelector("#auto-queue-list button, #auto-queue-list .drag-handle")'), null);
  for (const width of [320, 375, 768, 1440]) {
    for (const [name, client] of [['admin', admin], ['guest', guest]]) {
      await client.viewport(width);
      assert.equal(await client.eval('document.documentElement.scrollWidth <= innerWidth'), true, `${name}/${width}: automatic list overflow`);
      assert.equal(await client.eval('document.querySelectorAll("#auto-queue-list li").length'), 5);
      await client.eval('window.scrollTo(0,0)'); await client.screenshot(`${name}-auto-${width}`);
    }
  }
  const automatic = await admin.eval('adminState.autoQueueItems[0].videoId');
  await admin.click('#admin-skip');
  await admin.wait(`adminState.nowPlaying.videoId === ${JSON.stringify(automatic)} && adminState.autoQueueItems.length === 4`);
  const added = await guest.eval('Room.fetch("/api/request", {method:"POST", body:JSON.stringify({videoId:"manual00001",title:"เพลงที่ผู้ใช้เพิ่ม",channel:"Artist",duration:"3:20",clientId:"browser-batch",name:nickname})})');
  assert.equal(added.ok, true);
  await admin.wait('adminState.queue.length === 1 && adminState.autoQueueItems.length === 0');
  await guest.wait('document.querySelector("#auto-queue-section").hidden');
  assert.equal(await admin.eval('adminState.nowPlaying.videoId'), automatic);
  await admin.click('#admin-skip');
  await admin.wait('adminState.nowPlaying.videoId === "manual00001" && adminState.autoQueueItems.length === 5');
  await guest.wait('lastQueueState.autoQueueItems.length === 5');

  // Join or create from the welcome buttons, using a remote or touch.
  const playerPage = await page('/', false);
  await playerPage.viewport(1440);
  await playerPage.call('Page.bringToFront');
  assert.equal(await playerPage.eval('document.activeElement.id'), 'start-btn');
  await playerPage.eval('document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "Unidentified", keyCode: 20, bubbles: true, cancelable: true }))');
  assert.ok(['open-player-entry', 'open-queue-entry'].includes(await playerPage.eval('document.activeElement.id')));
  await playerPage.eval('document.querySelector("#open-player-entry").focus()');
  await playerPage.key('Enter');
  assert.equal(await playerPage.eval('document.activeElement.id'), 'room-code');
  await playerPage.key('Escape');
  assert.equal(await playerPage.eval('document.activeElement.id'), 'open-player-entry');
  await playerPage.key('Enter');
  await playerPage.call('Input.insertText', {text:'456'});
  await playerPage.key('ArrowDown');
  assert.equal(await playerPage.eval('document.activeElement === document.querySelector("#room-join button")'), true);
  await playerPage.key('Enter');
  await playerPage.wait('document.body.dataset.roomActive === "true" && Room.connected');
  const playerSession = await playerPage.eval('Room.sessionId');
  assert.equal(await playerPage.eval('Room.code'), '456');
  await playerPage.wait('!document.querySelector("#qr-card").hidden');
  assert.equal(await playerPage.eval('document.querySelector("#qr-card #player-room-label").textContent'), 'ห้อง 456');

  const returned = await page('/', false);
  await returned.click('#open-player-entry', true);
  await returned.call('Input.insertText', {text:'456'});
  await returned.click('#room-join button', true);
  await returned.wait('Room.connected');
  assert.equal(await returned.eval('Room.sessionId'), playerSession);
  await returned.eval('window.playerReloadMarker = true');
  await returned.call('Page.reload');
  await returned.wait('!window.playerReloadMarker && document.body?.dataset.roomActive === "true" && Room.connected');
  assert.equal(await returned.eval('Room.sessionId'), playerSession);
  await playerPage.click('#exit-room');
  await playerPage.wait('document.querySelector("#exit-dialog").open');
  assert.equal(await playerPage.eval('document.activeElement.id'), 'cancel-exit');
  assert.equal(await playerPage.eval('Room.connected'), true);
  await playerPage.click('#cancel-exit');
  assert.equal(await playerPage.eval('document.querySelector("#exit-dialog").open'), false);
  assert.equal(await playerPage.eval('document.activeElement.id'), 'exit-room');
  await playerPage.key('Enter');
  await playerPage.key('Escape');
  assert.equal(await playerPage.eval('Room.connected'), true);
  await playerPage.key('Enter');
  await playerPage.key('ArrowRight');
  assert.equal(await playerPage.eval('document.activeElement.id'), 'confirm-exit');
  await playerPage.key('Enter');
  await playerPage.wait('document.body.dataset.roomActive === "false"');
  assert.equal(await returned.eval('Room.connected'), true);

  const available = await (await fetch(base + '/api/sessions/available')).json();
  const controlPage = await page('/', false);
  await controlPage.click('#open-queue-entry');
  await controlPage.call('Input.insertText', { text: available.codes[0] });
  await controlPage.key('Enter');
  await controlPage.wait('document.querySelector("#room-error").textContent === "ไม่มีห้องนี้"');
  assert.match(await controlPage.eval('document.querySelector("#room-retry").textContent'), /10 วินาที/);
  assert.equal(await controlPage.eval('document.querySelector("#room-join button").disabled'), true);
  await controlPage.click('#open-player-entry');
  assert.equal(await controlPage.eval('document.querySelector("#room-join button").disabled'), false);

  const randomPlayer = await page('/', false);
  await randomPlayer.click('#start-btn', true);
  await randomPlayer.wait('Room.connected && !document.querySelector("#qr-card").hidden');
  const randomCode = await randomPlayer.eval('Room.code');
  assert.match(randomCode, /^[1-9][0-9]{2}$/);
  assert.notEqual(randomCode, '456');
  await controlPage.wait('!document.querySelector("#room-join button").disabled');
  await controlPage.click('#open-queue-entry');
  await controlPage.wait('!document.querySelector("#room-join button").disabled');
  await controlPage.eval(`document.querySelector('#room-code').value = ${JSON.stringify(randomCode)}`);
  await controlPage.click('#room-join button');
  await controlPage.wait('location.pathname === "/a" && typeof Room !== "undefined" && Room.connected');
  assert.equal(await controlPage.eval('Room.code'), randomCode);

  for (const width of [320, 375, 768, 1440]) {
    await randomPlayer.viewport(width);
    const geometry = await randomPlayer.eval(`(()=> {
      const box = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
      return { video: box('#player-wrap'), title: box('#now-title'), skip: box('#skip'), volume: box('#volume'),
        controls: box('#controls'), exit: box('#exit-room'), queue: box('#player-queue-card'), meta: box('#now-meta'),
        width: innerWidth, height: innerHeight, scroll: document.documentElement.scrollWidth,
        titleSize: parseFloat(getComputedStyle(document.querySelector('#now-title')).fontSize) };
    })()`);
    assert.equal(geometry.scroll, geometry.width);
    assert.ok(geometry.titleSize < 44);
    assert.ok(geometry.skip.right <= geometry.title.left && geometry.volume.right <= geometry.exit.left);
    assert.equal(geometry.meta.y, geometry.controls.y);
    assert.ok(geometry.video.height > geometry.height / 2);
    assert.ok(geometry.queue.bottom <= geometry.controls.y);
    assert.equal(await randomPlayer.eval('document.querySelector("#qr-toggle, #auto-queue-toggle")'), null);
    await randomPlayer.screenshot(`player-${width}`);
  }
  await controlPage.click('#admin-settings');
  const togglePlayerPanel = async (id) => {
    await controlPage.eval(`document.getElementById(${JSON.stringify(id)}).focus()`);
    await controlPage.key('Enter');
  };
  await togglePlayerPanel('setting-showPlayerQr');
  await randomPlayer.wait('document.querySelector("#qr-card").hidden && !document.querySelector("#player-queue-card").hidden');
  assert.equal(await randomPlayer.eval('document.querySelector("#player-room-label").getClientRects().length'), 0);
  await togglePlayerPanel('setting-showPlayerQueue');
  await randomPlayer.wait('document.querySelector("#player-sidebar").hidden');
  assert.ok(await randomPlayer.eval('document.querySelector("#player-wrap").offsetWidth >= innerWidth - 40'));
  assert.equal(await returned.eval('document.querySelector("#player-sidebar").hidden'), false, 'Display settings are isolated by room');
  await togglePlayerPanel('setting-showPlayerQr');
  await randomPlayer.wait('!document.querySelector("#qr-card").hidden && document.querySelector("#player-queue-card").hidden');
  await togglePlayerPanel('setting-showPlayerQueue');
  await randomPlayer.wait('!document.querySelector("#player-queue-card").hidden');
  assert.equal(await controlPage.eval('document.querySelector("#setting-allowQueueJoin").getAttribute("aria-pressed")'), 'true');
  await togglePlayerPanel('setting-allowQueueJoin');
  await controlPage.wait('!adminState.allowQueueJoin');
  await playerPage.click('#open-queue-entry');
  await playerPage.call('Input.insertText', { text: randomCode });
  await playerPage.key('Enter');
  await playerPage.wait('document.querySelector("#room-error").textContent === "ห้องนี้ปิดรับผู้เข้าร่วมจัดคิวใหม่"');
  assert.equal(await playerPage.eval('document.querySelector("#room-retry").textContent'), '');
  assert.equal(await playerPage.eval('Room.token'), undefined);
  await controlPage.call('Page.bringToFront');
  await togglePlayerPanel('setting-allowQueueJoin');
  await controlPage.wait('adminState.allowQueueJoin');
  await playerPage.click('#room-join button');
  await playerPage.wait('location.pathname === "/guest" && typeof Room !== "undefined" && Room.connected');
  for (const client of clients.slice(1)) assert.deepEqual(client.errors, [], 'No JavaScript runtime errors');
  // Export clean final views after the role redirects have rebuilt Guest feedback.
  await admin.click('#queue-tab'); await guest.click('#search-tab');
  for (const width of [320, 375, 768, 1440]) {
    for (const [name, client] of [['admin', admin], ['guest', guest]]) {
      await client.viewport(width);
      await client.eval('window.scrollTo(0,0)');
      await client.screenshot(`${name}-${width}`);
    }
  }
  console.log('PASS: real Chromium at 320/375/768/1440px; no overflow; 44px controls; touch tabs/add/menu; keyboard menus/settings; real API/WS playback, volume, move, pointer drag, immediate removal, Play Now, skip, search/modes/paging/clear/shuffle, duplicate/cooldown/error/empty feedback, scroll preservation, nickname refresh, role redirects, authenticated reconnect, ordered automatic batches/user priority, Player entry/refresh/local leave, room display toggles, and responsive playback controls and reduced motion. YouTube upstream simulated.');
  console.log(`Screenshots: ${artifacts}`);
} catch (error) {
  console.error(error);
  for (const [index, client] of clients.slice(1).entries()) {
    if (client.closed) continue;
    try {
      await client.screenshot(`failure-${index}`);
      const state = await client.eval('({url:location.pathname,text:document.body.innerText,requests:typeof pendingRequests !== "undefined" ? [...pendingRequests] : [],state:typeof lastQueueState !== "undefined" ? lastQueueState : null})');
      console.error(JSON.stringify({page:index,errors:client.errors,...state}));
    } catch {}
  }
  throw error;
} finally {
  for (const client of clients) client.ws.close();
  for (const process of [chrome, app]) {
    if (process && process.exitCode === null) { const ended = once(process, 'exit'); process.kill('SIGTERM'); await ended; }
  }
  rmSync(temp, { recursive: true, force: true });
}

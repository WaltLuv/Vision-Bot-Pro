// Process and browser lifecycle for the end-to-end run. Keeps the scenarios
// free of setup so each one reads as the behaviour it is checking.
import {createRequire} from 'node:module';
import {spawn, execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {createServer as createHttpsServer} from 'node:https';
import {readFileSync} from 'node:fs';
import {writeFileSync} from 'node:fs';
import {startModelFixture} from './model-fixture.mjs';

/**
 * Two owner-configured suppliers: one that answers and one that does not. The
 * pair is what makes a partial comparison real rather than asserted -- the
 * gateway has to keep the working supplier's offers and report the broken one.
 */
function startSupplierFixture() {
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/northside')) {res.statusCode = 500; res.end('{"error":"down"}'); return;}
    res.end(JSON.stringify({results: [
      {code: 'RS-118', title: 'M6 bolt 20-pack stainless', link: 'https://riverside.example.test/p/RS-118', price: 7.4, ship: 0, taxes: 0.59, stock: 36, status: 'In stock', pickup: true, store: 'Riverside yard', pickupEta: 'Ready today', delivers: true, deliveryEta: 'Thu, 5 Jun'},
      {code: 'RS-992', title: 'M6 bolt assorted tub', link: 'https://riverside.example.test/p/RS-992', price: 21.5, ship: 4.5, taxes: 1.72, stock: 4, status: 'Low stock', pickup: false, delivers: true, deliveryEta: 'Fri, 6 Jun'},
    ]}));
  });
  server.listen(0);
  return new Promise(resolve => server.on('listening', () => resolve({server, port: server.address().port})));
}

/**
 * Browser Use, stood in for, shaped like its v4 API as the official SDK defines
 * it: runs are created, polled and cancelled, never paused; each belongs to a
 * session, and a follow-up run in that session reuses its live browser. The
 * API side records every run it is asked to start and every cancel. The live view side is a small "website" served over https from
 * live.visionclaw.test -- an allowed live-view host -- so the app frames it
 * under exactly the policy it ships with. The page counts its own loads, so a
 * re-render that reloaded the view would show up as a second load.
 */
export const LIVE_HOST = 'live.visionclaw.test';
const LIVE_PAGE = `<!doctype html><meta name="viewport" content="width=device-width"><title>Remote site</title>
<style>body{font:18px sans-serif;margin:0;padding:20px}button{font-size:22px;padding:18px 28px}input{font-size:20px;margin-top:16px;width:80%}</style>
<h1>Remote site</h1><button id="press">Press me</button><p>Presses: <output id="presses">0</output></p><input id="typed" aria-label="Remote input">
<script>document.getElementById('press').onclick=()=>{const o=document.getElementById('presses');o.textContent=String(Number(o.textContent)+1);};</script>`;

function startBrowserUseFixture(dataDir) {
  // A certificate made for this run only, so no private key -- test or not -- is ever committed.
  const key = path.join(dataDir, 'live-key.pem'), cert = path.join(dataDir, 'live-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', `/CN=${LIVE_HOST}`], {stdio: 'ignore'});
  const calls = [], created = [], status = {};
  let loads = 0;
  const live = createHttpsServer({key: readFileSync(key), cert: readFileSync(cert)}, (req, res) => {
    if (!req.url?.startsWith('/view')) {res.statusCode = 404; res.end(); return;}
    loads++;
    res.setHeader('Content-Type', 'text/html');
    res.end(LIVE_PAGE);
  });
  const api = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const json = (code, value) => {res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));};
    if (req.method === 'POST' && req.url === '/api/v4/runs') {
      const body = JSON.parse(raw || '{}'), id = `bu-e2e-${created.length + 1}`;
      created.push(body); status[id] = 'running';
      json(200, {id, status: 'queued', sessionId: body.sessionId ?? 'sess-e2e', workspaceId: 'ws-e2e', eventsUrl: `/runs/${id}/events`});
      return;
    }
    const m = req.url?.match(/^\/api\/v4\/runs\/([^/]+)(?:\/(\w+))?$/);
    if (!m) {json(404, {detail: 'Not Found'}); return;}
    const [, id, action] = m;
    if (req.method === 'POST') {
      if (action !== 'cancel') {json(404, {detail: 'Not Found'}); return;}   // v4 has no pause or resume
      calls.push(`cancel:${id}`); status[id] = 'cancelled'; json(200, {id, status: 'cancelled'}); return;
    }
    // Every run in the session is on the same live browser.
    if (action === 'events') {json(200, {events: [{type: 'browser.ready', data: {live_view_url: `https://${LIVE_HOST}/view?session=e2e`}}], hasMore: false}); return;}
    if (action === 'status') {json(200, {status: status[id]}); return;}
    json(200, {id, status: status[id], result: status[id] === 'completed' ? 'The spec sheet lists M6 x 20 mm.' : null});
  });
  live.listen(0, '127.0.0.1');
  api.listen(0, '127.0.0.1');
  return Promise.all([live, api].map(server => new Promise(r => server.on('listening', r)))).then(() => ({
    live, api, calls, created, livePort: live.address().port, apiPort: api.address().port, loads: () => loads,
  }));
}

/**
 * Browserbase, stood in for: its REST API as the official SDK defines it, with
 * a real headless Chromium behind connectUrl -- the browser the employee
 * actually drives, step by step. Its live view is the same https page on the
 * allowed live-view host as above. A small shop site gives it somewhere to go.
 */
function startBrowserbaseFixture() {
  const chromium = spawn(process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    ['--headless=new', '--no-sandbox', '--no-proxy-server', '--remote-debugging-port=0', `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'vc-e2e-remote-'))}`, 'about:blank'],
    {stdio: ['ignore', 'ignore', 'pipe']});
  const released = [];
  let shopVisits = 0;
  const shop = createServer((req, res) => {
    shopVisits++;
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Hardware shop</title><h1>Hardware shop</h1><p>Moen 1222 cartridge: 3 in stock</p>');
  });
  return new Promise((resolve, reject) => {
    let err = '', started = false;
    chromium.stderr.on('data', d => {
      err += d;
      const m = err.match(/DevTools listening on (ws:\/\/\S+)/);
      // Chromium keeps writing here after announcing itself; start the stand-ins once.
      if (!m || started) return;
      started = true;
      const api = createServer(async (req, res) => {
        for await (const _ of req) {/* body not needed */}
        const json = v => {res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(v));};
        if (req.method === 'POST' && req.url === '/v1/sessions') {json({id: 'bb-e2e', status: 'RUNNING', connectUrl: m[1], keepAlive: false}); return;}
        if (req.url?.startsWith('/v1/sessions/bb-e2e/debug')) {json({debuggerFullscreenUrl: `https://${LIVE_HOST}/view?session=bb`, debuggerUrl: '', wsUrl: '', pages: []}); return;}
        if (req.method === 'POST' && req.url === '/v1/sessions/bb-e2e') {released.push('bb-e2e'); json({id: 'bb-e2e', status: 'COMPLETED'}); return;}
        res.statusCode = 404; res.end('{}');
      });
      api.listen(0, '127.0.0.1');
      shop.listen(0, '127.0.0.1');
      Promise.all([api, shop].map(s => new Promise(r => s.on('listening', r)))).then(() => resolve({
        chromium, api, shop, released, apiPort: api.address().port, shopUrl: `http://127.0.0.1:${shop.address().port}/`, shopVisits: () => shopVisits,
      }));
    });
    chromium.on('exit', () => reject(new Error('the stand-in remote browser exited: ' + err.slice(-200))));
  });
}

const supplierMapping = {
  items: 'results', sku: 'code', product: 'title', url: 'link', unitPrice: 'price',
  shipping: 'ship', tax: 'taxes', fees: '', inventory: 'stock', availability: 'status',
  pickupAvailable: 'pickup', pickupLocation: 'store', pickupEta: 'pickupEta',
  deliveryAvailable: 'delivers', deliveryEta: 'deliveryEta', specification: '',
};

export const root = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const require = createRequire(path.join(root, 'gateway/package.json'));
export const {chromium} = require('playwright');

export function reporter() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({name, ok: !!ok, detail});
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  };
  return {results, check};
}

// Polls deliberately slowly: the gateway rate-limits an owner to 240 requests a
// minute, and a tight loop over a long wait spends that budget on nothing.
export async function waitFor(fn, label, timeout = 45000, interval = 750) {
  const started = Date.now();
  for (;;) {
    try {if (await fn()) return true;} catch {/* keep polling */}
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, interval));
  }
}

/**
 * A real gateway process with its real database, run queue, tool gateway and
 * approval gate, pointed at a local model fixture so the employee's decisions
 * are fixed and no provider credential is involved.
 */
export async function startStack({port, tokens}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'vc-e2e-'));
  const model = await startModelFixture();
  const supplier = await startSupplierFixture();
  const browserUse = await startBrowserUseFixture(dataDir);
  const browserbase = await startBrowserbaseFixture();
  // The model stand-in runs in this process and needs to know where the shop is.
  process.env.E2E_SHOP_URL = browserbase.shopUrl;
  const supplierConfig = path.join(dataDir, 'suppliers.json');
  writeFileSync(supplierConfig, JSON.stringify([
    {id: 'riverside_supply', name: 'Riverside Building Supply', method: 'partner_api',
     endpoint: `http://127.0.0.1:${supplier.port}/riverside?q={query}`,
     auth: {type: 'bearer', env: 'RIVERSIDE_TOKEN'}, mapping: supplierMapping},
    {id: 'northside_lumber', name: 'Northside Lumber', method: 'partner_api',
     endpoint: `http://127.0.0.1:${supplier.port}/northside?q={query}`,
     auth: {type: 'bearer', env: 'NORTHSIDE_TOKEN'}, mapping: supplierMapping},
  ]));
  const gateway = spawn('node', ['--import', 'tsx', 'src/server.ts'], {
    cwd: path.join(root, 'gateway'),
    env: {
      ...process.env,
      PORT: String(port),
      GATEWAY_TOKENS: tokens,
      STORE_PATH: path.join(dataDir, 'gateway-store.json'),
      EMPLOYEE_DATA_DIR: dataDir,
      STATE_SECRET: 'e2e-only-not-a-secret',
      AGENT_RUNTIME: 'hermes',
      HERMES_PROVIDER: 'custom',
      HERMES_MODEL: 'fixture-model',
      HERMES_BASE_URL: `http://127.0.0.1:${model.port}/v1`,
      HERMES_API_KEY: 'fixture-only',
      ANTHROPIC_API_KEY: '',
      SUPPLIER_CONFIG_PATH: supplierConfig,
      RIVERSIDE_TOKEN: 'fixture-only',
      NORTHSIDE_TOKEN: 'fixture-only',
      SUPPLIER_TIMEOUT_MS: '4000',
      // One browser driving a dozen scenarios back to back is not one person on
      // a phone. The ceiling itself is exercised by the gateway tests; here it
      // would only throttle the suite.
      API_RATE_LIMIT: '4000',
      // eBay must stay out of the search even with this whole stack running.
      EBAY_CLIENT_ID: 'fixture-only',
      EBAY_CLIENT_SECRET: 'fixture-only',
      BROWSER_USE_API_KEY: 'fixture-only',
      BROWSER_USE_API_BASE: `http://127.0.0.1:${browserUse.apiPort}/api/v4`,
      BROWSER_LIVE_VIEW_HOSTS: LIVE_HOST,
      BROWSER_POLL_MS: '300',
      BROWSERBASE_API_KEY: 'fixture-only',
      BROWSERBASE_API_BASE: `http://127.0.0.1:${browserbase.apiPort}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  gateway.stdout.on('data', d => {log += d;});
  gateway.stderr.on('data', d => {log += d;});

  const base = `http://127.0.0.1:${port}`;
  await waitFor(async () => (await fetch(`${base}/health`).catch(() => null))?.ok, 'gateway to start', 30000);

  return {
    base,
    browserUse,
    browserbase,
    tail: (lines = 6) => log.split('\n').slice(-lines).join('\n'),
    async stop() {
      gateway.kill('SIGKILL');
      model.server.close();
      supplier.server.close();
      browserUse.live.close();
      browserUse.api.close();
      browserbase.api.close();
      browserbase.shop.close();
      browserbase.chromium.kill('SIGKILL');
      rmSync(dataDir, {recursive: true, force: true});
    },
  };
}

/**
 * Chromium with synthetic camera and microphone. getUserMedia only exists in a
 * secure context, which http://127.0.0.1 is, so the real capture path runs
 * exactly as it would on a phone over https.
 */
export function launchBrowser({livePort} = {}) {
  return chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium',
    args: ['--no-sandbox', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
      // The live-view "website" answers as https://live.visionclaw.test on the
      // standard port, which is what the app's frame policy names. The test
      // browser only ever talks to loopback, so it needs no proxy.
      ...(livePort ? [`--host-resolver-rules=MAP ${LIVE_HOST} 127.0.0.1:${livePort}`, '--no-proxy-server'] : [])],
  });
}

const PHONE = {
  viewport: {width: 390, height: 844},
  userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  permissions: ['camera', 'microphone'],
  // Only for the run's own self-signed live-view certificate.
  ignoreHTTPSErrors: true,
};

export async function openPhone(browser, base) {
  const context = await browser.newContext(PHONE);
  const page = await context.newPage();
  const cspViolations = [];
  const pageErrors = [];
  page.on('console', m => {if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text());});
  page.on('pageerror', e => pageErrors.push(String(e)));
  await page.goto(base, {waitUntil: 'networkidle'});
  return {context, page, cspViolations, pageErrors};
}

/** The bottom tab bar, addressed by role so it never collides with a button that happens to share its label. */
export const tab = (page, name) => page.getByRole('tab', {name, exact: true});

export async function signIn(page, token) {
  await page.locator('input[aria-label="Access code"]').fill(token);
  await page.locator('button:has-text("Sign in")').click();
  await waitFor(async () => await tab(page, 'Today').count() > 0, 'the app shell after sign-in');
}

/**
 * Read the gateway as the signed-in person, through the page's own session.
 * Returns null rather than throwing when the response is not JSON (a rate-limit
 * or an expired session), so a polling caller keeps waiting instead of failing
 * on a parse error that hides what actually happened.
 */
export const state = page => page.evaluate(async () => {
  // The gateway rate-limits by client address, so a long run of scenarios from
  // one machine can legitimately hit the ceiling. Waiting out the window is the
  // correct response to a 429; the limit is a feature, not something to raise
  // for the convenience of the test.
  for (let attempt = 0; attempt < 16; attempt++) {
    const res = await fetch('/api/state', {credentials: 'same-origin'});
    if (res.status === 429) {await new Promise(r => setTimeout(r, 5000)); continue;}
    try {return await res.json();} catch {return null;}
  }
  return null;
});
export const csrf = page => page.evaluate(async () => (await fetch('/api/session', {credentials: 'same-origin'})).json().then(s => s.csrf));

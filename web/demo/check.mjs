// Uses the published preview the way a person would, on a phone-sized
// Chromium, with the page wrapped exactly as the artifact host wraps it and a
// content policy that refuses any network request. Three passes:
//
//   scripted   no Claude in the page (a local build, or a viewer without it)
//   claude     stand-ins for the viewer's capabilities: `sample`, calling the
//              page's tools the way Claude does; `db` and `user`, keeping the
//              account across reloads; `mcp` and `permissions`, a Gmail and a
//              Google Calendar that record every call
//   declined   the viewer refuses to let the page use Claude
//
//     npm run build:demo && npm run check:demo
//
// Real `sample`, `db` and `mcp` calls only exist inside a claude.ai viewer and are not made here.
import {createServer} from 'node:http';
import {mkdirSync, readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, '../../gateway/package.json'));
const {chromium} = require('playwright');
const shots = path.join(here, '../demo-dist/shots');
mkdirSync(shots, {recursive: true});

// What the artifact host puts around a published page (see the Artifact tool's page contract).
const page = readFileSync(path.join(here, '../demo-dist/vision-bot-pro.html'), 'utf8');
const wrapped = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover">'
  + '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif;background:#faf9f7}img{max-width:100%}[hidden]{display:none!important}</style>'
  + `</head><body>${page}</body></html>`;
const server = createServer((req, res) => {
  if (req.url !== '/') {res.statusCode = 404; res.end(); return;}
  res.setHeader('content-type', 'text/html; charset=utf-8');
  // Nothing may leave the page: the preview has no server to reach.
  res.setHeader('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob: data:; media-src blob:; connect-src 'none'; frame-src 'none'; base-uri 'none'");
  res.end(wrapped);
}).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const url = `http://127.0.0.1:${server.address().port}/`;

// Stands in for the viewer's `sample`: it calls the page's tools the way Claude would for each task, and records every call.
const claudeStandIn = mode => `(() => {
  window.__calls = [];
  const sample = async (input, options = {}) => {
    const tools = options.tools ?? [];
    window.__calls.push({tools: tools.map(t => ({name: t.name, description: t.description.length, schema: JSON.stringify(t.inputSchema).length})),
      hasCache: 'cache' in options, cache: options.cache, images: options.images ? options.images.length : 0, modelTier: options.modelTier, input});
    if (${JSON.stringify(mode)} === 'declined') throw {code: 'not_granted', message: 'The viewer declined.'};
    if (tools.length && 'cache' in options) throw {code: 'invalid_request', message: 'cache passed with tools'};
    const task = /Task: ([\\s\\S]*)$/.exec(input)?.[1] ?? '';
    const call = (name, args) => tools.find(t => t.name === name).execute(args, {signal: options.signal ?? new AbortController().signal});
    if (/text maria/i.test(task)) return {text: 'STUB text: ' + (await call('send_text', {contact: 'Maria Lopez', message: 'Hi Maria, running 10 minutes late.'})).status, truncated: false};
    if (/cartridges/i.test(task)) {
      const found = await call('compare_prices', {item: 'Shower cartridge', quantity: 2, typical_unit_price_usd: 42});
      const best = found.offers.find(o => o.match === 'exact');
      return {text: 'STUB buy: ' + (await call('buy', {offer_id: best.offer_id, quantity: 2, fulfillment: 'pickup'})).status, truncated: false};
    }
    if (/browse/i.test(task)) {const r = await call('use_browser', {task: 'Find a cartridge', search: 'moen 1222 cartridge', typical_unit_price_usd: 40}); return {text: 'STUB browser: ' + r.status + ' ' + (r.found?.name ?? ''), truncated: false};}
    if (/ask me/i.test(task)) return {text: 'STUB answer: ' + (await call('ask_owner', {question: 'Which unit is it?'})).answer, truncated: false};
    if (/nobody/i.test(task)) {try {await call('send_text', {contact: 'Zed', message: 'x'});} catch (e) {return {text: 'STUB error: ' + e.message, truncated: false};}}
    const tryCall = async (name, args) => {try {return await call(name, args);} catch (e) {return {status: 'error: ' + e.message};}};
    if (/my contractor/i.test(task)) {const r = await tryCall('send_text', {contact: 'my contractor', message: 'Hi Joe, the part is in.'}); return {text: 'STUB contractor: ' + r.status + ' ' + (r.name ?? ''), truncated: false};}
    if (/inbox/i.test(task)) {const r = await tryCall('search_email', {query: 'in:inbox'}); return {text: 'STUB inbox: ' + (r.threads ? r.threads.threads.length + ' threads' : r.status), truncated: false};}
    if (/^Email /i.test(task)) {const r = await tryCall('send_email', {to: ['joe@example.com'], subject: 'Order RS-123', body: 'Hi Joe, the bolts are ordered.'}); return {text: 'STUB email: ' + r.status, truncated: false};}
    if (/calendar/i.test(task)) {const r = await tryCall('add_calendar_event', {title: 'Plumber visit', start: '2026-10-08T10:00:00-07:00', end: '2026-10-08T11:00:00-07:00', location: 'Unit 4B', guests: ['joe@example.com']}); return {text: 'STUB event: ' + r.status, truncated: false};}
    return {text: 'STUB answer to: ' + task + (options.images ? ' with ' + options.images.length + ' image' : ''), truncated: false};
  };
  sample.limits = async () => ({maxPromptBytes: 262144, images: {maxCount: 5, maxInputBytes: 20000000, mediaTypes: ['image/jpeg', 'image/png']}, tools: {maxCount: 16}});
  // Damage inspection: one possible crack, boxed, as Claude would describe the frame.
  window.__json = [];
  sample.json = async (input, options = {}) => {
    window.__json.push({images: options.images ? options.images.length : 0, modelTier: options.modelTier, input});
    return {findings: [{type: 'crack', severity: 'high', confidence: 0.82, description: 'Possible crack across the left bracket', location: 'left bracket', box: [480, 230, 640, 330], recommendation: 'Have a fitter check it'}],
      summary: 'One possible crack.', needsProfessional: false};
  };
  if (${JSON.stringify(mode)} === 'declined') {window.claude = {use: async name => (name === 'sample' ? sample : null)}; return;}

  // The viewer's private corner of the artifact's database, kept in this browser so a reload finds it.
  const kept = JSON.parse(localStorage.getItem('standin-db') || '{}');
  const keep = () => localStorage.setItem('standin-db', JSON.stringify(kept));
  window.__db = kept;
  const db = {collection: path => ({doc: id => {
    const key = path + '/' + id;
    return {
      get: async () => ({exists: key in kept, data: () => (key in kept ? JSON.parse(JSON.stringify(kept[key])) : undefined)}),
      set: async data => {const text = JSON.stringify(data); if (text.length > 262144) throw {code: 'invalid_argument', message: 'too big'}; kept[key] = JSON.parse(text); keep();},
      delete: async () => {delete kept[key]; keep();},
    };
  }})};
  const user = {id: async () => 'viewer-1'};

  // The viewer's Gmail and Google Calendar connectors, and claude.ai's question about each.
  const grants = JSON.parse(localStorage.getItem('standin-grants') || '{}');
  const permissions = {
    state: async name => grants[name] ?? 'prompt',
    request: async names => {for (const n of names) grants[n] = 'granted'; localStorage.setItem('standin-grants', JSON.stringify(grants)); return Object.fromEntries(names.map(n => [n, grants[n]]));},
  };
  window.__mcp = [];
  const mcp = {
    listTools: async () => ({servers: [{server: 'Gmail', authStatus: 'connected', tools: [{name: 'search_threads'}]}, {server: 'Google Calendar', authStatus: 'connected', tools: [{name: 'list_events'}]}]}),
    callTool: async (server, tool, input) => {
      window.__mcp.push({server, tool, input});
      if (tool === 'search_threads') return {payload: {threads: [{id: 't1', subject: 'Invoice 4471'}, {id: 't2', subject: 'Thursday visit'}]}};
      if (tool === 'send_message') return {payload: {id: 'm1', threadId: 't9', labelIds: ['SENT']}};
      if (tool === 'create_event') return {payload: {id: 'e1'}};
      return {payload: {}};
    },
  };
  const caps = {sample, db, user, permissions, mcp};
  window.claude = {use: async name => caps[name] ?? null};
})();`;

const results = [];
let shot = 0;
const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium', args: ['--no-sandbox']});

async function phone(mode) {
  const context = await browser.newContext({viewport: {width: 390, height: 844}, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'});
  if (mode !== 'scripted') await context.addInitScript(claudeStandIn(mode));
  const p = await context.newPage();
  p.problems = [];
  p.on('pageerror', e => p.problems.push(`page error: ${e.message}`));
  p.on('console', m => {if (m.type() === 'error') p.problems.push(`console: ${m.text()}`);});
  p.on('request', r => {if (!r.url().startsWith(url) && !/^(blob|data|about):/.test(r.url())) p.problems.push(`network: ${r.url()}`);});
  await p.goto(url);
  return p;
}

async function check(p, name, fn) {
  try {
    await fn();
    results.push({name, ok: true});
    console.log(`ok   ${name}`);
  } catch (e) {
    results.push({name, ok: false});
    console.log(`FAIL ${name} — ${String(e.message).split('\n')[0]}`);
    await p.screenshot({path: path.join(shots, `${String(++shot).padStart(2, '0')}-fail.png`)}).catch(() => {});
  }
}
const expect = (ok, what) => {if (!ok) throw new Error(what);};
const snap = (p, name) => p.screenshot({path: path.join(shots, `${String(++shot).padStart(2, '0')}-${name}.png`)});

// How a person gets around.
const tab = (p, name) => p.getByRole('tab', {name}).click();
const text = p => p.locator('body').innerText();
const approval = (p, label) => p.locator('section.approval').filter({has: p.getByRole('heading', {name: label, exact: true})});
async function send(p, task) {
  await tab(p, 'Today');
  await p.getByLabel('Ask or assign something').fill(task);
  await p.getByRole('button', {name: 'Send', exact: true}).click();
}
async function until(p, what, timeout = 20000) {
  const started = Date.now();
  for (;;) {
    const body = await text(p);
    if (typeof what === 'string' ? body.includes(what) : what.test(body)) return body;
    if (Date.now() - started > timeout) throw new Error(`never showed ${what}`);
    await p.waitForTimeout(250);
  }
}
const rows = async card => (await card.locator('dl.terms').innerText()).replace(/\n+/g, ' | ');

// --- scripted ------------------------------------------------------------------

{
  const p = await phone('scripted');

  await check(p, 'opens signed in on sample data, with the purchase waiting and its exact terms', async () => {
    await until(p, 'Preview on sample data');
    const card = approval(p, 'Buy this');
    await card.waitFor();
    const terms = await rows(card);
    for (const part of ['Supplier | Riverside Building Supply', 'Item | 40 × M6 × 40mm A4 stainless hex bolt, $1.32 each', 'Subtotal | $52.80', 'Tax | $3.83', 'Total | $56.63 USD', 'How you get it | Pickup at Riverside yard, 4 mi · ready today', 'Price held until'])
      expect(terms.includes(part), `terms lack "${part}": ${terms}`);
    expect(!(await card.getByRole('button', {name: 'Always allow this'}).count()), 'money offered standing permission');
    await snap(p, 'today');
  });

  await check(p, 'approving the purchase places the order, shown with its receipt', async () => {
    await approval(p, 'Buy this').getByRole('button', {name: 'Allow once'}).click();
    await until(p, 'Ordered from Riverside Building Supply');
    await tab(p, 'Tasks');
    const body = await until(p, /order placed/i);
    expect(/Riverside Building Supply · order RS-\d{5}/.test(body), 'no order number');
    await p.getByRole('link', {name: 'Buy this'}).first().click();
    const dialog = p.getByRole('dialog');
    expect((await dialog.innerText()).includes('Total: $56.63 USD'), 'receipt lacks the total');
    await dialog.getByRole('button', {name: 'Close'}).click();
  });

  await check(p, 'the sample photo opens as evidence', async () => {
    await p.getByRole('link', {name: 'Handrail bracket.jpg'}).click();
    const img = p.getByRole('dialog').locator('img');
    await img.waitFor();
    expect(await img.evaluate(i => i.complete && i.naturalWidth > 0), 'photo did not load');
    await p.getByRole('dialog').getByRole('button', {name: 'Close'}).click();
  });

  await check(p, 'a text waits for approval, goes to the right number, and the reply comes back as a task', async () => {
    await send(p, 'Text Maria that the plumber is running late');
    const card = approval(p, 'Send this text');
    await card.waitFor({timeout: 10000});
    const terms = await rows(card);
    expect(terms.includes('To | Maria Lopez · +14155550143') && terms.includes('Message | Hi Maria, the plumber is running late.'), terms);
    expect(!(await card.getByRole('button', {name: 'Always allow this'}).count()), 'texts offered standing permission');
    await card.getByRole('button', {name: 'Allow once'}).click();
    await until(p, 'Sent to Maria Lopez');
    await until(p, 'Text from Maria Lopez:', 20000);
  });

  await check(p, 'a declined call is not placed', async () => {
    await send(p, 'Call Joe Park to confirm Thursday at 10');
    const card = approval(p, 'Place this call');
    await card.waitFor({timeout: 10000});
    expect((await rows(card)).includes('What the call is for | Call Joe Park to confirm Thursday at 10'), 'objective missing');
    await card.getByRole('button', {name: 'Not now'}).click();
    await until(p, 'You chose not to allow the call to Joe Park');
  });

  await check(p, 'a price comparison asks every supplier and names the one that did not answer', async () => {
    await send(p, 'Compare prices for 10 shower cartridges');
    await until(p, /5 of 6 suppliers answered/);
    await tab(p, 'Tasks');
    const body = await until(p, 'Shower cartridges, 10 off');
    expect(/Not included: .*\(too slow to answer\)/.test(body), 'missing supplier not named');
    expect(body.includes('Total not known'), 'an unquoted total was not flagged');
    await p.getByRole('link', {name: /^Open at /}).first().click();
    await until(p, 'This is a sample offer');
    await snap(p, 'comparison');
  });

  await check(p, 'buying compares first, then asks with the exact quote, then orders', async () => {
    await send(p, 'Buy 40 M6 stainless bolts');
    const card = approval(p, 'Buy this');
    await card.waitFor({timeout: 15000});
    expect((await rows(card)).includes('Item | 40 × M6 stainless bolts'), await rows(card));
    await card.getByRole('button', {name: 'Allow once'}).click();
    await until(p, /Ordered from \S.* after you approved the exact quote/);
  });

  await check(p, 'the browser: approve, watch, take over, search yourself, hand back, and it finishes', async () => {
    await send(p, 'Look up a Moen 1222 cartridge online');
    const card = approval(p, 'Let a browser do this web task');
    await card.waitFor({timeout: 10000});
    expect(await card.getByRole('button', {name: 'Always allow this'}).count(), 'browser use should offer standing permission');
    await card.getByRole('button', {name: 'Allow once'}).click();
    await p.getByRole('button', {name: 'Watch it browse'}).click({timeout: 10000});
    await until(p, /Your employee is browsing: (Opening|Searching)/);
    await p.locator('.vbp-site').getByText('Sample Hardware').waitFor({timeout: 2000});
    await p.waitForFunction(() => (document.querySelector('#vbp-q')?.value ?? '').length > 3, null, {timeout: 10000});
    await snap(p, 'browsing');
    // The shield keeps the owner's taps off the page while the employee drives.
    expect(await p.locator('.live-shield').isVisible(), 'no shield while the employee drives');
    await p.getByRole('button', {name: 'Take over'}).click();
    await until(p, "You're in control");
    expect(!(await p.locator('.live-shield').isVisible()), 'the shield stayed up');
    await p.locator('#vbp-q').fill('moen shower valve');
    await p.locator('#vbp-q').press('Enter');
    await until(p, '3 results for "moen shower valve"');
    await p.waitForTimeout(1500);
    expect((await text(p)).includes('3 results for "moen shower valve"'), 'the employee moved while the owner had control');
    await snap(p, 'taken-over');
    await p.getByRole('button', {name: 'Hand back'}).click();
    await until(p, 'Finished.', 30000);
    await p.getByRole('button', {name: '← Back'}).click();
    await until(p, 'On the sample shop site I found Moen shower valve');
  });

  await check(p, 'Stop in the live view ends the browser, and "Always allow" skips the next question', async () => {
    await send(p, 'Look up drywall screws online');
    const card = approval(p, 'Let a browser do this web task');
    await card.waitFor({timeout: 10000});
    await card.getByRole('button', {name: 'Always allow this'}).click();
    await p.getByRole('button', {name: 'Watch it browse'}).click({timeout: 10000});
    await until(p, 'Your employee is browsing:');
    await p.locator('.live').getByRole('button', {name: 'Stop'}).click();
    await until(p, 'Stopped.');
    await p.getByRole('button', {name: '← Back'}).click();
    await until(p, 'The browser task ended early: stopped by the owner.');
    await send(p, 'Look up caulk online');
    await p.getByRole('button', {name: 'Watch it browse'}).waitFor({timeout: 10000});
    expect(!(await approval(p, 'Let a browser do this web task').count()), 'asked again after Always allow');
    await until(p, 'On the sample shop site I found', 40000);
  });

  await check(p, 'remembering shows under Employee, and Forget removes it', async () => {
    await send(p, 'Remember that the gate code is 4412');
    await until(p, "I'll remember that");
    await tab(p, 'Employee');
    const row = p.locator('.row-item').filter({hasText: 'the gate code is 4412'});
    await row.waitFor();
    await row.getByRole('button', {name: 'Forget'}).click();
    await p.waitForTimeout(500);
    expect(!(await row.count()), 'still remembered');
  });

  await check(p, 'renaming the employee, and adding and removing a person', async () => {
    await p.getByLabel('Name', {exact: true}).fill('Rosa');
    await p.getByRole('button', {name: 'Save'}).first().click();
    await until(p, 'Saved.');
    expect(await p.getByLabel('Name', {exact: true}).inputValue() === 'Rosa', 'name not kept');
    await p.getByLabel('Contact name').fill('Sam Carter');
    await p.getByLabel('Contact phone number').fill('014-2233');
    await p.getByRole('button', {name: 'Add person'}).click();
    await until(p, 'full mobile number');
    await p.getByLabel('Contact phone number').fill('(415) 555-0199');
    await p.getByLabel('Contact company').fill('Carter Roofing');
    await p.getByRole('button', {name: 'Add person'}).click();
    await until(p, '+14155550199 · Carter Roofing');
    await p.locator('.row-item').filter({hasText: 'Sam Carter'}).getByRole('button', {name: 'Remove'}).click();
    await p.waitForTimeout(500);
    expect(!(await text(p)).includes('Sam Carter'), 'not removed');
  });

  await check(p, 'the camera starts, freezes, and a photo goes with a question', async () => {
    await tab(p, 'Today');
    await p.getByRole('button', {name: 'Start camera'}).click();
    await p.waitForFunction(() => {const v = document.querySelector('video.preview'); return !!v && v.videoWidth > 0;}, null, {timeout: 10000});
    await p.getByRole('button', {name: 'Freeze frame'}).click();
    await until(p, 'Frozen.');
    await p.getByRole('button', {name: 'Unfreeze'}).click();
    await p.getByLabel('Ask or assign something').fill('What is this bracket made of?');
    await p.getByRole('button', {name: 'Ask about this photo'}).click();
    await until(p, 'Photo sent.');
    await tab(p, 'Tasks');
    const card = p.locator('section.card').filter({has: p.getByRole('heading', {name: 'What is this bracket made of?'})});
    await card.waitFor();
    await card.getByRole('link', {name: /^Photo /}).click();
    const img = p.getByRole('dialog').locator('img');
    await img.waitFor();
    expect(await img.evaluate(i => i.naturalWidth === 720), 'the photo is not the camera frame');
    await p.getByRole('dialog').getByRole('button', {name: 'Close'}).click();
  });

  await check(p, '"Use my photo" makes the camera show your own picture', async () => {
    // A plain red picture, made the way a phone's photo would arrive: as a file.
    const png = Buffer.from((await p.evaluate(() => {const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'); x.fillStyle = '#ff0000'; x.fillRect(0, 0, 64, 64); return c.toDataURL('image/png');})).split(',')[1], 'base64');
    await p.locator('.preview-label input[type=file]').setInputFiles({name: 'mine.png', mimeType: 'image/png', buffer: png});
    await until(p, 'The camera now shows your photo');
    await tab(p, 'Today');
    await p.waitForTimeout(400);
    const [r, g, b] = await p.evaluate(() => {
      const v = document.querySelector('video.preview'); const c = document.createElement('canvas'); c.width = 8; c.height = 8;
      const x = c.getContext('2d'); x.drawImage(v, 0, 0, 8, 8); return [...x.getImageData(4, 4, 1, 1).data];
    });
    expect(r > 200 && g < 60 && b < 60, `camera shows ${r},${g},${b}, not the red picture`);
  });

  await check(p, 'Stop on a task waiting for approval withdraws the approval', async () => {
    await send(p, 'Text Maria that the gate is open');
    await approval(p, 'Send this text').waitFor({timeout: 10000});
    await p.locator('section.card').filter({hasText: 'Needs you'}).getByRole('button', {name: 'Stop'}).click();
    await p.waitForTimeout(600);
    expect(!(await approval(p, 'Send this text').count()), 'approval still offered after Stop');
    await tab(p, 'Tasks');
    expect(/stopped · just now\s+Text Maria that the gate is open/i.test(await text(p)), 'task not shown as stopped');
  });

  await check(p, '"my contractor" is Joe Park: prices first, then a text about them, waiting for approval', async () => {
    await send(p, 'Price a Moen 1222 cartridge and text my contractor');
    const card = approval(p, 'Send this text');
    await card.waitFor({timeout: 15000});
    const terms = await rows(card);
    expect(terms.includes('To | Joe Park · +14155550178') && /Message \| Hi Joe, I found a replacement moen 1222 cartridge: .+ Can you fit it this week\?/.test(terms), terms);
    await card.getByRole('button', {name: 'Allow once'}).click();
    await until(p, 'Texted Joe Park after you approved it');
  });

  await check(p, 'a routine: saved with its schedule, run now, its last run shown, paused and deleted', async () => {
    await tab(p, 'Routines');
    await p.getByLabel('Routine name').fill('Bolt prices');
    await p.getByLabel('What it should do').fill('Compare prices for 40 M6 stainless bolts');
    await p.getByLabel('How often').selectOption('weekly');
    await p.getByLabel('Which day').selectOption('friday');
    await p.getByLabel('Time').fill('07:00');
    await p.getByRole('button', {name: 'Save routine'}).click();
    await until(p, 'Saved. Every Friday at 7:00 AM');
    const card = p.locator('section.routine').filter({hasText: 'Bolt prices'});
    await card.waitFor();
    expect(/Every Friday at 7:00 AM · next Fri/.test(await card.innerText()), await card.innerText());
    await card.getByRole('button', {name: 'Run now'}).click();
    await until(p, 'Started "Bolt prices"');
    await until(p, /Last run: Done · \d of \d suppliers answered/, 20000);
    await card.getByRole('button', {name: 'Pause'}).click();
    await card.getByRole('button', {name: 'Resume'}).waitFor();
    expect(/paused/i.test(await card.innerText()), 'not shown as paused');
    await card.getByRole('button', {name: 'Delete'}).click();
    await p.getByRole('alertdialog').getByRole('button', {name: 'OK'}).click();
    await p.waitForTimeout(500);
    expect(!(await card.count()), 'routine not deleted');
  });

  await check(p, 'without Claude, damage inspection says it needs Claude and stops', async () => {
    await tab(p, 'Today');
    if (await p.getByRole('button', {name: 'Start camera'}).count()) await p.getByRole('button', {name: 'Start camera'}).click();
    await p.getByRole('button', {name: /Inspect for damage/}).click();
    await until(p, 'Damage inspection needs Claude');
    await p.getByRole('button', {name: /Inspect for damage/}).waitFor();
  });

  await check(p, 'Settings says what is ready, and which supplier is not connected', async () => {
    await tab(p, 'Settings');
    const body = await until(p, 'Suppliers');
    for (const part of ['Carrying out tasks\n\nNot set up', 'Text messages\n\nReady', 'Phone calls\n\nReady', 'Using a browser\n\nReady', 'Voice and camera conversation\n\nNot set up', 'Searching the web\n\nNot set up', '6 of 7 connected', 'Needs NORTHSIDE_TOKEN', 'Connected tools: riverside',
      'Live browser\n\nReady', 'Fast routing\n\nRules', 'Saved sign-ins are not set up on this server', 'Gmail, Slack, Calendar, Notion and other apps are not set up on this server yet.'])
      expect(body.includes(part), `missing "${part}"`);
    await snap(p, 'settings');
  });

  await check(p, 'signing out shows the sign-in screen, Google sign-in says it is not in the preview, and any code signs back in', async () => {
    await p.getByRole('button', {name: 'Sign out'}).click();
    await p.getByLabel('Access code').waitFor();
    await until(p, 'Preview: any access code signs you in.');
    // The sign-in screen's Google button leads to the gateway, which the preview does not have.
    await p.getByRole('link', {name: 'Continue with Google'}).click();
    await until(p, 'Google sign-in is not part of this preview');
    expect(p.url() === url, `left the preview for ${p.url()}`);
    await p.getByLabel('Access code').fill('hello');
    await p.getByRole('button', {name: 'Sign in'}).click();
    await p.getByRole('tab', {name: 'Today'}).waitFor();
  });

  await check(p, 'Delete everything asks first, then leaves an empty account', async () => {
    await tab(p, 'Settings');
    await p.getByRole('button', {name: 'Delete everything'}).click();
    const ask = p.getByRole('alertdialog');
    await ask.waitFor();
    await ask.getByRole('button', {name: 'OK'}).click();
    await p.getByLabel('Access code').waitFor();
    await p.getByLabel('Access code').fill('hello');
    await p.getByRole('button', {name: 'Sign in'}).click();
    await tab(p, 'Tasks');
    await until(p, 'No tasks yet');
    await tab(p, 'Employee');
    await until(p, 'No one yet.');
  });

  await check(p, 'Reset brings the sample data back', async () => {
    await p.getByRole('button', {name: 'Reset'}).click();
    await approval(p, 'Buy this').waitFor();
  });

  await check(p, 'fits a 320px phone without sideways scrolling', async () => {
    await p.setViewportSize({width: 320, height: 700});
    for (const name of ['Today', 'Tasks', 'Routines', 'Employee', 'Settings']) {
      await tab(p, name);
      await p.waitForTimeout(200);
      const wide = await p.evaluate(() => document.documentElement.scrollWidth);
      expect(wide <= 320, `${name} is ${wide}px wide`);
    }
    await p.setViewportSize({width: 390, height: 844});
  });

  await check(p, 'no errors and no network use', async () => expect(!p.problems.length, p.problems.join('; ')));
  await p.context().close();
}

// --- with Claude -----------------------------------------------------------------

{
  const p = await phone('claude');
  const calls = () => p.evaluate(() => window.__calls);

  await check(p, 'with Claude, Settings says tasks are ready on Claude', async () => {
    await tab(p, 'Settings');
    await until(p, 'Carrying out tasks\n\nReady\n\nClaude, hosted by Anthropic.', 15000);
  });

  await check(p, 'Claude gets the tools within the platform limits, uncached, and answers', async () => {
    await send(p, 'What should I check before replacing a shower cartridge?');
    await until(p, 'STUB answer to: What should I check before replacing a shower cartridge?');
    const [call] = await calls();
    expect(call.tools.map(t => t.name).join() === 'send_text,place_call,compare_prices,buy,use_browser,ask_owner,remember,search_email,read_email,draft_email,send_email,calendar_events,add_calendar_event', call.tools.map(t => t.name).join());
    expect(call.tools.every(t => t.description <= 1024 && t.schema <= 4096), 'a tool is over the size limits');
    expect(!call.hasCache && call.modelTier === 'default', 'cache passed with tools, or wrong tier');
    for (const part of ['Maria Lopez, +14155550143', 'A4 316 stainless', 'offer_id offer-RS-118', 'Task: What should I check'])
      expect(call.input.includes(part), `brief lacks "${part}"`);
  });

  await check(p, 'Claude\'s text waits for the owner and reports what happened', async () => {
    await send(p, 'Text Maria I am running late');
    const card = approval(p, 'Send this text');
    await card.waitFor({timeout: 10000});
    expect((await rows(card)).includes('Message | Hi Maria, running 10 minutes late.'), 'wrong message');
    await card.getByRole('button', {name: 'Allow once'}).click();
    await until(p, 'STUB text: sent');
  });

  await check(p, 'Claude compares, then buys only after the owner approves the quote', async () => {
    await send(p, 'Get 2 shower cartridges');
    const card = approval(p, 'Buy this').filter({hasText: 'Shower cartridge'});
    await card.waitFor({timeout: 15000});
    await card.getByRole('button', {name: 'Allow once'}).click();
    await until(p, 'STUB buy: ordered');
    await tab(p, 'Tasks');
    await until(p, 'Shower cartridge, 2 off');
  });

  await check(p, 'Claude\'s browser task runs in the live view and returns what it found', async () => {
    await send(p, 'Please browse for a cartridge');
    const card = approval(p, 'Let a browser do this web task');
    await card.waitFor({timeout: 10000});
    await card.getByRole('button', {name: 'Allow once'}).click();
    await until(p, 'STUB browser: done Moen 1222 cartridge', 40000);
  });

  await check(p, 'Claude\'s question is answered in the app', async () => {
    await send(p, 'Ask me which unit before booking');
    const card = p.locator('section.approval').filter({hasText: 'A question for you'});
    await card.waitFor({timeout: 10000});
    expect((await rows(card)).includes('Which unit is it?'), 'question not shown');
    await card.getByLabel('Your answer').fill('4B');
    await card.getByRole('button', {name: 'Send answer'}).click();
    await until(p, 'STUB answer: 4B');
  });

  await check(p, 'a tool error goes back to Claude instead of failing the task', async () => {
    await send(p, 'Text nobody');
    await until(p, 'STUB error: No contact matches "Zed"');
  });

  await check(p, 'a photo is passed to Claude with the question', async () => {
    await tab(p, 'Today');
    await p.getByRole('button', {name: 'Start camera'}).click();
    await p.waitForFunction(() => (document.querySelector('video.preview')?.videoWidth ?? 0) > 0, null, {timeout: 10000});
    await p.getByRole('button', {name: 'Send photo'}).click();
    await until(p, 'Photo sent.');
    await tab(p, 'Today');
    await until(p, 'with 1 image');
  });

  await check(p, 'the brief says who each contact is, the owner\'s time, and which apps are real', async () => {
    const [first] = await calls();
    for (const part of ['Joe Park, +14155550178, Park Plumbing (My contractor, for plumbing and fixtures)', 'It is now ', 'The owner\'s real Gmail and Google Calendar'])
      expect(first.input.includes(part), `brief lacks "${part}"`);
  });

  await check(p, 'Claude texts "my contractor": Joe Park, after approval', async () => {
    await send(p, 'Tell my contractor the part is in');
    const card = approval(p, 'Send this text');
    await card.waitFor({timeout: 10000});
    expect((await rows(card)).includes('To | Joe Park · +14155550178'), await rows(card));
    await card.getByRole('button', {name: 'Allow once'}).click();
    await until(p, 'STUB contractor: sent Joe Park');
  });

  await check(p, 'Connected apps: Gmail and Google Calendar connect through claude.ai\'s own question', async () => {
    await tab(p, 'Settings');
    const gmail = p.locator('.app-row[data-app="gmail"]');
    await gmail.waitFor({timeout: 10000});
    expect((await gmail.innerText()).includes('Not connected'), await gmail.innerText());
    await gmail.getByRole('button', {name: 'Connect'}).click();
    await until(p, 'Gmail is connected.');
    await p.locator('.app-row[data-app="gmail"]').filter({hasText: 'Connected'}).getByRole('button', {name: 'Disconnect'}).waitFor();
    await p.locator('.app-row[data-app="googlecalendar"]').getByRole('button', {name: 'Connect'}).click();
    await until(p, 'Google Calendar is connected.');
    await snap(p, 'connected-apps');
  });

  await check(p, 'reading Gmail needs no approval and reaches the connector', async () => {
    await send(p, 'What is in my inbox?');
    await until(p, 'STUB inbox: 2 threads');
    const made = await p.evaluate(() => window.__mcp);
    expect(made.some(c => c.server === 'Gmail' && c.tool === 'search_threads' && c.input.query === 'in:inbox'), JSON.stringify(made));
  });

  await check(p, 'an email waits for approval of its exact words, then goes out through Gmail exactly as approved', async () => {
    await send(p, 'Email Joe the order details');
    const card = approval(p, 'Send this email');
    await card.waitFor({timeout: 10000});
    const terms = await rows(card);
    for (const part of ['App | Gmail', 'Action | Send email', 'To | joe@example.com', 'Subject | Order RS-123', 'Body | Hi Joe, the bolts are ordered.'])
      expect(terms.includes(part), `card lacks "${part}": ${terms}`);
    expect(!(await card.getByRole('button', {name: 'Always allow this'}).count()), 'email offered standing permission');
    expect(!(await p.evaluate(() => window.__mcp.some(c => c.tool === 'send_message'))), 'sent before approval');
    await snap(p, 'email-approval');
    await card.getByRole('button', {name: 'Allow once'}).click();
    await until(p, 'STUB email: sent');
    const sent = await p.evaluate(() => window.__mcp.find(c => c.tool === 'send_message'));
    expect(JSON.stringify(sent.input) === JSON.stringify({to: ['joe@example.com'], subject: 'Order RS-123', body: 'Hi Joe, the bolts are ordered.'}), JSON.stringify(sent.input));
  });

  await check(p, 'a declined email is not sent', async () => {
    await send(p, 'Email Joe again');
    const card = approval(p, 'Send this email');
    await card.waitFor({timeout: 10000});
    await card.getByRole('button', {name: 'Not now'}).click();
    await until(p, 'STUB email: declined by the owner');
    expect((await p.evaluate(() => window.__mcp.filter(c => c.tool === 'send_message').length)) === 1, 'a declined email was sent');
  });

  await check(p, 'a calendar event with a guest says it invites them, and is added only after approval, at the time asked', async () => {
    await send(p, 'Put the plumber visit on my calendar');
    const card = approval(p, 'Add this event and invite people');
    await card.waitFor({timeout: 10000});
    const terms = await rows(card);
    for (const part of ['App | Google Calendar', 'Action | Create event', 'Title | Plumber visit', 'Location | Unit 4B', 'Invite | joe@example.com (each gets an email invitation)'])
      expect(terms.includes(part), `card lacks "${part}": ${terms}`);
    expect(!(await p.evaluate(() => window.__mcp.some(c => c.tool === 'create_event'))), 'added before approval');
    await card.getByRole('button', {name: 'Allow once'}).click();
    await until(p, 'STUB event: added');
    const made = await p.evaluate(() => window.__mcp.find(c => c.tool === 'create_event'));
    expect(made.input.summary === 'Plumber visit' && made.input.attendees[0].email === 'joe@example.com' && made.input.notificationLevel === 'ALL' && !!made.input.timeZone, JSON.stringify(made.input));
    const starts = await p.evaluate(t => new Date(t).getTime(), made.input.startTime);
    expect(starts === Date.parse('2026-10-08T10:00:00-07:00'), `starts at ${made.input.startTime}`);
  });

  await check(p, 'a disconnected app is not used, and the app offers to connect it again', async () => {
    await tab(p, 'Settings');
    await p.locator('.app-row[data-app="gmail"]').getByRole('button', {name: 'Disconnect'}).click();
    await p.getByRole('alertdialog').getByRole('button', {name: 'OK'}).click();
    await until(p, 'Gmail is disconnected.');
    const before = await p.evaluate(() => window.__mcp.length);
    await send(p, 'What is in my inbox now?');
    await until(p, 'STUB inbox: error: The owner disconnected Gmail');
    await until(p, 'Your employee needs Gmail for a task.');
    expect((await p.evaluate(() => window.__mcp.length)) === before, 'the connector was called');
    await p.getByRole('button', {name: 'Connect Gmail'}).click();
    await until(p, 'Gmail is connected.');
  });

  await check(p, 'damage inspection: Claude checks the picture once, and the finding is boxed over the camera', async () => {
    await tab(p, 'Today');
    if (await p.getByRole('button', {name: 'Start camera'}).count()) await p.getByRole('button', {name: 'Start camera'}).click();
    await p.waitForFunction(() => (document.querySelector('video.preview')?.videoWidth ?? 0) > 0, null, {timeout: 10000});
    await p.getByRole('button', {name: /Inspect for damage/}).click();
    await until(p, /1 possible finding/i, 15000);
    await until(p, 'Possible crack across the left bracket');
    expect(await p.locator('.inspect-box').count() === 1, 'no box over the camera');
    await snap(p, 'inspection');
    await p.waitForTimeout(5000);
    const asked = await p.evaluate(() => window.__json);
    expect(asked.length === 1 && asked[0].images === 1 && asked[0].modelTier === 'default', `asked Claude ${asked.length} times`);
    await p.getByRole('button', {name: /Stop inspecting/}).click();
  });

  await check(p, 'the account is kept privately for the viewer: a reload brings back what changed', async () => {
    await until(p, 'saved for you');
    await tab(p, 'Employee');
    await p.getByLabel('Name', {exact: true}).fill('Rosa');
    await p.getByRole('button', {name: 'Save'}).first().click();
    await until(p, 'Saved.');
    await p.waitForTimeout(2800);
    expect(await p.evaluate(() => Object.keys(window.__db).join()) === 'data/users/viewer-1/preview', await p.evaluate(() => Object.keys(window.__db).join()));
    await p.reload();
    await tab(p, 'Employee');
    await p.waitForFunction(() => document.querySelector('input[aria-label="Name"]')?.value === 'Rosa', null, {timeout: 10000});
    await until(p, 'Gmail and Calendar are real once you connect them');
  });

  await check(p, 'a task waiting when the page reloads shows as stopped, and its question is withdrawn', async () => {
    await send(p, 'Text Maria I am running late');
    await approval(p, 'Send this text').waitFor({timeout: 10000});
    await p.waitForTimeout(2800);
    await p.reload();
    await tab(p, 'Tasks');
    await until(p, 'This page was closed or reloaded while the task was running');
    expect(!(await approval(p, 'Send this text').count()), 'the question is still offered');
  });

  await check(p, 'Delete everything is kept too: after a reload the account is still signed out and empty', async () => {
    await tab(p, 'Settings');
    await p.getByRole('button', {name: 'Delete everything'}).click();
    await p.getByRole('alertdialog').getByRole('button', {name: 'OK'}).click();
    await p.getByLabel('Access code').waitFor();
    await p.reload();
    await p.getByLabel('Access code').waitFor();
    await p.getByLabel('Access code').fill('hello');
    await p.getByRole('button', {name: 'Sign in'}).click();
    await tab(p, 'Tasks');
    await until(p, 'No tasks yet');
  });

  await check(p, 'Reset forgets the saved account and brings the sample data back', async () => {
    await p.getByRole('button', {name: 'Reset'}).click();
    await approval(p, 'Buy this').waitFor();
    await p.reload();
    await approval(p, 'Buy this').waitFor();
  });

  await check(p, 'no errors and no network use', async () => expect(!p.problems.length, p.problems.join('; ')));
  await p.context().close();
}

// --- Claude declined -------------------------------------------------------------

{
  const p = await phone('declined');
  await check(p, 'when the viewer declines Claude, the task still runs, scripted, and says why', async () => {
    await send(p, 'Text Maria that the gate code changed');
    const card = approval(p, 'Send this text');
    await card.waitFor({timeout: 10000});
    await card.getByRole('button', {name: 'Allow once'}).click();
    await until(p, 'You did not allow this preview to use Claude');
    await tab(p, 'Settings');
    await until(p, 'Carrying out tasks\n\nNot set up');
  });
  await check(p, 'no errors and no network use', async () => expect(!p.problems.length, p.problems.join('; ')));
  await p.context().close();
}

await browser.close();
server.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? '' : ''}`);
process.exit(failed.length ? 1 : 0);

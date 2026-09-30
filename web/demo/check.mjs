// Uses the published preview the way a person would, on a phone-sized
// Chromium, with the page wrapped exactly as the artifact host wraps it and a
// content policy that refuses any network request. Three passes:
//
//   scripted   no Claude in the page (a local build, or a viewer without it)
//   claude     a stand-in for the viewer's `sample` capability that calls the
//              page's tools the way Claude does, to check that plumbing
//   declined   the viewer refuses to let the page use Claude
//
//     npm run build:demo && npm run check:demo
//
// A real `sample` call only exists inside a claude.ai viewer and is not made here.
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
    return {text: 'STUB answer to: ' + task + (options.images ? ' with ' + options.images.length + ' image' : ''), truncated: false};
  };
  sample.limits = async () => ({maxPromptBytes: 262144, images: {maxCount: 5, maxInputBytes: 20000000, mediaTypes: ['image/jpeg', 'image/png']}, tools: {maxCount: 16}});
  window.claude = {use: async name => (name === 'sample' ? sample : null)};
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
    await until(p, 'Your employee is browsing. Tap Take over');
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
    await until(p, 'Your employee is browsing');
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
    await tab(p, 'Camera');
    await p.getByRole('button', {name: 'Start camera'}).click();
    await p.waitForFunction(() => {const v = document.querySelector('video.preview'); return !!v && v.videoWidth > 0;}, null, {timeout: 10000});
    await p.getByRole('button', {name: 'Freeze frame'}).click();
    await until(p, 'Frozen.');
    await p.getByRole('button', {name: 'Unfreeze'}).click();
    await p.getByLabel('What do you want to know about this?').fill('What is this bracket made of?');
    await p.getByRole('button', {name: 'Ask about this'}).click();
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
    await tab(p, 'Camera');
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

  await check(p, 'Settings says what is ready, and which supplier is not connected', async () => {
    await tab(p, 'Settings');
    const body = await until(p, 'Suppliers');
    for (const part of ['Carrying out tasks\n\nNot set up', 'Text messages\n\nReady', 'Phone calls\n\nReady', 'Using a browser\n\nReady', 'Voice and camera conversation\n\nNot set up', 'Searching the web\n\nNot set up', '6 of 7 connected', 'Needs NORTHSIDE_TOKEN', 'Connected tools: riverside'])
      expect(body.includes(part), `missing "${part}"`);
    await snap(p, 'settings');
  });

  await check(p, 'signing out shows the sign-in screen, and any code signs back in', async () => {
    await p.getByRole('button', {name: 'Sign out'}).click();
    await p.getByLabel('Access code').waitFor();
    await until(p, 'Preview: any access code signs you in.');
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
    for (const name of ['Today', 'Tasks', 'Employee', 'Camera', 'Settings']) {
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
    expect(call.tools.map(t => t.name).join() === 'send_text,place_call,compare_prices,buy,use_browser,ask_owner,remember', call.tools.map(t => t.name).join());
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
    await tab(p, 'Camera');
    await p.getByRole('button', {name: 'Start camera'}).click();
    await p.waitForFunction(() => (document.querySelector('video.preview')?.videoWidth ?? 0) > 0, null, {timeout: 10000});
    await p.getByRole('button', {name: 'Send photo'}).click();
    await until(p, 'Photo sent.');
    await tab(p, 'Today');
    await until(p, 'with 1 image');
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

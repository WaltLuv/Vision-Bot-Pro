// Each scenario asserts one behaviour of the running system. They share a page
// and run in order, because a later one relies on the sign-in an earlier one did.
import {openPhone, signIn, state, csrf, tab, waitFor} from './harness.mjs';

const PREVIEW = 'video.preview';

export async function appLoads({page, check, cspViolations, pageErrors}) {
  // The sign-in screen's wording is the owner's to change; its access-code field is what proves the app rendered.
  check('PWA loads and renders under the gateway CSP', await page.getByLabel('Access code', {exact: true}).count() > 0);
  check('no CSP violations while loading', cspViolations.length === 0, cspViolations[0] ?? '');
  check('no uncaught page errors while loading', pageErrors.length === 0, pageErrors[0] ?? '');
}

export async function session({page, context, check, token}) {
  await signIn(page, token);
  check('signs in and reaches the phone shell', true);
  const cookie = (await context.cookies()).find(c => c.name === 'vc_session');
  check('session cookie is HttpOnly and SameSite=Strict', !!cookie?.httpOnly && cookie?.sameSite === 'Strict', cookie ? `httpOnly=${cookie.httpOnly} sameSite=${cookie.sameSite}` : 'missing');
  check('access code is not persisted in the browser', await page.evaluate(t => !JSON.stringify({l: {...localStorage}, s: {...sessionStorage}}).includes(t), token));
}

export async function governedTask({page, check}) {
  await page.locator('textarea[aria-label="Ask or assign something"]').fill('Write a note about the shelf');
  await page.locator('button:has-text("Send")').click();
  await waitFor(async () => {
    await tab(page, 'Tasks').click();
    return (await page.locator('text=Done').count()) > 0;
  }, 'the task to finish', 90000);
  check('task completes through the gateway, the runtime and a governed tool', true);

  const body = await page.locator('.screen').innerText();
  check('the result is shown on the phone', /note is saved as task evidence/i.test(body), body.slice(0, 80));
  check('tool evidence is listed with the task', /Create a document as task evidence|Site note/i.test(body));

  const s = await state(page);
  const run = s?.run[0];
  check('the run was recorded as completed', run?.status === 'completed', `status=${run?.status}`);
  check('the run was executed by the selected runtime', run?.runtime === 'hermes', `runtime=${run?.runtime}`);
  check('the governed tool ran and was recorded', s?.action.find(a => a.name === 'document_create')?.status === 'completed');
  check('an evidence artifact was stored', s?.artifact.some(a => a.kind === 'document' || a.kind === 'tool_receipt'));
}

/**
 * The real capture path: getUserMedia, a live preview, freeze-frame as track
 * mute, and a still that travels to the gateway as owned evidence. Chromium
 * supplies a synthetic camera; everything above the device is the app's own code.
 */
export async function cameraAndMicrophone({page, check}) {
  await tab(page, 'Today').click();
  await page.locator('button:has-text("Start camera")').click();
  await waitFor(async () => await page.locator(PREVIEW).count() > 0, 'the camera preview');

  const live = await page.evaluate(async sel => {
    const v = document.querySelector(sel);
    for (let i = 0; i < 80 && (!v?.videoWidth || v.readyState < 2); i++) await new Promise(r => setTimeout(r, 100));
    const track = v?.srcObject?.getVideoTracks?.()[0];
    return {w: v?.videoWidth, h: v?.videoHeight, readyState: track?.readyState, muted: v?.muted, playsInline: v?.playsInline};
  }, PREVIEW);
  check('the camera opens and the preview shows live frames', live.w > 0 && live.h > 0 && live.readyState === 'live', `${live.w}x${live.h} track=${live.readyState}`);
  check('the preview is muted and inline, so it cannot hijack audio or go fullscreen', live.muted === true && live.playsInline === true);

  // Freeze is the native clients' pin: muting the track leaves the worker
  // holding the last frame it received.
  await page.locator('button:has-text("Freeze frame")').click();
  check('freezing the view disables the outgoing video track', await page.evaluate(sel => document.querySelector(sel)?.srcObject?.getVideoTracks?.()[0]?.enabled === false, PREVIEW));
  check('the frozen state is explained on screen', await page.locator('text=/Frozen\\./').count() > 0);
  await page.locator('button:has-text("Unfreeze")').click();
  check('unfreezing re-enables it', await page.evaluate(sel => document.querySelector(sel)?.srcObject?.getVideoTracks?.()[0]?.enabled === true, PREVIEW));

  const before = (await state(page))?.artifact.length ?? 0;
  await page.locator('button:has-text("Send photo")').click();
  await waitFor(async () => ((await state(page))?.artifact.length ?? 0) > before, 'the captured photo to reach the gateway', 45000, 1000);
  const s = await state(page);
  const photo = s?.artifact.find(a => a.kind === 'photo');
  check('a still captured from the live camera is stored as an owned photo', !!photo && photo.mime === 'image/jpeg', `mime=${photo?.mime}`);
  check('the photo is attached to a task as authorised visual context', s?.run.some(r => r.context?.attachments?.includes(photo?.id)));

  await page.locator('button:has-text("Stop camera")').click();
  check('stopping the camera releases the device', await page.evaluate(sel => {
    const v = document.querySelector(sel);
    return !v || !v.srcObject || v.srcObject.getVideoTracks().every(t => t.readyState === 'ended');
  }, PREVIEW));

  // The microphone is reachable in this context, but the app only publishes it
  // into a realtime session, which needs credentials this environment lacks.
  const mic = await page.evaluate(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({audio: true});
      const ok = s.getAudioTracks()[0]?.readyState === 'live';
      s.getTracks().forEach(t => t.stop());
      return ok;
    } catch (e) {return String(e);}
  });
  check('the microphone is available to the app in this context', mic === true, String(mic));
}

/** With no realtime credentials the app must say so and stay usable, not offer a dead control. */
export async function realtimeDegradesHonestly({page, check, base}) {
  const ticket = await page.evaluate(async token => (await fetch('/livekit-token', {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json', 'x-csrf-token': token}, body: '{}'})).status, await csrf(page));
  check('a realtime ticket is refused with a service status when unconfigured', ticket === 503, `status=${ticket}`);
  check('the app says voice is not set up rather than showing a dead control', await page.locator('text=/Voice conversation is not set up/').count() > 0);
  check('typing still works without any realtime credential', await page.locator('textarea[aria-label="Ask or assign something"]').count() > 0);
  void base;
}

/** A sensitive tool must stop the run and ask, and the answer must come from the person. */
export async function approvalGate({page, check}) {
  await tab(page, 'Today').click();
  await page.locator('textarea[aria-label="Ask or assign something"]').fill('Please ask me which room to use');
  await page.locator('button:has-text("Send")').click();

  await waitFor(async () => (await state(page))?.approval.some(a => a.status === 'pending'), 'the employee to ask', 150000, 1500);
  const pending = (await state(page))?.approval.find(a => a.status === 'pending');
  check('a sensitive tool stops the run and asks instead of proceeding', !!pending, `tool=${pending?.tool}`);
  check('the run waits on the person rather than continuing', (await state(page))?.run.find(r => r.id === pending.runId)?.status === 'needs_user');

  await waitFor(async () => await page.locator('text=/Which room should I use/').count() > 0, 'the question on screen');
  check('the exact question is shown on the phone', true);

  await page.locator('input[aria-label="Your answer"]').fill('The back office');
  await page.locator('button:has-text("Send answer")').click();
  await waitFor(async () => (await state(page))?.run.find(r => r.id === pending.runId)?.status === 'completed', 'the answered task to finish', 150000, 1500);
  check('answering releases the run and it completes', true);
  check('the decision was recorded against that exact approval', (await state(page))?.approval.find(a => a.id === pending.id)?.status === 'approved');
}

/** Stopping must end the work, not just the screen showing it. */
export async function cancellation({page, check}) {
  await tab(page, 'Today').click();
  await page.locator('textarea[aria-label="Ask or assign something"]').fill('Research this slowly and report back');
  await page.locator('button:has-text("Send")').click();
  await waitFor(async () => (await state(page))?.run.some(r => r.status === 'working'), 'the task to start', 150000, 1500);
  const running = (await state(page))?.run.find(r => r.status === 'working');
  check('a long task is accepted and starts working', !!running);

  await page.locator('button:has-text("Stop")').first().click();
  await waitFor(async () => (await state(page))?.run.find(r => r.id === running.id)?.status === 'cancelled', 'the task to stop', 120000, 1500);
  check('stopping marks the task cancelled immediately', true);

  // The model was still mid-answer; a cancelled run must not quietly finish later.
  await new Promise(r => setTimeout(r, Number(process.env.E2E_SLOW_MS ?? 8000) + 4000));
  const after = (await state(page))?.run.find(r => r.id === running.id);
  check('a cancelled task never completes afterwards', after?.status === 'cancelled' && !after?.result, `status=${after?.status}`);
  check('a cancelled task leaves no result artifact', !(await state(page))?.artifact.some(a => a.runId === running.id && a.kind === 'document'));
}

/** The work belongs to the server, not to the open page. */
export async function survivesDisconnect({browser, base, check, token}) {
  const first = await openPhone(browser, base);
  await signIn(first.page, token);
  await first.page.locator('textarea[aria-label="Ask or assign something"]').fill('Look into this slowly and tell me what you find');
  await first.page.locator('button:has-text("Send")').click();
  await waitFor(async () => (await state(first.page))?.run.some(r => r.status === 'working'), 'the long task to start', 150000, 1500);
  const started = (await state(first.page))?.run.find(r => r.status === 'working');
  check('a long task is acknowledged while it is still running', !!started && !started.result);

  // The conversation goes away mid-task: page closed, event stream dropped, all
  // client state gone.
  await first.context.close();

  const second = await openPhone(browser, base);
  await signIn(second.page, token);
  await waitFor(async () => (await state(second.page))?.run.find(r => r.id === started.id)?.status === 'completed', 'the task to finish without a client attached', 120000, 2000);
  const finished = (await state(second.page))?.run.find(r => r.id === started.id);
  check('the task completed while no client was connected', finished?.status === 'completed');
  check('its result is there on reconnect', !!finished?.result, String(finished?.result).slice(0, 60));
  await tab(second.page, 'Tasks').click();
  check('and the result is visible on the phone after reconnecting', /shelf|bolts|Done/i.test(await second.page.locator('.screen').innerText()));
  await second.context.close();
}

/** Two people on one gateway must not see each other at all. */
export async function ownershipIsolation({browser, base, check, token, otherToken}) {
  const alice = await openPhone(browser, base);
  await signIn(alice.page, token);
  const mine = await state(alice.page);
  const myRun = mine?.run[0], myArtifact = mine?.artifact[0];
  const contact = await alice.page.evaluate(async t => (await fetch('/api/contacts', {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json', 'x-csrf-token': t}, body: JSON.stringify({name: 'Private Contact', phone: '+15550001111'})})).json(), await csrf(alice.page));
  check('the first owner has tasks, artifacts and a contact', !!myRun && !!myArtifact && !!contact.id);
  await alice.context.close();

  const bob = await openPhone(browser, base);
  await signIn(bob.page, otherToken);
  const theirs = await state(bob.page);
  check('a second owner sees none of the first owner tasks', !theirs?.run.some(r => r.id === myRun.id), `${theirs?.run.length} own run(s)`);
  check('nor their artifacts', !theirs?.artifact.some(a => a.id === myArtifact.id));
  check('nor their contacts', !theirs?.contact.some(c => c.id === contact.id));
  check('nor their approvals', !theirs?.approval.some(a => mine.approval.some(m => m.id === a.id)));

  const probes = await bob.page.evaluate(async ids => {
    const get = async url => (await fetch(url, {credentials: 'same-origin'})).status;
    return {run: await get(`/api/runs/${ids.run}`), artifact: await get(`/api/artifacts/${ids.artifact}/content`)};
  }, {run: myRun.id, artifact: myArtifact.id});
  check("another owner's task reads as absent, not forbidden-with-detail", probes.run === 404, `status=${probes.run}`);
  check("another owner's artifact content is not served", probes.artifact === 404, `status=${probes.artifact}`);

  const writes = await bob.page.evaluate(async ({ids, t}) => {
    const post = async url => (await fetch(url, {method: 'POST', credentials: 'same-origin', headers: {'x-csrf-token': t, 'content-type': 'application/json'}, body: '{}'})).status;
    return {cancel: await post(`/api/runs/${ids.run}/cancel`), del: (await fetch(`/api/artifacts/${ids.artifact}`, {method: 'DELETE', credentials: 'same-origin', headers: {'x-csrf-token': t}})).status};
  }, {ids: {run: myRun.id, artifact: myArtifact.id}, t: await csrf(bob.page)});
  check("another owner cannot cancel someone else's task", writes.cancel >= 400, `status=${writes.cancel}`);
  await bob.context.close();

  const back = await openPhone(browser, base);
  await signIn(back.page, token);
  const after = await state(back.page);
  check('the first owner records are untouched by all of that', after?.run.some(r => r.id === myRun.id) && after?.artifact.some(a => a.id === myArtifact.id));
  await back.context.close();
}

export async function safety({page, check}) {
  const token = await csrf(page);
  const before = (await state(page))?.run.length;
  const replay = await page.evaluate(async t => {
    const send = () => fetch('/api/execute', {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json', 'x-csrf-token': t, 'idempotency-key': 'fixed-key'}, body: JSON.stringify({task: 'Say hello', context: {source: 'text', attachments: []}})}).then(r => r.json());
    return {first: (await send()).id, second: (await send()).id};
  }, token);
  check('a repeated submission resolves to the same run, not a second one', replay.first === replay.second, `${replay.first} vs ${replay.second}`);

  const csrfStatus = await page.evaluate(async () => (await fetch('/api/execute', {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json', 'idempotency-key': 'no-csrf'}, body: JSON.stringify({task: 'Should be refused', context: {source: 'text', attachments: []}})})).status);
  check('a mutation without the CSRF token is refused', csrfStatus === 403, `status=${csrfStatus}`);
  check('the refused request created no run', (await state(page))?.run.length === before + 1);

  await tab(page, 'Settings').click();
  await page.locator('button:has-text("Sign out")').click();
  await waitFor(async () => (await page.evaluate(async () => (await fetch('/api/state', {credentials: 'same-origin'})).status)) === 401, 'the session to be revoked');
  check('signing out revokes the session server-side', true);
}

/** Attachments are authority: a task may only carry evidence its owner holds. */
export async function attachmentRules({page, check}) {
  const s = await state(page);
  const photo = s?.artifact.find(a => a.kind === 'photo');
  check('a stored artifact never exposes its path on the server', photo && photo.path === undefined);

  const foreign = await page.evaluate(async t => (await fetch('/api/execute', {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json', 'x-csrf-token': t, 'idempotency-key': 'foreign-1'}, body: JSON.stringify({task: 'Use this', context: {source: 'phone', attachments: ['00000000-0000-4000-8000-000000000000']}})})).status, await csrf(page));
  check('an attachment that is not yours is refused', foreign >= 400, `status=${foreign}`);

  const linked = s?.evidence_link.some(l => s.run.some(r => r.id === l.runId && r.context?.attachments?.includes(l.artifactId)));
  check('evidence is linked to the task that was authorised to use it', linked);
}

/**
 * Procurement across more than one supplier, with one of them down. The point
 * is not that prices appear -- it is that the comparison says out loud it is
 * incomplete, so three prices are never mistaken for the market.
 */
export async function procurementComparison({page, check}) {
  await tab(page, 'Today').click();
  await page.locator('textarea[aria-label="Ask or assign something"]').fill('Price M6 bolts across suppliers');
  await page.locator('button:has-text("Send")').click();

  await waitFor(async () => ((await state(page))?.material.length ?? 0) > 0, 'the supplier search to run', 150000, 1500);
  const s = await state(page);
  const material = s.material[0];
  const offers = s.offer.filter(o => o.requestId === material.id);

  check('both configured suppliers were searched', material.suppliers?.length === 2, `searched=${material.suppliers?.map(x => x.id).join(',')}`);
  check('the supplier that answered produced offers', offers.length > 0, `${offers.length} offer(s)`);
  check('the supplier that failed is recorded as not having answered', material.suppliers?.find(x => x.id === 'northside_lumber')?.status === 'failed');
  check('one supplier failing did not erase the other supplier offers', offers.every(o => o.supplierId === 'riverside_supply'));
  check('every offer carries when its price was observed', offers.every(o => Date.parse(o.observedAt) > 0));

  // eBay credentials are present in this stack on purpose; it must still be absent.
  check('eBay is not in the search despite its credentials being set', !material.suppliers?.some(x => x.id === 'ebay'));

  const normalized = offers.find(o => o.sku === 'RS-118');
  check('offers normalize into one model with fulfillment and stock', !!normalized
    && normalized.pickup?.available === true && normalized.pickup?.location === 'Riverside yard'
    && normalized.delivery?.available === true && normalized.inventory === 36,
    normalized ? `pickup=${normalized.pickup?.available} stock=${normalized.inventory}` : 'missing');

  await tab(page, 'Tasks').click();
  await waitFor(async () => (await page.locator('text=/suppliers answered/').count()) > 0, 'the comparison on screen');
  const shown = await page.locator('.screen').innerText();
  check('the phone says how many suppliers answered', /1 of 2 suppliers answered/.test(shown), shown.match(/\d of \d suppliers answered/)?.[0] ?? '');
  check('the phone names the supplier that was not included', /Northside Lumber/.test(shown));
  check('the phone warns the comparison may be missing better prices', /There may be better prices than these/.test(shown));
  check('the phone shows when prices were checked', /checked .* ago|prices checked/i.test(shown));
  check('a complete total is shown for a fully quoted offer', /\$1[45]\.\d\d/.test(shown), shown.match(/\$\d+\.\d\d/g)?.join(' ') ?? '');
}

/**
 * The V1 loop, end to end on a phone: ask something it cannot know, watch it go
 * and find out, speak the next job instead of typing it, and confirm all of it
 * survives the app being closed and reopened.
 */
export async function v1AcceptanceLoop({page, browser, base, check, token}) {
  // --- ask something it has to look up (acceptance 3) ---------------------
  await tab(page, 'Today').click();
  await page.locator('textarea[aria-label="Ask or assign something"]').fill('Look up the current version of the tsx package and tell me what it is');
  await page.locator('button:has-text("Send")').click();

  await waitFor(async () => (await state(page))?.action.some(a => a.name === 'web_read' && a.status === 'completed'), 'the employee to read the web', 150000, 1500);
  const afterRead = await state(page);
  const readRun = afterRead.run.find(r => /tsx package/.test(r.task));
  check('an information question sends the employee to the web', !!afterRead.action.find(a => a.name === 'web_read' && a.status === 'completed'));

  await waitFor(async () => (await state(page))?.run.find(r => r.id === readRun.id)?.status === 'completed', 'the answer to come back', 150000, 1500);
  const answered = (await state(page)).run.find(r => r.id === readRun.id);
  check('it answers from what it actually read', /registry|version|dist-tags/i.test(String(answered?.result)), String(answered?.result).slice(0, 70));
  check('the web page it read is kept as evidence', (await state(page)).artifact.some(a => a.runId === readRun.id));

  // --- speak the next job (acceptance 4) ----------------------------------
  // Headless Chromium exposes webkitSpeechRecognition but has no speech engine
  // behind it, so it is replaced before any page script runs. Everything above
  // the engine — the control, the wiring, the box it fills, and sending it — is
  // the application's own code.
  await page.addInitScript(() => {
    class FakeRecognition {
      continuous = false; interimResults = false; lang = 'en-US';
      onresult = null; onerror = null; onend = null;
      start() {
        window.__listening = true;
        window.__spoke = phrase => this.onresult?.({resultIndex: 0, results: [Object.assign([{transcript: phrase}], {isFinal: true})]});
      }
      stop() {window.__listening = false; this.onend?.();}
      abort() {window.__listening = false;}
    }
    window.SpeechRecognition = FakeRecognition;
    window.webkitSpeechRecognition = FakeRecognition;
  });
  await page.reload({waitUntil: 'networkidle'});
  await waitFor(async () => await tab(page, 'Today').count() > 0, 'the app after reload');

  const micButton = page.locator('button[aria-label="Speak instead of typing"]');
  check('a microphone control is offered when the browser can listen', await micButton.count() > 0);
  await micButton.click();
  check('tapping it starts listening', await page.evaluate(() => window.__listening === true));
  check('it says it is listening', await page.locator('text=/Listening…/').count() > 0);

  await page.evaluate(() => window.__spoke('Check the smoke alarms in unit twelve'));
  const composer = page.locator('textarea[aria-label="Ask or assign something"]');
  check('what was said lands in the box, for you to read before it goes', (await composer.inputValue()) === 'Check the smoke alarms in unit twelve', await composer.inputValue());

  await page.locator('button:has-text("Send")').click();
  check('sending stops the microphone', await page.evaluate(() => window.__listening === false));
  await waitFor(async () => (await state(page))?.run.some(r => r.task === 'Check the smoke alarms in unit twelve'), 'the spoken task to be accepted', 150000, 1500);
  check('a spoken job becomes a real task', true);

  // --- history and Today (acceptance 12, 13) ------------------------------
  await tab(page, 'Tasks').click();
  const history = await page.locator('.screen').innerText();
  check('the task history shows the work', /tsx package/.test(history) && /smoke alarms/.test(history));

  await tab(page, 'Today').click();
  check('completed work shows on Today', /Recently finished|Done/i.test(await page.locator('.screen').innerText()));

  // --- survives being closed and reopened (acceptance 14) -----------------
  const before = await state(page);
  const context2 = await browser.newContext({viewport: {width: 390, height: 844}});
  const fresh = await context2.newPage();
  await fresh.goto(base, {waitUntil: 'networkidle'});
  await signIn(fresh, token);
  const after = await state(fresh);
  check('the employee is still the same employee after reopening', after?.agent[0]?.id === before.agent[0]?.id);
  check('tasks, runs and results are all still there', after?.run.length === before.run.length
    && after.run.find(r => r.id === readRun.id)?.result === answered?.result, `${before.run.length} -> ${after?.run.length}`);
  check('the conversation is still there', after?.conversation.length === before.conversation.length);
  check('the evidence is still there', after?.artifact.length === before.artifact.length);
  await context2.close();
}

/** Phone widths the product is specified for. */
export async function phoneWidths({browser, base, check, token}) {
  for (const width of [375, 390, 430]) {
    const context = await browser.newContext({viewport: {width, height: 844}});
    const page = await context.newPage();
    await page.goto(base, {waitUntil: 'networkidle'});
    await signIn(page, token);
    const overflow = await page.evaluate(() => ({
      body: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      widest: Math.max(...[...document.querySelectorAll('.screen *')].map(n => n.getBoundingClientRect().right)),
      client: document.documentElement.clientWidth,
    }));
    check(`no sideways scrolling at ${width}px`, overflow.body <= 0, `overflow=${overflow.body}px`);
    check(`nothing runs off the screen at ${width}px`, overflow.widest <= overflow.client + 1, `widest=${Math.round(overflow.widest)} client=${overflow.client}`);
    const tabs = await page.locator('[role="tab"]').count();
    check(`all five areas reachable at ${width}px`, tabs === 5, `${tabs} tabs`);
    await context.close();
  }
}

/**
 * Watching the employee use a browser, and taking it over. The live view is a
 * real https page framed under the app's own policy. What matters: it is shown,
 * it is not reloaded by the app's constant re-rendering, taps and typing reach
 * the website only once the owner has control, and control is only ever
 * granted after the provider actually stopped the employee's run.
 */
export async function liveBrowser({page, check, browserUse, cspViolations}) {
  await tab(page, 'Today').click();
  await page.locator('textarea[aria-label="Ask or assign something"]').fill('Browse the web for the M6 bolt spec sheet');
  await page.locator('button:has-text("Send")').click();

  await waitFor(async () => (await state(page))?.approval.some(a => a.status === 'pending' && a.tool === 'browser_work'), 'the browser request', 150000, 1500);
  check('using a browser asks first', true);
  await page.locator('button:has-text("Allow once")').first().click();

  await waitFor(async () => await page.locator('button:has-text("Watch it browse")').count() > 0, 'the Watch card', 60000, 750);
  check('Today offers to watch the employee browse', true);
  await page.locator('button:has-text("Watch it browse")').click();

  const live = page.locator('.live');
  const frame = page.locator('.live-frame');
  await waitFor(async () => await live.isVisible() && (await frame.getAttribute('src'))?.startsWith(`https://live.visionclaw.test/`), 'the live view to open', 20000, 300);
  check('the live view opens full screen over the app', await live.isVisible());

  const remote = page.frameLocator('.live-frame');
  await waitFor(async () => await remote.locator('h1').textContent() === 'Remote site', 'the remote page to load', 20000, 300);
  check('the live page loads under the app\'s frame policy', true);
  check('no frame-policy violation', cspViolations.length === 0, cspViolations[0] ?? '');

  // Watching: the view is covered, so a tap on the remote button goes nowhere.
  const box = await remote.locator('#press').boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  check('while the employee drives, your taps do not reach the website', await remote.locator('#presses').textContent() === '0');

  await page.locator('.live button:has-text("Take over")').click();
  await waitFor(async () => /You're in control/.test(await page.locator('.live-status').textContent()), 'control to change hands', 20000, 300);
  check('taking over stops the employee\'s current run at the browser provider first', browserUse.calls.includes('cancel:bu-e2e-1'));
  check('the screen says you are in control only after that', true);
  const during = await state(page);
  check('stopping the employee\'s run to hand you the browser does not end the task', during?.computer.some(c => c.status === 'working') && during?.run.some(r => r.status === 'working' || r.status === 'needs_user'));

  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await waitFor(async () => await remote.locator('#presses').textContent() === '1', 'the tap to land', 5000, 200);
  check('once in control, your taps reach the website', true);
  await remote.locator('#typed').fill('M6 x 20');
  check('and so does your typing', await remote.locator('#typed').inputValue() === 'M6 x 20');
  check('the live view was never reloaded by the app re-rendering', browserUse.loads() === 1, `loads=${browserUse.loads()}`);

  await page.locator('.live button:has-text("Hand back")').click();
  await waitFor(async () => /Your employee is browsing/.test(await page.locator('.live-status').textContent()), 'control to return', 20000, 300);
  check('handing back starts a follow-up run in the same browser session', browserUse.created.length === 2 && browserUse.created[1].sessionId === 'sess-e2e', `runs=${browserUse.created.length}`);
  check('telling the employee to carry on from the page as you left it', /handed it back/.test(browserUse.created[1]?.task ?? ''));
  check('the live view carried straight on, still never reloaded', browserUse.loads() === 1, `loads=${browserUse.loads()}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  check('and your taps stop reaching the website again', await remote.locator('#presses').textContent() === '1');

  await page.locator('.live button:has-text("Stop")').click();
  await waitFor(async () => (await page.locator('.live-status').textContent()) === 'Stopped.', 'the browser to stop', 20000, 300);
  check('stopping cancels the employee\'s follow-up run at the provider', browserUse.calls.includes('cancel:bu-e2e-2'));
  check('and lets go of the live view', (await frame.getAttribute('src')) === 'about:blank');
  const s = await state(page);
  check('the gateway keeps no live link once it ends', !s?.computer.some(c => c.liveUrl || c.liveEmbed));

  await page.locator('.live').getByRole('button', {name: '← Back', exact: true}).click();
  check('Back returns to the app', !(await live.isVisible()));
  check('and the Watch card is gone', await page.locator('button:has-text("Watch it browse")').count() === 0);
}

/**
 * A browser the employee drives itself (Browserbase), step by step, through
 * the real Hermes runtime. Taking it over needs no provider at all: the app
 * holds the employee's next step until the browser is handed back -- so the
 * pause is proven here by the employee visibly not reaching the shop.
 */
export async function drivenBrowser({page, check, browserbase}) {
  await tab(page, 'Today').click();
  await page.locator('textarea[aria-label="Ask or assign something"]').fill('Surf to the hardware shop and check the part');
  await page.locator('button:has-text("Send")').click();

  await waitFor(async () => (await state(page))?.approval.some(a => a.status === 'pending' && a.tool === 'browser_open'), 'the browser request', 150000, 1500);
  check('opening a browser the employee drives asks first', true);
  await page.locator('button:has-text("Allow once")').first().click();

  await waitFor(async () => await page.locator('button:has-text("Watch it browse")').count() > 0, 'the Watch card', 60000, 400);
  await page.locator('button:has-text("Watch it browse")').click();
  await page.locator('.live button:has-text("Take over")').click();
  await waitFor(async () => /You're in control/.test(await page.locator('.live-status').textContent()), 'control to change hands', 10000, 200);
  check('taking over a browser the employee drives is immediate', true);

  await new Promise(r => setTimeout(r, Number(process.env.E2E_SURF_PAUSE_MS ?? 5000) + 2500));
  check('while you drive, the employee does not touch the browser', browserbase.shopVisits() === 0, `visits=${browserbase.shopVisits()}`);
  const holding = await state(page);
  check('and its task waits for you rather than failing', holding?.run.some(r => /Surf/.test(r.task) && ['working', 'needs_user'].includes(r.status)));

  await page.locator('.live button:has-text("Hand back")').click();
  await waitFor(async () => (await state(page))?.run.find(r => /Surf/.test(r.task))?.status === 'completed', 'the task to finish', 90000, 750);
  check('handing back lets it carry on and finish', browserbase.shopVisits() >= 1, `visits=${browserbase.shopVisits()}`);
  const done = await state(page);
  check('every step it took is on the record', ['browser_open', 'browser_goto', 'browser_read'].every(n => done?.action.some(a => a.name === n && a.status === 'completed')));
  check('and the answer came from the page it read', done?.run.find(r => /Surf/.test(r.task))?.result?.includes('3 in stock'));
  await waitFor(async () => browserbase.released.length > 0, 'the browser to be released', 15000, 300);
  check('the browser is released as soon as the task is done', true);
  if (await page.locator('.live').isVisible()) await page.locator('.live').getByRole('button', {name: '← Back', exact: true}).click();
}

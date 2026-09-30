import {api, newIdempotencyKey} from '../api';
import {h, mount} from '../dom';
import {cameraMessage} from '../camera';
import type {Card} from '../realtime';
import {activeRun, liveApprovals, relativeTime, runTitle, STATUS_LABEL, canResume, unreconciledActions} from '../store';
import {approvalCard} from './approvals';
import {richText} from '../rich';
import type {Ctx} from './ctx';
import {Dictation, dictationMessage, dictationSupported} from '../voice';

// One <video> element for the life of the app. Rebuilding it on every render
// would tear down and restart the camera on each keystroke elsewhere.
// Dictation outlives any one render. The screen is rebuilt on every gateway
// event, so handlers must not hold on to the elements that existed when
// listening started — they would be writing into a detached box. What was heard
// is kept here instead and put back on each render.
let dictation: Dictation | null = null;
let spoken = '';
let listening = false;
let listeningNote = '';
// What is typed outlives any one render the same way. A rebuilt box used to
// come back empty, so text typed while an update landed was lost and Send then
// sent nothing at all.
let draft = '';

const preview = document.createElement('video');
preview.muted = true; preview.playsInline = true; preview.autoplay = true;
preview.className = 'preview';

/**
 * What the camera shows right now, and a question about it, as one task: the
 * photo is attached to the question, so the answer is about that picture. False
 * when nothing was sent.
 */
export async function askAboutPhoto(ctx: Ctx, question: string): Promise<boolean> {
  if (ctx.busy) return false;
  // The frame first, then the busy screen: a rebuild moves the preview.
  const blob = await ctx.camera.capture(preview);
  if (!blob) {ctx.toast(ctx.camera.running ? 'The camera has not produced a frame yet.' : 'Start the camera first, then ask.'); return false;}
  ctx.busy = true; ctx.rerender();
  try {
    const artifact = await api.upload(blob, `Photo ${new Date().toLocaleString()}.jpg`);
    await api.execute(question, {source: 'phone', attachments: [artifact.id]}, newIdempotencyKey());
    await ctx.refresh();
    ctx.toast('Photo sent.');
    return true;
  } catch (err) {
    ctx.toast(err instanceof Error ? err.message : 'The photo could not be sent.');
    return false;
  } finally {
    ctx.busy = false; ctx.rerender();
  }
}

/** Hand a task to the employee. Shared by typing, dictation and the camera. */
export async function sendTask(ctx: Ctx, task: string, visual?: string) {
  if (!task.trim() || ctx.busy) return;
  ctx.busy = true; ctx.rerender();
  try {
    await api.execute(task.trim(), {source: ctx.camera.running ? 'phone' : 'text', attachments: [], ...(visual ? {visualDescription: visual} : {})}, newIdempotencyKey());
    await ctx.refresh();
  } catch (err) {
    ctx.toast(err instanceof Error ? err.message : 'That task did not start.');
  } finally {
    ctx.busy = false; ctx.rerender();
  }
}

export function today(ctx: Ctx): HTMLElement {
  const run = activeRun(ctx.state.run);
  const approvals = liveApprovals(ctx.state.approval);

  const send = async (task: string, visual?: string) => {
    if (!task.trim() || ctx.busy) return;
    ctx.busy = true; ctx.rerender();
    try {
      // A fresh key per submission: the gateway deduplicates on it, so a retry
      // after a dropped response resolves to the same run instead of a second one.
      await api.execute(task.trim(), {source: ctx.camera.running ? 'phone' : 'text', attachments: [], ...(visual ? {visualDescription: visual} : {})}, newIdempotencyKey());
      await ctx.refresh();
    } catch (err) {
      // It did not go through, so what was typed comes back rather than being lost.
      if (!draft.trim()) draft = task;
      ctx.toast(err instanceof Error ? err.message : 'That task did not start.');
    } finally {
      ctx.busy = false; ctx.rerender();
    }
  };

  const composer = h('textarea', {class: 'composer', rows: 2, placeholder: 'Ask or assign something…', 'aria-label': 'Ask or assign something'});
  composer.value = draft;
  composer.addEventListener('input', () => {draft = composer.value;});
  // If the box being rebuilt had the cursor, the new one takes it back, at the same place.
  const typing = document.activeElement instanceof HTMLTextAreaElement && document.activeElement.classList.contains('composer') ? document.activeElement : null;
  if (typing) {
    const [start, end] = [typing.selectionStart, typing.selectionEnd];
    queueMicrotask(() => {if (composer.isConnected) {composer.focus(); composer.setSelectionRange(start, end);}});
  }
  const heard = h('p', {class: 'note'});
  // Speaking fills the same box typing does, and you read it before it is sent.
  // Mishearing "Unit 12" as "Unit 20" and acting on it unasked is worse than a
  // moment spent checking.
  const mic = dictationSupported() ? h('button', {class: `ghost mic ${listening ? 'listening' : ''}`, 'aria-label': 'Speak instead of typing'}, listening ? '■ Stop' : '🎤 Speak') : null;
  if (mic) {
    if (listening) composer.value = spoken;
    heard.textContent = listeningNote;
    dictation ??= new Dictation({
      onText: text => {
        spoken = text;
        // Write to whichever box is on screen now, not the one captured when
        // listening began.
        const live = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Ask or assign something"]');
        if (live) live.value = text;
        draft = text;
      },
      onState: (state, detail) => {
        listening = state === 'listening';
        listeningNote = detail ?? dictationMessage[state];
        ctx.rerender();
      },
    });
    mic.addEventListener('click', () => {
      if (dictation!.listening) dictation!.stop();
      else {spoken = composer.value; dictation!.start(composer.value);}
    });
  }
  const submit = h('button', {class: 'primary', disabled: ctx.busy, onclick: () => {dictation?.stop(); if (ctx.busy || !composer.value.trim()) return; const v = composer.value; composer.value = ''; draft = ''; spoken = ''; listeningNote = ''; heard.textContent = ''; void send(v);}}, ctx.busy ? 'Sending…' : 'Send');
  composer.addEventListener('keydown', e => {
    // Enter sends, Shift+Enter makes a new line -- on a phone keyboard the
    // send key is the fast path and a newline is the rare one.
    // Busy or empty, Enter keeps what is typed rather than clearing it unsent.
    if (e.key === 'Enter' && !e.shiftKey) {e.preventDefault(); if (ctx.busy || !composer.value.trim()) return; const v = composer.value; composer.value = ''; draft = ''; void send(v);}
  });

  return h('div', {class: 'screen'},
    // A decision the employee is waiting on comes first: nothing moves until it is made.
    ...approvals.map(a => approvalCard(a, () => void ctx.refresh(), m => ctx.toast(m), ctx.state.contact)),
    cameraSection(ctx, send),
    ...ctx.cards.map(cardView),
    browsingCard(ctx),
    run ? runPanel(ctx, run) : null,
    transcriptPanel(ctx),
    h('section', {class: 'card'},
      h('h3', {text: 'Type instead'}),
      composer,
      h('div', {class: 'row wrap'}, submit, mic),
      heard,
      h('p', {class: 'note', text: 'Typing works whether or not the camera or microphone are on.'}),
    ),
    recent(ctx),
  );
}

export function cameraSection(ctx: Ctx, send: (task: string, visual?: string) => Promise<void>): HTMLElement {
  const cam = ctx.camera.state;
  // Here, not in the Today screen: the Camera tab shows this same panel, and a
  // camera started there was never shown or captured (a black preview).
  if (preview.srcObject !== cam.stream) preview.srcObject = cam.stream;
  // A screen without the camera takes the preview out of the page, and the
  // browser pauses it. Put back, it stayed on that old frame, and a photo taken
  // then was of the past, so it plays again as soon as it is shown.
  if (cam.stream) queueMicrotask(() => {if (preview.isConnected && preview.paused) preview.play()?.catch(() => {});});
  const live = ctx.session.live;

  const startCamera = async () => {const s = await ctx.camera.start(); if (s.stream && live) await ctx.session.publishCamera(s.stream.getVideoTracks()[0]!); ctx.rerender();};
  const stopCamera = async () => {await ctx.session.unpublishCamera(); ctx.camera.stop(); ctx.rerender();};
  const flip = async () => {
    // Flipping replaces the underlying track, so the published one has to be
    // swapped too or the worker keeps receiving the old lens.
    await ctx.session.unpublishCamera();
    const s = await ctx.camera.flip();
    if (s.stream && live) await ctx.session.publishCamera(s.stream.getVideoTracks()[0]!);
    ctx.rerender();
  };
  const capture = () => askAboutPhoto(ctx, 'Look at the attached photo and tell me what you see.');

  return h('section', {class: 'card camera'},
    cam.stream ? preview : h('div', {class: 'preview placeholder'}, h('p', {text: cam.error ? cameraMessage[cam.error] : 'Camera is off.'})),
    h('div', {class: 'row wrap'},
      cam.stream
        ? h('button', {class: 'ghost', onclick: () => void stopCamera()}, 'Stop camera')
        : h('button', {class: 'primary', onclick: () => void startCamera()}, 'Start camera'),
      cam.stream && ctx.cameraMultiple ? h('button', {class: 'ghost', onclick: () => void flip()}, cam.facing === 'environment' ? 'Front camera' : 'Back camera') : null,
      cam.stream ? h('button', {class: 'ghost', onclick: () => {ctx.camera.setPinned(!ctx.camera.pinned); ctx.rerender();}}, ctx.camera.pinned ? 'Unfreeze' : 'Freeze frame') : null,
      cam.stream ? h('button', {class: 'ghost', onclick: () => void capture()}, 'Send photo') : null,
    ),
    ctx.camera.pinned ? h('p', {class: 'note', text: 'Frozen. The employee keeps seeing this frame until you unfreeze.'}) : null,
    voiceRow(ctx, send),
  );
}

function voiceRow(ctx: Ctx, _send: (task: string) => Promise<void>): HTMLElement {
  const realtime = ctx.connections?.realtime;
  const state = ctx.sessionState;
  const start = async () => {
    try {
      await ctx.session.connect();
      const track = ctx.camera.state.stream?.getVideoTracks()[0];
      if (track) await ctx.session.publishCamera(track);
    } catch {/* connect() already reported why through onState */}
    ctx.rerender();
  };
  const end = async () => {await ctx.session.disconnect(); ctx.rerender();};

  if (realtime === false) {
    return h('p', {class: 'note', text: 'Voice conversation is not set up on this server. Typing and photos still work.'});
  }
  return h('div', {class: 'row wrap'},
    ctx.session.live
      ? h('button', {class: 'ghost danger', onclick: () => void end()}, 'End conversation')
      : h('button', {class: 'primary', disabled: state === 'connecting', onclick: () => void start()}, state === 'connecting' ? 'Connecting…' : 'Start conversation'),
    ctx.session.live ? h('button', {class: 'ghost', onclick: async () => {await ctx.session.setMicEnabled(!ctx.session.micEnabled); ctx.rerender();}}, ctx.session.micEnabled ? 'Mute' : 'Unmute') : null,
    state === 'reconnecting' ? h('span', {class: 'pill warn', text: 'Reconnecting…'}) : null,
    ctx.sessionDetail ? h('span', {class: `pill ${ctx.session.live ? '' : 'warn'}`, text: ctx.sessionDetail}) : null,
  );
}

/** While the employee is using a browser, one tap to watch it (and take it over). */
function browsingCard(ctx: Ctx): HTMLElement | null {
  const c = ctx.state.computer.find(x => x.status === 'starting' || x.status === 'working');
  if (!c) return null;
  const yours = c.control === 'owner';
  return h('section', {class: 'card'},
    h('p', {class: 'eyebrow', text: yours ? 'You have the browser' : 'Using the web'}),
    h('h3', {text: c.task}),
    h('button', {class: 'primary', onclick: () => ctx.watch(c.id)}, yours ? 'Back to the browser' : 'Watch it browse'));
}

function runPanel(ctx: Ctx, run: ReturnType<typeof activeRun> & {}): HTMLElement {
  const blocked = unreconciledActions(ctx.state.action, run.id);
  return h('section', {class: 'card'},
    h('p', {class: 'eyebrow', text: STATUS_LABEL[run.status]}),
    h('h3', {text: runTitle(run)}),
    run.error ? h('p', {class: 'note', text: run.error}) : null,
    blocked.length ? h('p', {class: 'note', text: 'An external action needs checking before this can continue. Open it under Tasks.'}) : null,
    h('div', {class: 'row'},
      h('button', {class: 'ghost danger', onclick: async () => {try {await api.cancel(run.id); await ctx.refresh();} catch (e) {ctx.toast(e instanceof Error ? e.message : 'Could not stop that.');}}}, 'Stop'),
      canResume(run, ctx.state.action) ? h('button', {class: 'ghost', onclick: async () => {try {await api.resume(run.id); await ctx.refresh();} catch (e) {ctx.toast(e instanceof Error ? e.message : 'Could not resume.');}}}, 'Resume') : null,
    ),
  );
}

function transcriptPanel(ctx: Ctx): HTMLElement | null {
  if (!ctx.transcript.length) return null;
  const list = h('div', {class: 'transcript'});
  mount(list, ...ctx.transcript.slice(-40).map(t =>
    h('p', {class: `line ${t.role} ${t.final ? '' : 'interim'}`}, h('span', {class: 'who', text: t.role === 'you' ? 'You' : 'Employee'}), h('span', {text: t.text}))));
  return h('section', {class: 'card'}, h('h3', {text: 'Conversation'}), list);
}

// Cards come from the worker. Rendered as text only, and an image that fails to
// load falls back to its caption rather than leaving an empty frame.
function cardView(card: Card): HTMLElement {
  const img = card.image_url ? h('img', {class: 'card-image', src: card.image_url, alt: card.title ?? 'Attached image'}) : null;
  if (img) img.addEventListener('error', () => {img.replaceWith(h('p', {class: 'note', text: card.fallback_text ?? 'Image could not be shown.'}));});
  return h('section', {class: 'card result'},
    card.title ? h('h3', {text: card.title}) : null,
    card.value ? h('p', {class: 'big', text: card.value}) : null,
    card.body ? h('p', {text: card.body}) : null,
    img,
    card.facts?.length ? h('dl', {class: 'terms'}, ...card.facts.flatMap(f => [h('dt', {text: f.label ?? ''}), h('dd', {text: f.value ?? ''})])) : null,
    card.items?.length ? h('ul', {class: 'items'}, ...card.items.map(i => h('li', {},
      h('span', {class: 'title', text: `${i.glyph ? i.glyph + ' ' : ''}${i.title ?? ''}`}),
      i.subtitle ? h('span', {class: 'sub', text: i.subtitle}) : null,
      i.trailing ? h('span', {class: 'trailing', text: i.trailing}) : null))) : null,
  );
}

function recent(ctx: Ctx): HTMLElement | null {
  const done = ctx.state.run.filter(r => r.status === 'completed').slice(0, 3);
  if (!done.length) return null;
  return h('section', {class: 'card'},
    h('h3', {text: 'Recently finished'}),
    ...done.map(r => h('div', {class: 'row-item'},
      h('p', {class: 'task', text: runTitle(r)}),
      // The answer belongs where the question was asked, not only under Tasks.
      r.result ? h('p', {class: 'result-text'}, ...richText(r.result.length > 280 ? `${r.result.slice(0, 280)}…` : r.result)) : null,
      h('p', {class: 'note', text: `${relativeTime(r.completedAt ?? r.createdAt)} · ${STATUS_LABEL[r.status]}`}))),
    h('button', {class: 'ghost', onclick: () => ctx.go('tasks')}, 'See all tasks'),
  );
}

import {h} from '../dom';
import {askAboutPhoto, cameraSection, sendTask} from './today';
import {forgetEdits} from '../fields';
import type {Ctx} from './ctx';

/**
 * The camera on its own, for when showing something is the whole point: point
 * the phone at a problem and ask about it. It is the same panel as on Today,
 * not a second copy, so freeze, flip and capture behave identically.
 */
// What was typed, kept while the screen rebuilds, and cleared only once it went.
let asking = '';

export function camera(ctx: Ctx): HTMLElement {
  const question = h('textarea', {class: 'composer', rows: 2, placeholder: 'What do you want to know about this?', 'aria-label': 'What do you want to know about this?'});
  question.value = asking;
  question.addEventListener('input', () => {asking = question.value;});
  const ask = h('button', {class: 'primary', disabled: ctx.busy}, ctx.busy ? 'Sending…' : 'Ask about this');
  ask.addEventListener('click', async () => {
    const text = question.value.trim();
    if (!text) {ctx.toast('Type what you want to know first.'); return;}
    // The question goes with a photo of what the camera shows, as one task.
    // Sent on its own, the employee was asked about a picture it never got.
    if (await askAboutPhoto(ctx, text)) {asking = ''; forgetEdits(); ctx.rerender();}
  });

  return h('div', {class: 'screen'},
    cameraSection(ctx, (task, visual) => sendTask(ctx, task, visual)),
    h('section', {class: 'card'},
      h('h3', {text: 'Ask about what you see'}),
      h('p', {class: 'note', text: 'Point the camera at it and ask. A photo of what the camera shows goes with your question.'}),
      question,
      h('div', {class: 'row'}, ask),
    ),
  );
}

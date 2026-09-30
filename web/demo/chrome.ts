// What the published page adds around the app: a line saying it is a preview,
// a way to use your own photo as the camera, a reset, a viewer for evidence,
// and a confirm step that works where the browser's own dialog cannot open.
import {h} from '../src/dom';
import {preview} from './gateway';

let line: HTMLElement | null = null;
let photoButton: HTMLElement | null = null;

export function toast(message: string) {
  const node = h('div', {class: 'toast', role: 'status', text: message});
  document.body.append(node);
  setTimeout(() => node.remove(), 5000);
}

export function setSignedIn(yes: boolean) {
  if (line) line.textContent = yes ? 'Preview on sample data. Texts, calls, the browser and orders are simulated.' : 'Preview: any access code signs you in.';
  if (photoButton) photoButton.hidden = !yes;
}

export function installPreviewChrome(options: {usePhoto?: (file: File) => Promise<void>; reset(): void}) {
  const picker = h('input', {type: 'file', accept: 'image/*', hidden: true, 'aria-label': 'Photo to use as the camera'});
  picker.addEventListener('change', async () => {
    const file = picker.files?.[0];
    picker.value = '';
    if (!file || !options.usePhoto) return;
    try {
      await options.usePhoto(file);
      toast('The camera now shows your photo. Start the camera, then Send photo or Ask about this.');
    } catch {
      toast('That photo could not be opened. Try a JPEG or PNG.');
    }
  });
  line = h('span', {class: 'preview-text'});
  photoButton = options.usePhoto ? h('button', {class: 'preview-button', type: 'button', onclick: () => picker.click()}, 'Use my photo') : null;
  document.body.prepend(h('div', {class: 'preview-label', role: 'note'}, line,
    h('span', {class: 'preview-actions'}, photoButton, h('button', {class: 'preview-button', type: 'button', onclick: () => options.reset()}, 'Reset'), picker)));
  setSignedIn(preview.signedIn);

  // Evidence opens in a new tab on the gateway, and an offer at its supplier.
  // A published page has neither, so evidence opens over the app and a sample
  // offer says what it is.
  document.addEventListener('click', event => {
    const link = (event.target as Element | null)?.closest?.('a');
    const href = link?.getAttribute('href') ?? '';
    if (href.startsWith('/api/artifacts/')) {event.preventDefault(); showEvidence(decodeURIComponent(href.split('/')[3] ?? ''));}
    else if (href === 'https://example.com/') {event.preventDefault(); toast('This is a sample offer, so there is no product page. In the app this opens the supplier\'s own page.');}
  }, true);

  installConfirm();
}

function showEvidence(id: string) {
  const artifact = preview.state.artifact.find(a => a.id === id);
  const file = preview.uploads.get(id);
  const url = file ? URL.createObjectURL(file) : '';
  const close = h('button', {class: 'ghost', type: 'button'}, 'Close');
  const dialog = h('div', {class: 'preview-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': artifact?.name || 'Evidence'},
    h('div', {class: 'card'},
      h('h3', {text: artifact?.name || 'Evidence'}),
      url ? h('img', {src: url, alt: artifact?.name || 'Photo'})
        : artifact?.text ? h('p', {class: 'result-text', text: artifact.text})
        : h('p', {class: 'note', text: 'This file is no longer here.'}),
      close));
  const done = () => {dialog.remove(); document.removeEventListener('keydown', onKey); if (url) URL.revokeObjectURL(url);};
  const onKey = (e: KeyboardEvent) => {if (e.key === 'Escape') done();};
  close.addEventListener('click', done);
  dialog.addEventListener('click', e => {if (e.target === dialog) done();});
  document.addEventListener('keydown', onKey);
  document.body.append(dialog);
  close.focus();
}

/**
 * A published page's confirm() answers "no" at once without asking, which
 * would leave "Delete everything" doing nothing. Here the question opens on
 * the page, and OK presses the same button again with the answer ready, so the
 * app's own code carries on exactly as after the browser's dialog.
 */
function installConfirm() {
  let pressed: HTMLButtonElement | null = null;
  document.addEventListener('click', event => {pressed = (event.target as Element | null)?.closest?.('button') ?? null;}, true);
  let approved: string | null = null;
  window.confirm = (message?: string) => {
    const question = String(message ?? '');
    if (question === approved) {approved = null; return true;}
    const asker = pressed, label = asker?.textContent ?? '';
    const cancel = h('button', {class: 'ghost', type: 'button'}, 'Cancel');
    const ok = h('button', {class: 'ghost danger', type: 'button'}, 'OK');
    const dialog = h('div', {class: 'preview-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': question},
      h('div', {class: 'card'}, h('p', {text: question}), h('div', {class: 'row'}, cancel, ok)));
    cancel.addEventListener('click', () => dialog.remove());
    ok.addEventListener('click', () => {
      dialog.remove();
      // The app may have redrawn the button meanwhile; find it again by its label.
      const again = asker?.isConnected ? asker : [...document.querySelectorAll('button')].find(b => b.textContent === label);
      approved = question; again?.click(); approved = null;
    });
    document.body.append(dialog);
    cancel.focus();
    return false;
  };
}

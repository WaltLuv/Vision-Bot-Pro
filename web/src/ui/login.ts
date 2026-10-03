import {api, setCsrf} from '../api';
import {h} from '../dom';

// The access code is exchanged for an HttpOnly session cookie and is never
// stored by this app -- not in localStorage, not in a variable that outlives
// this function.
export function login(onDone: (owner: string) => void): HTMLElement {
  const field = h('input', {class: 'field', type: 'password', placeholder: 'Access code', 'aria-label': 'Access code', autocomplete: 'current-password'});
  const message = h('p', {class: 'note'});
  const button = h('button', {class: 'primary'}, 'Sign in');

  const submit = async () => {
    const token = field.value.trim();
    if (!token) return;
    button.disabled = true;
    message.textContent = '';
    try {
      const session = await api.login(token);
      field.value = '';
      setCsrf(session.csrf);
      onDone(session.owner);
    } catch (err) {
      message.textContent = err instanceof Error ? err.message : 'That code was not accepted.';
    } finally {
      button.disabled = false;
    }
  };
  button.addEventListener('click', () => void submit());
  field.addEventListener('keydown', e => {if (e.key === 'Enter') void submit();});

  // Google sign-in and the preview are offered only where this server has them,
  // so neither can lead to a page that does not work.
  const google = h('a', {class: 'primary', href: '/auth/google', text: 'Continue with Google', hidden: true});
  const preview = h('a', {class: 'ghost', href: '/preview/', text: 'Start a preview', hidden: true});
  api.signInOptions().then(o => {google.hidden = !o.google; preview.hidden = !o.preview;}).catch(() => {});

  return h('div', {class: 'screen centered'},
    h('section', {class: 'card'},
      h('h1', {class: 'brand', text: 'VisionBot Pro'}),
      h('p', {class: 'note', text: 'The field assistant for VisionOps. Sign in with Google, use an access code, or start a preview.'}),
      google,
      field, message,
      h('div', {class: 'row wrap'}, button, preview),
    ),
  );
}

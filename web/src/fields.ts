// The whole screen is rebuilt whenever the gateway reports a change, which is
// every few seconds while the employee works. Whatever the owner is in the
// middle of typing, ticking or choosing has to survive that: a rebuilt field
// comes back as the server last had it, or empty, and the cursor is gone.
//
// A field is carried across a rebuild only when the owner changed it, and only
// into the field that stands for the same thing: its data-key (for fields
// repeated in a list, such as one answer box per question), else its id, else
// its label. A label that appears more than once is skipped rather than
// guessed, so an answer can never land under a different question.

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
const FIELDS = 'input, textarea, select';
const EDITED = 'edited';

let scope: string | undefined;

function keyOf(el: Field): string | null {
  return el.dataset.key ? `key:${el.dataset.key}` : el.id ? `id:${el.id}` : el.getAttribute('aria-label') ? `label:${el.getAttribute('aria-label')}` : null;
}

function fieldsByKey(root: ParentNode): Map<string, Field> {
  const found = new Map<string, Field>(), repeated = new Set<string>();
  for (const el of root.querySelectorAll<Field>(FIELDS)) {
    const key = keyOf(el);
    if (!key) continue;
    if (found.has(key)) repeated.add(key);
    found.set(key, el);
  }
  for (const key of repeated) found.delete(key);
  return found;
}

const isToggle = (el: Field): el is HTMLInputElement => el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio');

/** Note which fields the owner has changed. Call once for the app's root. */
export function trackEdits(root: HTMLElement) {
  const mark = (event: Event) => {
    const el = event.target as Field;
    if (el?.matches?.(FIELDS)) el.dataset[EDITED] = '1';
  };
  root.addEventListener('input', mark, true);
  root.addEventListener('change', mark, true);
}

/** The owner's changes are saved or sent: the fields are theirs to show as the server has them again. */
export function forgetEdits(root: ParentNode = document) {
  for (const el of root.querySelectorAll<Field>(`[data-${EDITED}]`)) delete el.dataset[EDITED];
}

/**
 * Rebuild the screen, then put back what the owner had changed and where their
 * cursor was. `screen` names what is being shown; edits never carry over to a
 * different screen.
 */
export function rebuildKeepingEdits(root: HTMLElement, screen: string, rebuild: () => void) {
  const sameScreen = scope === screen;
  scope = screen;
  const before = sameScreen ? fieldsByKey(root) : new Map<string, Field>();
  const edits = [...before].filter(([, el]) => el.dataset[EDITED]);
  const active = document.activeElement;
  const focused = [...before].find(([, el]) => el === active);
  let selection: [number, number] | null = null;
  if (focused && !isToggle(focused[1]) && !(focused[1] instanceof HTMLSelectElement)) {
    try {
      const el = focused[1] as HTMLInputElement | HTMLTextAreaElement;
      if (el.selectionStart !== null && el.selectionEnd !== null) selection = [el.selectionStart, el.selectionEnd];
    } catch {/* this kind of input has no cursor */}
  }

  rebuild();
  if (!sameScreen) return;

  const after = fieldsByKey(root);
  for (const [key, old] of edits) {
    const el = after.get(key);
    if (!el || el.tagName !== old.tagName || (el as HTMLInputElement).type !== (old as HTMLInputElement).type) continue;
    el.dataset[EDITED] = '1';
    // The screen's own listeners hear the restored value, so anything it keeps
    // on the side (a draft, a set of ticked boxes) agrees with what is shown.
    if (isToggle(el)) {
      if (el.checked !== (old as HTMLInputElement).checked) {el.checked = (old as HTMLInputElement).checked; el.dispatchEvent(new Event('change', {bubbles: true}));}
    } else if (el.value !== old.value) {
      el.value = old.value;
      el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', {bubbles: true}));
    }
  }
  const target = focused ? after.get(focused[0]) : undefined;
  if (target) {
    // After the current task, so a screen that restores its own focus does not undo this one.
    queueMicrotask(() => {
      if (!target.isConnected) return;
      target.focus({preventScroll: true});
      if (selection && !isToggle(target) && !(target instanceof HTMLSelectElement)) {
        try {(target as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(selection[0], selection[1]);} catch {/* no cursor here */}
      }
    });
  }
}

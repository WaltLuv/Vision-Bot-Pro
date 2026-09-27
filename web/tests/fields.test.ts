import {beforeEach, describe, expect, it} from 'vitest';
import {h, mount} from '../src/dom';
import {forgetEdits, rebuildKeepingEdits, trackEdits} from '../src/fields';

// The app rebuilds the whole screen on every gateway event, which is every few
// seconds while the employee works. These are the owner's half-typed words,
// half-ticked boxes and cursor, surviving that.

let root: HTMLElement;
const $ = <T extends Element>(selector: string) => root.querySelector<T>(selector)!;
const type = (el: HTMLInputElement | HTMLTextAreaElement, text: string) => {el.value = text; el.dispatchEvent(new Event('input', {bubbles: true}));};

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById('app')!;
  trackEdits(root);
});

const employeeScreen = (saved: {name: string; role: string}) => () => mount(root,
  h('input', {'aria-label': 'Name', value: saved.name}),
  h('input', {'aria-label': 'Role', value: saved.role}));

describe('a rebuilt screen keeps what the owner changed', () => {
  it('keeps typed text, and shows the server value in fields not touched', () => {
    rebuildKeepingEdits(root, 'employee', employeeScreen({name: 'Vision-Bot-Pro', role: 'Assistant'}));
    type($('input[aria-label="Name"]'), 'Slim Charles');
    rebuildKeepingEdits(root, 'employee', employeeScreen({name: 'Vision-Bot-Pro', role: 'Site manager'}));
    expect($<HTMLInputElement>('input[aria-label="Name"]').value).toBe('Slim Charles');
    expect($<HTMLInputElement>('input[aria-label="Role"]').value).toBe('Site manager');
  });

  it('puts the cursor back in the same field, at the same place', async () => {
    rebuildKeepingEdits(root, 'employee', employeeScreen({name: 'Vision-Bot-Pro', role: ''}));
    const field = $<HTMLInputElement>('input[aria-label="Name"]');
    type(field, 'Slim Charles');
    field.focus();
    field.setSelectionRange(4, 4);
    rebuildKeepingEdits(root, 'employee', employeeScreen({name: 'Vision-Bot-Pro', role: ''}));
    await Promise.resolve();
    const rebuilt = $<HTMLInputElement>('input[aria-label="Name"]');
    expect(rebuilt).not.toBe(field);
    expect(document.activeElement).toBe(rebuilt);
    expect([rebuilt.selectionStart, rebuilt.selectionEnd]).toEqual([4, 4]);
  });

  it('keeps each answer with its own question when another question arrives above it', () => {
    const questions = (ids: string[]) => () => mount(root, ...ids.map(id => h('input', {'aria-label': 'Your answer', 'data-key': `answer:${id}`})));
    rebuildKeepingEdits(root, 'today', questions(['which-room']));
    type($('input[data-key="answer:which-room"]'), 'The kitchen');
    rebuildKeepingEdits(root, 'today', questions(['which-day', 'which-room']));
    expect($<HTMLInputElement>('input[data-key="answer:which-day"]').value).toBe('');
    expect($<HTMLInputElement>('input[data-key="answer:which-room"]').value).toBe('The kitchen');
  });

  it('never guesses between two fields with the same label', () => {
    const twoBoxes = () => mount(root, h('input', {'aria-label': 'Your answer'}), h('input', {'aria-label': 'Your answer'}));
    rebuildKeepingEdits(root, 'today', twoBoxes);
    type(root.querySelectorAll<HTMLInputElement>('input')[0]!, 'The kitchen');
    rebuildKeepingEdits(root, 'today', twoBoxes);
    expect([...root.querySelectorAll<HTMLInputElement>('input')].map(i => i.value)).toEqual(['', '']);
  });

  it('keeps a ticked box, and the screen hears it so Save sends it', () => {
    const chosen = new Set<string>();
    const skills = () => {
      chosen.clear();
      const box = h('input', {type: 'checkbox', id: 'skill-ordering'});
      box.addEventListener('change', () => box.checked ? chosen.add('ordering') : chosen.delete('ordering'));
      mount(root, box);
    };
    rebuildKeepingEdits(root, 'employee', skills);
    const box = $<HTMLInputElement>('#skill-ordering');
    box.checked = true;
    box.dispatchEvent(new Event('change', {bubbles: true}));
    rebuildKeepingEdits(root, 'employee', skills);
    expect($<HTMLInputElement>('#skill-ordering').checked).toBe(true);
    expect([...chosen]).toEqual(['ordering']);
  });

  it('does not carry anything into a different screen', () => {
    rebuildKeepingEdits(root, 'employee', () => mount(root, h('input', {'aria-label': 'Name'})));
    type($('input'), 'Slim Charles');
    rebuildKeepingEdits(root, 'settings', () => mount(root, h('input', {'aria-label': 'Name'})));
    expect($<HTMLInputElement>('input').value).toBe('');
  });

  it('shows the server copy again once the change is saved', () => {
    rebuildKeepingEdits(root, 'employee', employeeScreen({name: 'Vision-Bot-Pro', role: ''}));
    type($('input[aria-label="Name"]'), 'Slim Charles');
    forgetEdits();
    rebuildKeepingEdits(root, 'employee', employeeScreen({name: 'Charles', role: ''}));
    expect($<HTMLInputElement>('input[aria-label="Name"]').value).toBe('Charles');
  });
});

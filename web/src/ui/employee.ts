import {api} from '../api';
import {h} from '../dom';
import {forgetEdits} from '../fields';
import {humanise} from '../store';
import type {Ctx} from './ctx';

export function employee(ctx: Ctx): HTMLElement {
  const agent = ctx.state.agent[0];
  if (!agent) return h('div', {class: 'screen'}, h('section', {class: 'card'}, h('p', {text: 'Loading…'})));

  const name = h('input', {class: 'field', value: agent.name, 'aria-label': 'Name'});
  const title = h('input', {class: 'field', value: agent.title ?? '', 'aria-label': 'Role'});
  const instructions = h('textarea', {class: 'composer', rows: 4, 'aria-label': 'How it should work'});
  instructions.value = agent.instructions ?? '';

  const chosen = new Set(agent.skills ?? []);
  const skillRows = ctx.state.skill.map(skill => {
    const box = h('input', {type: 'checkbox', id: `skill-${skill.id}`});
    box.checked = chosen.has(skill.id);
    box.addEventListener('change', () => box.checked ? chosen.add(skill.id) : chosen.delete(skill.id));
    return h('label', {class: 'check', for: `skill-${skill.id}`}, box, h('span', {}, h('span', {class: 'title', text: skill.name}), h('span', {class: 'sub', text: skill.instructions})));
  });

  const save = async () => {
    try {
      // runtime is preserved exactly as the server set it. Which engine runs the
      // work is a server-side, owner-scoped decision and is deliberately not a
      // control here.
      await api.saveAgent({name: name.value.trim(), title: title.value.trim(), instructions: instructions.value, runtime: agent.runtime, skills: [...chosen]});
      forgetEdits();
      await ctx.refresh();
      ctx.toast('Saved.');
    } catch (err) {
      ctx.toast(err instanceof Error ? err.message : 'Those changes were not saved.');
    }
  };

  return h('div', {class: 'screen'},
    h('section', {class: 'card'},
      h('h3', {text: 'Your employee'}),
      h('label', {class: 'label', text: 'Name'}), name,
      h('label', {class: 'label', text: 'Role'}), title,
      h('label', {class: 'label', text: 'How it should work'}), instructions,
      h('div', {class: 'row'}, h('button', {class: 'primary', onclick: () => void save()}, 'Save')),
    ),
    h('section', {class: 'card'}, h('h3', {text: 'What it handles'}), ...skillRows,
      h('div', {class: 'row'}, h('button', {class: 'primary', onclick: () => void save()}, 'Save'))),
    memorySection(ctx),
    contactsSection(ctx),
  );
}

function memorySection(ctx: Ctx): HTMLElement {
  const text = h('input', {class: 'field', placeholder: 'Something it should remember', 'aria-label': 'Something it should remember'});
  const kind = h('select', {class: 'field', 'aria-label': 'Kind'}, ...(['profile', 'work', 'note', 'workspace'] as const).map(k => h('option', {value: k, text: humanise(k)})));
  const add = async () => {
    if (!text.value.trim()) return;
    try {await api.addMemory(kind.value as 'profile', text.value.trim()); text.value = ''; await ctx.refresh();}
    catch (err) {ctx.toast(err instanceof Error ? err.message : 'That was not saved.');}
  };
  return h('section', {class: 'card'},
    h('h3', {text: 'What it remembers'}),
    ...ctx.state.memory.map(m => h('div', {class: 'row-item'},
      h('p', {class: 'task', text: m.text}),
      h('button', {class: 'ghost small', onclick: async () => {await api.removeMemory(m.id); await ctx.refresh();}}, 'Forget'))),
    h('div', {class: 'row wrap'}, kind, text, h('button', {class: 'primary', onclick: () => void add()}, 'Add')),
  );
}

/**
 * A number as the phone networks take it (E.164), from however it was typed.
 * Ten digits, or eleven starting with 1, are a North American number; anything
 * else needs its country code. Null when it cannot be a phone number.
 */
export function phoneNumber(typed: string): string | null {
  const text = typed.trim(), digits = text.replace(/\D/g, '');
  if (/[^\d\s()+.-]/.test(text)) return null;
  if (text.startsWith('+')) return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && /^1[2-9]/.test(digits)) return `+${digits}`;
  return null;
}

function contactsSection(ctx: Ctx): HTMLElement {
  const name = h('input', {class: 'field', placeholder: 'Name', 'aria-label': 'Contact name', autocomplete: 'off'});
  const phone = h('input', {class: 'field', type: 'tel', placeholder: 'Mobile number', 'aria-label': 'Contact phone number', autocomplete: 'off'});
  const organization = h('input', {class: 'field', placeholder: 'Company (optional)', 'aria-label': 'Contact company', autocomplete: 'off'});
  // So "text my contractor" finds the right person without the employee guessing.
  const role = h('input', {class: 'field', placeholder: 'Who they are to you (optional), like my contractor', 'aria-label': 'Who they are to you', autocomplete: 'off'});
  const add = async () => {
    const number = phoneNumber(phone.value);
    if (!name.value.trim()) {ctx.toast('Add their name.'); return;}
    if (!number) {ctx.toast('Use their full mobile number. Outside the US and Canada, start with + and the country code.'); return;}
    try {
      await api.addContact({name: name.value.trim(), phone: number, organization: organization.value.trim(), notes: role.value.trim()});
      name.value = phone.value = organization.value = role.value = '';
      forgetEdits();
      await ctx.refresh();
      ctx.toast('Added.');
    } catch (err) {
      ctx.toast(err instanceof Error ? err.message : 'They were not added.');
    }
  };
  return h('section', {class: 'card'},
    h('h3', {text: 'People it can contact'}),
    ctx.state.contact.length
      ? h('div', {}, ...ctx.state.contact.map(c => h('div', {class: 'row-item'},
          h('p', {class: 'task', text: String(c.name ?? 'Contact')}),
          // The number shown is the one a text or call goes to, so it can be checked here.
          h('p', {class: 'note', text: [c.phone, c.organization, c.notes].filter(Boolean).map(String).join(' · ')}),
          h('button', {class: 'ghost small', onclick: async () => {await api.removeContact(c.id); await ctx.refresh();}}, 'Remove'))))
      : h('p', {class: 'note', text: 'No one yet. A message or call is only ever sent to someone here, after you approve it.'}),
    h('label', {class: 'label', text: 'Add someone'}),
    name, phone, organization, role,
    h('div', {class: 'row'}, h('button', {class: 'primary', onclick: () => void add()}, 'Add person')),
  );
}

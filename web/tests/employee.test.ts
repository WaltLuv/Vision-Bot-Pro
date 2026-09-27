import {beforeEach, describe, expect, it, vi} from 'vitest';

const addContact = vi.fn(async (c: Record<string, unknown>) => ({id: 'contact-1', ...c}));
vi.mock('../src/api', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  api: {addContact, removeContact: vi.fn()},
}));

const {employee, phoneNumber} = await import('../src/ui/employee');
const {mount} = await import('../src/dom');
import type {Ctx} from '../src/ui/ctx';

// Texts and calls only ever go to someone on the list, so the owner has to be
// able to put people on it from the phone, and see the number that will be used.

function makeCtx(contacts: Record<string, unknown>[] = []) {
  const toast = vi.fn(), refresh = vi.fn(async () => {});
  const ctx = {
    owner: 'owner', busy: false, streamOnline: true, cards: [], transcript: [],
    state: {agent: [{id: 'a', name: 'Vision-Bot-Pro', runtime: 'hermes', skills: []}], skill: [], memory: [], contact: contacts, run: [], approval: [], computer: [], artifact: [], action: []},
    rerender() {}, toast, refresh, go() {},
  } as unknown as Ctx;
  return {ctx, toast, refresh};
}

const field = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const button = (text: string) => [...document.querySelectorAll('button')].find(b => b.textContent === text)!;
const type = (label: string, text: string) => {field(label).value = text; field(label).dispatchEvent(new Event('input', {bubbles: true}));};

describe('employee: people it can contact', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    addContact.mockClear();
  });

  it('adds a person with the number as the phone networks take it', async () => {
    const {ctx, refresh} = makeCtx();
    mount(document.getElementById('app')!, employee(ctx));
    type('Contact name', 'Maria Lopez');
    type('Contact phone number', '(555) 014-2233');
    type('Contact company', 'Unit 4B');
    button('Add person').click();
    await vi.waitFor(() => expect(addContact).toHaveBeenCalledTimes(1));
    expect(addContact.mock.calls[0]?.[0]).toEqual({name: 'Maria Lopez', phone: '+15550142233', organization: 'Unit 4B'});
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(field('Contact name').value).toBe('');
  });

  it('says what is wrong instead of saving a number it cannot use', async () => {
    const {ctx, toast} = makeCtx();
    mount(document.getElementById('app')!, employee(ctx));
    type('Contact name', 'Maria Lopez');
    type('Contact phone number', '014-2233');
    button('Add person').click();
    await Promise.resolve();
    expect(addContact).not.toHaveBeenCalled();
    expect(toast.mock.calls[0]?.[0]).toMatch(/full mobile number/);
  });

  it('shows the number a text or call will go to', () => {
    const {ctx} = makeCtx([{id: 'c1', name: 'Maria Lopez', phone: '+15550142233', organization: 'Unit 4B'}]);
    mount(document.getElementById('app')!, employee(ctx));
    expect(document.body.textContent).toContain('Maria Lopez');
    expect(document.body.textContent).toContain('+15550142233 · Unit 4B');
  });
});

describe('phoneNumber', () => {
  it.each([
    ['+1 555 014 2233', '+15550142233'],
    ['(555) 014-2233', '+15550142233'],
    ['1-555-014-2233', '+15550142233'],
    ['555.014.2233', '+15550142233'],
    ['+44 20 7946 0958', '+442079460958'],
  ])('%s is %s', (typed, stored) => expect(phoneNumber(typed)).toBe(stored));

  it.each(['014-2233', '+0 20 7946 0958', '555-014-2233 ext 4', 'call me', '', '055 014 2233'])('%s is not a number it can use', typed => expect(phoneNumber(typed)).toBeNull());
});

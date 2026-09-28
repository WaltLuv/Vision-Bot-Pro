import {describe, expect, it, vi} from 'vitest';

vi.mock('../src/api', async importOriginal => ({...(await importOriginal<typeof import('../src/api')>()), api: {decide: vi.fn(async () => {})}}));
const {approvalCard} = await import('../src/ui/approvals');
import type {Approval} from '../src/api';

const card = (over: Partial<Approval>) => approvalCard({id: 'a1', runId: 'r1', tool: 'sms_send', label: 'Send this text', effect: 'communication',
  details: {}, status: 'pending', expiresAt: Date.now() + 60_000, ...over} as Approval, () => {}, () => {});

describe('approval cards', () => {
  // A question is not a permission: it is headed and explained as a question.
  it('asks a question as a question', () => {
    const el = card({tool: 'ask_user', label: 'Your employee has a question', effect: 'sensitive', details: {question: 'Which room is the leak in?'}});
    expect(el.querySelector('.eyebrow')!.textContent).toBe('A question for you');
    expect(el.textContent).toContain('Your employee carries on once you answer.');
    expect(el.textContent).not.toContain('This runs only if you allow it.');
    expect([...el.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Send answer', 'Not now']);
  });

  it('keeps a permission a permission', () => {
    const el = card({});
    expect(el.textContent).toContain('This runs only if you allow it.');
    expect([...el.querySelectorAll('button')].map(b => b.textContent)).toEqual(['Allow once', 'Not now']);
  });
});

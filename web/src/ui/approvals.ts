import {api, type Approval, type Contact} from '../api';
import {h} from '../dom';
import {approvalRows, EFFECT_LABEL, NO_STANDING_APPROVAL, NO_STANDING_TOOLS} from '../store';

// An approval card states exactly what is being authorised. For a purchase that
// means supplier, items, quantities and total as separate rows taken from the
// approval's own details -- the person authorises those terms, not a summary of
// them, and the gateway validates the decision against this same record.
export function approvalCard(approval: Approval, after: () => void, fail: (message: string) => void, contacts: Contact[] = []) {
  const financial = approval.effect === 'financial';
  const answering = approval.tool === 'ask_user';
  const answer = answering ? h('input', {class: 'field', type: 'text', placeholder: 'Your answer', 'aria-label': 'Your answer', 'data-key': `answer:${approval.id}`}) : null;

  const decide = async (decision: 'once' | 'deny' | 'always' | 'never') => {
    try {
      await api.decide(approval.id, decision, answer?.value.trim() || undefined);
      after();
    } catch (err) {
      fail(err instanceof Error ? err.message : 'That decision did not go through.');
    }
  };

  const rows = approvalRows(approval, contacts);
  return h('section', {class: `card approval ${financial ? 'financial' : ''}`},
    h('p', {class: 'eyebrow', text: answering ? 'A question for you' : EFFECT_LABEL[approval.effect] ?? 'Needs your approval'}),
    h('h3', {text: approval.label || approval.tool}),
    rows.length ? h('dl', {class: 'terms'}, ...rows.flatMap(r => [h('dt', {text: r.label}), h('dd', {text: r.value})])) : null,
    answer,
    h('p', {class: 'note', text: answering ? 'Your employee carries on once you answer.' : financial ? 'Nothing is bought until you authorise these exact terms.' : 'This runs only if you allow it.'}),
    h('div', {class: 'row'},
      h('button', {class: 'primary', onclick: () => void decide('once')}, answering ? 'Send answer' : 'Allow once'),
      h('button', {class: 'ghost', onclick: () => void decide('deny')}, 'Not now'),
      // Standing permission is never offered for money, deletion or outbound
      // messages: those are the effects that must stay a per-action decision.
      !answering && !NO_STANDING_APPROVAL.has(approval.effect) && !NO_STANDING_TOOLS.has(approval.tool)
        ? h('button', {class: 'ghost', onclick: () => void decide('always')}, 'Always allow this')
        : null,
    ),
  );
}

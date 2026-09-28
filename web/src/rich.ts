// A model's answer, readable on a phone. Models write light markdown -- **bold**,
// *emphasis*, `code`, bullet lists, [links](https://...) -- and shown raw it reads
// as stray symbols. This turns that much into elements, and nothing more: every
// piece of text still goes in through textContent (see dom.ts), so an answer
// cannot inject markup, and only https links become links.
import {h, type Child} from './dom';

const INLINE = /\*\*(.+?)\*\*|\*(\S(?:.*?\S)?)\*|`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g;

function inline(line: string): Child[] {
  const out: Child[] = [];
  let at = 0;
  for (const m of line.matchAll(INLINE)) {
    if (m.index > at) out.push(line.slice(at, m.index));
    if (m[1] !== undefined) out.push(h('strong', {}, ...inline(m[1])));
    else if (m[2] !== undefined) out.push(h('em', {}, ...inline(m[2])));
    else if (m[3] !== undefined) out.push(h('code', {text: m[3]}));
    else out.push(h('a', {href: m[5], target: '_blank', rel: 'noopener noreferrer', text: m[4]}));
    at = m.index + m[0].length;
  }
  if (at < line.length) out.push(line.slice(at));
  return out;
}

/** The answer as lines of text and inline elements; lists become "•" lines and headings bold lines. */
export function richText(text: string): Child[] {
  const out: Child[] = [];
  text.split('\n').forEach((raw, i) => {
    if (i) out.push('\n');
    const heading = raw.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {out.push(h('strong', {}, ...inline(heading[1]!))); return;}
    const bullet = raw.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {out.push(`${bullet[1]}• `, ...inline(bullet[2]!)); return;}
    out.push(...inline(raw));
  });
  return out;
}

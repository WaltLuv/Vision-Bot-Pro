import {describe, expect, it} from 'vitest';
import {h} from '../src/dom';
import {richText} from '../src/rich';

// Answers are written in light markdown by the models. Rendered, they read as a
// person would expect; nothing in them can become markup.
const render = (text: string) => h('p', {}, ...richText(text));

describe('richText', () => {
  it('turns bold, emphasis and code into elements and drops the symbols', () => {
    const p = render('The cheapest is **The Home Depot** at *$24.97*, SKU `304869155`.');
    expect(p.textContent).toBe('The cheapest is The Home Depot at $24.97, SKU 304869155.');
    expect(p.querySelector('strong')!.textContent).toBe('The Home Depot');
    expect(p.querySelector('em')!.textContent).toBe('$24.97');
    expect(p.querySelector('code')!.textContent).toBe('304869155');
  });

  it('shows lists as bullets and headings as bold lines, keeping line breaks', () => {
    const p = render('## Options\n- Lowe\'s $36.48\n* Home Depot $38.97');
    expect(p.textContent).toBe('Options\n• Lowe\'s $36.48\n• Home Depot $38.97');
    expect(p.querySelector('strong')!.textContent).toBe('Options');
  });

  it('links only https addresses, opening them safely', () => {
    const p = render('See [the listing](https://www.homedepot.com/p/1) or [this](javascript:alert(1)).');
    const links = p.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe('https://www.homedepot.com/p/1');
    expect(links[0]!.getAttribute('rel')).toBe('noopener noreferrer');
    expect(p.textContent).toContain('[this](javascript:alert(1))');
  });

  it('never turns text into markup', () => {
    const p = render('**<img src=x onerror=alert(1)>** <script>alert(1)</script>');
    expect(p.querySelector('img, script')).toBeNull();
    expect(p.textContent).toBe('<img src=x onerror=alert(1)> <script>alert(1)</script>');
  });

  it('leaves plain text, and lone asterisks in arithmetic, alone', () => {
    expect(render('2 * 3 = 6, and 4 * 5 = 20').textContent).toBe('2 * 3 = 6, and 4 * 5 = 20');
  });
});

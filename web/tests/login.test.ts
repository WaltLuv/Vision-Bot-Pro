import {beforeEach, describe, expect, it, vi} from 'vitest';

const signInOptions = vi.fn();
vi.mock('../src/api', async importOriginal => ({...(await importOriginal<typeof import('../src/api')>()), api: {signInOptions, login: vi.fn()}}));
const {login} = await import('../src/ui/login');
const {mount} = await import('../src/dom');

const link = (name: string) => [...document.querySelectorAll('a')].find(a => a.textContent === name)!;
const show = async () => {
  document.body.innerHTML = '<div id="app"></div>';
  mount(document.getElementById('app')!, login(() => {}));
  await vi.waitFor(() => expect(signInOptions).toHaveBeenCalled());
  await Promise.resolve(); await Promise.resolve();
};

// Each way in is offered only where the server has it, so none leads to a page that does not work.
describe('sign-in screen', () => {
  beforeEach(() => {signInOptions.mockReset();});

  it('offers Google sign-in and the preview when the server has them', async () => {
    signInOptions.mockResolvedValue({google: true, preview: true});
    await show();
    expect(link('Continue with Google').hidden).toBe(false);
    expect(link('Continue with Google').getAttribute('href')).toBe('/auth/google');
    expect(link('Start a preview').hidden).toBe(false);
    expect(link('Start a preview').getAttribute('href')).toBe('/preview/');
  });

  it('keeps them out of sight when it does not', async () => {
    signInOptions.mockResolvedValue({google: false, preview: false});
    await show();
    expect(link('Continue with Google').hidden).toBe(true);
    expect(link('Start a preview').hidden).toBe(true);
  });

  it('keeps them out of sight when the server cannot be asked, and the access code still works', async () => {
    signInOptions.mockImplementation(() => Promise.reject(new Error('offline')));
    await show();
    expect(link('Continue with Google').hidden).toBe(true);
    expect(document.querySelector('input[aria-label="Access code"]')).not.toBeNull();
  });
});

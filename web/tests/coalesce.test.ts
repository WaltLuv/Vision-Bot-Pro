import {describe, expect, it} from 'vitest';
import {coalesce} from '../src/coalesce';

// The app refetches on every gateway event. A burst of events -- a reconnect
// catching up, a busy task -- must be a fetch or two, not one per event.
describe('coalesce', () => {
  it('turns a burst of calls into one run, plus one for calls made during it', async () => {
    let runs = 0, release!: () => void;
    const refresh = coalesce(() => {runs++; return new Promise<void>(r => {release = r;});});
    const burst = Array.from({length: 200}, () => refresh());
    expect(runs).toBe(1);
    release();
    await Promise.resolve(); await Promise.resolve();
    expect(runs).toBe(2);
    release();
    await Promise.all(burst);
    expect(runs).toBe(2);
  });

  it('settles every caller only after a run that started after their call', async () => {
    const order: string[] = [];
    let release!: () => void;
    const refresh = coalesce(() => {order.push('load'); return new Promise<void>(r => {release = r;});});
    const first = refresh().then(() => order.push('first settled'));
    const second = refresh().then(() => order.push('second settled'));
    release(); await Promise.resolve(); await Promise.resolve();
    expect(order).toEqual(['load', 'load']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['load', 'load', 'first settled', 'second settled']);
  });

  it('runs again for a call after the last one finished, and survives a failed run', async () => {
    let runs = 0;
    const refresh = coalesce(async () => {runs++; if (runs === 1) throw new Error('offline');});
    await expect(refresh()).rejects.toThrow('offline');
    await refresh();
    expect(runs).toBe(2);
  });
});

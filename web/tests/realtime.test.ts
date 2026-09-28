import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {subscribe} from '../src/api';
import {applyCard, applyTranscript, dismissCard} from '../src/store';
import type {Card, TranscriptEntry} from '../src/realtime';

const segment = (over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({id: 's1', role: 'employee', text: 'hello', final: false, at: 1, ...over});

describe('transcript segments', () => {
  // Speech is re-sent as it is refined. Appending each version is what makes a
  // transcript stutter with half-finished duplicates of the same sentence.
  it('replaces a segment in place rather than appending a second copy', () => {
    let list = applyTranscript([], segment({text: 'hel'}));
    list = applyTranscript(list, segment({text: 'hello there', final: true}));
    expect(list).toHaveLength(1);
    expect(list[0]!.text).toBe('hello there');
    expect(list[0]!.final).toBe(true);
  });

  it('keeps separate segments apart', () => {
    let list = applyTranscript([], segment({id: 'a', text: 'first'}));
    list = applyTranscript(list, segment({id: 'b', text: 'second'}));
    expect(list.map(l => l.text)).toEqual(['first', 'second']);
  });

  // Out-of-order delivery must not turn a finished line back into a guess.
  it('does not let a late interim overwrite a finished segment', () => {
    let list = applyTranscript([], segment({text: 'hello there', final: true}));
    list = applyTranscript(list, segment({text: 'hel', final: false}));
    expect(list[0]!.text).toBe('hello there');
    expect(list[0]!.final).toBe(true);
  });

  it('does not mutate the list it was given', () => {
    const original = [segment()];
    applyTranscript(original, segment({id: 'b'}));
    expect(original).toHaveLength(1);
  });
});

describe('cards', () => {
  const card = (over: Partial<Card> = {}): Card => ({uuid: 'c1', type: 'info', title: 'Weather', ...over});

  it('updates a card in place when its uuid is reused', () => {
    let list = applyCard([], card({value: '18°'}));
    list = applyCard(list, card({value: '21°'}));
    expect(list).toHaveLength(1);
    expect(list[0]!.value).toBe('21°');
  });

  it('adds distinct cards and dismisses only the named one', () => {
    let list = applyCard(applyCard([], card()), card({uuid: 'c2', title: 'Schedule'}));
    expect(list).toHaveLength(2);
    list = dismissCard(list, 'c1');
    expect(list.map(c => c.uuid)).toEqual(['c2']);
    expect(dismissCard(list, 'nope')).toHaveLength(1);
  });
});

// A dropped event stream is the normal case on a phone: the screen locks, the
// network changes. What matters is that reconnecting resumes rather than
// replaying, and that it keeps trying without hammering the gateway.
describe('event stream reconnect', () => {
  const opened: FakeSource[] = [];
  class FakeSource {
    onopen: (() => void) | null = null;
    onmessage: ((e: {data: string; lastEventId: string}) => void) | null = null;
    onerror: (() => void) | null = null;
    closed = false;
    constructor(readonly url: string) {opened.push(this);}
    close() {this.closed = true;}
  }

  beforeEach(() => {
    opened.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', FakeSource as unknown as typeof EventSource);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  // The page has just loaded the current state; replaying every past event made
  // it refetch once per event and trip the gateway's rate limit.
  it('starts at now rather than replaying the history, and reports the stream healthy', () => {
    const status: boolean[] = [];
    subscribe(() => {}, online => status.push(online));
    expect(opened[0]!.url).toBe('/api/events');
    opened[0]!.onopen!();
    expect(status).toEqual([true]);
  });

  it('resumes from where the gateway said "now" was, when nothing else has happened', () => {
    subscribe(() => {}, () => {});
    opened[0]!.onmessage!({data: JSON.stringify({seq: 41, type: 'stream.ready'}), lastEventId: '41'});
    opened[0]!.onerror!();
    vi.advanceTimersByTime(600);
    expect(opened[1]!.url).toBe('/api/events?after=41');
  });

  it('resumes from the last event seen instead of replaying the stream', () => {
    const seen: number[] = [];
    subscribe(e => seen.push(e.seq), () => {});
    opened[0]!.onopen!();
    opened[0]!.onmessage!({data: JSON.stringify({seq: 7, type: 'run.updated'}), lastEventId: '7'});
    expect(seen).toEqual([7]);

    opened[0]!.onerror!();
    vi.advanceTimersByTime(600);
    expect(opened[1]!.url).toBe('/api/events?after=7');
  });

  it('reports the stream down, closes it, and backs off between attempts', () => {
    const status: boolean[] = [];
    subscribe(() => {}, online => status.push(online));
    opened[0]!.onerror!();
    expect(status).toEqual([false]);
    expect(opened[0]!.closed).toBe(true);

    vi.advanceTimersByTime(500);
    expect(opened).toHaveLength(2);
    opened[1]!.onerror!();
    vi.advanceTimersByTime(999);
    expect(opened).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(opened).toHaveLength(3);
  });

  // A phone that slept for an hour must not sit out an ever-growing delay.
  it('caps the backoff so a long sleep still reconnects promptly', () => {
    subscribe(() => {}, () => {});
    for (let i = 0; i < 12; i++) {
      opened[opened.length - 1]!.onerror!();
      vi.advanceTimersByTime(15000);
    }
    const before = opened.length;
    opened[before - 1]!.onerror!();
    vi.advanceTimersByTime(15000);
    expect(opened.length).toBe(before + 1);
  });

  it('ignores an unparseable event rather than tearing down the stream', () => {
    const seen: unknown[] = [];
    subscribe(e => seen.push(e), () => {});
    opened[0]!.onmessage!({data: 'not json', lastEventId: '3'});
    expect(seen).toHaveLength(0);
    expect(opened[0]!.closed).toBe(false);
  });

  it('stops reconnecting once unsubscribed', () => {
    const stop = subscribe(() => {}, () => {});
    opened[0]!.onerror!();
    stop();
    vi.advanceTimersByTime(60000);
    expect(opened).toHaveLength(1);
    expect(opened[0]!.closed).toBe(true);
  });
});

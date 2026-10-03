// Google Search, through Gemini.
//
// The owner's Gemini key can also search: Gemini runs the Google searches
// itself and says which pages back each part of its answer. Web search and the
// stores' price check (webprices.ts) both use it, so a Gemini key alone gives
// the employee research and price comparisons without another account.
//
// Gemini hands back its sources as Google redirect links. Each is followed one
// hop, asking only Google's redirect host, to learn the page it leads to; no
// source page is fetched here.
import {redactText} from './redact.js';

const api = () => (process.env.GEMINI_API_BASE?.trim() || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '');
const REDIRECT_HOST = 'vertexaisearch.cloud.google.com';

export const geminiKey = (env: NodeJS.ProcessEnv = process.env) => env.GEMINI_API_KEY?.trim() || env.GOOGLE_API_KEY?.trim() || '';
/** A dated model release, so a search behaves the same until the owner changes it. */
export const searchModel = (env: NodeJS.ProcessEnv = process.env) => env.SEARCH_MODEL?.trim() || 'gemini-3.5-flash';

export interface GroundedSource {title: string; url: string; domain: string}
export interface GroundedAnswer {
  text: string;
  /** What Gemini searched Google for. */
  queries: string[];
  sources: GroundedSource[];
  /** A part of the answer, and which sources back it (indexes into sources). */
  supports: {text: string; sources: number[]}[];
}

export const domainOf = (url: string) => {try {return new URL(url).hostname.toLowerCase().replace(/^www\./, '');} catch {return '';}};

/** Where a grounding link leads, without loading the page. Falls back to the link itself. */
async function landing(uri: string, http: typeof fetch): Promise<string> {
  let url: URL;
  try {url = new URL(uri);} catch {return '';}
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
  if (url.hostname !== REDIRECT_HOST) return url.toString();
  try {
    const response = await http(url, {redirect: 'manual', signal: AbortSignal.timeout(8_000)});
    await response.body?.cancel().catch(() => {});
    const to = response.headers.get('location');
    if (to && /^https?:\/\//i.test(to)) return new URL(to).toString();
  } catch {}
  return url.toString();
}

function failure(status: number, body: any): string {
  const message = typeof body?.error?.message === 'string' ? body.error.message : '';
  if (status === 402 || /prepayment|credits are depleted/i.test(message))
    return 'Google Search through Gemini is out of credits on this Gemini project. Top it up in Google AI Studio, or set SEARCH_API_KEY to search with Brave instead.';
  if (status === 401 || /api key/i.test(message)) return 'Gemini did not accept its API key (GEMINI_API_KEY or GOOGLE_API_KEY).';
  if (status === 429) return 'Gemini search is over its rate limit or quota right now. Try again in a minute.';
  if (status === 404) return `Gemini has no model called ${searchModel()} for this key. Set SEARCH_MODEL to one that can search.`;
  return `Search through Gemini returned HTTP ${status}${message ? `: ${redactText(message).slice(0, 200)}` : ''}`;
}

/** Asks Gemini, with Google Search on, and returns its answer with the pages behind it. */
export async function groundedSearch(prompt: string, http: typeof fetch = fetch, timeoutMs = 45_000): Promise<GroundedAnswer> {
  const key = geminiKey();
  if (!key) throw Error('Searching through Google needs a Gemini key (GEMINI_API_KEY or GOOGLE_API_KEY).');
  const model = searchModel(), signal = AbortSignal.timeout(timeoutMs);
  const ask = async (thinkLess: boolean) => {
    const response = await http(`${api()}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal,
      headers: {'content-type': 'application/json', 'x-goog-api-key': key},
      body: JSON.stringify({
        contents: [{role: 'user', parts: [{text: prompt}]}],
        tools: [{google_search: {}}],
        // Gemini 3 and later think before answering; a lookup needs little of it, and it is most of the wait.
        ...(thinkLess ? {generationConfig: {thinkingConfig: {thinkingLevel: 'low'}}} : {}),
      }),
    });
    return {response, body: await response.json().catch(() => null) as any};
  };
  const thinkLess = /^gemini-([3-9]|\d{2})/.test(model);
  let {response, body} = await ask(thinkLess);
  // A model that takes no thinking level says so; ask it again without one.
  if (thinkLess && response.status === 400 && /thinking/i.test(String(body?.error?.message ?? ''))) ({response, body} = await ask(false));
  if (!response.ok) throw Error(failure(response.status, body));
  const candidate = body?.candidates?.[0];
  const parts: any[] = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
  const text = parts.map(p => (typeof p?.text === 'string' && !p.thought ? p.text : '')).join('').trim();
  const meta = candidate?.groundingMetadata ?? {};
  const chunks: any[] = Array.isArray(meta.groundingChunks) ? meta.groundingChunks.slice(0, 20) : [];
  const sources = await Promise.all(chunks.map(async (chunk): Promise<GroundedSource> => {
    const title = String(chunk?.web?.title ?? '').slice(0, 200), url = await landing(String(chunk?.web?.uri ?? ''), http);
    // Gemini titles a source with its site's name; the page's own address says it better once it is known.
    const named = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(title) ? title.toLowerCase().replace(/^www\./, '') : '';
    const domain = domainOf(url);
    return {title, url, domain: domain && domain !== REDIRECT_HOST ? domain : named};
  }));
  const supports = (Array.isArray(meta.groundingSupports) ? meta.groundingSupports : []).map((s: any) => ({
    text: String(s?.segment?.text ?? ''),
    sources: (Array.isArray(s?.groundingChunkIndices) ? s.groundingChunkIndices : []).filter((i: unknown): i is number => Number.isInteger(i) && (i as number) >= 0 && (i as number) < sources.length),
  }));
  return {text, queries: (Array.isArray(meta.webSearchQueries) ? meta.webSearchQueries : []).map(String).slice(0, 10), sources, supports};
}

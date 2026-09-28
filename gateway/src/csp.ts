import {liveFrameSources} from "./employee/browser.js";

/**
 * The LiveKit server the phone connects to for voice and camera, as the origins
 * it uses: its websocket, and the http(s) twin the client checks a failed
 * connection against. Any secure websocket was already allowed; a LiveKit on the
 * same computer (ws://127.0.0.1:7880, what a local install runs) was not, so
 * conversations could never start. Reduced to a bare origin, so the setting can
 * add nothing else to the policy.
 */
function liveKitSources(): string {
  let url: URL;
  try {url = new URL(process.env.LIVEKIT_URL ?? '');} catch {return '';}
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return '';
  const secure = url.protocol === 'wss:';
  return ` ${secure ? 'wss' : 'ws'}://${url.host} ${secure ? 'https' : 'http'}://${url.host}`;
}

/** The phone app's page policy. No inline script; the only thing it may frame is a live view of the employee's browser. */
export const appContentSecurityPolicy = (): string =>
  `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' wss:${liveKitSources()}; frame-src ${liveFrameSources()}; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`;

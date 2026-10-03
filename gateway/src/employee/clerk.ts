// Google sign-in for the phone app, through Clerk.
//
// Clerk runs the Google sign-in on a page of its own; a development instance
// uses Clerk's own Google credentials, so there is nothing to set up at Google.
// That page hands this server the Clerk session token. The server verifies it
// with Clerk, looks up the account's verified email, and lets in only an email
// the owner listed. What it gets is the same session an access code gives, so
// nothing else in the app changes, and access codes keep working beside it.
//
// The owner's own email signs in to the owner's employee. Any other listed
// email (or anyone at a listed @domain) gets an employee of their own, kept
// apart like every owner's. Which emails may sign in is checked again on every
// request, so taking one off the list ends its sessions.
import {createClerkClient, verifyToken} from '@clerk/backend';
import {tokenHash} from './auth.js';

export interface ClerkSettings {
  publishableKey: string; secretKey: string; frontendApi: string;
  ownerEmail: string; allowed: string[];
  /** Optional: Clerk's PEM public key, to verify without a network call. */
  jwtKey?: string; apiUrl?: string;
}

/** The Clerk frontend API host a publishable key names: pk_test_ followed by base64 of "host$". */
export function frontendApiOf(publishableKey: string): string | null {
  const m = /^pk_(?:test|live)_([A-Za-z0-9+/=_-]+)$/.exec(publishableKey.trim());
  if (!m) return null;
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
  if (!decoded.endsWith('$')) return null;
  const host = decoded.slice(0, -1).toLowerCase();
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

const emails = (s?: string) => (s ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);

/** Google sign-in's settings, or null when it is not set up: both keys are needed, and they must be Clerk's. */
export function clerkSettings(env: NodeJS.ProcessEnv = process.env): ClerkSettings | null {
  const publishableKey = env.CLERK_PUBLISHABLE_KEY?.trim() ?? '', secretKey = env.CLERK_SECRET_KEY?.trim() ?? '';
  const frontendApi = frontendApiOf(publishableKey);
  if (!frontendApi || !/^sk_(?:test|live)_\S+$/.test(secretKey)) return null;
  return {publishableKey, secretKey, frontendApi, ownerEmail: emails(env.CLERK_OWNER_EMAIL)[0] ?? '', allowed: emails(env.CLERK_ALLOWED_EMAILS),
    jwtKey: env.CLERK_JWT_KEY?.trim() || undefined, apiUrl: env.CLERK_API_URL?.trim() || undefined};
}

/** The owner an access code signs in as on this server: the first one in GATEWAY_TOKENS. */
export const mainOwner = (env: NodeJS.ProcessEnv = process.env) => (env.GATEWAY_TOKENS ?? '').split(',')[0]?.split(':')[1]?.trim() || 'owner';

/** Whose employee an email signs in to: the owner's own, one of its own, or none. */
export function ownerForEmail(email: string, s: ClerkSettings, owner: string): string | null {
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return null;
  if (s.ownerEmail && e === s.ownerEmail) return owner;
  const domain = e.slice(e.lastIndexOf('@'));
  return s.allowed.some(a => a === e || (a.startsWith('@') && a === domain)) ? e : null;
}

/** What a Google session is granted on. Recomputed on every request, so removing an email ends its sessions. */
export const clerkGrant = (email: string) => `clerk:${email.trim().toLowerCase()}`;

export function clerkGrantValid(owner: string, hash: string, main = mainOwner(), s = clerkSettings()): boolean {
  if (!s) return false;
  const email = owner === main ? s.ownerEmail : owner;
  return !!email && ownerForEmail(email, s, main) === owner && tokenHash(clerkGrant(email)) === hash;
}

/**
 * Who a Clerk session token belongs to, by verified email. Clerk's azp claim
 * must name the page origin the request comes from, so a browser on another
 * site's page cannot present a token issued to this one. Null when it does not
 * verify, or the account has no verified email. The email list, not this check,
 * is what decides who gets in.
 */
export async function verifiedEmail(token: string, origin: string, s: ClerkSettings): Promise<string | null> {
  // Clerk's exported verifyToken returns the token's claims, and throws when the token does not verify.
  const claims = await verifyToken(token, {secretKey: s.secretKey, jwtKey: s.jwtKey, apiUrl: s.apiUrl, authorizedParties: [origin]}).catch(() => null);
  const userId = (claims as {sub?: unknown} | null)?.sub;
  if (typeof userId !== 'string' || !userId) return null;
  const user = await createClerkClient({secretKey: s.secretKey, publishableKey: s.publishableKey, apiUrl: s.apiUrl}).users.getUser(userId);
  const email = user.primaryEmailAddress;
  return email?.verification?.status === 'verified' ? email.emailAddress : null;
}

// --- the sign-in page -------------------------------------------------------
//
// A page of its own, so Clerk's script never runs on the app's page: the app
// keeps its strict policy, and this one allows exactly Clerk and the bot check
// Clerk uses. Since Clerk's version 6 script, its sign-in screens come as a
// script of their own (@clerk/ui), which the page loads first and hands to
// Clerk when it starts; without it Clerk refuses to show a sign-in.

export const clerkPagePolicy = (s: ClerkSettings) =>
  `default-src 'self'; script-src 'self' https://${s.frontendApi} https://challenges.cloudflare.com; connect-src 'self' https://${s.frontendApi}; ` +
  `img-src 'self' data: https://img.clerk.com; style-src 'self' 'unsafe-inline'; frame-src 'self' https://challenges.cloudflare.com; worker-src 'self' blob:; ` +
  `form-action 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`;

const PAGE_STYLE = `:root{color-scheme:dark;--bg:#101114;--panel:#191b20;--line:#2c3039;--ink:#f2f4f8;--muted:#a2a9b8;--accent:#6ea8ff;--accent-ink:#07131f}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{width:min(100%,420px);display:flex;flex-direction:column;gap:14px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:18px}
h1{margin:0;font-size:1.4rem}p{margin:0;color:var(--muted);font-size:.92rem}#status:empty{display:none}
button{font:inherit;min-height:44px;padding:10px 14px;border-radius:10px;border:1px solid var(--line);background:#22252c;color:var(--ink);cursor:pointer}
a{color:var(--accent)}[hidden]{display:none!important}`;

export function clerkSignInPage(s: ClerkSettings): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Sign in · VisionBot Pro</title><link rel="icon" href="/icon-192.png"><style>${PAGE_STYLE}</style>
<script defer crossorigin="anonymous" src="https://${s.frontendApi}/npm/@clerk/ui@1/dist/ui.browser.js"></script>
<script defer crossorigin="anonymous" data-clerk-publishable-key="${s.publishableKey}" src="https://${s.frontendApi}/npm/@clerk/clerk-js@6/dist/clerk.browser.js"></script>
<script defer src="/auth/clerk/sign-in.js"></script></head>
<body><main><h1>VisionBot Pro</h1><p id="status" role="status">Loading Google sign-in…</p><div id="sign-in"></div>
<button id="other" type="button" hidden>Use a different Google account</button><p><a href="/">Use an access code instead</a></p></main></body></html>`;
}

export const notSetUpPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · VisionBot Pro</title><link rel="icon" href="/icon-192.png"><style>${PAGE_STYLE}</style></head><body><main><h1>VisionBot Pro</h1>
<p>Google sign-in is not set up on this server yet. Whoever runs it can turn it on with bash deploy/local.sh --setup.</p><p><a href="/">Use an access code instead</a></p></main></body></html>`;

/** Runs on the sign-in page: Clerk's own sign-in, then the server starts the app's session for whoever it was. */
export const clerkSignInScript = `(() => {
  const status = document.getElementById('status'), box = document.getElementById('sign-in'), other = document.getElementById('other');
  const say = text => {status.textContent = text;};
  let sending = false;
  async function finish() {
    if (sending) return;
    sending = true;
    say('Signing you in…');
    try {
      const token = await window.Clerk.session.getToken();
      const res = await fetch('/api/auth/clerk', {method: 'POST', credentials: 'same-origin', headers: {'content-type': 'application/json', 'x-vision-bot': 'sign-in'}, body: JSON.stringify({token})});
      if (res.ok) {location.replace('/'); return;}
      const body = await res.json().catch(() => ({}));
      say((body && body.error && body.error.message) || 'That sign-in did not go through. Try again.');
    } catch {
      say('That sign-in did not go through. Check your connection and try again.');
    }
    other.hidden = false;
    sending = false;
  }
  other.addEventListener('click', async () => {other.hidden = true; await window.Clerk.signOut(); location.reload();});
  (async () => {
    if (!window.Clerk || !window.__internal_ClerkUICtor) {say('Google sign-in could not load. Check your connection, or use your access code.'); return;}
    // Its screens, from their own script; and no usage reports, which go to a host this page does not allow.
    try {await window.Clerk.load({ui: {ClerkUI: window.__internal_ClerkUICtor}, telemetry: false});} catch {say('Google sign-in could not load. Use your access code instead.'); return;}
    if (window.Clerk.user) {finish(); return;}
    say('');
    window.Clerk.mountSignIn(box, {fallbackRedirectUrl: '/auth/clerk', signUpFallbackRedirectUrl: '/auth/clerk'});
    window.Clerk.addListener(({user}) => {if (user) finish();});
  })();
})();
`;

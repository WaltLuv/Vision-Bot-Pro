import dotenv from "dotenv";
import {fileURLToPath} from "node:url";
// The server's settings: gateway/.env (deploy/local.sh) or the repository's .env (deploy/install.sh).
dotenv.config({quiet: true});
dotenv.config({path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true});
import {Store} from "./employee/db.js";
import {ToolGateway} from "./employee/tools.js";
import {BrowserbaseBrowsers, browserbaseEnabled, jevBrowserEnabled} from "./employee/browserbase.js";
import {jevRoute, ruleRoute} from "./employee/route.js";
import {search, searchProvider} from "./employee/web.js";

/**
 * Live check against the real services, with the keys in this server's .env. Run it on the server, where the
 * internet is open:
 *
 *   cd gateway && npm run live-check
 *
 * It opens ONE guest Browserbase session (a few cents), goes to a Home Depot search, lets Jev do one harmless step,
 * and closes the session. It never signs in, adds to a cart or buys anything. Each line says what worked and how
 * long it took; nothing printed contains a key.
 */
const TASK = "Find prices for 1/2 inch drywall at Home Depot";
const ok = (s: string) => console.log(`  PASS  ${s}`), bad = (s: string) => console.log(`  FAIL  ${s}`), skip = (s: string) => console.log(`  SKIP  ${s}`);
const ms = (t: number) => `${Math.round(performance.now() - t)} ms`;
let failures = 0;
const fail = (s: string) => {failures++; bad(s);};

console.log(`VisionBot live check: "${TASK}"\n`);

// 1. Routing: the rules, then Jev when a TypeSafe key is set.
let t = performance.now();
const rules = ruleRoute(TASK);
ok(`fast router: ${rules.route}, opens ${rules.startUrl} (${ms(t)})`);
if (process.env.TYPESAFE_API_KEY) {
  t = performance.now();
  // Asked directly, with a generous limit, so this shows Jev's real answer and speed.
  const jev = await jevRoute("Need something to patch a hole in the bathroom wall, compare options", fetch, 5000);
  jev ? ok(`Jev routing: ${jev.route} at ${Math.round(jev.confidence * 100)}% (${ms(t)})`) : fail(`Jev routing: no usable answer (${ms(t)}). Check TYPESAFE_API_KEY.`);
} else skip("Jev routing: TYPESAFE_API_KEY is not set");

// 2. Quick search.
if (searchProvider()) {
  t = performance.now();
  try {const r = await search("1/2 inch drywall 4x8 price", fetch, 15000); ok(`quick search (${r.provider}): ${r.results.length} results (${ms(t)})`);}
  catch (e) {fail(`quick search: ${(e as Error).message}`);}
} else skip("quick search: no SEARCH_API_KEY or Gemini key");

// 3. Browserbase, and Jev on the live page.
if (!browserbaseEnabled()) {skip("live browser: BROWSERBASE_API_KEY is not set");}
else {
  const db = new Store(":memory:"), tools = new ToolGateway(db), bb = new BrowserbaseBrowsers(db);
  bb.register(tools);
  db.put("live-check", "policy", {id: "p", tool: "browser_open", policy: "allow"});
  db.put("live-check", "run", {id: "run", task: TASK, status: "working"});
  let n = 0;
  const use = (name: string, args: object = {}) => tools.wait("live-check", "run", name, args, `k${++n}`, AbortSignal.timeout(120_000));
  try {
    t = performance.now();
    const opened = await use("browser_open", {purpose: "VisionBot live check"});
    const c = db.get("live-check", "computer", opened.computerId)!;
    c.liveEmbed ? ok(`Browserbase session open with a live view (${ms(t)})`) : fail(`Browserbase opened but gave no embeddable live view (${c.liveHost ?? "no host"})`);
    t = performance.now();
    const at = await use("browser_goto", {url: rules.startUrl});
    ok(`Home Depot search loaded: "${String(at.title).slice(0, 60)}" (${ms(t)})`);
    const page = await use("browser_read");
    /access denied|captcha|are you a robot|blocked/i.test(page.text) ? fail("Home Depot showed a block or captcha page to this browser") : ok(`page readable: ${page.controls.length} controls`);
    if (jevBrowserEnabled()) {
      t = performance.now();
      const r = await use("browser_do", {goal: "Open the first drywall product in the search results"});
      ["done", "likely_done"].includes(r.status) ? ok(`Jev on the live page: ${r.status} in ${r.jevCalls} decisions, now "${String(r.title).slice(0, 60)}" (${ms(t)})`) : fail(`Jev on the live page: ${r.status}${r.info ? ` (${r.info})` : ""}`);
    } else skip("Jev on the live page: TYPESAFE_API_KEY is not set");
  } catch (e) {fail(`live browser: ${(e as Error).message}`);}
  finally {
    for (const c of db.list("live-check", "computer")) await bb.release("live-check", c.id, "closed").catch(() => {});
    console.log("  ----  Browserbase session closed");
    db.close();
  }
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll live checks passed.");
process.exit(failures ? 1 : 0);

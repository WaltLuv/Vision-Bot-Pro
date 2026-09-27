// End-to-end check of the real path: a browser loading the built PWA from the
// real gateway, signing in, and working through the behaviours the migration is
// accepted on -- camera, governed execution, approvals, cancellation, durability
// across a disconnect, and isolation between two owners.
//
// Only the model is a fixture. The gateway, its database, the run queue, the
// tool gateway, the approval gate and the Hermes subprocess are the real ones,
// and no provider credential is involved.
//
// Requires: web/dist built, gateway deps installed, and HERMES_CHECKOUT +
// HERMES_PYTHON pointing at an installed official Hermes runtime.
import {launchBrowser, openPhone, reporter, startStack, state} from './harness.mjs';
import * as scenario from './scenarios.mjs';

if (!process.env.HERMES_CHECKOUT) {
  console.error('HERMES_CHECKOUT is not set. Install the official Hermes runtime and point HERMES_CHECKOUT at the\ndirectory containing run_agent.py (and HERMES_PYTHON at its interpreter). See docs/TESTING.md.');
  process.exit(2);
}

const PORT = Number(process.env.E2E_PORT ?? 8790);
const TOKEN = 'e2e-access-code';
const OTHER_TOKEN = 'e2e-second-access-code';

const {results, check} = reporter();
let stack, browser, phone;

try {
  stack = await startStack({port: PORT, tokens: `${TOKEN}:alice,${OTHER_TOKEN}:bob`});
  browser = await launchBrowser({livePort: stack.browserUse.livePort});

  phone = await openPhone(browser, stack.base);
  const ctx = {...phone, browser, base: stack.base, check, token: TOKEN, otherToken: OTHER_TOKEN, browserUse: stack.browserUse, browserbase: stack.browserbase};

  // Order matters: each scenario builds on the sign-in and the records the
  // previous ones created, and `safety` signs out at the end.
  await scenario.appLoads(ctx);
  await scenario.session(ctx);
  await scenario.governedTask(ctx);
  await scenario.v1AcceptanceLoop(ctx);
  await scenario.phoneWidths(ctx);
  await scenario.cameraAndMicrophone(ctx);
  await scenario.attachmentRules(ctx);
  await scenario.realtimeDegradesHonestly(ctx);
  await scenario.procurementComparison(ctx);
  await scenario.approvalGate(ctx);
  await scenario.liveBrowser(ctx);
  await scenario.drivenBrowser(ctx);
  await scenario.cancellation(ctx);
  await scenario.survivesDisconnect(ctx);
  await scenario.ownershipIsolation(ctx);
  await scenario.safety(ctx);

  console.log(`\n[server log tail]\n${stack.tail()}`);
} catch (error) {
  check('the run completed without an unexpected error', false, String(error?.message ?? error));
  // A timeout says what did not happen; these say why.
  const runs = phone ? (await state(phone.page).catch(() => null))?.run : null;
  if (runs) console.log('\n[tasks at failure]\n' + runs.map(r => `${r.status.padEnd(10)} ${r.runtime ?? '-'} ${r.task.slice(0, 60)}`).join('\n'));
  if (stack) console.log(`\n[server log tail]\n${stack.tail(80)}`);
} finally {
  await browser?.close().catch(() => {});
  await stack?.stop();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} end-to-end checks passed`);
if (failed.length) console.log(`failed:\n${failed.map(f => `  - ${f.name}${f.detail ? ' — ' + f.detail : ''}`).join('\n')}`);
process.exit(failed.length ? 1 : 0);

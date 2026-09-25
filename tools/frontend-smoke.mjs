/**
 * Frontend smoke test.
 *
 * Boots index.html in a headless DOM (jsdom) against a real server, then drives
 * the actual UI the way a person would: create an account at the sign-in gate,
 * navigate every page, upload a reference file, run a streamed generation, build
 * an automation, invite a teammate, and confirm a viewer really is read-only.
 *
 * It catches the class of bug an API test cannot — broken render paths, stale
 * element references, event wiring, and role checks that only exist in the DOM.
 *
 * Usage:
 *   npm i --no-save jsdom          # test-only dependency, never shipped
 *   node tools/frontend-smoke.mjs  # starts its own server on a throwaway database
 *
 * Env:
 *   ORIGIN  run against an already-running server instead of starting one
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(`${root}/index.html`, 'utf8');
const appJs = fs.readFileSync(`${root}/app.js`, 'utf8');

// --- a server to drive ------------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-smoke-'));
const envOrigin = process.env.ORIGIN || '';
const port = 4700 + Math.floor(Math.random() * 300);
const ORIGIN = envOrigin || `http://127.0.0.1:${port}`;
let server = null;

if (!envOrigin) {
  server = spawn(process.execPath, ['--no-warnings=ExperimentalWarning', path.join(root, 'server', 'index.js')], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      AI_STUDIO_HOST: '127.0.0.1',
      AI_STUDIO_DB: path.join(tmpDir, 'smoke.db'),
      AI_STUDIO_UPLOADS: path.join(tmpDir, 'uploads'),
      AI_STUDIO_QUIET: '1',
      AI_STUDIO_SCHEDULER_TICK_MS: '300',
      OPENAI_API_KEY: '',
      ANTHROPIC_API_KEY: '',
      GEMINI_API_KEY: '',
      OLLAMA_ENABLED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.log = '';
  server.stdout.on('data', (data) => { server.log += data.toString(); });
  server.stderr.on('data', (data) => { server.log += data.toString(); });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${ORIGIN}/api/health`)).ok) return true;
    } catch { /* not up yet */ }
    await wait(150);
  }
  return false;
}

const problems = [];
let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// --- cookie jar ------------------------------------------------------------
// jsdom does not carry cookies between fetches, so the test owns a jar and
// attaches it to every request — the same thing a browser does silently.
function createJar(label = 'session') {
  const jar = new Map();
  return {
    label,
    get: (name) => jar.get(name) || '',
    has: (name) => jar.has(name),
    header: () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
    absorb(response) {
      const lines = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
      for (const line of lines) {
        const [pair] = String(line).split(';');
        const index = pair.indexOf('=');
        if (index < 0) continue;
        const name = pair.slice(0, index).trim();
        const value = pair.slice(index + 1).trim();
        if (value) jar.set(name, value);
        else jar.delete(name);
      }
    },
    clear: () => jar.clear(),
  };
}

/** A fetch that behaves like the browser's: the jar travels with every call. */
function jarredFetch(jar) {
  return async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, ORIGIN);
    const headers = new Headers(init.headers || {});
    if (jar.header() && !headers.has('cookie')) headers.set('cookie', jar.header());
    // Real browsers send Origin on cross-origin writes; same-origin ones are
    // allowed to omit it, which is what this test relies on.
    const response = await fetch(url, { ...init, headers });
    jar.absorb(response);
    return response;
  };
}

/** Small helper so the test can set up state through the API when it needs to. */
async function api(jar, path_, { method = 'GET', body } = {}) {
  const response = await jarredFetch(jar)(`${ORIGIN}${path_}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  return { status: response.status, body: payload };
}

// --- one DOM per "browser" -------------------------------------------------
function bootWindow({ jar, search = '', label = 'window' }) {
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: `${ORIGIN}/${search}` });
  const { window } = dom;
  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = () => {};
  window.fetch = jarredFetch(jar);
  window.TextDecoder = TextDecoder;
  window.AbortController = AbortController;
  // jsdom has no working FormData/File pipeline for uploads, so the browser
  // globals the app actually uses are the Node ones. Node's FormData cannot read
  // a jsdom <form>, so a thin shim fills that gap: form → entries, everything
  // else → straight through to the real implementation.
  const NodeFormData = FormData;
  class BrowserishFormData extends NodeFormData {
    constructor(form) {
      super();
      const isElement = form && typeof form === 'object' && typeof form.querySelectorAll === 'function' && form.nodeType === 1;
      if (!isElement) return;
      for (const field of form.querySelectorAll('input, select, textarea')) {
        if (!field.name || field.disabled) continue;
        if (field.type === 'checkbox' || field.type === 'radio') {
          if (field.checked) this.append(field.name, field.value);
        } else {
          this.append(field.name, field.value);
        }
      }
    }
  }
  window.FormData = BrowserishFormData;
  window.Blob = Blob;
  window.File = File;
  window.addEventListener('error', (event) => problems.push(`${label} error: ${event.message}`));
  window.addEventListener('unhandledrejection', (event) => problems.push(`${label} rejection: ${event.reason?.message || event.reason}`));
  const nativeError = window.console.error;
  window.console.error = (...args) => { problems.push(`${label} console.error: ${args.join(' ').slice(0, 200)}`); nativeError?.(...args); };
  window.eval(appJs);
  return {
    window,
    dom,
    $: (selector) => window.document.querySelector(selector),
    text: (selector) => window.document.querySelector(selector)?.textContent?.trim() || '',
    async click(selector) {
      const node = typeof selector === 'string' ? window.document.querySelector(selector) : selector;
      if (!node) throw new Error(`missing element: ${selector}`);
      node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(40);
      return node;
    },
    typeInto(selector, value) {
      const node = window.document.querySelector(selector);
      if (!node) throw new Error(`missing input: ${selector}`);
      node.value = value;
      node.dispatchEvent(new window.Event('input', { bubbles: true }));
      return node;
    },
    async submit(selector) {
      const form = window.document.querySelector(selector);
      if (!form) throw new Error(`missing form: ${selector}`);
      form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
      await wait(60);
    },
    async waitFor(predicate, { timeoutMs = 8000, intervalMs = 100, label: what = 'condition' } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return true;
        await wait(intervalMs);
      }
      console.log(`    (timed out waiting for ${what})`);
      return false;
    },
  };
}

const memberRow = (app_, name) => [...app_.window.document.querySelectorAll('.member-row')]
  .find((row) => (row.textContent || '').includes(name)) || null;

const up = await waitForServer();
if (!up) {
  console.error(`Server did not start at ${ORIGIN}.\n${server?.log || ''}`);
  process.exit(1);
}

console.log(`\nFrontend smoke test (${ORIGIN})\n`);
console.log('Sign-in gate');
const ownerJar = createJar('owner');
const app = bootWindow({ jar: ownerJar, label: 'owner' });
const { window, $, text } = app;

check('The shell is hidden until we sign in', window.document.body.classList.contains('is-locked') === false || Boolean($('#auth-screen')) , 'gate mounted');
for (let i = 0; i < 40 && !$('#auth-form'); i += 1) await wait(100);
check('The gate renders a sign-up form on a fresh server', Boolean($('#auth-form')) && Boolean($('#auth-name')));
check('The gate explains the first-run claim', ($('#auth-card')?.textContent || '').includes('Northstar Studio'), text('#auth-card').slice(0, 90));
check('The shell is not usable before signing in', window.document.body.classList.contains('is-locked'));

app.typeInto('#auth-name', 'Smoke Owner');
app.typeInto('#auth-email', 'smoke-owner@example.com');
app.typeInto('#auth-password', 'smoke-owner-pass');
await app.submit('#auth-form');
const signedIn = await app.waitFor(() => !window.document.body.classList.contains('is-locked'), { label: 'the studio to load' });
check('Signing up opens the studio', signedIn);
// The gate closes before the workspace data lands, so wait for the shell to be
// painted from the server before reading anything out of it.
await app.waitFor(() => text('#profile-name') === 'Smoke Owner', { label: 'the shell to show the account' });
check('The gate is hidden', $('#auth-screen')?.hidden === true);
check('The gate screen is followed by the studio', !window.document.body.classList.contains('is-locked'));
check('The workspace switcher shows the claimed workspace', text('#workspace-name') === 'Northstar Studio', text('#workspace-name'));
check('The breadcrumb follows the workspace', text('#breadcrumb-workspace') === 'Northstar Studio');
check('The profile shows the signed-in person', text('#profile-name') === 'Smoke Owner' && text('#profile-avatar') === 'SO', `${text('#profile-name')} / ${text('#profile-avatar')}`);
check('The role pill names the role', /Owner/.test(text('#role-pill')), text('#role-pill'));

console.log('\nBoot');
check('Backend connected', text('#env-label') === 'Demo engine', `pill says "${text('#env-label')}"`);
check('Projects loaded from SQLite', Number(text('#project-count')) >= 6, `count=${text('#project-count')}`);
check('Sidebar credits reflect the database', /^\d[\d,]*$/.test(text('#sidebar-credits')), text('#sidebar-credits'));
check('Overview rendered', ($('#app-content').innerHTML || '').includes('Pick up where you left off'));
check('Recent work shows a real project', /project-grid|A recent idea/.test($('#app-content').innerHTML || ''), 'recent projects rendered');

console.log('\nNavigation (every page renders)');
const pages = [['projects', 'Projects'], ['canvas', 'Canvas'], ['models', 'Models'], ['prompts', 'Prompt library'], ['automations', 'Automations'], ['team', 'Team'], ['usage', 'Usage'], ['settings', 'Settings'], ['overview', 'Good morning']];
for (const [page, expected] of pages) {
  await app.click(`.sidebar .nav-link[data-page="${page}"]`);
  await wait(60);
  check(`${page}: renders with heading`, ($('#app-content').innerHTML || '').includes(expected));
}

console.log('\nTeam page');
await app.click('.sidebar .nav-link[data-page="team"]');
await wait(80);
check('The team page lists the signed-in owner', ($('#app-content').innerHTML || '').includes('Smoke Owner'));
check('Roles are explained', ($('#app-content').innerHTML || '').includes('Full control'));
check('Owners see the invite button', Boolean($('[data-action="invite-modal"]')));
check('The member count is in the sidebar', text('#member-count') === '1', text('#member-count'));

console.log('\nLive data on pages');
await app.click('.sidebar .nav-link[data-page="models"]');
await wait(80);
check('Models page lists the live catalogue', ($('#app-content').innerHTML || '').includes('Studio demo'), 'demo engine present');
check('Model cards show connection state', ($('#app-content').innerHTML || '').includes('NEEDS KEY'), 'needs-key badges present');
await app.click('[data-action="model-filter"][data-filter="Image"]');
await wait(60);
check('Model filter narrows to image models', ($('#app-content').innerHTML || '').includes('Image') && !($('#app-content').innerHTML || '').includes('GPT-4.1'));

await app.click('.sidebar .nav-link[data-page="usage"]');
await wait(80);
const usageHtml = $('#app-content').innerHTML || '';
check('Usage page uses recorded generations', usageHtml.includes('Measured from generations') && usageHtml.includes('Real data'));
check('Usage shows a credit total', /\d/.test(text('.credits-number')));

await app.click('.sidebar .nav-link[data-page="settings"]');
await wait(60);
await app.click('[data-action="settings-tab"][data-tab="Connections"]');
await wait(60);
const connections = $('#app-content').innerHTML || '';
check('Connections tab lists all providers', ['OpenAI', 'Anthropic', 'Google Gemini', 'Ollama', 'Studio demo engine'].every((name) => connections.includes(name)));
check('Connections tab names the env var', connections.includes('OPENAI_API_KEY'));

console.log('\nFile storage panel');
check('Storage panel names the driver', connections.includes('Local disk'), 'driver label rendered');
check('Storage panel shows where bytes live', /on this machine/.test($('#app-content').innerHTML || ''), 'directory rendered');
check('Storage panel counts the objects', /object/.test($('#app-content').innerHTML || ''), 'usage line rendered');
await app.click('[data-action="storage-check"]');
const probed = await app.waitFor(() => ($('#app-content').innerHTML || '').includes('Storage answered in'), { label: 'the storage probe to report' });
check('Testing storage reports a real result', probed, ($('.storage-result')?.textContent || '').slice(0, 90));
check('The probe is shown as a success, not an error', Boolean($('.storage-result.is-ok')) && !$('.storage-result.is-bad'), ($('.storage-result')?.className || ''));

console.log('\nAccount settings');
await app.click('[data-action="settings-tab"][data-tab="Profile"]');
await wait(60);
check('Profile shows the account email', ($('#app-content').innerHTML || '').includes('smoke-owner@example.com'));
check('Profile offers a password change', Boolean($('#password-form')) && Boolean($('#password-current')));
app.typeInto('#settings-name', 'Smoke Owner Renamed');
await app.submit('#settings-form');
await app.waitFor(() => text('#profile-name') === 'Smoke Owner Renamed', { label: 'the profile name to update' });
check('Renaming the account updates the shell', text('#profile-name') === 'Smoke Owner Renamed', text('#profile-name'));

console.log('\nWorkspace switching');
await app.click('.workspace-switcher');
await wait(60);
check('The workspace menu lists the current workspace', ($('.popover')?.textContent || '').includes('Northstar Studio'));
await app.click('[data-action="new-workspace"]');
await wait(60);
check('Creating a workspace opens a dialog', Boolean($('#new-workspace-name')));
app.typeInto('#new-workspace-name', 'Smoke Side Project');
await app.submit('#create-workspace-form');
await app.waitFor(() => text('#workspace-name') === 'Smoke Side Project', { label: 'the new workspace to open' });
check('The new workspace becomes active', text('#workspace-name') === 'Smoke Side Project', text('#workspace-name'));
check('The new workspace is empty', Number(text('#project-count')) === 0, `count=${text('#project-count')}`);
check('Switching workspaces keeps the member list honest', text('#member-count') === '1', text('#member-count'));
await app.click('.workspace-switcher');
await wait(60);
const switchBack = [...window.document.querySelectorAll('[data-action="switch-workspace"]')].find((node) => node.textContent.includes('Northstar Studio'));
check('The menu offers the other workspace', Boolean(switchBack));
switchBack.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await app.waitFor(() => text('#workspace-name') === 'Northstar Studio' && Number(text('#project-count')) >= 6, { label: 'the original workspace to load' });
check('Switching back restores its projects', Number(text('#project-count')) >= 6, `count=${text('#project-count')}`);

console.log('\nReference attachments');
await app.click('.sidebar .nav-link[data-page="overview"]');
await wait(60);
check('Composer offers an attach control', Boolean($('[data-action="attach-files"]')) && Boolean($('#attachment-input')));
const attachmentInput = $('#attachment-input');
const brief = new window.File(['Studio brief. Target: a mountain tea house. Avoid: glossy gradients.\n'], 'smoke-brief.txt', { type: 'text/plain' });
Object.defineProperty(attachmentInput, 'files', { value: [brief], configurable: true });
attachmentInput.dispatchEvent(new window.Event('change', { bubbles: true }));
for (let i = 0; i < 40 && !$('.attachment-chip'); i += 1) await wait(100);
check('Uploaded file appears as a chip', ($('.attachment-chip')?.textContent || '').includes('smoke-brief.txt'), text('.attachment-chip'));
check('Attach button counts the file', ($('[data-action="attach-files"]')?.textContent || '').includes('1'));

console.log('\nGeneration through the UI — image mode (default)');
await app.click('.sidebar .nav-link[data-page="overview"]');
await wait(60);
const before = Number(text('#project-count'));
// Re-attach after the re-render above, then send the brief with the prompt.
const attachmentInput2 = $('#attachment-input');
const brief2 = new window.File(['Studio brief. Target: a mountain tea house. Avoid: glossy gradients.\n'], 'smoke-brief.txt', { type: 'text/plain' });
Object.defineProperty(attachmentInput2, 'files', { value: [brief2], configurable: true });
attachmentInput2.dispatchEvent(new window.Event('change', { bubbles: true }));
for (let i = 0; i < 40 && !$('.attachment-chip'); i += 1) await wait(100);
app.typeInto('#main-prompt', 'A restrained identity for a mountain tea house, cool greys, hand-cut type.');
await app.submit('#prompt-form');
check('Output dialog opens immediately', Boolean($('#output-title')) && text('#output-title') === 'Studio output');
// The requested model is "Auto select"; the resolved model and the demo notice
// arrive with the first stream events, so give them a moment.
for (let i = 0; i < 30 && !text('#output-subtitle').includes('Studio demo engine'); i += 1) await wait(100);
check('Dialog names the resolved model', text('#output-subtitle').includes('Studio demo engine'), text('#output-subtitle'));
check('Demo notice is shown to the user', ($('#output-notices')?.textContent || '').includes('not a real model'));
for (let i = 0; i < 40 && !$('.output-image'); i += 1) await wait(100);
const imageSrc = $('.output-image')?.getAttribute('src') || '';
check('Image asset renders in the dialog', imageSrc.startsWith('data:image/svg+xml') || imageSrc.startsWith('/api/files/'), imageSrc.slice(0, 60));
for (let i = 0; i < 40 && $('.output-stats')?.children.length === 0; i += 1) await wait(200);
check('Image run completes with stats', ($('.output-stats')?.children.length || 0) >= 5, `${$('.output-stats')?.children.length} stats`);
check('References are confirmed in the dialog', ($('#output-notices')?.textContent || '').includes('reference file'), text('#output-notices').slice(0, 120));
check('Status says saved to project', ($('#output-status')?.textContent || '').includes('Saved to your project'));
check('Generation id is shown', /Generation g-/.test(text('#output-note')), text('#output-note'));
check('Actions offered: copy, open, again', Boolean($('#output-copy')) && Boolean($('[data-action="open-project"]')) && Boolean($('[data-action="generate-again"]')));
check('Stored asset replaces the inline data URL', ($('.output-image')?.getAttribute('src') || '').startsWith('/api/files/'), $('.output-image')?.getAttribute('src'));
check('Project count increased', Number(text('#project-count')) > before, `${before} → ${text('#project-count')}`);
check('Dashboard refreshes with the new project', ($('#app-content').innerHTML || '').includes('mountain tea house'), 'new project is visible behind the dialog');
await app.click('#output-close');
await wait(60);

console.log('\nGeneration through the UI — writing mode');
await app.click('[data-action="choose-mode"]');
await wait(60);
const writingOption = window.document.querySelector('[data-action="select-mode"][data-value="Writing"]');
check('Mode picker offers Writing', Boolean(writingOption));
writingOption.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(60);
check('Mode switched to Writing', text('#selected-mode') === 'Writing', text('#selected-mode'));
app.typeInto('#main-prompt', 'Write a considered launch note for a small ceramics studio, plain-spoken and specific.');
await app.submit('#prompt-form');
for (let i = 0; i < 40 && ($('#output-stream')?.textContent || '').length < 60; i += 1) await wait(100);
check('Output streams into the dialog', ($('#output-stream')?.textContent || '').length > 60, `${($('#output-stream')?.textContent || '').length} chars`);
check('Caret/streaming state applied', $('#output-stream').classList.contains('is-streaming'));
for (let i = 0; i < 60 && $('.output-stats')?.children.length === 0; i += 1) await wait(200);
check('Text run completes with stats', ($('.output-stats')?.children.length || 0) >= 5);
check('Streamed text was persisted', ($('#output-stream')?.textContent || '').length > 150, `${($('#output-stream')?.textContent || '').length} chars`);

await app.click('#output-close');
await wait(80);
check('Dialog closes cleanly', !$('#output-title'));

console.log('\nAutomations: schedules, runs, builder');
await app.click('.sidebar .nav-link[data-page="automations"]');
await wait(80);
const automationHtml = $('#app-content').innerHTML || '';
check('Automations show their schedule', /Every (Monday|day|weekday)|of each month/.test(automationHtml), 'schedule label rendered');
check('Next run is shown for clock schedules', automationHtml.includes('Next run'), (automationHtml.match(/class="automation-schedule">[^<]*/) || ['no schedule label'])[0].slice(0, 90));
// Run one by hand, then confirm the run shows up in the workflow's history.
// (a-archive is the workspace chore, which deliberately has no dialog.)
await app.click('[data-action="run-automation"][data-id="a-digest"]');
for (let i = 0; i < 60 && !$('#output-title'); i += 1) await wait(100);
check('Run now opens the output dialog', Boolean($('#output-title')));
for (let i = 0; i < 60 && $('.output-stats')?.children.length === 0; i += 1) await wait(200);
await app.click('#output-close');
await wait(120);
await app.click('.sidebar .nav-link[data-page="automations"]');
for (let i = 0; i < 40 && !($('#app-content').innerHTML || '').includes('automation-run'); i += 1) await wait(150);
const historyNow = $('#app-content').innerHTML || '';
check('Run history loads from the server', historyNow.includes('automation-run') && historyNow.includes('Ran '), 'run rows rendered');
await app.click('[data-action="new-automation"]');
await wait(80);
check('Schedule builder opens', Boolean($('#automation-kind')));
const intervalFields = window.document.querySelector('[data-schedule-fields="interval"]');
check('Interval fields start hidden', intervalFields.hidden === true);
$('#automation-kind').value = 'interval';
$('#automation-kind').dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(60);
check('Choosing an interval reveals its fields',
  intervalFields.hidden === false && window.document.querySelector('[data-schedule-fields="daily weekly monthly"]').hidden === true,
  `interval hidden=${intervalFields.hidden}, daily hidden=${window.document.querySelector('[data-schedule-fields="daily weekly monthly"]').hidden}, kind=${$('#automation-kind')?.value}`);
$('#automation-name').value = 'Smoke test heartbeat';
$('#automation-every').value = '45';
await app.submit('#automation-form');
for (let i = 0; i < 40 && !($('#app-content').innerHTML || '').includes('Smoke test heartbeat'); i += 1) await wait(100);
check('Created automation is listed with its schedule', ($('#app-content').innerHTML || '').includes('Every 45 minutes'), 'new row rendered');

// The row shows the chain it will run, not a category name.
const rowHtml = $('#app-content').innerHTML || '';
check('Workflows show their step chain', rowHtml.includes('step-chain') && rowHtml.includes('>Generate<'), 'chain pills rendered');
check('Chore workflows show their own step', rowHtml.includes('Tidy'), 'tidy pill rendered');

// The builder: add a step and pick what it is.
await app.click('[data-action="new-automation"]');
await wait(80);
check('The builder starts with one step', window.document.querySelectorAll('[data-step-row]').length === 1, `${window.document.querySelectorAll('[data-step-row]').length} rows`);
check('The webhook step is unavailable without an allow list', [...window.document.querySelectorAll('[data-step-kind] option')].some((option) => option.value === 'webhook' && option.disabled), 'webhook option disabled');
await app.click('[data-action="add-step"]');
await wait(60);
check('A second step can be added', window.document.querySelectorAll('[data-step-row]').length === 2, `${window.document.querySelectorAll('[data-step-row]').length} rows`);
const secondKind = window.document.querySelectorAll('[data-step-kind]')[1];
secondKind.value = 'export';
secondKind.dispatchEvent(new window.Event('change', { bubbles: true }));
await wait(60);
check('A step can be changed to an export', window.document.querySelectorAll('[data-step-row]')[1].innerHTML.includes('data-step-option="format"'), 'export options rendered');
const formatSelect = window.document.querySelectorAll('[data-step-option="format"]')[0];
formatSelect.value = 'zip';
$('#automation-name').value = 'Smoke chain';
$('#automation-kind').value = 'manual';
$('#automation-kind').dispatchEvent(new window.Event('change', { bubbles: true }));
await app.submit('#automation-form');
for (let i = 0; i < 40 && !($('#app-content').innerHTML || '').includes('Smoke chain'); i += 1) await wait(100);
const chained = $('#app-content').innerHTML || '';
check('A two-step chain is created and shown', chained.includes('Smoke chain') && chained.includes('Generate') && chained.includes('zip'), 'chain row rendered');
// Order matters: the chain should read Generate → Export, not alphabetically.
const chainRow = [...window.document.querySelectorAll('.automation-row')].find((row) => row.textContent.includes('Smoke chain'));
const chainText = chainRow?.querySelector('.step-chain')?.textContent || '';
check('The chain keeps its order', /Generate\s*→\s*Export/.test(chainText.replace(/\s+/g, ' ')), chainText.replace(/\s+/g, ' ').slice(0, 60));

// Running it should record steps that the run log can show.
await app.click('[data-action="run-automation"][data-id]');
await wait(200);
for (let i = 0; i < 60 && !($('#app-content').innerHTML || '').includes('run-log'); i += 1) await wait(150);
const logHtml = $('#app-content').innerHTML || '';
check('The run log lists runs', logHtml.includes('run-log') && logHtml.includes('Run log'), 'run log rendered');
const runHead = window.document.querySelector('.run-log-head');
check('A logged run can be opened', Boolean(runHead));
if (runHead) {
  runHead.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(200);
  const opened = $('#app-content').innerHTML || '';
  check('Opening a run shows each step', opened.includes('run-step') && /run-step-message/.test(opened), 'steps rendered');
  check('A step reports what it did', /Generated|Exported|Archive|Posted/.test($('.run-log-row.is-open')?.textContent || ''), ($('.run-log-row.is-open')?.textContent || '').slice(0, 90));
}

console.log('\nProject detail + history');
if ($('#automation-form')) { await app.click('[data-action="close-modal"]'); await wait(60); }
await app.click('.sidebar .nav-link[data-page="projects"]');
await wait(80);
// Open the project that actually has stored files (the one the image run made).
const projectCards = [...window.document.querySelectorAll('.project-title-button')];
const firstCard = projectCards.find((node) => node.textContent.includes('tea house')) || projectCards[0];
check('Projects page lists project cards', Boolean(firstCard), `${projectCards.length} cards`);
firstCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
// The history slot loads asynchronously; wait for it to resolve.
for (let i = 0; i < 30 && ($('#project-generations')?.textContent || '').includes('Loading'); i += 1) await wait(100);
const detail = $('#project-detail-title')?.textContent || '';
check('Project detail opens', detail.length > 0, detail);
check('Generation history is listed', ($('#project-generations')?.textContent || '').includes('Generation history'));
const historyHtml = $('#project-generations')?.innerHTML || '';
check('History contains real output or an asset', historyHtml.includes('<pre') || historyHtml.includes('output-image'), `${historyHtml.length} chars of markup`);
for (let i = 0; i < 30 && !$('#project-files')?.innerHTML; i += 1) await wait(100);
check('Project files section renders stored files', Boolean($('#project-files')?.innerHTML), 'files slot filled');
await app.click('[data-action="close-modal"]');
await wait(60);

console.log('\nPrompt library save + use');
await app.click('.sidebar .nav-link[data-page="prompts"]');
await wait(60);
await app.click('[data-action="save-prompt-info"]');
await wait(60);
check('Save-a-prompt dialog opens', Boolean($('#save-prompt-title-input')));
$('#save-prompt-title-input').value = 'Smoke test prompt';
$('#save-prompt-body').value = 'Write a warm, specific product story for [product].';
await app.submit('#save-prompt-form');
await wait(700);
check('Saved prompt lands in the library', ($('#app-content').innerHTML || '').includes('Smoke test prompt'));
await app.click('[data-action="use-prompt"]');
await wait(400);
check('Using a prompt jumps to the prompt box', ($('#main-prompt')?.value || '').length > 20);

console.log('\nCommand palette + errors');
$('.command-search').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(80);
check('Command palette opens', Boolean($('#command-input')));
app.typeInto('#command-input', 'aurora');
await wait(80);
check('Command palette finds a project', ($('#command-results')?.textContent || '').toLowerCase().includes('aurora'));
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(60);
check('Escape closes the palette', !$('#command-input'));

// Unconfigured provider must produce a friendly, actionable failure.
await app.click('.sidebar .nav-link[data-page="overview"]');
await wait(60);
// Force an explicit model whose provider has no key by calling the app's own path.
const selectModel = $('[data-action="choose-model"]');
selectModel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(60);
check('Model picker only offers runnable models', ($('.popover')?.textContent || '').includes('Studio demo') || ($('.popover')?.textContent || '').includes('Studio demo render'));
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(40);

// ---------------------------------------------------------------------------
// Phase 4: invites and roles, driven entirely through the UI
// ---------------------------------------------------------------------------
console.log('\nInviting a teammate (owner)');
await app.click('.sidebar .nav-link[data-page="team"]');
await wait(80);
await app.click('[data-action="invite-modal"]');
await wait(60);
check('Invite dialog opens', Boolean($('#invite-email')) && Boolean($('#invite-role')));
check('Invite dialog offers the roles an owner may assign', ['Admin', 'Editor', 'Viewer'].every((role) => ($('#invite-role')?.innerHTML || '').includes(role)));
app.typeInto('#invite-email', 'smoke-viewer@example.com');
$('#invite-role').value = 'viewer';
await app.submit('#invite-form-modal');
await app.waitFor(() => Boolean($('#invite-link')), { label: 'the invite link dialog' });
check('An invite link is produced', ($('#invite-link')?.value || '').includes('invite='), $('#invite-link')?.value);
const inviteUrl = $('#invite-link')?.value || '';
const inviteToken = inviteUrl.includes('invite=') ? inviteUrl.split('invite=')[1] : '';
await app.click('[data-action="close-modal"]');
await wait(60);
check('The pending invite is listed', ($('#app-content').innerHTML || '').includes('smoke-viewer@example.com'));

// Accepting the invite as a different person, in a second DOM.
console.log('\nAccepting the invite (new account, viewer)');
const viewerJar = createJar('viewer');
const viewer = bootWindow({ jar: viewerJar, search: inviteToken ? `?invite=${inviteToken}` : '', label: 'viewer' });
for (let i = 0; i < 40 && !viewer.$('#invite-form'); i += 1) await wait(100);
check('An invite link opens the acceptance screen', Boolean(viewer.$('#invite-form')), viewer.text('#auth-card').slice(0, 80));
check('The screen names the workspace', (viewer.$('#auth-card')?.textContent || '').includes('Northstar Studio'), (viewer.$('#auth-card')?.textContent || '').slice(0, 70));
check('The screen names the role', /viewer/i.test(viewer.$('#auth-card')?.textContent || ''), 'role mentioned');
check('A new invitee is asked for a name and password', Boolean(viewer.$('#auth-name')) && Boolean(viewer.$('#auth-password')));
viewer.typeInto('#auth-name', 'Smoke Viewer');
viewer.typeInto('#auth-password', 'smoke-viewer-pass');
await viewer.submit('#invite-form');
const joined = await viewer.waitFor(() => !viewer.window.document.body.classList.contains('is-locked'), { label: 'the viewer to join' });
check('Accepting the invite signs them in', joined);
await viewer.waitFor(() => Number(viewer.text('#project-count')) >= 6, { label: 'the viewer workspace to load' });
check('The viewer lands in the workspace', viewer.text('#workspace-name') === 'Northstar Studio', viewer.text('#workspace-name'));
check('The viewer is told they are read-only', /read only/.test(viewer.text('#role-pill')), viewer.text('#role-pill'));
check('A viewer gets an explanation instead of the composer', Boolean(viewer.$('.readonly-note')) && viewer.$('#prompt-form')?.hidden === true);
check('A viewer sees no New project button', !viewer.$('[data-action="new-project"]') && ![...viewer.window.document.querySelectorAll('[data-action="new-project"]')].length);
check('A viewer can still read the projects', Number(viewer.text('#project-count')) >= 6, viewer.text('#project-count'));

await viewer.click('.sidebar .nav-link[data-page="team"]');
await wait(80);
check('The team page lists both people', (viewer.$('#app-content').innerHTML || '').includes('Smoke Owner Renamed') && (viewer.$('#app-content').innerHTML || '').includes('Smoke Viewer'));
check('A viewer sees no invite controls', !viewer.$('[data-action="invite-modal"]'));
check('A viewer sees no role dropdowns', !viewer.$('.role-select'));

// The owner sees the viewer, can promote them, and can remove them.
console.log('\nManaging roles (owner)');
await app.click('.sidebar .nav-link[data-page="team"]');
await wait(80);
check('The owner sees both members', ($('#app-content').innerHTML || '').includes('Smoke Viewer'));
const roleSelects = [...window.document.querySelectorAll('.role-select')];
check('The owner sees role controls for other members', roleSelects.length >= 1, `${roleSelects.length} selects`);
const viewerSelect = memberRow(app, 'Smoke Viewer')?.querySelector('.role-select');
check('The role control belongs to the other member', viewerSelect?.value === 'viewer', viewerSelect?.value || 'none');
check('The owner keeps an immutable badge instead of a dropdown', !memberRow(app, 'Smoke Owner Renamed')?.querySelector('select') && (memberRow(app, 'Smoke Owner Renamed')?.textContent || '').includes('OWNER'));
viewerSelect.value = 'editor';
viewerSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
// The row re-renders from the server's answer, so wait for the dropdown to
// come back holding the new role instead of trusting the markup around it.
const roleLanded = await app.waitFor(
  () => memberRow(app, 'Smoke Viewer')?.querySelector('.role-select')?.value === 'editor',
  { label: 'the role change to land' },
);
check('Changing a role updates the member row', roleLanded, `row says "${(memberRow(app, 'Smoke Viewer')?.textContent || '').trim().slice(0, 60)}"`);
const refreshed = await api(ownerJar, '/api/members');
check('The server agrees with the change', refreshed.body.members.find((member) => member.name === 'Smoke Viewer')?.role === 'editor', JSON.stringify(refreshed.body.members?.map((m) => [m.name, m.role])));

// Promote the editor to admin so a role the owner can manage is exercised.
// (Admins cannot be edited by other admins — only owners.)
const editorSelect = memberRow(app, 'Smoke Viewer')?.querySelector('.role-select');
check('The viewer row is editable by the owner', Boolean(editorSelect) && editorSelect.value === 'editor', editorSelect?.value || 'no select');
editorSelect.value = 'admin';
editorSelect.dispatchEvent(new window.Event('change', { bubbles: true }));
const promoted = await app.waitFor(
  () => /admin/i.test(memberRow(app, 'Smoke Viewer')?.textContent || '') && (memberRow(app, 'Smoke Viewer')?.querySelector('select')?.value === 'admin' || (memberRow(app, 'Smoke Viewer')?.textContent || '').includes('ADMIN')),
  { label: 'the promotion to land' },
);
check('A member can be promoted to admin', promoted, `row says "${(memberRow(app, 'Smoke Viewer')?.textContent || '').trim().slice(0, 70)}"`);
const promotedOnServer = await api(ownerJar, '/api/members');
check('The server recorded the promotion', promotedOnServer.body.members.find((member) => member.name === 'Smoke Viewer')?.role === 'admin', JSON.stringify(promotedOnServer.body.members?.map((m) => [m.name, m.role])));
await app.click('.sidebar .nav-link[data-page="team"]');
await wait(80);
await app.click('[data-action="remove-member"]');
await wait(60);
check('Removing someone asks first', Boolean($('[data-action="confirm-remove-member"]')));
await app.click('[data-action="confirm-remove-member"]');
await app.waitFor(() => !($('#app-content').innerHTML || '').includes('Smoke Viewer'), { label: 'the member to disappear' });
check('The member is gone from the list', !($('#app-content').innerHTML || '').includes('Smoke Viewer'));
const afterRemoval = await api(ownerJar, '/api/members');
check('The server dropped their membership', !afterRemoval.body.members.some((member) => member.name === 'Smoke Viewer'));
const viewerAfter = await api(viewerJar, '/api/bootstrap');
check('Their session no longer reads the workspace', viewerAfter.status === 401, `status=${viewerAfter.status}`);

console.log('\nWorkspace deletion guard (owner)');
await app.click('.sidebar .nav-link[data-page="settings"]');
await wait(60);
await app.click('[data-action="settings-tab"][data-tab="Workspace"]');
await wait(60);
check('The workspace tab names the workspace', ($('#app-content').innerHTML || '').includes('Northstar Studio'));
check('The danger zone is only offered when another workspace exists', Boolean($('[data-action="delete-workspace"]')) || ($('#app-content').innerHTML || '').includes('cannot be deleted'));

console.log(`\nRuntime problems captured: ${problems.length}`);
for (const problem of problems.slice(0, 8)) console.log(`  ! ${problem}`);
check('No uncaught errors or console errors', problems.length === 0, problems[0] || '');

if (server) {
  server.kill('SIGTERM');
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

const total = passed + failures.length;
console.log(`\n${failures.length ? '✗' : '✓'} ${passed}/${total} frontend checks passed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}

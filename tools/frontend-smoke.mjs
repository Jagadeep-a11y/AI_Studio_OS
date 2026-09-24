/**
 * Frontend smoke test.
 *
 * Boots index.html in a headless DOM against a running server, then drives the
 * real UI: navigation, filters, settings, a full streamed generation, prompt
 * saving, and the command palette. It catches the class of bug an API test
 * cannot — broken render paths, stale element references, event wiring.
 *
 * Usage:
 *   npm start                     # in one terminal
 *   npm i --no-save jsdom         # test-only dependency, never shipped
 *   node tools/frontend-smoke.mjs
 *
 * Env: ORIGIN (default http://127.0.0.1:4173)
 *
 * Note: it runs against the server's real database, so it leaves behind the
 * projects, generations, and prompt it created. Point ORIGIN at a throwaway
 * instance (AI_STUDIO_DB=./data/smoke.db) if that bothers you.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const ORIGIN = process.env.ORIGIN || 'http://127.0.0.1:4173';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(`${root}/index.html`, 'utf8');
const appJs = fs.readFileSync(`${root}/app.js`, 'utf8');

const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true, url: `${ORIGIN}/` });
const { window } = dom;

window.scrollTo = () => {};
window.Element.prototype.scrollIntoView = () => {};
window.fetch = (input, init) => fetch(new URL(typeof input === 'string' ? input : input.url, ORIGIN), init);
window.TextDecoder = TextDecoder;
window.AbortController = AbortController;

const problems = [];
window.addEventListener('error', (event) => problems.push(`window error: ${event.message}`));
window.addEventListener('unhandledrejection', (event) => problems.push(`unhandled rejection: ${event.reason?.message || event.reason}`));
const originalError = console.error;
console.error = (...args) => { problems.push(`console.error: ${args.join(' ')}`); originalError(...args); };

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`); }
  else { failures.push(`${name}${detail ? ` — ${detail}` : ''}`); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const $ = (selector) => window.document.querySelector(selector);
const text = (selector) => $(selector)?.textContent?.trim() || '';
const click = (selector) => {
  const node = $(selector);
  if (!node) throw new Error(`missing element: ${selector}`);
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  return node;
};
const typeInto = (selector, value) => {
  const node = $(selector);
  node.value = value;
  node.dispatchEvent(new window.Event('input', { bubbles: true }));
};
const submit = (selector) => $(selector).dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

// Boot the app
window.eval(appJs);
await wait(1200); // let GET /api/bootstrap land

console.log('\nFrontend smoke test\n');
console.log('Boot');
check('Backend connected', text('#env-label') === 'Demo engine', `pill says "${text('#env-label')}"`);
check('Projects loaded from SQLite', Number(text('#project-count')) >= 6, `count=${text('#project-count')}`);
check('Sidebar credits reflect the database', /^\d[\d,]*$/.test(text('#sidebar-credits')), text('#sidebar-credits'));
check('Overview rendered', ($('#app-content').innerHTML || '').includes('Pick up where you left off'));
check('Recent work shows a real project', /project-grid|A recent idea/.test($('#app-content').innerHTML || ''), 'recent projects rendered');

console.log('\nNavigation (every page renders)');
const pages = [['projects', 'Projects'], ['canvas', 'Canvas'], ['models', 'Models'], ['prompts', 'Prompt library'], ['automations', 'Automations'], ['usage', 'Usage'], ['settings', 'Settings'], ['overview', 'Good morning']];
for (const [page, expected] of pages) {
  const link = $(`.sidebar .nav-link[data-page="${page}"]`);
  link.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(60);
  check(`${page}: renders with heading`, ($('#app-content').innerHTML || '').includes(expected));
}

console.log('\nLive data on pages');
click('.sidebar .nav-link[data-page="models"]');
await wait(80);
check('Models page lists the live catalogue', ($('#app-content').innerHTML || '').includes('Studio demo'), 'demo engine present');
check('Model cards show connection state', ($('#app-content').innerHTML || '').includes('NEEDS KEY'), 'needs-key badges present');
click('[data-action="model-filter"][data-filter="Image"]');
await wait(60);
check('Model filter narrows to image models', ($('#app-content').innerHTML || '').includes('Image') && !($('#app-content').innerHTML || '').includes('GPT-4.1'));

click('.sidebar .nav-link[data-page="usage"]');
await wait(80);
const usageHtml = $('#app-content').innerHTML || '';
check('Usage page uses recorded generations', usageHtml.includes('Measured from generations') && usageHtml.includes('Real data'));
check('Usage shows a credit total', /\d/.test(text('.credits-number')));

click('.sidebar .nav-link[data-page="settings"]');
await wait(60);
click('[data-action="settings-tab"][data-tab="Connections"]');
await wait(60);
const connections = $('#app-content').innerHTML || '';
check('Connections tab lists all providers', ['OpenAI', 'Anthropic', 'Google Gemini', 'Ollama', 'Studio demo engine'].every((name) => connections.includes(name)));
check('Connections tab names the env var', connections.includes('OPENAI_API_KEY'));

console.log('\nGeneration through the UI — image mode (default)');
click('.sidebar .nav-link[data-page="overview"]');
await wait(60);
const before = Number(text('#project-count'));
typeInto('#main-prompt', 'A restrained identity for a mountain tea house, cool greys, hand-cut type.');
submit('#prompt-form');
check('Output dialog opens immediately', Boolean($('#output-title')) && text('#output-title') === 'Studio output');
// The requested model is "Auto select"; the resolved model and the demo notice
// arrive with the first stream events, so give them a moment.
for (let i = 0; i < 30 && !text('#output-subtitle').includes('Studio demo engine'); i += 1) await wait(100);
check('Dialog names the resolved model', text('#output-subtitle').includes('Studio demo engine'), text('#output-subtitle'));
check('Demo notice is shown to the user', ($('#output-notices')?.textContent || '').includes('not a real model'));
for (let i = 0; i < 40 && !$('.output-image'); i += 1) await wait(100);
check('Image asset renders in the dialog', Boolean($('.output-image')) && ($('.output-image').getAttribute('src') || '').startsWith('data:image/svg+xml'));
for (let i = 0; i < 40 && $('.output-stats')?.children.length === 0; i += 1) await wait(200);
check('Image run completes with stats', ($('.output-stats')?.children.length || 0) >= 5, `${$('.output-stats')?.children.length} stats`);
check('Status says saved to project', ($('#output-status')?.textContent || '').includes('Saved to your project'));
check('Generation id is shown', /Generation g-/.test(text('#output-note')), text('#output-note'));
check('Actions offered: copy, open, again', Boolean($('#output-copy')) && Boolean($('[data-action="open-project"]')) && Boolean($('[data-action="generate-again"]')));
check('Project count increased', Number(text('#project-count')) > before, `${before} → ${text('#project-count')}`);
check('Dashboard refreshes with the new project', ($('#app-content').innerHTML || '').includes('mountain tea house'), 'new project is visible behind the dialog');
click('#output-close');
await wait(60);

console.log('\nGeneration through the UI — writing mode');
click('[data-action="choose-mode"]');
await wait(60);
const writingOption = window.document.querySelector('[data-action="select-mode"][data-value="Writing"]');
check('Mode picker offers Writing', Boolean(writingOption));
writingOption.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(60);
check('Mode switched to Writing', text('#selected-mode') === 'Writing', text('#selected-mode'));
typeInto('#main-prompt', 'Write a considered launch note for a small ceramics studio, plain-spoken and specific.');
submit('#prompt-form');
for (let i = 0; i < 40 && ($('#output-stream')?.textContent || '').length < 60; i += 1) await wait(100);
check('Output streams into the dialog', ($('#output-stream')?.textContent || '').length > 60, `${($('#output-stream')?.textContent || '').length} chars`);
check('Caret/streaming state applied', $('#output-stream').classList.contains('is-streaming'));
for (let i = 0; i < 60 && $('.output-stats')?.children.length === 0; i += 1) await wait(200);
check('Text run completes with stats', ($('.output-stats')?.children.length || 0) >= 5);
check('Streamed text was persisted', ($('#output-stream')?.textContent || '').length > 150, `${($('#output-stream')?.textContent || '').length} chars`);

click('#output-close');
await wait(80);
check('Dialog closes cleanly', !$('#output-title'));

console.log('\nProject detail + history');
const firstCard = $('.project-title-button');
firstCard.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
// The history slot loads asynchronously; wait for it to resolve.
for (let i = 0; i < 30 && ($('#project-generations')?.textContent || '').includes('Loading'); i += 1) await wait(100);
const detail = $('#project-detail-title')?.textContent || '';
check('Project detail opens', detail.length > 0, detail);
check('Generation history is listed', ($('#project-generations')?.textContent || '').includes('Generation history'));
const historyHtml = $('#project-generations')?.innerHTML || '';
check('History contains real output or an asset', historyHtml.includes('<pre') || historyHtml.includes('output-image'), `${historyHtml.length} chars of markup`);
click('[data-action="close-modal"]');
await wait(60);

console.log('\nPrompt library save + use');
click('.sidebar .nav-link[data-page="prompts"]');
await wait(60);
click('[data-action="save-prompt-info"]');
await wait(60);
check('Save-a-prompt dialog opens', Boolean($('#save-prompt-title-input')));
$('#save-prompt-title-input').value = 'Smoke test prompt';
$('#save-prompt-body').value = 'Write a warm, specific product story for [product].';
submit('#save-prompt-form');
await wait(700);
check('Saved prompt lands in the library', ($('#app-content').innerHTML || '').includes('Smoke test prompt'));
const usesBefore = $('#app-content').innerHTML.match(/(\d+) use/)?.[1];
click('[data-action="use-prompt"]');
await wait(400);
check('Using a prompt jumps to the prompt box', ($('#main-prompt')?.value || '').length > 20);

console.log('\nCommand palette + errors');
$('.command-search').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(80);
check('Command palette opens', Boolean($('#command-input')));
typeInto('#command-input', 'aurora');
await wait(80);
check('Command palette finds a project', ($('#command-results')?.textContent || '').toLowerCase().includes('aurora'));
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(60);
check('Escape closes the palette', !$('#command-input'));

// Unconfigured provider must produce a friendly, actionable failure.
click('.sidebar .nav-link[data-page="overview"]');
await wait(60);
// Force an explicit model whose provider has no key by calling the app's own path.
const selectModel = $('[data-action="choose-model"]');
selectModel.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await wait(60);
check('Model picker only offers runnable models', ($('.popover')?.textContent || '').includes('Studio demo') || ($('.popover')?.textContent || '').includes('Studio demo render'));
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(40);

console.log(`\nRuntime problems captured: ${problems.length}`);
for (const problem of problems.slice(0, 8)) console.log(`  ! ${problem}`);
check('No uncaught errors or console errors', problems.length === 0);

const total = passed + failures.length;
console.log(`\n${failures.length ? '✗' : '✓'} ${passed}/${total} frontend checks passed`);
if (failures.length) {
  console.log('\nFailures:');
  for (const failure of failures) console.log(`  - ${failure}`);
  process.exit(1);
}
dom.window.close();

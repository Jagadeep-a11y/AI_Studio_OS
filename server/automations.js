import { newId } from './db.js';
import { buildProjectArchive, buildProjectMarkdown, exportFileName } from './exports.js';
import { AUTOMATION_TEMPLATES } from './seed.js';

/**
 * Automations are chains of steps.
 *
 * The route ("run now"), an event listener, and the scheduler all call
 * `execute()`, so a manual run and a scheduled run produce identical records,
 * identical activity, and identical error handling. If they diverged, the run
 * history would stop being trustworthy — which is the only reason to have one.
 *
 * Four step kinds:
 *   • generate — a model call whose output is kept on the project
 *   • export   — the project as Markdown, or as a zip with its files
 *   • tidy     — archive projects that finished long enough ago to be history
 *   • webhook  — POST the run summary to a host an operator allow-listed
 *
 * A failing step stops the chain and everything after it is recorded as
 * skipped. Half a chain is a result worth recording honestly, not something to
 * paper over by continuing.
 */

export const MAX_STEPS = 5;
const MAX_RETRIES = 3;
const MAX_BACKOFF_MS = 30_000;

/**
 * Retrying is only safe when the failure was the network's idea. A step is
 * retried when the error says it is retryable (the provider helpers and the S3
 * client both mark them), when the status is a rate limit or a server error, or
 * when the message is one of the usual transient shapes. A 400 or a missing key
 * never retries — that would just burn attempts and credits.
 */
export function isTransient(error) {
  if (!error) return false;
  // An explicit verdict from the layer that knows beats any guess made here.
  if (error.retryable === false) return false;
  if (error.retryable === true) return true;
  const status = Number(error.status) || 0;
  if (status === 429 || status >= 500) return true;
  return /rate limit|too many requests|timed? ?out|timeout|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|connection reset|temporarily unavailable|502 bad gateway|503 service/i.test(String(error.message || ''));
}

export const STEP_KINDS = {
  generate: {
    label: 'Generate',
    blurb: 'Run a model and keep the output on the project.',
  },
  export: {
    label: 'Export',
    blurb: 'Write the project out as Markdown, or as a zip with its files.',
  },
  tidy: {
    label: 'Tidy projects',
    blurb: 'Archive the projects that finished long enough ago to be history.',
  },
  webhook: {
    label: 'Webhook',
    blurb: 'POST a JSON run summary to a host this server is allowed to call.',
  },
};

/** Old automations stored an action name; those names still mean the same thing. */
const LEGACY_ACTIONS = {
  'Curate & summarize': [{ action: 'generate' }],
  'Draft a handoff': [{ action: 'generate' }],
  'Prepare a creative brief': [{ action: 'generate' }],
  // The workspace chore that used to report "not in this build" now does it.
  'Organize projects': [{ action: 'tidy', options: { afterDays: 60 } }],
};

/**
 * Turns whatever is stored on an automation into a validated step list.
 * Returns an error string rather than throwing so the route can answer 400.
 */
export function normalizeSteps({ steps, action } = {}) {
  const inherited = LEGACY_ACTIONS[String(action || '').trim()];
  const source = Array.isArray(steps) && steps.length
    ? steps
    : (inherited || (STEP_KINDS[String(action || '').trim()] ? [{ action }] : []));
  if (!source.length) return { steps: [], error: 'An automation needs at least one step' };
  if (source.length > MAX_STEPS) return { steps: [], error: `An automation can run at most ${MAX_STEPS} steps` };

  const out = [];
  for (const [index, raw] of source.entries()) {
    const name = String(raw?.action || raw?.kind || '').trim();
    if (!STEP_KINDS[name]) {
      return { steps: [], error: `“${name || 'Unnamed step'}” is not a step this server can run (step ${index + 1})` };
    }
    const options = raw?.options && typeof raw.options === 'object' ? { ...raw.options } : {};
    if (name === 'webhook' && !String(options.url || '').trim()) {
      return { steps: [], error: 'A webhook step needs a URL' };
    }
    if (name === 'export' && options.format && !['markdown', 'zip'].includes(options.format)) {
      return { steps: [], error: 'An export step can only produce markdown or zip' };
    }
    out.push({ action: name, ...(Object.keys(options).length ? { options } : {}) });
  }
  return { steps: out };
}

/** The step list an automation will actually run, stored or inherited. */
export function stepsOf(automation) {
  const stored = Array.isArray(automation?.steps) ? automation.steps.filter((step) => STEP_KINDS[step?.action]) : [];
  if (stored.length) return stored;
  return normalizeSteps({ action: automation?.action }).steps;
}

export function createAutomationRunner({ store, gateway, files, webhooks, logger = console }) {
  const templates = AUTOMATION_TEMPLATES;

  /**
   * Runs one step, retrying transient failures with exponential backoff. The
   * attempt count travels with the result so the run log says "attempt 3"
   * instead of quietly looking like a slow success.
   */
  async function withRetry(attempt, step, { onWait } = {}) {
    const retries = Math.min(MAX_RETRIES, Math.max(0, Number(step?.options?.retries ?? (['generate', 'webhook'].includes(step?.action) ? 2 : 0)) || 0));
    const base = Math.min(MAX_BACKOFF_MS, Math.max(0, Number(step?.options?.backoffMs ?? 400) || 0));
    let lastError;
    for (let attemptNumber = 0; attemptNumber <= retries; attemptNumber += 1) {
      try {
        const result = await attempt();
        return { ...result, attempts: attemptNumber + 1 };
      } catch (error) {
        lastError = error;
        if (attemptNumber === retries || !isTransient(error)) throw error;
        const wait = Math.round(base * 2 ** attemptNumber);
        onWait?.({ attempt: attemptNumber + 2, wait, error });
        logger.warn?.(`⟳ retrying ${step.action} in ${wait}ms after: ${error.message}`);
        if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
    throw lastError;
  }

  const promptFor = (automation, step, project) => {
    const explicit = String(step?.options?.prompt || '').trim();
    if (explicit) return explicit;
    const template = templates[automation.action];
    if (template?.buildPrompt) return template.buildPrompt({ project });
    return `Write a short, useful studio note about the project “${project?.title || 'Untitled project'}”. Two paragraphs at most, with a clear next action.`;
  };

  /**
   * One step. Each returns a small result the run log shows verbatim, and throws
   * on failure so the chain stops in one place.
   */
  const runStep = {
    async generate({ automation, step, project, data, signal }) {
      const prompt = promptFor(automation, step, project);
      let accumulated = '';
      let summary = null;
      let failure = null;
      for await (const event of gateway.run({ selection: 'Auto select', prompt, mode: 'Writing', kind: 'text', signal: signal || undefined })) {
        if (event.type === 'delta') accumulated += event.text;
        if (event.type === 'summary') summary = event;
        if (event.type === 'error') failure = event;
      }
      if (failure) throw new Error(failure.message);

      let generationId = null;
      if (summary) {
        generationId = newId('g');
        data.createGeneration({
          id: generationId,
          projectId: project?.id || null,
          provider: summary.provider,
          modelId: summary.modelId,
          modelLabel: summary.modelLabel,
          kind: 'text',
          mode: 'Writing',
          prompt,
          status: 'streaming',
        });
        data.finishGeneration(generationId, {
          output: accumulated,
          status: 'succeeded',
          tokensIn: summary.tokensIn,
          tokensOut: summary.tokensOut,
          credits: summary.credits,
          costUsd: summary.costUsd,
          latencyMs: summary.latencyMs,
        });
        if (project) data.recordOutput(project.id, { count: 1 });
      }
      return {
        status: 'succeeded',
        message: `Generated ${accumulated.length} characters with ${summary?.modelLabel || 'the demo engine'}`,
        generationId,
        output: accumulated,
        isDemo: Boolean(summary?.isDemo),
        model: summary?.modelLabel || '',
      };
    },

    async export({ step, project, data }) {
      if (!project) throw new Error('There is no project to export yet');
      const format = step?.options?.format === 'zip' ? 'zip' : 'markdown';
      const generations = data.listGenerations({ projectId: project.id, limit: 50 });
      const filesForProject = data.filesForProject(project.id, 200);
      const scoped = files?.forWorkspace(data);

      if (format === 'markdown') {
        const markdown = buildProjectMarkdown({ project, generations, files: filesForProject });
        const stored = await scoped.write({
          name: exportFileName(project, 'md'),
          mime: 'text/markdown',
          buffer: Buffer.from(markdown, 'utf8'),
          kind: 'export',
          projectId: project.id,
          excerpt: markdown.slice(0, 400),
        });
        return {
          status: 'succeeded',
          message: `Exported “${project.title}” as ${stored.name} (${generations.length} generation${generations.length === 1 ? '' : 's'})`,
          fileId: stored.id,
          files: [stored],
        };
      }

      const archive = await buildProjectArchive({
        project,
        generations,
        files: filesForProject,
        read: (row) => scoped.read(row),
      });
      const stored = await scoped.write({
        name: exportFileName(project, 'zip'),
        mime: 'application/zip',
        buffer: archive.buffer,
        kind: 'export',
        projectId: project.id,
        excerpt: `Zip export of “${project.title}”: ${archive.entryCount} entries.`,
      });
      const skipped = archive.skipped.length ? ` · ${archive.skipped.length} skipped` : '';
      return {
        status: 'succeeded',
        message: `Exported “${project.title}” as ${stored.name} (${archive.entryCount} entries${skipped})`,
        fileId: stored.id,
        files: [stored],
      };
    },

    async tidy({ step, data }) {
      const afterDays = Math.min(3650, Math.max(1, Number(step?.options?.afterDays) || 60));
      const statuses = Array.isArray(step?.options?.statuses) && step.options.statuses.length
        ? step.options.statuses.map((value) => String(value))
        : ['Completed', 'Complete', 'Published'];
      const dryRun = Boolean(step?.options?.dryRun);
      const cutoff = Date.now() - afterDays * 86_400_000;

      const candidates = data.listProjects()
        .filter((project) => !project.archived)
        .filter((project) => statuses.includes(project.status))
        .filter((project) => new Date(project.updatedAt || project.createdAt || 0).getTime() < cutoff)
        .slice(0, 10);

      if (!candidates.length) {
        return { status: 'skipped', message: `Nothing to tidy — no ${statuses.join('/').toLowerCase()} project has been untouched for ${afterDays} days` };
      }
      const titles = candidates.map((project) => project.title);
      if (!dryRun) for (const project of candidates) data.archiveProject(project.id);
      return {
        status: 'succeeded',
        message: `${dryRun ? 'Would archive' : 'Archived'} ${candidates.length} project${candidates.length === 1 ? '' : 's'}: ${titles.join(', ').slice(0, 160)}`,
        archived: dryRun ? [] : titles,
      };
    },

    async webhook({ automation, step, project, data, runId, source, steps, produced }) {
      const url = String(step?.options?.url || '').trim();
      const event = String(step?.options?.event || 'automation.run');
      const settings = data.getSettings();
      const payload = {
        event,
        generatedAt: new Date().toISOString(),
        workspace: { id: data.workspaceId, name: settings.workspace || '' },
        automation: { id: automation.id, name: automation.name, source },
        runId,
        project: project ? { id: project.id, title: project.title, status: project.status, outputs: project.outputs } : null,
        steps: steps.map((record) => ({ action: record.action, status: record.status, message: record.message })),
        files: produced.map((file) => ({ id: file.id, name: file.name, size: file.size, url: file.url })),
      };
      const result = await webhooks.send({ url, event, payload });
      return { status: 'succeeded', message: `Posted the run summary to ${result.hostname} (${result.status} in ${result.ms}ms)` };
    },
  };

  /**
   * Run one automation start to finish. `data` is a workspace-scoped store;
   * every caller passes one, so a run writes into the workspace that owns the
   * automation and nowhere else.
   */
  async function execute({ automation, source = 'manual', project = null, signal = null, data }) {
    const steps = stepsOf(automation);
    const target = project || data.listProjects()[0] || null;

    if (!steps.length) {
      const runId = recordRun(data, automation, { source, status: 'skipped', note: 'No runnable step' });
      return {
        status: 'skipped',
        message: `“${automation.name}” has no steps this server can run, so nothing was written.`,
        generation: null,
        output: '',
        isDemo: false,
        runId,
        steps: [],
      };
    }

    const runId = data.startAutomationRun({ automationId: automation.id, note: `${source}: ${steps.map((step) => step.action).join(' → ')}` });
    const records = [];
    const produced = [];
    let output = '';
    let lastGenerationId = null;
    let isDemo = false;
    let failure = null;

    for (const [index, step] of steps.entries()) {
      if (failure) {
        records.push({ index, action: step.action, status: 'skipped', message: 'Skipped after the previous step failed', ms: 0 });
        data.recordStepRun({ runId, automationId: automation.id, index, action: step.action, status: 'skipped', message: 'Skipped after the previous step failed', ms: 0, attempts: 0 });
        continue;
      }
      const started = Date.now();
      let record;
      const notes = [];
      try {
        const result = await withRetry(
          () => runStep[step.action]({ automation, step, project: target, data, signal, runId, source, steps: records, produced, files }),
          step,
          { onWait: ({ attempt: next, wait, error }) => notes.push(`attempt ${next} in ${wait}ms (${error.message.slice(0, 80)})`) },
        );
        record = {
          index,
          action: step.action,
          status: result.status,
          message: notes.length ? `${result.message} · retried after ${notes.join(', ')}` : result.message,
          ms: Date.now() - started,
          attempts: result.attempts || 1,
          generationId: result.generationId || null,
          fileId: result.fileId || null,
        };
        if (result.output) output = result.output;
        if (result.generationId) lastGenerationId = result.generationId;
        if (result.isDemo) isDemo = true;
        if (result.files?.length) produced.push(...result.files);
      } catch (error) {
        failure = { index, action: step.action, message: error.message, hint: error.hint, code: error.code };
        record = {
          index,
          action: step.action,
          status: 'failed',
          message: error.message,
          hint: error.hint || null,
          ms: Date.now() - started,
          attempts: notes.length + 1,
        };
      }
      records.push(record);
      data.recordStepRun({
        runId,
        automationId: automation.id,
        index,
        action: record.action,
        status: record.status,
        message: record.message,
        ms: record.ms,
        attempts: record.attempts || 1,
        generationId: record.generationId || null,
        fileId: record.fileId || null,
      });
    }

    const status = failure ? 'failed' : (records.every((record) => record.status === 'skipped') ? 'skipped' : 'succeeded');
    const done = records.filter((record) => record.status === 'succeeded').length;
    data.finishAutomationRun(runId, {
      status,
      generationId: lastGenerationId,
      note: `${source}: ${records.map((record) => `${record.action} ${record.status}`).join(', ')}`,
    });

    if (failure) {
      data.addActivity({
        icon: 'close',
        tone: 'orange',
        line: `<strong>${escapeForActivity(automation.name)}</strong> stopped at step ${failure.index + 1} (${escapeForActivity(failure.action)})`,
        project: target?.title || '',
      });
      return {
        status: 'failed',
        message: `${failure.action} failed: ${failure.message}`,
        hint: failure.hint || null,
        generation: lastGenerationId ? data.getGeneration(lastGenerationId) : null,
        output,
        isDemo,
        runId,
        steps: records,
        files: produced,
        projectId: target?.id || null,
      };
    }

    data.addActivity({
      icon: 'workflow',
      tone: 'green',
      line: `<strong>${escapeForActivity(automation.name)}</strong> ran ${records.length} step${records.length === 1 ? '' : 's'}${isDemo ? ' in demo mode' : ''}`,
      project: target?.title || '',
    });

    // The run message says what actually happened, not just that something did:
    // a single-step run reads as the step, a chain lists each step's outcome.
    const summary = records.map((record) => record.message).filter(Boolean).join(' · ').slice(0, 400);
    return {
      status,
      message: status === 'skipped'
        ? `“${automation.name}” had nothing to do: ${summary || 'every step reported nothing to do'}.`
        : (records.length === 1
          ? `“${automation.name}”: ${summary || 'finished'}.`
          : `“${automation.name}” finished ${done} step${done === 1 ? '' : 's'}${isDemo ? ' in demo mode' : ''} — ${summary}`),
      generation: lastGenerationId ? data.getGeneration(lastGenerationId) : null,
      output,
      isDemo,
      runId,
      steps: records,
      files: produced,
      projectId: target?.id || null,
    };
  }

  function recordRun(data, automation, { source, status, note }) {
    const runId = data.startAutomationRun({ automationId: automation.id, note });
    data.finishAutomationRun(runId, { status, note });
    return runId;
  }

  return {
    execute,
    stepsOf,
    templates: Object.keys(templates),
    /** For the UI: which steps this server can offer, and which it cannot. */
    catalog: () => Object.entries(STEP_KINDS).map(([id, kind]) => ({
      id,
      label: kind.label,
      blurb: kind.blurb,
      available: id === 'webhook' ? (webhooks?.patterns?.length || 0) > 0 : true,
    })),
    webhooksEnabled: () => (webhooks?.patterns?.length || 0) > 0,
  };
}

const escapeForActivity = (value) => String(value ?? '')
  .replace(/<[^>]*>/g, '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

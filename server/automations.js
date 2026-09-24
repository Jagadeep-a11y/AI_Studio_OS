import { AUTOMATION_TEMPLATES } from './seed.js';

/**
 * One place where an automation actually does its work.
 *
 * The route ("run now"), the event listener, and the scheduler all call
 * `execute()`, so a manual run and a scheduled run produce identical records,
 * identical activity, and identical error handling. If they diverged, the run
 * history would stop being trustworthy — which is the only reason to have one.
 */
export function createAutomationRunner({ store, gateway }) {
  async function execute({ automation, source = 'manual', project = null, signal = null }) {
    const template = AUTOMATION_TEMPLATES[automation.action];

    // Workspace chores have no generator step yet: say so instead of pretending.
    if (!template || template.kind === 'navigate') {
      store.recordAutomationRun({
        automationId: automation.id,
        status: 'skipped',
        note: 'Workspace chore — no generator step in this build.',
      });
      return {
        status: 'skipped',
        message: `“${automation.name}” is a workspace chore with no generator step in this build, so nothing was written. Pick one of the generating actions to get output.`,
        generation: null,
        output: '',
        isDemo: false,
      };
    }

    const target = project || store.listProjects()[0] || null;
    const prompt = template.buildPrompt({ project: target });
    const started = Date.now();
    let accumulated = '';
    let summary = null;
    let failure = null;

    try {
      for await (const event of gateway.run({ selection: 'Auto select', prompt, mode: 'Writing', kind: 'text', signal: signal || undefined })) {
        if (event.type === 'delta') accumulated += event.text;
        if (event.type === 'summary') summary = event;
        if (event.type === 'error') failure = event;
      }
      if (failure) throw new Error(failure.message);
    } catch (error) {
      const runId = store.recordAutomationRun({ automationId: automation.id, status: 'failed', note: `${source}: ${error.message}` });
      store.addActivity({
        icon: 'close',
        tone: 'orange',
        line: `<strong>${escapeForActivity(automation.name)}</strong> failed on its ${source} run`,
        project: target?.title || '',
      });
      return { status: 'failed', message: error.message, generation: null, output: accumulated, isDemo: false, runId };
    }

    const generationId = `g-${Date.now().toString(36)}-auto`;
    if (summary) {
      store.createGeneration({
        id: generationId,
        projectId: target?.id || null,
        provider: summary.provider,
        modelId: summary.modelId,
        modelLabel: summary.modelLabel,
        kind: 'text',
        mode: 'Writing',
        prompt,
        status: 'streaming',
      });
      store.finishGeneration(generationId, {
        output: accumulated,
        status: 'succeeded',
        tokensIn: summary.tokensIn,
        tokensOut: summary.tokensOut,
        credits: summary.credits,
        costUsd: summary.costUsd,
        latencyMs: summary.latencyMs || Date.now() - started,
      });
      if (target) store.recordOutput(target.id, { count: 1 });
    }

    const runId = store.recordAutomationRun({
      automationId: automation.id,
      generationId: summary ? generationId : null,
      status: 'succeeded',
      note: `${source}: ${prompt.slice(0, 160)}`,
    });

    store.addActivity({
      icon: 'workflow',
      tone: 'green',
      line: `<strong>${escapeForActivity(automation.name)}</strong> ran ${summary?.isDemo ? 'in demo mode' : 'successfully'}`,
      project: target?.title || '',
    });

    return {
      status: 'succeeded',
      generation: summary ? store.getGeneration(generationId) : null,
      output: accumulated,
      isDemo: Boolean(summary?.isDemo),
      model: summary?.modelLabel || '',
      runId,
      projectId: target?.id || null,
      message: `“${automation.name}” finished${summary?.isDemo ? ' in demo mode' : ''}.`,
    };
  }

  return { execute, templates: Object.keys(AUTOMATION_TEMPLATES) };
}

const escapeForActivity = (value) => String(value ?? '')
  .replace(/<[^>]*>/g, '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

import { nextOccurrence } from './schedule.js';

/**
 * The scheduler.
 *
 * A single timer, a single in-flight guard, and a claim-then-run pattern:
 *
 *   1. find automations whose `next_run_at` has passed
 *   2. move `next_run_at` forward *before* running, so a slow run or a restart
 *      mid-run can never double-fire the same window
 *   3. run it through the same executor the Run-now button uses
 *   4. schedule the next occurrence from the moment the run finishes
 *
 * Two policies worth stating out loud:
 *
 *   • No backfill. A server that was off for a week runs a due workflow once,
 *     then resumes its normal cadence — never a burst of catch-up runs.
 *   • Failures back off, they do not storm. A failed run moves the next attempt
 *     out by the backoff window instead of retrying immediately.
 */
export function createScheduler({ store, accounts, runner, config, logger = console }) {
  const { enabled, tickMs, maxPerTick, backoffMs } = config.scheduler;
  const state = {
    enabled,
    running: false,
    ticking: false,
    startedAt: null,
    lastTickAt: null,
    lastResult: null,
    ticks: 0,
    runs: 0,
    failures: 0,
    timer: null,
  };

  const isoOf = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

  /**
   * Every workspace runs its own clock. The scheduler walks them in turn:
   * one slow provider in one workspace cannot hold up another workspace's
   * schedules, and the per-tick ceiling applies to each of them separately.
   */
  const activeWorkspaces = () => {
    const ids = store.db.prepare('SELECT DISTINCT workspace_id AS id FROM automations WHERE workspace_id IS NOT NULL').all();
    return ids.map((row) => store.forWorkspace(row.id)).filter((data) => data.workspaceId);
  };

  async function runOne(data, automation, dueAt) {
    // Claim the window first: if anything below throws, the schedule still moved.
    const timeZone = () => data.getSettings().timezone || 'UTC';

    data.setNextRun(automation.id, isoOf(Date.now() + backoffMs));
    state.running = true;
    const started = Date.now();
    try {
      const result = await runner.execute({ automation, source: 'scheduled', data });
      const finishedAt = Date.now();
      const next = nextOccurrence(automation.schedule, finishedAt, timeZone());
      data.setNextRun(automation.id, isoOf(next));

      if (result.status === 'failed') {
        state.failures += 1;
        logger.warn(`⟳ “${automation.name}” failed after ${finishedAt - started}ms: ${result.message}`);
      } else if (result.status === 'skipped') {
        logger.log(`⟳ “${automation.name}” skipped (no generator step)`);
      } else {
        state.runs += 1;
        logger.log(`⟳ “${automation.name}” ran in ${finishedAt - started}ms${result.isDemo ? ' (demo engine)' : ''}`);
      }
      return { automation: automation.name, workspace: data.workspaceId, dueAt, status: result.status, next: isoOf(next) };
    } catch (error) {
      state.failures += 1;
      const next = nextOccurrence(automation.schedule, Date.now() + backoffMs, timeZone());
      data.setNextRun(automation.id, isoOf(next));
      logger.error(`⟳ “${automation.name}” threw: ${error.message}`);
      return { automation: automation.name, workspace: data.workspaceId, dueAt, status: 'error', message: error.message, next: isoOf(next) };
    } finally {
      state.running = false;
    }
  }

  /** Runs every automation whose window has passed. Safe to call concurrently. */
  async function tickOnce({ reason = 'timer' } = {}) {
    if (state.ticking) return state.lastResult;
    state.ticking = true;
    state.ticks += 1;
    state.lastTickAt = new Date().toISOString();
    const outcomes = [];
    let dueCount = 0;
    try {
      for (const data of activeWorkspaces()) {
        const due = data.dueAutomations(new Date().toISOString(), maxPerTick);
        dueCount += due.length;
        for (const automation of due) {
          if (!automation.schedule || !['interval', 'daily', 'monthly'].includes(automation.schedule.type)) {
            // Event-driven or manual rows should not hold a clock at all.
            data.setNextRun(automation.id, null);
            continue;
          }
          outcomes.push(await runOne(data, automation, automation.nextRunAt));
        }
      }
      state.lastResult = { reason, due: dueCount, outcomes, at: state.lastTickAt };
      return state.lastResult;
    } finally {
      state.ticking = false;
    }
  }

  function start() {
    if (!enabled || state.timer) return state;
    state.startedAt = new Date().toISOString();
    state.timer = setInterval(() => {
      tickOnce().catch((error) => logger.error('Scheduler tick failed:', error.message));
    }, tickMs);
    // Never hold the process open just to poll a schedule.
    if (typeof state.timer.unref === 'function') state.timer.unref();
    logger.log(`Scheduler running every ${tickMs < 1000 ? `${tickMs}ms` : `${Math.round(tickMs / 1000)}s`}`);
    return state;
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.startedAt = null;
  }

  /** Status shown in Settings → Connections. */
  function status(workspaceId = null) {
    const data = workspaceId ? store.forWorkspace(workspaceId) : null;
    const next = data
      ? data.scheduledAutomations()
        .filter((automation) => automation.nextRunAt && automation.enabled)
        .sort((a, b) => String(a.nextRunAt).localeCompare(String(b.nextRunAt)))[0] || null
      : null;
    return {
      enabled,
      active: Boolean(state.timer),
      tickMs,
      timeZone: data ? (data.getSettings().timezone || 'UTC') : 'UTC',
      workspaces: activeWorkspaces().length,
      startedAt: state.startedAt,
      lastTickAt: state.lastTickAt,
      lastResult: state.lastResult,
      counts: { ticks: state.ticks, runs: state.runs, failures: state.failures },
      nextAutomation: next ? { id: next.id, name: next.name, nextRunAt: next.nextRunAt } : null,
    };
  }

  return {
    start,
    stop,
    tickOnce,
    status,
    /** Exposed for tests: what would this schedule do next, in this workspace? */
    scheduleOf: (schedule, fromMs, timeZone = 'UTC') => nextOccurrence(schedule, fromMs, timeZone),
  };
}

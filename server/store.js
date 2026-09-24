import {
  activityFromRow,
  automationFromRow,
  generationFromRow,
  newId,
  nowIso,
  projectFromRow,
  promptFromRow,
} from './db.js';

/**
 * Data access. Routes call these helpers so SQL stays in one layer and the
 * HTTP handlers read like the product, not like a database driver.
 */
export function createStore(db) {
  const statements = {
    projectsAll: db.prepare('SELECT * FROM projects WHERE archived = 0 ORDER BY updated_at DESC'),
    projectsIncludingArchived: db.prepare('SELECT * FROM projects ORDER BY updated_at DESC'),
    projectOne: db.prepare('SELECT * FROM projects WHERE id = ?'),
    projectInsert: db.prepare(`INSERT INTO projects (id, title, type, model, status, prompt, art, outputs, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    projectUpdate: db.prepare('UPDATE projects SET title = ?, type = ?, model = ?, status = ?, prompt = ?, art = ?, archived = ?, updated_at = ? WHERE id = ?'),
    projectTouch: db.prepare('UPDATE projects SET updated_at = ? WHERE id = ?'),
    projectOutputs: db.prepare('UPDATE projects SET outputs = outputs + ?, status = ?, updated_at = ? WHERE id = ?'),

    promptsAll: db.prepare('SELECT * FROM prompts ORDER BY uses DESC'),
    promptOne: db.prepare('SELECT * FROM prompts WHERE id = ?'),
    promptInsert: db.prepare('INSERT INTO prompts (id, title, category, icon, mode, body, uses, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)'),
    promptUse: db.prepare('UPDATE prompts SET uses = uses + 1 WHERE id = ?'),

    automationsAll: db.prepare('SELECT * FROM automations ORDER BY created_at DESC'),
    automationOne: db.prepare('SELECT * FROM automations WHERE id = ?'),
    automationInsert: db.prepare(`INSERT INTO automations (id, name, description, trigger, action, last_run, enabled, tone, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    automationUpdate: db.prepare('UPDATE automations SET name = ?, description = ?, trigger = ?, action = ?, enabled = ?, tone = ?, last_run = ? WHERE id = ?'),
    automationLastRun: db.prepare('UPDATE automations SET last_run = ? WHERE id = ?'),
    lastRunFor: db.prepare('SELECT created_at FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 1'),
    runInsert: db.prepare('INSERT INTO automation_runs (id, automation_id, generation_id, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    runsFor: db.prepare('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT ?'),

    activityAll: db.prepare('SELECT * FROM activity ORDER BY created_at DESC, id DESC LIMIT ?'),
    activityInsert: db.prepare('INSERT INTO activity (icon, tone, line, project, created_at) VALUES (?, ?, ?, ?, ?)'),

    settingsAll: db.prepare('SELECT key, value FROM settings'),
    settingUpsert: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),

    generationInsert: db.prepare(`INSERT INTO generations
      (id, project_id, provider, model_id, model_label, kind, mode, prompt, output, asset_url, status, error, tokens_in, tokens_out, credits, cost_usd, latency_ms, created_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    generationOne: db.prepare('SELECT * FROM generations WHERE id = ?'),
    generationByProject: db.prepare('SELECT * FROM generations WHERE project_id = ? ORDER BY created_at DESC LIMIT ?'),
    generationRecent: db.prepare('SELECT * FROM generations ORDER BY created_at DESC LIMIT ?'),
    generationFinish: db.prepare(`UPDATE generations SET output = ?, asset_url = ?, status = ?, error = ?, tokens_in = ?, tokens_out = ?, credits = ?, cost_usd = ?, latency_ms = ?, finished_at = ? WHERE id = ?`),

    totals: db.prepare(`SELECT COUNT(*) AS generations, COALESCE(SUM(tokens_in),0) AS tokensIn, COALESCE(SUM(tokens_out),0) AS tokensOut,
      COALESCE(SUM(credits),0) AS credits, COALESCE(SUM(cost_usd),0) AS costUsd, COALESCE(AVG(NULLIF(latency_ms,0)),0) AS avgLatency
      FROM generations WHERE status IN ('succeeded','failed')`),
    successCount: db.prepare(`SELECT COUNT(*) AS count FROM generations WHERE status = 'succeeded'`),
    byProvider: db.prepare(`SELECT provider, COUNT(*) AS count, COALESCE(SUM(credits),0) AS credits, COALESCE(SUM(cost_usd),0) AS costUsd
      FROM generations WHERE status = 'succeeded' GROUP BY provider ORDER BY credits DESC`),
    byKind: db.prepare(`SELECT kind, COUNT(*) AS count, COALESCE(SUM(credits),0) AS credits
      FROM generations WHERE status = 'succeeded' GROUP BY kind ORDER BY credits DESC`),
    daily: db.prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count, COALESCE(SUM(credits),0) AS credits
      FROM generations WHERE status = 'succeeded' AND created_at >= ? GROUP BY day ORDER BY day ASC`),
  };

  const touchProject = (id, iso = nowIso()) => {
    if (!id) return;
    statements.projectTouch.run(iso, id);
  };

  return {
    db,

    // --- Projects -----------------------------------------------------------
    listProjects({ includeArchived = false } = {}) {
      const rows = includeArchived ? statements.projectsIncludingArchived.all() : statements.projectsAll.all();
      return rows.map(projectFromRow);
    },
    getProject(id) {
      return projectFromRow(statements.projectOne.get(id));
    },
    createProject({ title, type = 'Campaign', model = 'Auto select', status = 'Draft', prompt = '', art = null, outputs = 0 }) {
      const cleanTitle = String(title || '').trim().slice(0, 120) || 'Untitled project';
      const project = {
        id: newId('p'),
        title: cleanTitle,
        type,
        model,
        status,
        prompt: String(prompt || '').slice(0, 4000),
        art: art || artForType(type),
        outputs,
      };
      const iso = nowIso();
      statements.projectInsert.run(project.id, project.title, project.type, project.model, project.status, project.prompt, project.art, project.outputs, iso, iso);
      return this.getProject(project.id);
    },
    updateProject(id, patch = {}) {
      const existing = this.getProject(id);
      if (!existing) return null;
      const merged = { ...existing, ...definedOnly(patch) };
      statements.projectUpdate.run(
        merged.title, merged.type, merged.model, merged.status, merged.prompt || '',
        merged.art || artForType(merged.type), merged.archived ? 1 : 0, nowIso(), id,
      );
      return this.getProject(id);
    },
    duplicateProject(id) {
      const source = this.getProject(id);
      if (!source) return null;
      return this.createProject({
        title: `${source.title} (copy)`,
        type: source.type,
        model: source.model,
        status: source.status === 'Completed' ? 'In progress' : source.status,
        prompt: source.prompt,
        art: source.art,
        outputs: 0,
      });
    },
    archiveProject(id) {
      const project = this.getProject(id);
      if (!project) return null;
      statements.projectUpdate.run(
        project.title, project.type, project.model, project.status, project.prompt || '',
        project.art || artForType(project.type), 1, nowIso(), id,
      );
      return true;
    },
    recordOutput(projectId, { count = 1, status } = {}) {
      if (!projectId) return;
      const project = this.getProject(projectId);
      if (!project) return;
      statements.projectOutputs.run(count, status || project.status, nowIso(), projectId);
    },
    touchProject,

    // --- Generations --------------------------------------------------------
    createGeneration(record) {
      const iso = nowIso();
      statements.generationInsert.run(
        record.id, record.projectId || null, record.provider, record.modelId, record.modelLabel,
        record.kind, record.mode || 'Writing', record.prompt, '', null, record.status || 'streaming',
        null, 0, 0, 0, 0, 0, iso, null,
      );
      return this.getGeneration(record.id);
    },
    getGeneration(id) {
      return generationFromRow(statements.generationOne.get(id));
    },
    finishGeneration(id, patch = {}) {
      const current = this.getGeneration(id);
      if (!current) return null;
      statements.generationFinish.run(
        patch.output ?? current.output ?? '',
        patch.assetUrl ?? current.assetUrl ?? null,
        patch.status || 'succeeded',
        patch.error || null,
        patch.tokensIn ?? current.tokensIn ?? 0,
        patch.tokensOut ?? current.tokensOut ?? 0,
        patch.credits ?? current.credits ?? 0,
        patch.costUsd ?? current.costUsd ?? 0,
        patch.latencyMs ?? current.latencyMs ?? 0,
        nowIso(),
        id,
      );
      return this.getGeneration(id);
    },
    listGenerations({ projectId = null, limit = 25 } = {}) {
      const rows = projectId ? statements.generationByProject.all(projectId, limit) : statements.generationRecent.all(limit);
      return rows.map(generationFromRow);
    },

    // --- Prompts ------------------------------------------------------------
    listPrompts() {
      return statements.promptsAll.all().map(promptFromRow);
    },
    getPrompt(id) {
      return promptFromRow(statements.promptOne.get(id));
    },
    incrementPromptUses(id) {
      statements.promptUse.run(id);
      return this.getPrompt(id);
    },
    createPrompt({ title, category = 'My prompts', mode = 'Writing', body, icon = 'sparkles' }) {
      const id = newId('p');
      statements.promptInsert.run(id, String(title || 'Untitled prompt').slice(0, 120), category, icon, mode, String(body || '').slice(0, 4000), nowIso());
      return this.getPrompt(id);
    },

    // --- Automations --------------------------------------------------------
    listAutomations() {
      return statements.automationsAll.all().map((row) => {
        const lastRun = statements.lastRunFor.get(row.id);
        return automationFromRow(row, lastRun ? lastRun.created_at : null);
      });
    },
    getAutomation(id) {
      const row = statements.automationOne.get(id);
      if (!row) return null;
      const lastRun = statements.lastRunFor.get(row.id);
      return automationFromRow(row, lastRun ? lastRun.created_at : null);
    },
    createAutomation({ name, description = '', trigger = 'On demand', action = 'Curate & summarize', enabled = true, tone = 'purple' }) {
      const id = newId('a');
      statements.automationInsert.run(id, String(name || 'Untitled automation').slice(0, 120), description, trigger, action, 'Not run yet', enabled ? 1 : 0, tone, nowIso());
      return this.getAutomation(id);
    },
    updateAutomation(id, patch = {}) {
      const current = this.getAutomation(id);
      if (!current) return null;
      const merged = { ...current, ...definedOnly(patch) };
      statements.automationUpdate.run(
        merged.name, merged.description, merged.trigger, merged.action,
        merged.enabled ? 1 : 0, merged.tone || 'purple', merged.lastRun || 'Not run yet', id,
      );
      return this.getAutomation(id);
    },
    recordAutomationRun({ automationId, generationId = null, status = 'succeeded', note = '' }) {
      statements.runInsert.run(newId('run'), automationId, generationId, status, note, nowIso());
      statements.automationLastRun.run(nowIso(), automationId);
    },
    listAutomationRuns(automationId, limit = 5) {
      return statements.runsFor.all(automationId, limit).map((row) => ({
        id: row.id,
        automationId: row.automation_id,
        generationId: row.generation_id,
        status: row.status,
        note: row.note,
        created: row.created_at,
      }));
    },

    // --- Activity -----------------------------------------------------------
    listActivity(limit = 8) {
      return statements.activityAll.all(limit).map(activityFromRow);
    },
    addActivity({ icon = 'sparkles', tone = '', line, project = '' }) {
      statements.activityInsert.run(icon, tone, String(line || '').slice(0, 400), project, nowIso());
      return this.listActivity(8);
    },

    // --- Settings -----------------------------------------------------------
    getSettings() {
      const settings = {};
      for (const row of statements.settingsAll.all()) settings[row.key] = row.value;
      return settings;
    },
    saveSettings(patch = {}) {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null) continue;
        statements.settingUpsert.run(String(key), String(value).slice(0, 400));
      }
      return this.getSettings();
    },

    // --- Usage --------------------------------------------------------------
    usageSummary({ creditsIncluded = 10_000, days = 7 } = {}) {
      const totals = statements.totals.get();
      const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
      const daily = statements.daily.all(sinceIso);
      const byDay = new Map(daily.map((row) => [row.day, row]));
      const series = [];
      for (let offset = days - 1; offset >= 0; offset -= 1) {
        const date = new Date(Date.now() - offset * 86_400_000);
        const key = date.toISOString().slice(0, 10);
        const row = byDay.get(key);
        series.push({
          day: key,
          label: new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(date).slice(0, 1),
          count: row?.count || 0,
          credits: Math.round(row?.credits || 0),
        });
      }
      const creditsUsed = Math.round(totals.credits || 0);
      return {
        plan: {
          name: 'Studio plan',
          creditsIncluded,
          creditsUsed,
          creditsRemaining: Math.max(0, creditsIncluded - creditsUsed),
          renewsOn: new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 10),
        },
        totals: {
          generations: totals.generations || 0,
          succeeded: statements.successCount.get().count || 0,
          tokensIn: totals.tokensIn || 0,
          tokensOut: totals.tokensOut || 0,
          credits: creditsUsed,
          costUsd: Number((totals.costUsd || 0).toFixed(4)),
          avgLatencyMs: Math.round(totals.avgLatency || 0),
        },
        byProvider: statements.byProvider.all().map((row) => ({ provider: row.provider, count: row.count, credits: Math.round(row.credits), costUsd: Number(row.costUsd.toFixed(4)) })),
        byKind: statements.byKind.all().map((row) => ({ kind: row.kind, count: row.count, credits: Math.round(row.credits) })),
        daily: series,
        recent: this.listGenerations({ limit: 8 }),
      };
    },
  };
}

/**
 * Drops keys the caller did not actually send, so a partial PATCH never blanks
 * an existing column with `undefined`.
 */
function definedOnly(patch) {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined && value !== null));
}

/** Keeps the deterministic gradient artwork used by the project cards. */
export function artForType(type) {
  const key = String(type || '').toLowerCase();
  if (key.includes('brand') || key.includes('identity')) return 'fieldnotes';
  if (key.includes('web')) return 'nimbus';
  if (key.includes('audio')) return 'soundscape';
  if (key.includes('video')) return 'aurora';
  if (key.includes('product')) return 'studio';
  return 'atlas';
}

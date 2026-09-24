import {
  activityFromRow,
  automationFromRow,
  fileFromRow,
  generationFromRow,
  inviteFromRow,
  membershipFromRow,
  newId,
  nowIso,
  projectFromRow,
  promptFromRow,
  relativeTime,
  userFromRow,
  workspaceFromRow,
} from './db.js';
import { describeSchedule, nextOccurrence } from './schedule.js';

/**
 * Data access. Routes call these helpers so SQL stays in one layer and the HTTP
 * handlers read like the product, not like a database driver.
 *
 * The store has two halves:
 *
 *   • The account half — users, sessions, workspaces, memberships, invites.
 *     These are global by nature: a session has to be resolvable before anybody
 *     knows which workspace the request is about.
 *   • `forWorkspace(id)` — everything that belongs to a workspace. Every query
 *     in that half carries a `workspace_id` filter, so a leaked project id from
 *     another workspace still returns nothing. Tenancy is enforced in SQL, not
 *     by a check the route author has to remember to write.
 */
export function createStore(db) {
  const statements = {
    // --- Accounts -----------------------------------------------------------
    userInsert: db.prepare('INSERT INTO users (id, email, name, password_hash, avatar, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
    userById: db.prepare('SELECT * FROM users WHERE id = ?'),
    userSeen: db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?'),
    userName: db.prepare('UPDATE users SET name = ? WHERE id = ?'),
    userPassword: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
    userDelete: db.prepare('DELETE FROM users WHERE id = ?'),
    userCount: db.prepare('SELECT COUNT(*) AS count FROM users'),
    usersAll: db.prepare('SELECT * FROM users ORDER BY created_at ASC'),

    sessionInsert: db.prepare('INSERT INTO sessions (id, user_id, workspace_id, created_at, last_used_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)'),
    sessionGet: db.prepare('SELECT * FROM sessions WHERE id = ?'),
    sessionTouch: db.prepare('UPDATE sessions SET last_used_at = ?, expires_at = ?, workspace_id = ? WHERE id = ?'),
    sessionDelete: db.prepare('DELETE FROM sessions WHERE id = ?'),
    sessionsForUser: db.prepare('DELETE FROM sessions WHERE user_id = ?'),
    sessionsExpired: db.prepare('DELETE FROM sessions WHERE expires_at <= ?'),

    // --- Workspaces ---------------------------------------------------------
    workspaceInsert: db.prepare('INSERT INTO workspaces (id, name, owner_id, plan, created_at) VALUES (?, ?, ?, ?, ?)'),
    workspaceOne: db.prepare('SELECT * FROM workspaces WHERE id = ?'),
    workspaceUpdate: db.prepare('UPDATE workspaces SET name = ?, owner_id = ? WHERE id = ?'),
    workspaceDelete: db.prepare('DELETE FROM workspaces WHERE id = ?'),
    workspacesForUser: db.prepare(`SELECT w.*, m.role AS role FROM workspaces w
      JOIN memberships m ON m.workspace_id = w.id WHERE m.user_id = ? ORDER BY w.created_at ASC`),
    orphanWorkspaces: db.prepare(`SELECT w.* FROM workspaces w
      LEFT JOIN memberships m ON m.workspace_id = w.id
      WHERE m.user_id IS NULL ORDER BY w.created_at ASC`),

    memberInsert: db.prepare('INSERT OR REPLACE INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)'),
    memberOne: db.prepare('SELECT * FROM memberships WHERE workspace_id = ? AND user_id = ?'),
    memberRole: db.prepare('UPDATE memberships SET role = ? WHERE workspace_id = ? AND user_id = ?'),
    memberDelete: db.prepare('DELETE FROM memberships WHERE workspace_id = ? AND user_id = ?'),
    membersFor: db.prepare(`SELECT m.workspace_id, m.user_id, m.role, m.created_at,
        u.name, u.email, u.avatar, u.last_seen_at
      FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = ? ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 ELSE 3 END, u.name ASC`),
    memberCount: db.prepare('SELECT COUNT(*) AS count FROM memberships WHERE workspace_id = ?'),

    inviteInsert: db.prepare('INSERT INTO invites (id, workspace_id, email, role, token_hash, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
    inviteByHash: db.prepare('SELECT * FROM invites WHERE token_hash = ?'),
    invitesFor: db.prepare('SELECT * FROM invites WHERE workspace_id = ? ORDER BY created_at DESC'),
    inviteAccept: db.prepare('UPDATE invites SET accepted_at = ?, accepted_by = ? WHERE id = ?'),
    inviteRevoke: db.prepare('DELETE FROM invites WHERE id = ? AND workspace_id = ?'),
    invitePending: db.prepare('SELECT * FROM invites WHERE workspace_id = ? AND email = ? AND accepted_at IS NULL'),
    invitesExpired: db.prepare('DELETE FROM invites WHERE expires_at <= ? AND accepted_at IS NULL'),
  };

  const store = {
    db,

    // --- Users --------------------------------------------------------------
    createUser({ email, name, passwordHash, avatar = '' }) {
      const id = newId('u');
      statements.userInsert.run(id, String(email).toLowerCase(), String(name || '').trim().slice(0, 80) || email, passwordHash, avatar, nowIso());
      return this.getUser(id);
    },
    getUser(id) {
      return userFromRow(statements.userById.get(id));
    },
    getUserByEmail(email) {
      return userFromRow(statements.userByEmail.get(String(email || '').toLowerCase()));
    },
    /** The raw row, for password verification — the shaped user never carries the hash. */
    getUserRowByEmail(email) {
      return statements.userByEmail.get(String(email || '').toLowerCase()) || null;
    },
    markUserSeen(id) {
      statements.userSeen.run(nowIso(), id);
    },
    setName(userId, name) {
      const clean = String(name || '').trim().slice(0, 80);
      if (!clean) return this.getUser(userId);
      statements.userName.run(clean, userId);
      return this.getUser(userId);
    },
    setPassword(userId, passwordHash) {
      statements.userPassword.run(passwordHash, userId);
    },
    deleteUser(id) {
      statements.userDelete.run(id);
    },
    countUsers() {
      return statements.userCount.get().count || 0;
    },
    listUsers() {
      return statements.usersAll.all().map(userFromRow);
    },

    // --- Sessions -----------------------------------------------------------
    createSession({ id, userId, workspaceId = null, ttlMs, userAgent = '' }) {
      const now = Date.now();
      statements.sessionInsert.run(id, userId, workspaceId, nowIso(), nowIso(), new Date(now + ttlMs).toISOString(), String(userAgent).slice(0, 200));
      return statements.sessionGet.get(id) || null;
    },
    getSession(id) {
      return statements.sessionGet.get(id) || null;
    },
    /** Sliding expiry: an active session never has to be re-authenticated. */
    touchSession(id, { ttlMs, workspaceId }) {
      const now = Date.now();
      statements.sessionTouch.run(nowIso(), new Date(now + ttlMs).toISOString(), workspaceId, id);
    },
    deleteSession(id) {
      statements.sessionDelete.run(id);
    },
    deleteSessionsForUser(userId) {
      statements.sessionsForUser.run(userId);
    },
    pruneSessions() {
      statements.sessionsExpired.run(nowIso());
    },

    // --- Workspaces ---------------------------------------------------------
    createWorkspace({ name, ownerId = null, plan = 'Studio plan' }) {
      const id = newId('w');
      statements.workspaceInsert.run(id, String(name || 'Untitled workspace').trim().slice(0, 80), ownerId, plan, nowIso());
      return this.getWorkspace(id);
    },
    getWorkspace(id) {
      return workspaceFromRow(statements.workspaceOne.get(id));
    },
    renameWorkspace(id, name) {
      const workspace = this.getWorkspace(id);
      if (!workspace) return null;
      statements.workspaceUpdate.run(String(name).trim().slice(0, 80) || workspace.name, workspace.ownerId, id);
      return this.getWorkspace(id);
    },
    setWorkspacePlan(id, plan) {
      const workspace = this.getWorkspace(id);
      if (!workspace) return null;
      db.prepare('UPDATE workspaces SET plan = ? WHERE id = ?').run(String(plan).slice(0, 40), id);
      return this.getWorkspace(id);
    },
    transferWorkspace(id, ownerId) {
      const workspace = this.getWorkspace(id);
      if (!workspace) return null;
      statements.workspaceUpdate.run(workspace.name, ownerId, id);
      return this.getWorkspace(id);
    },
    deleteWorkspace(id) {
      statements.workspaceDelete.run(id);
    },
    listWorkspacesForUser(userId) {
      return statements.workspacesForUser.all(userId).map((row) => ({ ...workspaceFromRow(row), role: row.role }));
    },
    /** Workspaces with no members at all — seeded data waiting for an owner. */
    listOrphanWorkspaces() {
      return statements.orphanWorkspaces.all().map(workspaceFromRow);
    },
    countMembers(workspaceId) {
      return statements.memberCount.get(workspaceId).count || 0;
    },

    // --- Memberships --------------------------------------------------------
    addMember(workspaceId, userId, role = 'editor') {
      statements.memberInsert.run(workspaceId, userId, role, nowIso());
      return this.membershipOf(workspaceId, userId);
    },
    membershipOf(workspaceId, userId) {
      return membershipFromRow(statements.memberOne.get(workspaceId, userId));
    },
    listMembers(workspaceId) {
      return statements.membersFor.all(workspaceId).map((row) => ({
        userId: row.user_id,
        role: row.role,
        name: row.name,
        email: row.email,
        avatar: row.avatar || '',
        lastSeenAt: row.last_seen_at || null,
        joinedAt: row.created_at,
      }));
    },
    setMemberRole(workspaceId, userId, role) {
      statements.memberRole.run(role, workspaceId, userId);
      return this.membershipOf(workspaceId, userId);
    },
    removeMember(workspaceId, userId) {
      statements.memberDelete.run(workspaceId, userId);
    },

    // --- Invites ------------------------------------------------------------
    createInvite({ workspaceId, email, role, tokenHash, invitedBy = null, ttlMs }) {
      const id = newId('inv');
      const now = Date.now();
      statements.inviteInsert.run(id, workspaceId, String(email).toLowerCase(), role, tokenHash, invitedBy, nowIso(), new Date(now + ttlMs).toISOString());
      return inviteFromRow(statements.inviteByHash.get(tokenHash));
    },
    getInviteByTokenHash(tokenHash) {
      return inviteFromRow(statements.inviteByHash.get(tokenHash));
    },
    listInvites(workspaceId) {
      return statements.invitesFor.all(workspaceId).map(inviteFromRow);
    },
    pendingInvitesFor(workspaceId, email) {
      return statements.invitePending.all(workspaceId, String(email).toLowerCase()).map(inviteFromRow);
    },
    acceptInvite(id, userId) {
      statements.inviteAccept.run(nowIso(), userId, id);
    },
    revokeInvite(id, workspaceId) {
      statements.inviteRevoke.run(id, workspaceId);
      return true;
    },
    pruneInvites() {
      statements.invitesExpired.run(nowIso());
    },

    // --- Workspace-scoped data ---------------------------------------------
    forWorkspace(workspaceId) {
      return createWorkspaceStore(db, workspaceId, store);
    },
  };

  return store;
}

/**
 * Everything that belongs to one workspace. Built per request (they are cheap —
 * better a new closure than a stale workspace id), and every statement filters
 * on `workspace_id`, including the `WHERE id = ?` lookups.
 */
function createWorkspaceStore(db, workspaceId, root) {
  const statements = {
    projectsAll: db.prepare('SELECT * FROM projects WHERE workspace_id = ? AND archived = 0 ORDER BY updated_at DESC'),
    projectsIncludingArchived: db.prepare('SELECT * FROM projects WHERE workspace_id = ? ORDER BY updated_at DESC'),
    projectOne: db.prepare('SELECT * FROM projects WHERE id = ? AND workspace_id = ?'),
    projectInsert: db.prepare(`INSERT INTO projects (id, workspace_id, title, type, model, status, prompt, art, outputs, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    projectUpdate: db.prepare('UPDATE projects SET title = ?, type = ?, model = ?, status = ?, prompt = ?, art = ?, archived = ?, updated_at = ? WHERE id = ? AND workspace_id = ?'),
    projectTouch: db.prepare('UPDATE projects SET updated_at = ? WHERE id = ? AND workspace_id = ?'),
    projectOutputs: db.prepare('UPDATE projects SET outputs = outputs + ?, status = ?, updated_at = ? WHERE id = ? AND workspace_id = ?'),

    promptsAll: db.prepare('SELECT * FROM prompts WHERE workspace_id = ? ORDER BY uses DESC'),
    promptOne: db.prepare('SELECT * FROM prompts WHERE id = ? AND workspace_id = ?'),
    promptInsert: db.prepare('INSERT INTO prompts (id, workspace_id, title, category, icon, mode, body, uses, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)'),
    promptUse: db.prepare('UPDATE prompts SET uses = uses + 1 WHERE id = ? AND workspace_id = ?'),

    automationsAll: db.prepare('SELECT * FROM automations WHERE workspace_id = ? ORDER BY created_at DESC'),
    automationOne: db.prepare('SELECT * FROM automations WHERE id = ? AND workspace_id = ?'),
    automationInsert: db.prepare(`INSERT INTO automations
      (id, workspace_id, name, description, trigger, trigger_label, schedule, next_run_at, action, last_run, enabled, tone, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    automationUpdate: db.prepare(`UPDATE automations SET name = ?, description = ?, trigger = ?, trigger_label = ?, schedule = ?,
      next_run_at = ?, action = ?, enabled = ?, tone = ?, last_run = ? WHERE id = ? AND workspace_id = ?`),
    automationLastRun: db.prepare('UPDATE automations SET last_run = ?, last_status = ? WHERE id = ? AND workspace_id = ?'),
    automationNextRun: db.prepare('UPDATE automations SET next_run_at = ? WHERE id = ? AND workspace_id = ?'),
    automationDue: db.prepare('SELECT * FROM automations WHERE workspace_id = ? AND enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT ?'),
    automationByEvent: db.prepare('SELECT * FROM automations WHERE workspace_id = ? AND enabled = 1 AND schedule LIKE ?'),
    scheduledAutomations: db.prepare('SELECT * FROM automations WHERE workspace_id = ? AND enabled = 1 AND next_run_at IS NOT NULL'),
    lastRunFor: db.prepare('SELECT created_at FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 1'),
    runInsert: db.prepare('INSERT INTO automation_runs (id, automation_id, generation_id, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
    runStats: db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS recent, MAX(created_at) AS last_at
      FROM automation_runs WHERE automation_id IN (SELECT id FROM automations WHERE workspace_id = ?)`),
    runsFor: db.prepare(`SELECT * FROM automation_runs WHERE automation_id IN (SELECT id FROM automations WHERE id = ? AND workspace_id = ?)
      ORDER BY created_at DESC LIMIT ?`),
    runOne: db.prepare('SELECT * FROM automation_runs WHERE id = ?'),

    fileInsert: db.prepare(`INSERT INTO files (id, workspace_id, name, mime, size, path, kind, excerpt, project_id, generation_id, storage_driver, storage_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    fileOne: db.prepare('SELECT * FROM files WHERE id = ? AND workspace_id = ?'),
    filesForProject: db.prepare('SELECT * FROM files WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT ?'),
    filesForGeneration: db.prepare('SELECT * FROM files WHERE workspace_id = ? AND generation_id = ? ORDER BY created_at ASC'),
    filesRecent: db.prepare('SELECT * FROM files WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?'),
    filesForIds: db.prepare('SELECT * FROM files WHERE workspace_id = ? AND id IN (SELECT value FROM json_each(?)) ORDER BY created_at ASC'),
    fileDelete: db.prepare('DELETE FROM files WHERE id = ? AND workspace_id = ?'),
    fileStats: db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(size),0) AS bytes FROM files WHERE workspace_id = ?'),

    activityAll: db.prepare('SELECT * FROM activity WHERE workspace_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'),
    activityInsert: db.prepare('INSERT INTO activity (workspace_id, icon, tone, line, project, created_at) VALUES (?, ?, ?, ?, ?, ?)'),

    settingsAll: db.prepare('SELECT key, value FROM settings WHERE workspace_id = ?'),
    settingUpsert: db.prepare('INSERT INTO settings (workspace_id, key, value) VALUES (?, ?, ?) ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value'),

    generationInsert: db.prepare(`INSERT INTO generations
      (id, workspace_id, project_id, provider, model_id, model_label, kind, mode, prompt, output, asset_url, status, error, tokens_in, tokens_out, credits, cost_usd, latency_ms, created_at, finished_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    generationOne: db.prepare('SELECT * FROM generations WHERE id = ? AND workspace_id = ?'),
    generationByProject: db.prepare('SELECT * FROM generations WHERE workspace_id = ? AND project_id = ? ORDER BY created_at DESC LIMIT ?'),
    generationRecent: db.prepare('SELECT * FROM generations WHERE workspace_id = ? ORDER BY created_at DESC LIMIT ?'),
    generationFinish: db.prepare(`UPDATE generations SET output = ?, asset_url = ?, status = ?, error = ?, tokens_in = ?, tokens_out = ?, credits = ?, cost_usd = ?, latency_ms = ?, finished_at = ? WHERE id = ? AND workspace_id = ?`),

    totals: db.prepare(`SELECT COUNT(*) AS generations, COALESCE(SUM(tokens_in),0) AS tokensIn, COALESCE(SUM(tokens_out),0) AS tokensOut,
      COALESCE(SUM(credits),0) AS credits, COALESCE(SUM(cost_usd),0) AS costUsd, COALESCE(AVG(NULLIF(latency_ms,0)),0) AS avgLatency
      FROM generations WHERE workspace_id = ? AND status IN ('succeeded','failed')`),
    successCount: db.prepare("SELECT COUNT(*) AS count FROM generations WHERE workspace_id = ? AND status = 'succeeded'"),
    byProvider: db.prepare(`SELECT provider, COUNT(*) AS count, COALESCE(SUM(credits),0) AS credits, COALESCE(SUM(cost_usd),0) AS costUsd
      FROM generations WHERE workspace_id = ? AND status = 'succeeded' GROUP BY provider ORDER BY credits DESC`),
    byKind: db.prepare(`SELECT kind, COUNT(*) AS count, COALESCE(SUM(credits),0) AS credits
      FROM generations WHERE workspace_id = ? AND status = 'succeeded' GROUP BY kind ORDER BY credits DESC`),
    daily: db.prepare(`SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS count, COALESCE(SUM(credits),0) AS credits
      FROM generations WHERE workspace_id = ? AND status = 'succeeded' AND created_at >= ? GROUP BY day ORDER BY day ASC`),
  };

  const touchProject = (id, iso = nowIso()) => {
    if (!id) return;
    statements.projectTouch.run(iso, id, workspaceId);
  };

  const workspace = () => root.getWorkspace(workspaceId);

  return {
    db,
    workspaceId,

    // --- People -------------------------------------------------------------
    /** Members and invites are owned by the root store; scoped callers just name none. */
    listMembers() {
      return root.listMembers(workspaceId);
    },
    membershipOf(userId) {
      return root.membershipOf(workspaceId, userId);
    },
    invites() {
      return root.listInvites(workspaceId);
    },

    // --- Projects -----------------------------------------------------------
    listProjects({ includeArchived = false } = {}) {
      const rows = includeArchived ? statements.projectsIncludingArchived.all(workspaceId) : statements.projectsAll.all(workspaceId);
      return rows.map(projectFromRow);
    },
    getProject(id) {
      return projectFromRow(statements.projectOne.get(id, workspaceId));
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
      statements.projectInsert.run(project.id, workspaceId, project.title, project.type, project.model, project.status, project.prompt, project.art, project.outputs, iso, iso);
      return this.getProject(project.id);
    },
    updateProject(id, patch = {}) {
      const existing = this.getProject(id);
      if (!existing) return null;
      const merged = { ...existing, ...definedOnly(patch) };
      statements.projectUpdate.run(
        merged.title, merged.type, merged.model, merged.status, merged.prompt || '',
        merged.art || artForType(merged.type), merged.archived ? 1 : 0, nowIso(), id, workspaceId,
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
        project.art || artForType(project.type), 1, nowIso(), id, workspaceId,
      );
      return true;
    },
    recordOutput(projectId, { count = 1, status } = {}) {
      if (!projectId) return;
      const project = this.getProject(projectId);
      if (!project) return;
      statements.projectOutputs.run(count, status || project.status, nowIso(), projectId, workspaceId);
    },
    touchProject,

    // --- Generations --------------------------------------------------------
    createGeneration(record) {
      const iso = nowIso();
      statements.generationInsert.run(
        record.id, workspaceId, record.projectId || null, record.provider, record.modelId, record.modelLabel,
        record.kind, record.mode || 'Writing', record.prompt, '', null, record.status || 'streaming',
        null, 0, 0, 0, 0, 0, iso, null,
      );
      return this.getGeneration(record.id);
    },
    getGeneration(id) {
      return generationFromRow(statements.generationOne.get(id, workspaceId));
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
        workspaceId,
      );
      return this.getGeneration(id);
    },
    listGenerations({ projectId = null, limit = 25 } = {}) {
      const rows = projectId
        ? statements.generationByProject.all(workspaceId, projectId, limit)
        : statements.generationRecent.all(workspaceId, limit);
      return rows.map(generationFromRow);
    },

    // --- Prompts ------------------------------------------------------------
    listPrompts() {
      return statements.promptsAll.all(workspaceId).map(promptFromRow);
    },
    getPrompt(id) {
      return promptFromRow(statements.promptOne.get(id, workspaceId));
    },
    incrementPromptUses(id) {
      statements.promptUse.run(id, workspaceId);
      return this.getPrompt(id);
    },
    createPrompt({ title, category = 'My prompts', mode = 'Writing', body, icon = 'sparkles' }) {
      const id = newId('p');
      statements.promptInsert.run(id, workspaceId, String(title || '').trim().slice(0, 120) || 'Untitled prompt', category, icon, mode, String(body || '').slice(0, 4000), nowIso());
      return this.getPrompt(id);
    },

    // --- Automations --------------------------------------------------------
    listAutomations() {
      return statements.automationsAll.all(workspaceId).map((row) => automationFromRow(row, row.last_run));
    },
    getAutomation(id) {
      const row = statements.automationOne.get(id, workspaceId);
      if (!row) return null;
      const last = statements.lastRunFor.get(row.id);
      return automationFromRow(row, last?.created_at || row.last_run);
    },
    createAutomation({ name, description = '', action = 'Curate & summarize', enabled = true, tone = 'purple', schedule = { type: 'manual' }, timeZone = 'UTC' }) {
      const id = newId('a');
      const nextRun = nextOccurrence(schedule, Date.now(), timeZone);
      statements.automationInsert.run(
        id, workspaceId, String(name || 'Untitled automation').slice(0, 120), description, describeSchedule(schedule),
        describeSchedule(schedule), JSON.stringify(schedule), nextRun ? new Date(nextRun).toISOString() : null,
        action, null, enabled ? 1 : 0, tone, nowIso(),
      );
      return this.getAutomation(id);
    },
    updateAutomation(id, patch = {}, { timeZone = 'UTC' } = {}) {
      const current = this.getAutomation(id);
      if (!current) return null;
      const merged = { ...current, ...definedOnly(patch) };
      const scheduleChanged = patch.schedule !== undefined;
      const nextRun = !merged.enabled ? null : nextOccurrence(merged.schedule, Date.now(), timeZone);
      statements.automationUpdate.run(
        merged.name, merged.description, describeSchedule(merged.schedule), describeSchedule(merged.schedule),
        JSON.stringify(merged.schedule), nextRun ? new Date(nextRun).toISOString() : null,
        merged.action, merged.enabled ? 1 : 0, merged.tone || 'purple', merged.lastRunAt || null, id, workspaceId,
      );
      if (scheduleChanged && nextRun) statements.automationNextRun.run(new Date(nextRun).toISOString(), id, workspaceId);
      return this.getAutomation(id);
    },
    /** Automations whose clock-based schedule is due, oldest first. */
    dueAutomations(nowIsoValue = nowIso(), limit = 5) {
      return statements.automationDue.all(workspaceId, nowIsoValue, limit).map((row) => automationFromRow(row, row.last_run));
    },
    automationsForEvent(event, value) {
      const key = `%"event":"${event}"%"value":"${value}"%`;
      return statements.automationByEvent.all(workspaceId, key).map((row) => automationFromRow(row, row.last_run));
    },
    scheduledAutomations() {
      return statements.scheduledAutomations.all(workspaceId).map((row) => automationFromRow(row, row.last_run));
    },
    setNextRun(id, iso) {
      statements.automationNextRun.run(iso, id, workspaceId);
    },
    /** Run counts for the automations page: all time, and since a cut-off. */
    automationRunStats(sinceIso) {
      const row = statements.runStats.get(sinceIso, workspaceId) || {};
      return { total: Number(row.total) || 0, recent: Number(row.recent) || 0, lastRunAt: row.last_at || null };
    },
    recordAutomationRun({ automationId, generationId = null, status = 'succeeded', note = '' }) {
      const id = newId('run');
      statements.runInsert.run(id, automationId, generationId, status, note, nowIso());
      statements.automationLastRun.run(nowIso(), status, automationId, workspaceId);
      return id;
    },
    listAutomationRuns(automationId, limit = 5) {
      return statements.runsFor.all(automationId, workspaceId, limit).map((row) => ({
        id: row.id,
        automationId: row.automation_id,
        generationId: row.generation_id,
        status: row.status,
        note: row.note,
        created: row.created_at,
        createdLabel: relativeTime(row.created_at),
        generation: row.generation_id ? this.getGeneration(row.generation_id) : null,
      }));
    },

    /** The workspace this store is scoped to. Object keys are namespaced by it. */
    workspaceId,

    // --- Files --------------------------------------------------------------
    /**
     * `path` is kept in the row for databases from before object storage; new
     * files record the driver and key the storage layer actually used.
     */
    createFile({ id, name, mime, size, path: storedPath, kind = 'attachment', excerpt = '', projectId = null, generationId = null, storageDriver = 'local', storageKey = null }) {
      const key = storageKey || storedPath;
      statements.fileInsert.run(id, workspaceId, name, mime, size, key, kind, excerpt, projectId, generationId, storageDriver, key, nowIso());
      return this.getFile(id);
    },
    getFile(id) {
      return fileFromRow(statements.fileOne.get(id, workspaceId));
    },
    /** Raw row, for the file store's disk operations. */
    getFileRow(id) {
      return statements.fileOne.get(id, workspaceId) || null;
    },
    filesForGeneration(generationId) {
      return statements.filesForGeneration.all(workspaceId, generationId).map(fileFromRow);
    },
    filesForProject(projectId, limit = 50) {
      return statements.filesForProject.all(workspaceId, projectId, limit).map(fileFromRow);
    },
    filesByIds(ids = []) {
      const clean = [...new Set(ids.filter((id) => typeof id === 'string' && id))].slice(0, 16);
      if (!clean.length) return [];
      return statements.filesForIds.all(workspaceId, JSON.stringify(clean)).map(fileFromRow);
    },
    listFiles({ limit = 50 } = {}) {
      return statements.filesRecent.all(workspaceId, limit).map(fileFromRow);
    },
    deleteFile(id) {
      statements.fileDelete.run(id, workspaceId);
    },
    /** Disk usage for this workspace, without loading file bytes. */
    fileStats() {
      const row = statements.fileStats.get(workspaceId) || {};
      return { count: Number(row.count) || 0, bytes: Number(row.bytes) || 0 };
    },

    // --- Activity -----------------------------------------------------------
    listActivity(limit = 8) {
      return statements.activityAll.all(workspaceId, limit).map(activityFromRow);
    },
    addActivity({ icon = 'sparkles', tone = '', line, project = '' }) {
      statements.activityInsert.run(workspaceId, icon, tone, String(line || '').slice(0, 400), project, nowIso());
      return this.listActivity(8);
    },

    // --- Settings -----------------------------------------------------------
    getSettings() {
      const settings = { ...defaultSettings(workspace()?.name || 'My workspace') };
      for (const row of statements.settingsAll.all(workspaceId)) settings[row.key] = row.value;
      return settings;
    },
    saveSettings(patch = {}) {
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null) continue;
        statements.settingUpsert.run(workspaceId, String(key), String(value).slice(0, 400));
      }
      return this.getSettings();
    },

    // --- Usage --------------------------------------------------------------
    usageSummary({ creditsIncluded = 10_000, days = 7 } = {}) {
      const totals = statements.totals.get(workspaceId);
      const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
      const daily = statements.daily.all(workspaceId, sinceIso);
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
          name: workspace()?.plan || 'Studio plan',
          creditsIncluded,
          creditsUsed,
          creditsRemaining: Math.max(0, creditsIncluded - creditsUsed),
          renewsOn: new Date(Date.now() + 12 * 86_400_000).toISOString().slice(0, 10),
        },
        totals: {
          generations: totals.generations || 0,
          succeeded: statements.successCount.get(workspaceId).count || 0,
          tokensIn: totals.tokensIn || 0,
          tokensOut: totals.tokensOut || 0,
          credits: creditsUsed,
          costUsd: Number((totals.costUsd || 0).toFixed(4)),
          avgLatencyMs: Math.round(totals.avgLatency || 0),
        },
        byProvider: statements.byProvider.all(workspaceId).map((row) => ({ provider: row.provider, count: row.count, credits: Math.round(row.credits), costUsd: Number(row.costUsd.toFixed(4)) })),
        byKind: statements.byKind.all(workspaceId).map((row) => ({ kind: row.kind, count: row.count, credits: Math.round(row.credits) })),
        daily: series,
        recent: this.listGenerations({ limit: 8 }),
      };
    },
  };
}

/** Preferences a workspace starts with. Copied into rows on first save. */
export function defaultSettings(workspaceName = 'My workspace') {
  return {
    name: '',
    email: '',
    workspace: workspaceName,
    timezone: 'Asia/Kolkata',
    startPage: 'Overview',
    defaultModel: 'Auto select',
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

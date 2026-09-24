import {
  SESSION_COOKIE,
  can,
  checkPasswordStrength,
  createRateLimiter,
  createSessionToken,
  hashPassword,
  hashToken,
  isRole,
  looksLikeEmail,
  normaliseEmail,
  parseCookies,
  verifyPassword,
} from './auth.js';
import { escapeText } from './html.js';
import { ProviderError } from './providers/util.js';

/**
 * Account and workspace flows.
 *
 * The route layer stays thin by pushing the decisions here, where they can be
 * reasoned about (and tested) without HTTP. Two things this module guarantees:
 *
 *   • Every session resolves to exactly one active workspace, and the caller is
 *     always a member of it. Losing a membership invalidates the session's
 *     workspace on the next request instead of leaking that workspace's data.
 *   • Roles are checked here with `can()`, so a route cannot forget.
 */
export function createAccounts({ store, config }) {
  const authConfig = config.auth;
  const loginLimiter = createRateLimiter({ windowMs: authConfig.loginWindowMs, max: authConfig.loginMaxAttempts });
  const signupLimiter = createRateLimiter({ windowMs: authConfig.loginWindowMs, max: authConfig.signupMaxAttempts });

  const ttlMs = authConfig.sessionTtlDays * 86_400_000;
  const inviteTtlMs = authConfig.inviteTtlDays * 86_400_000;

  const fail = (status, message, code, hint = '') => {
    throw new ProviderError(message, { status, code, hint });
  };

  /** A workspace id we are allowed to put in a session: member, active, or none. */
  function landingWorkspace(userId, preferredId = null) {
    const workspaces = store.listWorkspacesForUser(userId);
    if (!workspaces.length) return null;
    return workspaces.find((workspace) => workspace.id === preferredId) || workspaces[0];
  }

  function envOf(req) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    const ip = forwarded || req.socket?.remoteAddress || 'unknown';
    return { ip, agent: String(req.headers['user-agent'] || '').slice(0, 200) };
  }

  const limiterKey = (req, email) => `${envOf(req).ip}|${normaliseEmail(email)}`;

  return {
    cookieName: SESSION_COOKIE,
    sessionTtlMs: ttlMs,

    /** True when nobody has signed up yet — the UI shows "claim the studio". */
    isFirstRun() {
      return store.countUsers() === 0;
    },

    /** Workspaces that exist but have no members (seeded demo data, usually). */
    claimableWorkspaces() {
      return store.listOrphanWorkspaces();
    },

    /**
     * Resolves the caller from the cookie or an `Authorization: Bearer` header,
     * then re-checks membership on every request. Returns null when unauthenticated.
     */
    resolve(req) {
      const cookies = parseCookies(req.headers.cookie);
      const header = String(req.headers.authorization || '');
      const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
      const token = bearer || cookies[SESSION_COOKIE] || '';
      if (!token) return null;

      const row = store.getSession(hashToken(token));
      if (!row) return null;
      if (Date.parse(row.expires_at) <= Date.now()) {
        store.deleteSession(row.id);
        return null;
      }

      const user = store.getUser(row.user_id);
      if (!user) {
        store.deleteSession(row.id);
        return null;
      }

      const workspaces = store.listWorkspacesForUser(user.id);
      const active = landingWorkspace(user.id, row.workspace_id);
      if (!active) {
        // The user exists but belongs nowhere: deleting a workspace removes its
        // memberships, and a session without a workspace has nothing to read.
        store.deleteSession(row.id);
        return null;
      }

      const role = active.role;
      store.touchSession(row.id, { ttlMs, workspaceId: active.id });
      if (row.workspace_id !== active.id) store.markUserSeen(user.id);

      return {
        token,
        sessionId: row.id,
        user,
        workspaces: workspaces.map(({ id, name, role: memberRole }) => ({ id, name, role: memberRole })),
        workspace: active,
        role,
        /** The workspace-scoped data layer. Everything workspace-owned goes through it. */
        data: store.forWorkspace(active.id),
      };
    },

    /** Throws 403 unless the caller's role covers `capability`. */
    require(auth, capability) {
      if (!auth) fail(401, 'Sign in to continue.', 'unauthenticated', 'Your session may have expired.');
      if (!can(auth.role, capability)) {
        fail(403, `Your role in ${auth.workspace.name} is ${auth.role}, which cannot ${verbFor(capability)}.`,
          'forbidden', 'Ask a workspace owner or admin for a higher role.');
      }
      return auth;
    },

    // --- Sign up / in / out -------------------------------------------------

    async signUp({ email, name, password, workspaceName }, req = {}) {
      if (!authConfig.allowSignups) fail(403, 'This studio is not accepting new accounts.', 'signups_closed', 'Ask an owner to invite you instead.');
      const clean = normaliseEmail(email);
      if (!looksLikeEmail(clean)) fail(400, 'That does not look like an email address.', 'invalid_email');
      const passwordError = checkPasswordStrength(password);
      if (passwordError) fail(400, passwordError, 'weak_password');
      const limit = signupLimiter.check(envOf(req).ip);
      if (!limit.allowed) fail(429, 'Too many attempts. Try again shortly.', 'rate_limited');
      if (store.getUserByEmail(clean)) fail(409, 'An account already exists for that email.', 'email_taken', 'Sign in instead, or use another address.');

      const user = store.createUser({ email: clean, name, passwordHash: await hashPassword(password) });

      // The very first account on a database that already has content takes it
      // over, so seeded or pre-accounts data is never stranded without an owner.
      // Later accounts always get their own workspace — never somebody's orphan.
      const claimable = store.countUsers() === 1 ? (store.listOrphanWorkspaces()[0] || null) : null;
      const workspace = claimable || store.createWorkspace({ name: workspaceName || `${user.name.split(' ')[0]}'s workspace`, ownerId: user.id });
      if (claimable) store.transferWorkspace(claimable.id, user.id);
      store.addMember(workspace.id, user.id, 'owner');
      store.markUserSeen(user.id);
      signupLimiter.reset(envOf(req).ip);

      const scoped = store.forWorkspace(workspace.id);
      scoped.addActivity({
        icon: 'star',
        tone: 'green',
        line: `<strong>${escapeText(user.name)}</strong> created this workspace`,
        project: workspace.name,
      });

      return { user, workspace: { ...workspace, role: 'owner' }, claimed: Boolean(claimable) };
    },

    async signIn({ email, password }, req = {}) {
      const clean = normaliseEmail(email);
      const key = limiterKey(req, clean);
      const limit = loginLimiter.check(key);
      if (!limit.allowed) {
        const minutes = Math.ceil((limit.retryAfterMs || authConfig.loginWindowMs) / 60_000);
        fail(429, `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`, 'rate_limited');
      }

      const row = store.getUserRowByEmail(clean);
      const ok = row ? await verifyPassword(password, row.password_hash) : await verifyPassword(password, 'scrypt$1$1$1$AAAA$AAAA');
      // One message for both cases: whether an email exists is not public.
      if (!ok || !row) fail(401, 'That email and password do not match an account.', 'invalid_credentials', 'Check for typos, or create an account.');
      loginLimiter.reset(key);

      const user = store.getUser(row.id);
      store.markUserSeen(user.id);
      const workspace = landingWorkspace(user.id);
      if (!workspace) fail(403, 'Your account is not a member of any workspace.', 'no_workspace', 'Ask an owner for an invite.');
      return { user, workspace };
    },

    /** Creates a session row and returns the raw token (never stored as-is). */
    startSession(user, workspace, req = {}) {
      const token = createSessionToken();
      store.createSession({
        id: hashToken(token),
        userId: user.id,
        workspaceId: workspace?.id || null,
        ttlMs,
        userAgent: envOf(req).agent,
      });
      return token;
    },

    signOut(token) {
      if (token) store.deleteSession(hashToken(token));
    },

    /** Ends every session for a user — used after a password change. */
    signOutEverywhere(userId) {
      store.deleteSessionsForUser(userId);
    },

    changePassword(user, currentPassword, nextPassword) {
      return (async () => {
        const row = store.getUserRowByEmail(user.email);
        if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
          fail(401, 'That is not your current password.', 'invalid_credentials');
        }
        const passwordError = checkPasswordStrength(nextPassword);
        if (passwordError) fail(400, passwordError, 'weak_password');
        store.setPassword(user.id, await hashPassword(nextPassword));
        this.signOutEverywhere(user.id);
        return true;
      })();
    },

    // --- Workspaces ---------------------------------------------------------

    switchWorkspace(auth, workspaceId) {
      const target = auth.workspaces.find((workspace) => workspace.id === workspaceId);
      if (!target) fail(404, 'That workspace is not one of yours.', 'workspace_not_found');
      const workspace = store.getWorkspace(target.id);
      store.touchSession(auth.sessionId, { ttlMs, workspaceId: workspace.id });
      return { workspace: { ...workspace, role: target.role } };
    },

    createWorkspaceFor(user, name) {
      const owned = store.listWorkspacesForUser(user.id).filter((workspace) => workspace.role === 'owner').length;
      if (owned >= authConfig.maxWorkspacesPerUser) {
        fail(403, `You already own ${owned} workspaces, which is the limit on this instance.`, 'workspace_limit');
      }
      const workspace = store.createWorkspace({ name: name || 'New workspace', ownerId: user.id });
      store.addMember(workspace.id, user.id, 'owner');
      const scoped = store.forWorkspace(workspace.id);
      scoped.saveSettings({ workspace: workspace.name });
      scoped.addActivity({ icon: 'star', tone: 'green', line: `<strong>${escapeText(user.name)}</strong> created this workspace`, project: workspace.name });
      return { ...workspace, role: 'owner' };
    },

    renameWorkspace(auth, name) {
      const workspace = store.renameWorkspace(auth.workspace.id, name);
      if (!workspace) fail(404, 'Workspace not found.', 'not_found');
      return workspace;
    },

    // --- Members ------------------------------------------------------------

    members(workspaceId) {
      return store.listMembers(workspaceId);
    },

    setMemberRole(auth, userId, role) {
      if (!isRole(role) || role === 'owner') fail(400, 'Pick editor, admin, or viewer.', 'invalid_role', 'Ownership is transferred, not assigned.');
      const target = store.membershipOf(auth.workspace.id, userId);
      if (!target) fail(404, 'That person is not in this workspace.', 'not_a_member');
      if (target.role === 'owner') {
        fail(403, 'The owner of a workspace keeps that role. Transfer ownership to someone else first.', 'owner_required');
      }
      if (!canManageRole(auth.role, target.role, role)) {
        fail(403, auth.role === 'admin'
          ? 'An admin cannot change another admin. Ask an owner.'
          : `A ${auth.role} cannot change who is in this workspace.`, 'forbidden', 'Only owners and admins can manage members.');
      }
      store.setMemberRole(auth.workspace.id, userId, role);
      return store.listMembers(auth.workspace.id);
    },

    removeMember(auth, userId) {
      const target = store.membershipOf(auth.workspace.id, userId);
      if (!target) fail(404, 'That person is not in this workspace.', 'not_a_member');
      if (target.role === 'owner') {
        fail(403, 'The owner cannot be removed. Transfer ownership first.', 'owner_required');
      }
      if (auth.user.id !== userId && !can(auth.role, 'manage')) {
        fail(403, 'Only owners and admins can remove people.', 'forbidden');
      }
      if (auth.user.id !== userId && !canManageRole(auth.role, target.role)) {
        fail(403, 'Only an owner can remove an admin.', 'forbidden');
      }
      if (auth.user.id === userId && auth.role === 'owner') {
        fail(403, 'Owners cannot leave their own workspace. Transfer it first.', 'owner_required');
      }
      store.removeMember(auth.workspace.id, userId);
      // Removing yourself ends the session: it is pinned to this workspace.
      if (auth.user.id === userId) store.deleteSession(auth.sessionId);
      return store.listMembers(auth.workspace.id);
    },

    /** Hands the workspace over. Checked here as well as in the route. */
    transferOwnership(auth, userId) {
      this.require(auth, 'own');
      const target = store.membershipOf(auth.workspace.id, userId);
      if (!target) fail(404, 'That person is not in this workspace.', 'not_a_member');
      if (target.userId === auth.user.id) fail(400, 'You already own this workspace.', 'already_owner');
      store.setMemberRole(auth.workspace.id, userId, 'owner');
      store.setMemberRole(auth.workspace.id, auth.user.id, 'admin');
      store.transferWorkspace(auth.workspace.id, userId);
      return store.listMembers(auth.workspace.id);
    },

    // --- Invites ------------------------------------------------------------

    invite(auth, { email, role = 'editor' }, origin = '') {
      const clean = normaliseEmail(email);
      if (!looksLikeEmail(clean)) fail(400, 'That does not look like an email address.', 'invalid_email');
      if (!isRole(role) || role === 'owner') {
        fail(400, 'Invite someone as an editor, admin, or viewer.', 'invalid_role');
      }
      if (!assignable(auth.role).includes(role)) {
        fail(403, auth.role === 'admin'
          ? 'An admin cannot invite another admin.'
          : `A ${auth.role} cannot invite people to this workspace.`,
        'forbidden', 'Only an owner can invite admins; owners and admins can invite editors and viewers.');
      }
      const existing = store.getUserByEmail(clean);
      if (existing && store.membershipOf(auth.workspace.id, existing.id)) {
        fail(409, `${existing.name} is already in this workspace.`, 'already_member');
      }

      // One live invite per email per workspace: re-inviting refreshes the link.
      for (const pending of store.pendingInvitesFor(auth.workspace.id, clean)) store.revokeInvite(pending.id, auth.workspace.id);

      const token = createSessionToken();
      const invite = store.createInvite({
        workspaceId: auth.workspace.id,
        email: clean,
        role,
        tokenHash: hashToken(token),
        invitedBy: auth.user.id,
        ttlMs: inviteTtlMs,
      });
      const scoped = store.forWorkspace(auth.workspace.id);
      scoped.addActivity({
        icon: 'plus',
        tone: 'purple',
        line: `<strong>${escapeText(auth.user.name)}</strong> invited ${escapeText(clean)} as ${role}`,
        project: auth.workspace.name,
      });
      return { invite, token, acceptUrl: `${origin || ''}/?invite=${token}`, expiresInDays: authConfig.inviteTtlDays };
    },

    listInvites(workspaceId) {
      return store.listInvites(workspaceId);
    },

    revokeInvite(auth, inviteId) {
      const live = store.listInvites(auth.workspace.id).find((item) => item.id === inviteId);
      if (!live) fail(404, 'That invite is no longer active.', 'not_found');
      store.revokeInvite(inviteId, auth.workspace.id);
      return store.listInvites(auth.workspace.id);
    },

    /** Public lookup for the accept screen: who invited whom, and where to. */
    describeInvite(token) {
      const invite = store.getInviteByTokenHash(hashToken(token || ''));
      if (!invite || invite.acceptedAt) fail(404, 'That invite link is no longer valid.', 'invite_not_found');
      if (invite.status === 'expired') fail(410, 'That invite has expired.', 'invite_expired', 'Ask for a fresh invite.');
      const workspace = store.getWorkspace(invite.workspaceId);
      if (!workspace) fail(404, 'That workspace no longer exists.', 'workspace_not_found');
      const invitedBy = invite.invitedBy ? store.getUser(invite.invitedBy) : null;
      return {
        invite: { id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expiresAt },
        workspace: { id: workspace.id, name: workspace.name, memberCount: store.listMembers(workspace.id).length },
        invitedBy: invitedBy ? invitedBy.name : 'A teammate',
        existingAccount: Boolean(store.getUserByEmail(invite.email)),
      };
    },

    /** Accepting either joins an existing account or creates one. */
    async acceptInvite(token, { name, password } = {}, req = {}) {
      const invite = store.getInviteByTokenHash(hashToken(token || ''));
      if (!invite || invite.acceptedAt) fail(404, 'That invite link is no longer valid.', 'invite_not_found');
      if (invite.status === 'expired') fail(410, 'That invite has expired.', 'invite_expired');

      const row = store.getUserRowByEmail(invite.email);
      let user;
      if (row) {
        // An existing account has to prove it is the same person — either with
        // their password, or by already being signed in as that account.
        const signedIn = this.resolve(req);
        const sameAccount = signedIn && signedIn.user.id === row.id;
        if (!sameAccount) {
          const ok = await verifyPassword(password, row.password_hash);
          if (!ok) fail(401, 'Sign in with your existing password to accept this invite.', 'invalid_credentials');
        }
        user = store.getUser(row.id);
      } else {
        const passwordError = checkPasswordStrength(password);
        if (passwordError) fail(400, passwordError, 'weak_password');
        user = store.createUser({ email: invite.email, name: name || invite.email.split('@')[0], passwordHash: await hashPassword(password) });
      }

      if (!store.membershipOf(invite.workspaceId, user.id)) {
        store.addMember(invite.workspaceId, user.id, invite.role);
      }
      store.acceptInvite(invite.id, user.id);
      store.markUserSeen(user.id);
      const workspace = store.getWorkspace(invite.workspaceId);
      store.forWorkspace(workspace.id).addActivity({
        icon: 'plus',
        tone: 'green',
        line: `<strong>${escapeText(user.name)}</strong> joined the workspace as ${invite.role}`,
        project: workspace.name,
      });
      return { user, workspace: { ...workspace, role: invite.role }, invite };
    },
  };

  // --- small helpers --------------------------------------------------------

  function canManageRole(actorRole, targetRole, nextRole) {
    if (targetRole === 'owner') return false;
    if (nextRole === 'admin') return actorRole === 'owner';
    if (actorRole === 'owner') return true;
    if (actorRole === 'admin') return targetRole !== 'admin';
    return false;
  }

  function assignable(role) {
    if (role === 'owner') return ['admin', 'editor', 'viewer'];
    if (role === 'admin') return ['editor', 'viewer'];
    return [];
  }

  function verbFor(capability) {
    if (capability === 'read') return 'view this workspace';
    if (capability === 'run' || capability === 'write') return 'create or change work here';
    if (capability === 'manage') return 'manage members';
    return 'do that';
  }
}

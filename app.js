(() => {
  'use strict';

  const STORAGE = {
    projects: 'studio-os-projects-v1',
    automations: 'studio-os-automations-v1',
    settings: 'studio-os-settings-v1',
  };

  const pageNames = {
    overview: 'Overview',
    projects: 'Projects',
    canvas: 'Canvas',
    models: 'Models',
    prompts: 'Prompt library',
    automations: 'Automations',
    usage: 'Usage & billing',
    settings: 'Settings',
  };

  const seedProjects = [
    {
      id: 'p-aurora',
      title: 'Aurora — skincare launch film',
      type: 'Campaign',
      model: 'Runway Gen-4',
      status: 'Completed',
      updated: '12 min ago',
      art: 'aurora',
      prompt: 'A slow, sunlit film for a new botanical skincare line. Warm peach and rose tones, tactile close-ups of glass and water, soft morning shadows, calm editorial pacing.',
      outputs: 8,
    },
    {
      id: 'p-fieldnotes',
      title: 'Fieldnotes — visual identity',
      type: 'Brand identity',
      model: 'Flux 1.1 Pro',
      status: 'In progress',
      updated: '48 min ago',
      art: 'fieldnotes',
      prompt: 'Build a quiet, tactile identity for Fieldnotes, a sustainable outdoor journal. Pair warm paper, forest green, and understated editorial typography.',
      outputs: 14,
    },
    {
      id: 'p-nimbus',
      title: 'Nimbus product launch page',
      type: 'Website',
      model: 'Claude 4 Sonnet',
      status: 'In review',
      updated: '2 hours ago',
      art: 'nimbus',
      prompt: 'A thoughtful product landing page for Nimbus, a lightweight air-quality monitor. Calm coastal colors, generous space, clear product benefits and an editorial hero.',
      outputs: 3,
    },
    {
      id: 'p-soundscape',
      title: 'Soundscape for slow mornings',
      type: 'Audio',
      model: 'Suno v4',
      status: 'Completed',
      updated: 'Yesterday',
      art: 'soundscape',
      prompt: 'Instrumental ambient audio for a slow Sunday morning. Soft felt piano, warm tape texture, subtle field recordings, no percussion, around three minutes.',
      outputs: 4,
    },
    {
      id: 'p-atlas',
      title: 'Atlas — a weekend in Lisbon',
      type: 'Campaign',
      model: 'Flux 1.1 Pro',
      status: 'In progress',
      updated: 'Yesterday',
      art: 'atlas',
      prompt: 'A sun-faded travel editorial about finding a slower rhythm in Lisbon. Burnt terracotta, deep indigo, candid film photography and a little grain.',
      outputs: 11,
    },
    {
      id: 'p-studio',
      title: 'Studio OS mobile dashboard',
      type: 'Product design',
      model: 'Claude 4 Sonnet',
      status: 'Draft',
      updated: 'Sep 20',
      art: 'studio',
      prompt: 'Explore a mobile companion for a creative AI workspace. Make the project queue, model picker and quick capture feel calm and useful.',
      outputs: 1,
    },
  ];

  const seedAutomations = [
    { id: 'a-digest', name: 'Monday inspiration digest', description: 'Collect the week’s saved references and send a tidy Monday recap.', trigger: 'Every Monday · 9:00 AM', action: 'Curate & summarize', lastRun: 'Today, 9:00 AM', enabled: true, tone: 'purple' },
    { id: 'a-review', name: 'Ready-for-review handoff', description: 'When a project is marked ready, create a short handoff with the latest outputs.', trigger: 'When status changes to review', action: 'Draft a handoff', lastRun: 'Yesterday', enabled: true, tone: 'green' },
    { id: 'a-archive', name: 'Keep the workspace tidy', description: 'Find old experiments and group them into an archive collection.', trigger: 'On the first day of each month', action: 'Organize projects', lastRun: 'Sep 1, 2026', enabled: false, tone: 'orange' },
  ];

  let modelData = [
    { name: 'GPT-4.1', maker: 'OpenAI', logo: 'O', logoClass: 'logo-ink', description: 'A versatile reasoning model for briefs, research, and code.', tags: ['Text', 'Reasoning'], id: 'model-gpt' },
    { name: 'Claude 4 Sonnet', maker: 'Anthropic', logo: 'A', logoClass: 'logo-orange', description: 'Thoughtful writing and structured thinking for creative work.', tags: ['Text', 'Reasoning'], id: 'model-claude' },
    { name: 'Flux 1.1 Pro', maker: 'Black Forest Labs', logo: 'F', logoClass: '', description: 'Expressive, high-fidelity image generation with strong art direction.', tags: ['Image', 'Design'], id: 'model-flux' },
    { name: 'Runway Gen-4', maker: 'Runway', logo: 'R', logoClass: 'logo-blue', description: 'Bring a visual idea to life with controllable, cinematic video.', tags: ['Video', 'Motion'], id: 'model-runway' },
    { name: 'ElevenLabs v2', maker: 'ElevenLabs', logo: 'E', logoClass: 'logo-green', description: 'Natural voice and expressive narration for your next story.', tags: ['Audio', 'Voice'], id: 'model-eleven' },
    { name: 'Suno v4', maker: 'Suno', logo: 'S', logoClass: 'logo-orange', description: 'Turn a feeling, lyric, or sketch into an original song.', tags: ['Audio', 'Music'], id: 'model-suno' },
  ];

  // Replaced by the server's library as soon as /api/bootstrap answers.
  let promptData = [
    { id: 'p-brand', title: 'Brand world starter', category: 'Brand & identity', icon: 'sparkles', uses: '2.4k uses', mode: 'Image', text: 'Create a distinctive visual world for [brand]. Start with three mood directions, a considered palette, material references, and one memorable hero image. Keep it editorial, specific, and easy to art-direct.' },
    { id: 'p-campaign', title: 'Campaign concept sprint', category: 'Marketing', icon: 'wand', uses: '1.8k uses', mode: 'Writing', text: 'Develop three campaign routes for [product] and [audience]. For each route, include a one-line idea, the human insight behind it, a visual hook, sample headline, and a practical first activation.' },
    { id: 'p-product', title: 'Product page, with a point of view', category: 'Product & web', icon: 'globe', uses: '986 uses', mode: 'Writing', text: 'Write a clear, characterful landing page for [product]. Lead with the customer’s real tension, make the value concrete, use short scannable sections, and finish with a confident call to action. Avoid empty superlatives.' },
    { id: 'p-film', title: 'A film in six beats', category: 'Film & motion', icon: 'video', uses: '842 uses', mode: 'Video', text: 'Turn this idea into a 20-second film: [idea]. Write six distinct shots with framing, movement, light, sound, and transition. Keep the visual language coherent and leave room for a quiet final beat.' },
    { id: 'p-research', title: 'Make the research useful', category: 'Research', icon: 'book', uses: '721 uses', mode: 'Writing', text: 'Synthesize the following research for a creative team: [notes]. Separate what we know from what we assume, surface three useful tensions, and end with five specific questions worth exploring next.' },
    { id: 'p-sound', title: 'Soundtrack in a sentence', category: 'Audio', icon: 'audio', uses: '603 uses', mode: 'Audio', text: 'Compose an original instrumental soundscape for [scene or feeling]. Describe the tempo, core instruments, texture, dynamics, and emotional arc. Keep it original, understated, and vivid.' },
  ];

  const defaultSettings = { name: 'Alex Chen', email: 'alex@northstar.studio', workspace: 'Northstar Studio', timezone: 'Asia/Kolkata' };

  /**
   * Backend client.
   *
   * The app is fully usable without a server (demo data from local storage),
   * and upgrades itself the moment `GET /api/bootstrap` answers: real projects
   * from SQLite, the real model catalogue, real generations.
   */
  const api = {
    online: false,
    mode: 'offline',
    providers: [],
    capabilities: {},
    lastError: '',
    async request(path, { method = 'GET', body } = {}) {
      const response = await fetch(path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload?.error?.message || `Request failed (${response.status})`);
        error.hint = payload?.error?.hint || '';
        error.code = payload?.error?.code || 'request_failed';
        error.status = response.status;
        throw error;
      }
      return payload;
    },
    /** Reads a server-sent-event response, dispatching each event to a handler. */
    async stream(path, body, handlers = {}, signal) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        const error = new Error(payload?.error?.message || `Generation failed (${response.status})`);
        error.hint = payload?.error?.hint || '';
        throw error;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() || '';
        for (const block of blocks) {
          const eventLine = block.split('\n').find((line) => line.startsWith('event:'));
          const dataLine = block.split('\n').find((line) => line.startsWith('data:'));
          if (!dataLine) continue;
          const name = eventLine ? eventLine.slice(6).trim() : 'message';
          let payload = {};
          try { payload = JSON.parse(dataLine.slice(5).trim()); } catch { payload = {}; }
          handlers[name]?.(payload);
        }
      }
      return true;
    },
  };

  const state = {
    page: 'overview',
    projectFilter: 'All projects',
    projectSearch: '',
    promptSearch: '',
    promptCategory: 'All prompts',
    selectedModel: 'Auto select',
    promptMode: 'Image',
    modalType: '',
    previousFocus: null,
    popover: null,
    settingsTab: 'Profile',
    notificationsRead: false,
    attachments: [],       // reference files waiting to be sent with a prompt
    uploads: [],           // files stored on the server for this workspace
    models: null,          // live catalogue once the server answers
    usage: null,           // live usage summary
    generation: null,      // in-flight generation view state
    modelFilter: 'All models',
    projects: readStorage(STORAGE.projects, seedProjects),
    automations: readStorage(STORAGE.automations, seedAutomations),
    settings: readStorage(STORAGE.settings, defaultSettings),
    activity: [
      { icon: 'wand', tone: '', line: '<strong>Flux 1.1 Pro</strong> created 4 new variations', project: 'Fieldnotes identity', time: '18 minutes ago' },
      { icon: 'check', tone: 'green', line: '<strong>Runway Gen-4</strong> finished a video generation', project: 'Aurora launch film', time: '42 minutes ago' },
      { icon: 'file', tone: 'orange', line: '<strong>Claude 4 Sonnet</strong> updated a project brief', project: 'Nimbus product page', time: '2 hours ago' },
    ],
  };

  // Storage is an optional convenience for this static, no-backend starter app.
  function readStorage(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      if (value) {
        const parsed = JSON.parse(value);
        if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback;
        if (parsed && typeof parsed === 'object') return { ...fallback, ...parsed };
      }
    } catch (error) {
      console.info('Using in-memory demo data; local storage is unavailable.', error);
    }
    return Array.isArray(fallback) ? fallback.map((item) => ({ ...item })) : { ...fallback };
  }

  function saveStorage(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* Private browsing may disable storage. */ }
  }

  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const icon = (name, extraClass = '') => `<svg class="icon ${extraClass}" aria-hidden="true"><use href="#i-${escapeHTML(name)}"></use></svg>`;

  /** Small preview chips for the files waiting to be sent with the next prompt. */
  function attachmentStripHTML() {
    if (!state.attachments.length) return '';
    const chips = state.attachments.map((file) => `<span class="attachment-chip ${file.uploading ? 'is-uploading' : ''}" data-file-id="${escapeHTML(file.id || '')}">${icon(file.isImage ? 'image' : 'file', 'icon-small')}<span class="attachment-name">${escapeHTML(file.name)}</span><span class="attachment-size">${escapeHTML(humanSize(file.size))}</span>${file.uploading ? '' : `<button type="button" data-action="remove-attachment" data-id="${escapeHTML(file.id)}" aria-label="Remove ${escapeHTML(file.name)}">${icon('close', 'icon-small')}</button>`}</span>`).join('');
    return `<div class="attachment-strip" aria-label="Attached reference files">${chips}</div>`;
  }

  function humanSize(bytes) {
    const value = Number(bytes) || 0;
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${Math.round(value / 102.4) / 10} KB`;
    return `${Math.round(value / (1024 * 102.4)) / 10} MB`;
  }

  /**
   * Uploads the picked files, then re-renders only the attachment strip so the
   * text the user has already typed is never disturbed.
   */
  async function uploadAttachments(fileList) {
    const picked = Array.from(fileList || []).slice(0, 8);
    if (!picked.length) return;
    if (!api.online) {
      showToast('Start the Studio server (npm start) to attach reference files.', 'error');
      return;
    }

    const pending = picked.map((file) => ({ id: `pending-${Math.random().toString(36).slice(2, 8)}`, name: file.name, size: file.size, isImage: file.type.startsWith('image/'), uploading: true }));
    state.attachments = [...state.attachments, ...pending];
    refreshAttachmentStrip();

    const form = new FormData();
    for (const file of picked) form.append('files', file, file.name);
    try {
      const response = await fetch('/api/files', { method: 'POST', body: form });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error?.message || 'The upload failed.');
      const uploadedIds = new Set(payload.files.map((file) => file.id));
      state.attachments = state.attachments.filter((file) => !pending.some((item) => item.id === file.id)).concat(payload.files);
      if (Array.isArray(payload.files)) state.uploads = [...payload.files, ...state.uploads];
      showToast(`${payload.files.length} file${payload.files.length === 1 ? '' : 's'} attached.`);
    } catch (error) {
      state.attachments = state.attachments.filter((file) => !pending.some((item) => item.id === file.id));
      showToast(error.message, 'error');
    } finally {
      refreshAttachmentStrip();
      const input = document.getElementById('attachment-input');
      if (input) input.value = '';
    }
  }

  function refreshAttachmentStrip() {
    const strip = document.querySelector('.attachment-strip');
    if (strip) {
      strip.outerHTML = attachmentStripHTML();
      // An empty strip leaves nothing behind, so repaint the composer instead.
      if (!state.attachments.length) renderPage();
    } else if (state.attachments.length) {
      renderPage();
    }
  }
  const currentPageName = () => pageNames[state.page] || 'Overview';

  function updateShell() {
    const pageNameNode = document.getElementById('current-page-name');
    if (pageNameNode) pageNameNode.textContent = currentPageName();
    document.title = `${currentPageName()} · AI Studio OS`;
    document.querySelectorAll('.sidebar .nav-link[data-page]').forEach((item) => {
      item.classList.toggle('is-active', item.dataset.page === state.page);
      if (item.matches('a')) item.setAttribute('aria-current', item.dataset.page === state.page ? 'page' : 'false');
    });
    const count = document.getElementById('project-count');
    if (count) count.textContent = String(state.projects.length);
    const credits = document.getElementById('sidebar-credits');
    if (credits) {
      const used = state.usage?.plan?.creditsUsed ?? 6820;
      credits.textContent = used.toLocaleString('en-US');
    }
    updateEnvPill();
  }

  /** The pill that tells the truth about where generations come from. */
  function updateEnvPill() {
    const pill = document.querySelector('.env-pill');
    const label = document.getElementById('env-label');
    if (!pill || !label) return;
    pill.classList.toggle('is-live', api.online && api.mode === 'live');
    pill.classList.toggle('is-demo', api.online && api.mode !== 'live');
    pill.classList.toggle('is-offline', !api.online);
    if (!api.online) label.textContent = 'Demo mode';
    else label.textContent = api.mode === 'live' ? 'Live models' : 'Demo engine';
    const planBar = document.querySelector('.plan-progress span');
    if (planBar && state.usage?.plan) {
      const percent = Math.min(100, Math.round((state.usage.plan.creditsUsed / state.usage.plan.creditsIncluded) * 100));
      planBar.style.width = `${percent}%`;
      const percentLabel = document.querySelector('.plan-percent');
      if (percentLabel) percentLabel.textContent = `${percent}%`;
    }
  }

  const providerLabel = (id) => api.providers.find((provider) => provider.id === id)?.label || id;
  const configuredProviders = () => api.providers.filter((provider) => provider.configured && provider.id !== 'mock');
  const hasLiveProviders = () => configuredProviders().length > 0;

  function navigate(page) {
    if (!pageNames[page]) return;
    state.page = page;
    state.projectSearch = '';
    state.promptSearch = '';
    closePopover();
    closeSidebar();
    updateShell();
    renderPage();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderPage() {
    const content = document.getElementById('app-content');
    if (!content) return;
    const renderers = {
      overview: renderDashboard,
      projects: renderProjectsPage,
      canvas: renderCanvasPage,
      models: renderModelsPage,
      prompts: renderPromptsPage,
      automations: renderAutomationsPage,
      usage: renderUsagePage,
      settings: renderSettingsPage,
    };
    content.innerHTML = (renderers[state.page] || renderDashboard)();
    updateShell();
    if (state.page === 'automations') loadAutomationRuns();
    if (state.page === 'settings' && state.settingsTab === 'Connections') loadWorkspaceFiles();
  }

  function getArtMarkup(project) {
    const known = ['aurora', 'fieldnotes', 'nimbus', 'soundscape', 'atlas', 'studio', 'new'];
    const art = known.includes(project.art) ? project.art : 'studio';
    const artInside = {
      aurora: '',
      fieldnotes: '<div class="fieldnote-paper"><span>FIELD NOTES</span><span>Take the long way</span></div>',
      nimbus: '<div class="nimbus-ui"></div>',
      soundscape: '<div class="sound-wave"></div>',
      atlas: '<div class="atlas-shape"></div>',
      studio: '<div class="studio-panels"><span></span><span></span><span></span></div>',
      new: icon('plus'),
    }[art];
    const artLabel = {
      aurora: 'AURORA · BOTANICAL SKINCARE',
      fieldnotes: 'FIELDNOTES · IDENTITY STUDY',
      nimbus: 'NIMBUS · PRODUCT EXPERIENCE',
      soundscape: 'SOUNDSCAPE · SLOW MORNING',
      atlas: 'ATLAS · LISBON, UNHURRIED',
      studio: 'STUDIO OS · PRODUCT DESIGN',
      new: '',
    }[art];
    const status = ['Completed', 'In progress', 'In review', 'Generating', 'Draft'].includes(project.status) ? project.status : 'Draft';
    const statusClass = status.toLowerCase().replaceAll(' ', '-');
    return `<div class="project-art project-art--${art}">${artInside}${artLabel ? `<span class="art-overlay-label">${artLabel}</span>` : ''}<span class="project-status status-${statusClass}"><i class="status-dot"></i>${escapeHTML(status)}</span></div>`;
  }

  function projectCard(project, context = '') {
    const id = escapeHTML(project.id);
    const title = escapeHTML(project.title);
    return `<article class="project-card ${context ? `project-card--${context}` : ''}">
      <button type="button" class="project-art-button" data-action="open-project" data-id="${id}" aria-label="Open project: ${title}">${getArtMarkup(project)}</button>
      <div class="project-info">
        <div class="project-title-line">
          <button type="button" class="project-title-button" data-action="open-project" data-id="${id}">${title}</button>
          <button type="button" class="project-menu-button" data-action="project-menu" data-id="${id}" aria-label="More actions for ${title}">${icon('more')}</button>
        </div>
        <div class="project-meta"><span class="project-type">${escapeHTML(project.type)}</span><span class="meta-separator"></span><span>${escapeHTML(project.updated || 'Just now')}</span></div>
      </div>
    </article>`;
  }

  function renderDashboard() {
    const activeCount = state.projects.filter((project) => project.status !== 'Completed').length;
    const creditsUsed = state.usage?.plan?.creditsUsed ?? 6820;
    const creditsIncluded = state.usage?.plan?.creditsIncluded ?? 10_000;
    const projectCards = state.projects.slice(0, 2).map((project) => projectCard(project, 'home')).join('');
    const dateText = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());
    const activityRows = state.activity.slice(0, 3).map((item) => `<div class="activity-item"><span class="activity-icon ${escapeHTML(item.tone || '')}">${icon(item.icon)}</span><div class="activity-copy"><p>${item.line}</p><time>${escapeHTML(item.time)}</time></div></div>`).join('');
    return `<section class="welcome-row" aria-labelledby="welcome-heading">
      <div><div class="eyebrow">Your creative space</div><h1 id="welcome-heading">Good morning, Alex</h1><p>Here’s what’s happening in your studio today.</p></div>
      <div class="date-badge">${icon('sun')}<span>${escapeHTML(dateText)}</span></div>
    </section>

    <section class="hero-card" aria-labelledby="hero-heading">
      <div class="hero-top">
        <div class="hero-copy"><div class="hero-eyebrow">${icon('sparkles')} One studio. Every model.</div><h2 id="hero-heading">Turn a spark into <em>something real.</em></h2><p class="hero-subtitle">Start with a thought. Your best tools are already here.</p></div>
        <div class="hero-art" aria-hidden="true"><span class="hero-orbit"></span><span class="hero-orb"></span><span class="hero-spark">✳</span><span class="hero-note">${icon('lightning')} A little more flow</span></div>
      </div>
      <form class="prompt-box" id="prompt-form">
        <label class="sr-only" for="main-prompt">Describe what you want to create</label>
        <textarea id="main-prompt" name="prompt" rows="2" placeholder="Describe an idea, paste a brief, or drop a task to get started..."></textarea>
        ${attachmentStripHTML()}
        <div class="prompt-footer">
          <div class="prompt-tools">
            <button class="prompt-tool" type="button" data-action="choose-mode" aria-label="Choose creation type">${icon(modeIcon(state.promptMode))}<span id="selected-mode">${escapeHTML(state.promptMode)}</span>${icon('chevron-down', 'icon-small')}</button>
            <button class="prompt-tool model-tool" type="button" data-action="choose-model" aria-label="Choose an AI model">${icon('sliders')}<span id="selected-model">${escapeHTML(state.selectedModel)}</span>${icon('chevron-down', 'icon-small')}</button>
            <button class="prompt-tool" type="button" data-action="attach-files" aria-label="Attach reference files">${icon('paperclip')}<span>Attach</span>${state.attachments.length ? `<span class="prompt-tool-count">${state.attachments.length}</span>` : ''}</button>
            <button class="prompt-tool prompt-enhance" type="button" data-action="enhance-prompt">${icon('wand')}<span>Polish</span></button>
            <input type="file" id="attachment-input" class="sr-only" multiple accept="image/*,.pdf,.txt,.md,.csv,.json" />
          </div>
          <button class="prompt-submit" type="submit" aria-label="Start creating">${icon('arrow-right')}</button>
        </div>
      </form>
      <span class="prompt-hint">${api.online
        ? `The arrow sends this to ${escapeHTML(state.selectedModel)} and saves the result in a new project`
        : 'Start the Studio server to generate — an idea is still saved as a project'}</span>
    </section>

    <section class="metrics-grid" aria-label="Workspace summary">
      <article class="metric-card"><div class="metric-topline"><span>Monthly credits</span><span class="metric-icon">${icon('lightning')}</span></div><div class="metric-main"><strong class="metric-value">${creditsUsed.toLocaleString('en-US')}</strong><span class="metric-meta">of ${creditsIncluded.toLocaleString('en-US')} used</span></div><div class="mini-progress"><span style="width:${Math.min(100, Math.round((creditsUsed / creditsIncluded) * 100))}%"></span></div></article>
      <article class="metric-card"><div class="metric-topline"><span>Active projects</span><span class="metric-icon green">${icon('folder')}</span></div><div class="metric-main"><strong class="metric-value">${activeCount}</strong><span class="metric-meta positive">${state.projects.length} total in your studio</span></div></article>
      <article class="metric-card"><div class="metric-topline"><span>${state.usage ? 'Generations this month' : 'Time saved this month'}</span><span class="metric-icon peach">${icon(state.usage ? 'sparkles' : 'clock')}</span></div><div class="metric-main">${state.usage
        ? `<strong class="metric-value">${state.usage.totals.generations}</strong><span class="metric-meta positive">avg ${(state.usage.totals.avgLatencyMs / 1000).toFixed(1)}s per run</span>`
        : `<strong class="metric-value">12.4 hrs</strong><span class="metric-meta positive">↑ 18% from last month</span>`}</div></article>
    </section>

    <div class="home-columns">
      <section class="recent-projects" aria-labelledby="recent-heading">
        <div class="section-head"><div class="section-title-group"><div><h2 id="recent-heading">Pick up where you left off</h2><p class="section-subtitle">Your recent work, all in one place.</p></div></div><button class="text-link" type="button" data-page="projects">All projects ${icon('arrow-right')}</button></div>
        ${projectCards ? `<div class="project-grid">${projectCards}</div>` : `<div class="empty-state"><div><span class="empty-state-icon">${icon('folder')}</span><h2>A fresh start</h2><p>Create a project to bring all your ideas and generations together.</p><button class="primary-button" type="button" data-action="new-project">${icon('plus')} New project</button></div></div>`}
      </section>
      <aside class="activity-panel" aria-labelledby="activity-heading">
        <div class="section-head"><div><h2 id="activity-heading">Studio activity</h2><p class="section-subtitle">The latest from your workspace.</p></div><button class="quiet-button" type="button" data-action="activity-refresh" aria-label="Refresh activity">${icon('refresh')}</button></div>
        <div class="activity-list">${activityRows || '<p class="section-subtitle">Nothing new just yet.</p>'}</div>
        <div class="activity-divider"></div>
        <button class="usage-nudge" type="button" data-page="usage" style="width:100%;border:0;text-align:left;cursor:pointer"><span class="nudge-icon">${icon('lightning')}</span><p><strong>Your studio is in good shape</strong>Credits reset in 12 days.</p>${icon('arrow-right', 'icon-arrow')}</button>
      </aside>
    </div>`;
  }

  function modeIcon(mode) {
    return ({ Image: 'image', Video: 'video', Writing: 'file', Audio: 'audio', Code: 'code' })[mode] || 'sparkles';
  }

  const projectFilters = ['All projects', 'In progress', 'In review', 'Completed', 'Draft'];

  function renderProjectsPage() {
    return `<section class="page-heading"><div><div class="eyebrow">Your workspace</div><h1>Projects</h1><p>Ideas, experiments, and finished work — gathered in one place.</p></div><button class="primary-button" type="button" data-action="new-project">${icon('plus')} New project</button></section>
      <div class="toolbar-row"><div class="filter-tabs" role="tablist" aria-label="Filter projects">${projectFilters.map((filter) => `<button class="filter-tab ${state.projectFilter === filter ? 'is-active' : ''}" type="button" role="tab" aria-selected="${state.projectFilter === filter}" data-action="project-filter" data-filter="${escapeHTML(filter)}">${escapeHTML(filter)}</button>`).join('')}</div><label class="inline-search">${icon('search')}<span class="sr-only">Search projects</span><input id="project-search" type="search" value="${escapeHTML(state.projectSearch)}" placeholder="Search projects..." /></label></div>
      <div id="projects-results">${projectListHTML()}</div>`;
  }

  function projectListHTML() {
    const query = state.projectSearch.trim().toLowerCase();
    const shown = state.projects.filter((project) => {
      const matchesFilter = state.projectFilter === 'All projects' || project.status === state.projectFilter || (state.projectFilter === 'In progress' && project.status === 'Generating');
      const matchesSearch = !query || `${project.title} ${project.type} ${project.model}`.toLowerCase().includes(query);
      return matchesFilter && matchesSearch;
    });
    if (!shown.length) return `<div class="empty-state"><div><span class="empty-state-icon">${icon('search')}</span><h2>No projects found</h2><p>Try a different search or clear the current filter.</p><button class="secondary-button" type="button" data-action="clear-project-filters">Clear filters</button></div></div>`;
    return `<div class="projects-page-grid">${shown.map((project) => projectCard(project, 'full')).join('')}</div>`;
  }

  function renderCanvasPage() {
    const boards = state.projects.filter((project) => /design|identity|website|canvas|product/i.test(`${project.type} ${project.title}`)).slice(0, 3);
    return `<section class="page-heading"><div><div class="eyebrow">Think in possibilities</div><h1>Canvas</h1><p>A flexible space to connect references, prompts, and generations.</p></div><button class="secondary-button" type="button" data-action="canvas-tips">${icon('help')} Canvas guide</button></section>
      <section class="canvas-hero"><div class="canvas-hero-copy"><div class="eyebrow">${icon('sparkles')} Your visual thinking space</div><h2>Make room for the messy middle.</h2><p>Pull ideas together, explore directions side by side, and turn the promising ones into a project. Your next great idea probably isn’t linear.</p><button class="primary-button" type="button" data-action="create-canvas">${icon('plus')} Create a canvas</button></div><div class="canvas-board" aria-hidden="true"><div class="board-card board-card-one"></div><div class="board-connector"></div><div class="board-card board-card-two"></div><div class="board-card board-card-three"></div><div class="canvas-tools"><span>${icon('image')}</span><span>${icon('file')}</span><span>${icon('wand')}</span><span>${icon('plus')}</span></div></div></section>
      <h2 class="canvas-section-title">A good canvas can help you...</h2><div class="feature-card-grid"><article class="feature-card"><span class="feature-icon">${icon('image')}</span><h3>Gather your references</h3><p>Keep images, notes, and raw thoughts near the work they inspire.</p></article><article class="feature-card"><span class="feature-icon">${icon('sparkles')}</span><h3>Explore a few directions</h3><p>Try a prompt with different models without losing your starting point.</p></article><article class="feature-card"><span class="feature-icon">${icon('workflow')}</span><h3>Connect the dots</h3><p>Move from a loose idea to a clear brief and an actionable project.</p></article></div>
      <h2 class="canvas-section-title">Recent boards</h2>${boards.length ? `<div class="project-grid">${boards.slice(0, 2).map((project) => projectCard(project, 'home')).join('')}</div>` : `<div class="empty-state"><div><span class="empty-state-icon">${icon('canvas')}</span><h2>Your board starts here</h2><p>Create a canvas to collect references and explore your first direction.</p></div></div>`}`;
  }

  const modelFilters = ['All models', 'Text', 'Image'];

  function renderModelsPage() {
    const live = Array.isArray(state.models) && state.models.length > 0;
    const count = live ? state.models.length : modelData.length;
    const strip = live
      ? `<div class="provider-strip">${api.providers.map((provider) => `<span class="provider-chip ${provider.configured ? 'is-on' : ''}"><span class="status-dot" style="background:${provider.configured ? '#4fb483' : '#d7d5e0'}"></span>${escapeHTML(provider.label)} <small>${provider.configured ? (provider.isDemo ? 'demo' : 'connected') : 'not set'}</small></span>`).join('')}</div>`
      : '';
    return `<section class="page-heading"><div><div class="eyebrow">The right tool for the thought</div><h1>Models</h1><p>Choose a favorite, or let Studio OS route each task to a good fit.</p></div><button class="secondary-button" type="button" data-action="refresh-models">${icon('refresh')} Refresh catalogue</button></section>
      ${strip}
      <div class="toolbar-row"><div class="filter-tabs" role="tablist" aria-label="Model families">${modelFilters.map((filter) => `<button class="filter-tab ${state.modelFilter === filter ? 'is-active' : ''}" type="button" role="tab" aria-selected="${state.modelFilter === filter}" data-action="model-filter" data-filter="${escapeHTML(filter)}">${escapeHTML(filter)}</button>`).join('')}</div><span class="section-subtitle">${count} model${count === 1 ? '' : 's'} ${live ? 'in this build' : 'in the demo catalogue'}</span></div>
      <div class="model-grid" id="model-results">${modelCardsHTML(state.modelFilter)}</div>`;
  }

  function modelCardsHTML(filter) {
    // Live entries carry provider/model facts; the demo catalogue keeps the UI
    // useful before a server is running.
    const source = Array.isArray(state.models) && state.models.length
      ? state.models.map((model) => ({
        name: model.name,
        maker: `${model.providerLabel || model.maker}${model.isDemo ? ' · demo' : ''}`,
        logo: String(model.name || '?').slice(0, 1).toUpperCase(),
        logoClass: '',
        description: `${model.description}${model.descriptionNote ? ` ${model.descriptionNote}` : ''}`,
        tags: [model.kind === 'image' ? 'Image' : 'Text', ...(model.tags || [])],
        kind: model.kind,
        selectable: model.selectable,
        isDemo: model.isDemo,
        verified: model.verified,
        pricing: model.pricing,
      }))
      : modelData.map((model) => ({ ...model, kind: model.tags.includes('Image') ? 'image' : 'text', selectable: true }));
    const shown = source.filter((model) => filter === 'All models' || model.tags.includes(filter));
    if (!shown.length) return '<div class="empty-state"><div><h2>No models in this category</h2><p>Choose a different model family.</p></div></div>';
    return shown.map((model) => {
      const flags = [
        model.isDemo ? '<span class="badge badge-demo">DEMO</span>' : '',
        model.selectable && !model.isDemo ? '<span class="badge badge-live">CONNECTED</span>' : '',
        model.selectable === false ? '<span class="badge badge-off">NEEDS KEY</span>' : '',
        model.verified === false ? '<span class="badge badge-off">ID UNVERIFIED</span>' : '',
      ].filter(Boolean).join('');
      const price = model.pricing
        ? (model.pricing.unit === 'usd-per-image'
          ? `~$${model.pricing.perImage}/image`
          : `~$${model.pricing.input}/$${model.pricing.output} per M tokens`)
        : '';
      return `<article class="model-card ${model.selectable === false ? 'model-unavailable' : ''}"><span class="model-status">${model.selectable === false ? 'Needs a key' : 'Available'}</span><div class="model-card-top"><span class="model-logo ${model.logoClass || ''}">${escapeHTML(model.logo)}</span><div><h3>${escapeHTML(model.name)}</h3><span class="model-maker">${escapeHTML(model.maker)}</span></div></div><p>${escapeHTML(model.description)}</p><div class="model-flags">${flags}</div><div class="model-card-bottom"><div class="model-tags">${model.tags.slice(0, 3).map((tag) => `<span>${escapeHTML(tag)}</span>`).join('')}</div><button class="text-link" type="button" data-action="use-model" data-model="${escapeHTML(model.name)}" ${model.selectable === false ? 'disabled title="Add this provider key to .env first"' : ''}>Use model ${icon('arrow-right')}</button></div>${price ? `<span class="model-price">Estimated pricing: ${escapeHTML(price)} — verify with the provider.</span>` : ''}</article>`;
    }).join('');
  }

  function renderPromptsPage() {
    const categories = ['All prompts', 'Brand & identity', 'Marketing', 'Product & web', 'Film & motion', 'Research', 'Audio'];
    return `<section class="page-heading"><div><div class="eyebrow">A little help getting started</div><h1>Prompt library</h1><p>Thoughtful starting points, ready to make your own.</p></div><button class="secondary-button" type="button" data-action="save-prompt-info">${icon('plus')} Save a prompt</button></section>
      <div class="toolbar-row"><div class="filter-tabs prompt-filters" role="tablist" aria-label="Filter prompts">${categories.map((category) => `<button type="button" class="filter-tab ${state.promptCategory === category ? 'is-active' : ''}" data-action="prompt-category" data-filter="${escapeHTML(category)}">${escapeHTML(category)}</button>`).join('')}</div><label class="inline-search">${icon('search')}<span class="sr-only">Search prompts</span><input id="prompt-search" type="search" value="${escapeHTML(state.promptSearch)}" placeholder="Search prompts..." /></label></div>
      <div id="prompts-results">${promptCardsHTML()}</div>`;
  }

  /** Use counts arrive as numbers from the server and as strings in demo data. */
  const formatUses = (uses) => {
    if (typeof uses === 'string') return uses;
    const value = Number(uses) || 0;
    if (value >= 1000) return `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k uses`;
    return `${value} use${value === 1 ? '' : 's'}`;
  };

  function promptCardsHTML() {
    const query = state.promptSearch.toLowerCase().trim();
    const shown = promptData.filter((prompt) => (state.promptCategory === 'All prompts' || prompt.category === state.promptCategory) && (!query || `${prompt.title} ${prompt.category} ${prompt.text}`.toLowerCase().includes(query)));
    if (!shown.length) return `<div class="empty-state"><div><span class="empty-state-icon">${icon('search')}</span><h2>No prompts found</h2><p>Try another phrase or choose a different category.</p></div></div>`;
    return `<div class="prompt-grid">${shown.map((prompt) => `<article class="prompt-card"><div class="prompt-card-head"><span class="prompt-card-icon">${icon(prompt.icon)}</span><div><h3>${escapeHTML(prompt.title)}</h3><span class="prompt-category">${escapeHTML(prompt.category)}</span></div></div><blockquote>${escapeHTML(prompt.text)}</blockquote><div class="prompt-card-footer"><span class="prompt-usage">${escapeHTML(formatUses(prompt.uses))}</span><button class="text-link" type="button" data-action="use-prompt" data-id="${escapeHTML(prompt.id)}">Use prompt ${icon('arrow-right')}</button></div></article>`).join('')}</div>`;
  }

  /** File count + scheduler health, refreshed whenever Connections is opened. */
  async function loadWorkspaceFiles() {
    if (!api.online) return;
    try {
      const [filePayload, scheduler] = await Promise.all([
        api.request('/api/files?limit=50'),
        api.request('/api/scheduler'),
      ]);
      state.uploads = filePayload.files;
      state.scheduler = scheduler;
      if (state.page === 'settings') {
        const content = document.getElementById('app-content');
        if (content) content.innerHTML = renderSettingsPage();
      }
    } catch { /* settings still render without storage stats */ }
  }

  /**
   * The bootstrap payload stays small, so run history is fetched when the

   * automations page is actually opened. One in-flight request at a time.
   */
  async function loadAutomationRuns({ force = false } = {}) {
    if (!api.online || state.automationRunsLoading) return;
    // Rendering the page repeatedly must not turn into a request storm.
    if (!force && state.automationRunsFetchedAt && Date.now() - state.automationRunsFetchedAt < 4000) return;
    state.automationRunsLoading = true;
    try {
      const payload = await api.request('/api/automations?runs=1');
      state.automations = payload.automations;
      if (payload.stats) state.automationStats = payload.stats;
      state.automationRunsFetchedAt = Date.now();
      if (payload.scheduler) state.scheduler = payload.scheduler;
      if (state.page === 'automations') {
        const content = document.getElementById('app-content');
        if (content) content.innerHTML = renderAutomationsPage();
      }
    } catch { /* the list is still usable without history */ } finally {
      state.automationRunsLoading = false;
    }
  }

  /** Turns the schedule builder's fields into the server's schedule shape. */
  function scheduleFromForm(data) {
    const kind = String(data.get('kind') || 'daily');
    const time = String(data.get('time') || '09:00');
    if (kind === 'weekly') return { type: 'daily', time, daysOfWeek: [Number(data.get('weekday'))] };
    if (kind === 'monthly') return { type: 'monthly', day: Number(data.get('day')), time };
    if (kind === 'interval') return { type: 'interval', everyMinutes: Number(data.get('everyMinutes')) };
    if (kind === 'event') {
      const [event, value] = String(data.get('event') || 'project.status:In review').split(':');
      return { type: 'event', event, value };
    }
    if (kind === 'manual') return { type: 'manual' };
    return { type: 'daily', time, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] };
  }

  /** Shows only the fields the chosen schedule type needs. */
  function syncScheduleFields(scope) {
    const kind = scope.querySelector('[data-schedule-kind]')?.value;
    for (const block of scope.querySelectorAll('[data-schedule-fields]')) {
      block.hidden = !block.dataset.scheduleFields.split(' ').includes(kind);
    }
  }

  /** Last few runs of a workflow, straight from the server's run history. */
  function automationRunsHTML(automation) {
    const runs = automation.runs || [];
    if (!runs.length) return '';
    return `<div class="automation-runs">${runs.map((run) => `<div class="automation-run"><span class="status-dot ${escapeHTML(run.status)}"></span><span>${escapeHTML(run.status === 'succeeded' ? 'Ran' : run.status === 'failed' ? 'Failed' : 'Skipped')} ${escapeHTML(run.createdLabel || '')}</span><span>${escapeHTML((run.note || '').slice(0, 54))}</span></div>`).join('')}</div>`;
  }

  function schedulerHeadline() {
    const scheduler = state.scheduler;
    if (!scheduler) return 'Unknown';
    if (!scheduler.enabled) return 'Paused';
    return scheduler.active ? 'Checking every ' + Math.round(scheduler.tickMs / 1000) + 's' : 'Stopped';
  }

  function schedulerDetail() {
    const scheduler = state.scheduler;
    if (!scheduler) return 'No scheduler status from the server yet.';
    const runs = scheduler.counts?.runs || 0;
    return `${runs} scheduled run${runs === 1 ? '' : 's'} · ${escapeHTML(scheduler.timeZone || 'UTC')}`;
  }

  function renderAutomationsPage() {
    return `<section class="page-heading"><div><div class="eyebrow">Let the small things run themselves</div><h1>Automations</h1><p>Make repeatable creative work feel a little less repetitive.</p></div><button class="primary-button" type="button" data-action="new-automation">${icon('plus')} New automation</button></section>
      <section class="metrics-grid" aria-label="Automation summary"><article class="metric-card"><div class="metric-topline"><span>Active automations</span><span class="metric-icon">${icon('workflow')}</span></div><div class="metric-main"><strong class="metric-value">${state.automations.filter((automation) => automation.enabled).length}</strong><span class="metric-meta">out of ${state.automations.length} workflows</span></div></article><article class="metric-card"><div class="metric-topline"><span>Runs this month</span><span class="metric-icon green">${icon('refresh')}</span></div><div class="metric-main"><strong class="metric-value">${escapeHTML(String(state.automationStats?.recent ?? 0))}</strong><span class="metric-meta">${escapeHTML(state.automationStats?.total ? `${state.automationStats.total} recorded in total` : 'no runs recorded yet')}</span></div></article><article class="metric-card"><div class="metric-topline"><span>The scheduler</span><span class="metric-icon peach">${icon('clock')}</span></div><div class="metric-main"><strong class="metric-value">${escapeHTML(schedulerHeadline())}</strong><span class="metric-meta">${escapeHTML(schedulerDetail())}</span></div></article></section>
      <div class="section-head"><div><h2>Your workflows</h2><p class="section-subtitle">Pause, run, or refine a workflow any time.</p></div><button class="text-link" type="button" data-action="automation-templates">Browse templates ${icon('arrow-right')}</button></div>
      <div class="automation-list">${state.automations.map((automation) => `<article class="automation-row"><span class="automation-icon ${escapeHTML(automation.tone || '')}">${icon('workflow')}</span><div class="automation-main"><h3>${escapeHTML(automation.name)}</h3><p>${escapeHTML(automation.description)}</p>${automationRunsHTML(automation)}</div><span class="automation-meta">${escapeHTML(automation.trigger || automation.triggerLabel || 'On demand')}${automation.nextRunLabel ? `<span class="automation-schedule">Next run ${escapeHTML(automation.nextRunLabel)}</span>` : (automation.schedule?.type === 'event' ? '<span class="automation-schedule">Runs when the event fires</span>' : '')}</span><button type="button" class="quiet-button" data-action="run-automation" data-id="${escapeHTML(automation.id)}" aria-label="Run ${escapeHTML(automation.name)} now">${icon('play')}</button><button type="button" class="toggle" role="switch" aria-checked="${Boolean(automation.enabled)}" aria-label="${automation.enabled ? 'Pause' : 'Enable'} ${escapeHTML(automation.name)}" data-action="toggle-automation" data-id="${escapeHTML(automation.id)}"></button></article>`).join('') || `<div class="empty-state"><div><span class="empty-state-icon">${icon('workflow')}</span><h2>No workflows yet</h2><p>Create your first automation to take a repeatable task off your hands.</p><button class="primary-button" type="button" data-action="new-automation">${icon('plus')} New automation</button></div></div>`}</div>`;
  }

  /**
   * Usage is real once the server is up: credits come from recorded
   * generations, and the breakdown and history are aggregates over them.
   */
  function renderUsagePage() {
    const usage = state.usage;
    if (usage) return renderLiveUsagePage(usage);
    const totalUsed = 6820 + Math.max(0, state.projects.length - seedProjects.length) * 30;
    const percent = Math.min(100, Math.round((totalUsed / 10000) * 100));
    const chart = [40, 62, 53, 82, 64, 92, 68].map((height, index) => `<div class="chart-column"><span style="height:${height}%"></span><small>${['M', 'T', 'W', 'T', 'F', 'S', 'S'][index]}</small></div>`).join('');
    return `<section class="page-heading"><div><div class="eyebrow">A clear view of your creative fuel</div><h1>Usage & billing</h1><p>Keep an eye on your credits and the work they’re powering.</p></div><button class="secondary-button" type="button" data-action="download-usage">${icon('download')} Export usage</button></section>
      <div class="usage-overview"><section class="usage-card"><div class="usage-card-head"><div><h2>Studio plan · monthly credits</h2><p>Your plan renews on October 6, 2026.</p></div><button type="button" class="secondary-button" data-action="manage-plan">Manage plan</button></div><div class="credits-number">${totalUsed.toLocaleString('en-US')} <span>/ 10,000 credits used</span></div><div class="credits-bar"><span style="width:${percent}%"></span></div><div class="credits-labels"><span>${percent}% used</span><span>${(10000 - totalUsed).toLocaleString('en-US')} credits left</span></div></section>
      <section class="usage-card"><div class="usage-card-head"><div><h2>Credits by creative tool</h2><p>A snapshot of where this month went.</p></div><span class="metric-icon">${icon('chart')}</span></div><div class="usage-breakdown"><div class="usage-row"><span class="usage-color"></span><span class="usage-row-name">Image generation</span><span class="usage-row-value">3,280</span></div><div class="usage-row"><span class="usage-color green"></span><span class="usage-row-name">Video & motion</span><span class="usage-row-value">2,140</span></div><div class="usage-row"><span class="usage-color orange"></span><span class="usage-row-name">Text & audio</span><span class="usage-row-value">1,400</span></div></div></section></div>
      <section class="usage-card" style="margin-bottom:16px"><div class="usage-card-head"><div><h2>Daily activity</h2><p>Credits used across the last seven days.</p></div><span class="detail-tag">This week</span></div><div class="mini-chart" aria-label="Weekly credit activity">${chart}</div></section>
      <div class="section-head"><div><h2>Recent usage</h2><p class="section-subtitle">The latest model activity in your studio.</p></div></div><div class="usage-table-wrap"><table class="usage-table"><thead><tr><th>ACTIVITY</th><th>MODEL</th><th>PROJECT</th><th>DATE</th><th>CREDITS</th></tr></thead><tbody><tr><td class="table-strong">Image generation · 4 outputs</td><td>Flux 1.1 Pro</td><td>Fieldnotes identity</td><td>Today, 10:42 AM</td><td>180</td></tr><tr><td class="table-strong">Video generation · 1 output</td><td>Runway Gen-4</td><td>Aurora launch film</td><td>Today, 9:18 AM</td><td>420</td></tr><tr><td class="table-strong">Writing · 3 requests</td><td>Claude 4 Sonnet</td><td>Nimbus product page</td><td>Yesterday</td><td>36</td></tr><tr><td class="table-strong">Audio generation · 2 outputs</td><td>Suno v4</td><td>Slow mornings</td><td>Sep 22, 2026</td><td>260</td></tr></tbody></table></div>`;
  }

  function renderLiveUsagePage(usage) {
    const { plan, totals, byKind, byProvider, daily, recent } = usage;
    const percent = Math.min(100, Math.round((plan.creditsUsed / plan.creditsIncluded) * 100));
    const maxCredits = Math.max(1, ...daily.map((day) => day.credits));
    const chart = daily.map((day) => `<div class="chart-column"><span style="height:${Math.max(4, Math.round((day.credits / maxCredits) * 100))}%"></span><small>${escapeHTML(day.label)}</small></div>`).join('');
    const kindLabel = { image: 'Image generation', text: 'Text & writing' };
    const breakdown = byKind.length
      ? byKind.map((row, index) => `<div class="usage-row"><span class="usage-color ${['', 'green', 'orange'][index % 3]}"></span><span class="usage-row-name">${escapeHTML(kindLabel[row.kind] || row.kind)} <small>· ${row.count} generation${row.count === 1 ? '' : 's'}</small></span><span class="usage-row-value">${row.credits.toLocaleString('en-US')}</span></div>`).join('')
      : '<p class="section-subtitle">No generations recorded yet. Run one from the Overview prompt box.</p>';
    const providerRows = byProvider.map((row) => `<div class="usage-row"><span class="usage-color green"></span><span class="usage-row-name">${escapeHTML(providerLabel(row.provider))}</span><span class="usage-row-value">${row.credits.toLocaleString('en-US')} cr · $${row.costUsd.toFixed(3)}</span></div>`).join('');
    const rows = recent.length
      ? recent.map((item) => {
        const project = state.projects.find((entry) => entry.id === item.projectId);
        return `<tr><td class="table-strong">${item.kind === 'image' ? 'Image' : 'Text'} generation${item.status === 'failed' ? ' · failed' : ''}</td><td>${escapeHTML(item.model)}</td><td>${escapeHTML(project?.title || '—')}</td><td>${escapeHTML(item.createdLabel)}</td><td>${Math.round(item.credits)}</td></tr>`;
      }).join('')
      : '<tr><td class="table-strong" colspan="5">No generations yet — your first run will appear here.</td></tr>';
    return `<section class="page-heading"><div><div class="eyebrow">A clear view of your creative fuel</div><h1>Usage & billing</h1><p>Measured from generations recorded in your workspace database.</p></div><button class="secondary-button" type="button" data-action="download-usage">${icon('download')} Export usage</button></section>
      <div class="usage-overview"><section class="usage-card"><div class="usage-card-head"><div><h2>${escapeHTML(plan.name)} · monthly credits</h2><p>Credits reset on ${escapeHTML(plan.renewsOn)}. Spending is estimated from each model's published rates.</p></div><button type="button" class="secondary-button" data-action="manage-plan">Manage plan</button></div><div class="credits-number">${plan.creditsUsed.toLocaleString('en-US')} <span>/ ${plan.creditsIncluded.toLocaleString('en-US')} credits used</span></div><div class="credits-bar"><span style="width:${percent}%"></span></div><div class="credits-labels"><span>${percent}% used</span><span>${plan.creditsRemaining.toLocaleString('en-US')} credits left</span></div></section>
      <section class="usage-card"><div class="usage-card-head"><div><h2>Credits by creative tool</h2><p>${totals.generations} generation${totals.generations === 1 ? '' : 's'} · ${totals.tokensIn + totals.tokensOut} tokens · avg ${(totals.avgLatencyMs / 1000).toFixed(1)}s</p></div><span class="metric-icon">${icon('chart')}</span></div><div class="usage-breakdown">${breakdown}${providerRows}</div></section></div>
      <section class="usage-card" style="margin-bottom:16px"><div class="usage-card-head"><div><h2>Daily activity</h2><p>Credits used across the last seven days.</p></div><span class="detail-tag">Real data</span></div><div class="mini-chart" aria-label="Weekly credit activity">${chart}</div></section>
      <div class="section-head"><div><h2>Recent usage</h2><p class="section-subtitle">Every generation, newest first.</p></div></div><div class="usage-table-wrap"><table class="usage-table"><thead><tr><th>ACTIVITY</th><th>MODEL</th><th>PROJECT</th><th>DATE</th><th>CREDITS</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function renderSettingsPage() {
    const tabs = ['Profile', 'Workspace', 'Preferences', 'Connections'];
    let fields = '';
    if (state.settingsTab === 'Profile') {
      fields = `<div class="form-row"><div class="form-field"><label for="settings-name">Full name</label><input id="settings-name" name="name" value="${escapeHTML(state.settings.name)}" /></div><div class="form-field"><label for="settings-email">Email address</label><input id="settings-email" name="email" type="email" value="${escapeHTML(state.settings.email)}" /></div></div><div class="form-field"><label for="settings-role">Role</label><input id="settings-role" value="Creative lead" disabled /></div>`;
    } else if (state.settingsTab === 'Workspace') {
      fields = `<div class="form-field"><label for="settings-workspace">Workspace name</label><input id="settings-workspace" name="workspace" value="${escapeHTML(state.settings.workspace)}" /></div><div class="form-field"><label for="settings-workspace-type">Workspace type</label><select id="settings-workspace-type"><option>Personal workspace</option><option>Team workspace</option></select></div><div class="form-field"><label for="settings-workspace-description">About this workspace</label><textarea id="settings-workspace-description" placeholder="What are you making together?">A small, curious studio for good ideas.</textarea></div>`;
    } else if (state.settingsTab === 'Preferences') {
      fields = `<div class="form-field"><label for="settings-timezone">Time zone</label><select id="settings-timezone" name="timezone"><option ${state.settings.timezone === 'Asia/Kolkata' ? 'selected' : ''}>Asia/Kolkata</option><option>America/Los_Angeles</option><option>Europe/London</option><option>UTC</option></select></div><div class="form-field"><label for="settings-start-page">Start page</label><select id="settings-start-page"><option>Overview</option><option>Projects</option><option>Canvas</option></select></div><p class="section-subtitle">Keyboard shortcut: press Ctrl / ⌘ + K to search, create, or jump anywhere.</p>`;
    }
    const iconFor = (tab) => ({ Profile: 'file', Workspace: 'folder', Preferences: 'settings', Connections: 'lightning' }[tab]);
    const connectionPanel = `<h2>Generation connections</h2><p>Keys are read from <code>.env</code> on the server. This page never sees them.</p>${api.online ? `<div class="provider-list" style="margin-top:14px">${providerRowsHTML({ showProbe: true })}</div><div style="margin-top:14px">${nextStepHTML()}</div>` : `<div class="output-notice" style="margin-top:14px">${icon('close')}<div>The Studio server is not reachable, so no connections can be inspected. Run <code>npm start</code> and reconnect.</div></div><button class="secondary-button" type="button" data-action="reconnect-backend" style="margin-top:12px">${icon('refresh')} Reconnect</button>`}
    ${api.online ? `<h2 style="margin-top:18px">Automation scheduler</h2>
      <div class="scheduler-note">${icon('clock')}<span>${escapeHTML(schedulerHeadline())} · ${escapeHTML(schedulerDetail())}</span></div>
      <p>Due workflows are claimed by the server before they run, so a restart never double-fires one. A window missed while the server was off runs once on the next check — never a backlog.</p>
      <p>Storage: ${(state.uploads || []).length} file${(state.uploads || []).length === 1 ? '' : 's'} on disk in <code>data/uploads</code>. Generated images are saved as files instead of data URLs inside the database.</p>` : ''};`

    return `<section class="page-heading"><div><div class="eyebrow">Make the studio yours</div><h1>Settings</h1><p>Manage your profile and the way your workspace feels.</p></div></section><div class="settings-layout"><nav class="settings-nav" aria-label="Settings sections">${tabs.map((tab) => `<button type="button" class="${state.settingsTab === tab ? 'is-active' : ''}" data-action="settings-tab" data-tab="${escapeHTML(tab)}">${icon(iconFor(tab))}${escapeHTML(tab)}</button>`).join('')}</nav><section class="settings-card">${state.settingsTab === 'Connections'
      ? connectionPanel
      : `<h2>${escapeHTML(state.settingsTab)} settings</h2><p>Only you can see and manage these details.</p><form id="settings-form">${fields}<div class="modal-footer" style="padding:13px 0 0;margin-top:5px"><span class="modal-note">${api.online ? 'Saved to your workspace database.' : 'Changes save to this browser.'}</span><button class="primary-button" type="submit">Save changes</button></div></form>`}</section></div>`;
  }

  function openModal(html, type = 'generic', options = {}) {
    closePopover();
    const root = document.getElementById('modal-root');
    state.previousFocus = document.activeElement;
    state.modalType = type;
    root.innerHTML = html;
    const focusTarget = root.querySelector(options.focus || '[autofocus], input, textarea, select, button');
    window.setTimeout(() => focusTarget?.focus(), 0);
  }

  function closeModal(restoreFocus = true) {
    const root = document.getElementById('modal-root');
    if (!root || !root.firstElementChild) return;
    root.innerHTML = '';
    state.modalType = '';
    if (restoreFocus && state.previousFocus && typeof state.previousFocus.focus === 'function') state.previousFocus.focus();
    state.previousFocus = null;
  }

  function newProjectModal() {
    const typeOptions = ['Campaign', 'Brand identity', 'Website', 'Image', 'Video', 'Writing', 'Audio', 'Product design'];
    const modelOptions = ['Auto select', ...(Array.isArray(state.models) && state.models.length
      ? state.models.filter((model) => model.selectable).map((model) => model.name)
      : modelData.map((model) => model.name))];
    openModal(`<div class="modal-scrim" data-scrim="true"><section class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="project-modal-title"><div class="modal-header"><div><h2 id="project-modal-title">Start a new project</h2><p>Give your idea a home. You can add detail as it grows.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div><form id="create-project-form"><div class="modal-body"><div class="form-field"><label for="new-project-name">Project name</label><input id="new-project-name" name="title" placeholder="e.g. Spring campaign direction" required maxlength="72" /></div><div class="form-row"><div class="form-field"><label for="new-project-type">Project type</label><select id="new-project-type" name="type">${typeOptions.map((type) => `<option>${escapeHTML(type)}</option>`).join('')}</select></div><div class="form-field"><label for="new-project-model">Starting model</label><select id="new-project-model" name="model">${modelOptions.map((model) => `<option ${model === state.selectedModel ? 'selected' : ''}>${escapeHTML(model)}</option>`).join('')}</select></div></div><div class="form-field"><label for="new-project-prompt">A little context <span style="color:#a6a4b0;font-weight:400">(optional)</span></label><textarea id="new-project-prompt" name="prompt" placeholder="What are you hoping to make?"></textarea></div></div><div class="modal-footer"><span class="modal-note">Your project stays in this browser for now.</span><button class="secondary-button" type="button" data-action="close-modal">Cancel</button><button class="primary-button" type="submit">Create project ${icon('arrow-right')}</button></div></form></section></div>`, 'new-project', { focus: '#new-project-name' });
  }

  function projectDetailModal(id) {
    const project = state.projects.find((item) => item.id === id);
    if (!project) return showToast('That project is no longer here.', 'error');
    const cover = getArtMarkup(project);
    const prompt = project.prompt || 'Add a short brief to give this project a clear starting point.';
    openModal(`<div class="modal-scrim" data-scrim="true"><section class="modal-dialog modal-wide" role="dialog" aria-modal="true" aria-labelledby="project-detail-title"><div class="modal-header"><div><h2 id="project-detail-title">${escapeHTML(project.title)}</h2><p>Project overview · Updated ${escapeHTML(project.updated || 'just now')}</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div><div class="project-detail-cover">${cover}</div><div class="modal-body"><div class="detail-tags"><span class="detail-tag">${escapeHTML(project.type)}</span><span class="detail-tag">${escapeHTML(project.model || 'Auto select')}</span><span class="detail-tag">${escapeHTML(project.status || 'Draft')}</span></div><div class="detail-stats"><div class="detail-stat"><strong>${escapeHTML(project.outputs ?? 0)}</strong><span>outputs created</span></div><div class="detail-stat"><strong>${escapeHTML(project.model || 'Auto select')}</strong><span>primary model</span></div><div class="detail-stat"><strong>${escapeHTML(project.updated || 'Just now')}</strong><span>last activity</span></div></div><p class="detail-section-label">Project brief</p><p class="detail-prompt">${escapeHTML(prompt)}</p><div id="project-files"></div><div id="project-generations"></div></div><div class="modal-footer"><span class="modal-note">A good project can change shape as you work.</span><button class="secondary-button" type="button" data-action="duplicate-project" data-id="${escapeHTML(project.id)}">${icon('copy')} Duplicate</button><button class="secondary-button" type="button" data-action="generate-again" data-id="${escapeHTML(project.id)}">${icon('wand')} Generate</button><button class="primary-button" type="button" data-action="detail-open-canvas" data-id="${escapeHTML(project.id)}">Open in canvas ${icon('arrow-right')}</button></div></section></div>`, 'project-detail', { focus: '.modal-close' });
    loadProjectGenerations(project.id);
    loadProjectFiles(project.id);
  }

  /**
   * Reference material and generated assets that belong to a project. Bytes
   * live on the server; this only ever renders URLs.
   */
  async function loadProjectFiles(projectId) {
    if (!api.online) return;
    const slot = document.getElementById('project-files');
    if (!slot) return;
    try {
      const { files } = await api.request(`/api/projects/${encodeURIComponent(projectId)}/files`);
      const slotNow = document.getElementById('project-files');
      if (!slotNow || !files?.length) return;
      const attachments = files.filter((file) => file.kind === 'attachment');
      const outputs = files.filter((file) => file.kind !== 'attachment');
      const tile = (file) => `<figure class="file-tile"><a href="${escapeHTML(file.url)}" target="_blank" rel="noopener">${file.isImage ? `<img src="${escapeHTML(file.url)}" alt="${escapeHTML(file.name)}">` : `<div style="height:92px;display:grid;place-items:center;background:#f4f2ee">${icon('file')}</div>`}</a><figcaption class="file-tile-body"><strong title="${escapeHTML(file.name)}">${escapeHTML(file.name)}</strong><span>${escapeHTML(humanSize(file.size))}</span></figcaption></figure>`;
      slotNow.innerHTML = `${outputs.length ? `<p class="detail-section-label">Generated assets</p><div class="file-grid">${outputs.map(tile).join('')}</div>` : ''}${attachments.length ? `<p class="detail-section-label" style="margin-top:12px">Reference files</p><div class="file-grid">${attachments.map(tile).join('')}</div>` : ''}`;
    } catch { /* files are a bonus; generations still render */ }
  }

  /** Real output history for a project, pulled from the database. */
  async function loadProjectGenerations(projectId) {
    if (!api.online) return;
    const slot = document.getElementById('project-generations');
    if (!slot) return;
    slot.innerHTML = '<p class="detail-section-label">Generation history</p><p class="section-subtitle">Loading…</p>';
    try {
      const { generations } = await api.request(`/api/projects/${encodeURIComponent(projectId)}`);
      const slotNow = document.getElementById('project-generations');
      if (!slotNow) return;
      if (!generations?.length) {
        slotNow.innerHTML = '<p class="detail-section-label">Generation history</p><p class="section-subtitle">No generations yet. Use Generate to run this brief.</p>';
        return;
      }
      slotNow.innerHTML = `<p class="detail-section-label">Generation history</p>${generations.map((item) => `
        <details class="detail-prompt" style="padding:11px">
          <summary style="cursor:pointer;color:#4f4d5f;font-size:9.5px">${item.kind === 'image' ? 'Image' : 'Text'} · ${escapeHTML(item.model)} · ${escapeHTML(item.createdLabel)} · ${Math.round(item.credits)} credits${item.status === 'failed' ? ' · failed' : ''}</summary>
          ${item.assetUrl ? `<img class="output-image" style="margin:10px 0 0" alt="Stored generation" src="${item.assetUrl}">` : ''}
          ${item.error ? `<p style="margin:9px 0 0;color:#9c3f47">${escapeHTML(item.error)}</p>` : ''}
          <pre style="margin:9px 0 0;white-space:pre-wrap;font-family:inherit;font-size:9px;line-height:1.6;color:#6e6c7b">${escapeHTML(item.output.slice(0, 4000)) || 'No text output.'}</pre>
        </details>`).join('')}`;
    } catch (error) {
      const slotNow = document.getElementById('project-generations');
      if (slotNow) slotNow.innerHTML = `<p class="detail-section-label">Generation history</p><p class="section-subtitle">${escapeHTML(error.message)}</p>`;
    }
  }

  function notificationModal() {
    const notices = [
      { icon: 'check', tone: 'green', text: '<strong>Your Aurora launch film is ready.</strong> Eight clips were added to the project.', when: '12 minutes ago' },
      { icon: 'sparkles', tone: '', text: '<strong>Flux 1.1 Pro has a new update.</strong> Your favorite image model just got a little better.', when: '2 hours ago' },
      { icon: 'lightning', tone: 'orange', text: '<strong>You’re making the most of your plan.</strong> 3,180 credits are ready when you are.', when: 'Yesterday' },
    ];
    const body = state.notificationsRead ? '<div class="empty-state" style="min-height:170px;border:0"><div><span class="empty-state-icon">' + icon('check') + '</span><h2>You’re all caught up</h2><p>New studio activity will show up here.</p></div></div>' : notices.map((notice) => `<div class="notification-item"><span class="activity-icon ${notice.tone}">${icon(notice.icon)}</span><div><p>${notice.text}</p><small>${escapeHTML(notice.when)}</small></div></div>`).join('');
    openModal(`<div class="modal-scrim" data-scrim="true"><section class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="notifications-title"><div class="modal-header"><div><h2 id="notifications-title">Notifications</h2><p>A few things happening in your studio.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div><div class="modal-body">${body}</div>${state.notificationsRead ? '' : `<div class="modal-footer"><span class="modal-note">You’re up to date through today.</span><button class="quiet-button" type="button" data-action="mark-notifications-read">Mark all as read</button></div>`}</section></div>`, 'notifications', { focus: '.modal-close' });
  }

  function helpModal() {
    openModal(`<div class="modal-scrim" data-scrim="true"><section class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="help-title"><div class="modal-header"><div><h2 id="help-title">A few handy shortcuts</h2><p>Less hunting around, more making.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div><div class="modal-body"><div class="notification-item"><span class="activity-icon">${icon('search')}</span><div><p><strong>Search anything</strong> — jump to a project, tool, or action.</p><small><kbd>⌘</kbd> + <kbd>K</kbd> on Mac · <kbd>Ctrl</kbd> + <kbd>K</kbd> elsewhere</small></div></div><div class="notification-item"><span class="activity-icon green">${icon('plus')}</span><div><p><strong>Start a project</strong> — use the prompt box on Overview or the New project button.</p><small>Every idea gets a space of its own.</small></div></div><div class="notification-item"><span class="activity-icon orange">${icon('models')}</span><div><p><strong>Try another model</strong> — pick one for this task, or leave Auto select on.</p><small>Your work stays connected to its project.</small></div></div></div><div class="modal-footer"><span class="modal-note">Need a hand? This starter runs entirely in your browser.</span><button class="primary-button" type="button" data-action="close-modal">Got it</button></div></section></div>`, 'help', { focus: '.modal-close' });
  }

  function commandModal() {
    openModal(`<div class="modal-scrim command-scrim" data-scrim="true"><section class="command-dialog" role="dialog" aria-modal="true" aria-label="Search or jump to"><div class="command-input-wrap">${icon('search')}<input id="command-input" type="search" autocomplete="off" placeholder="Search projects, tools, or actions..." aria-label="Search projects, tools, or actions" /><kbd>ESC</kbd></div><div class="command-list" id="command-results"></div><div class="command-footer"><span><kbd>↑</kbd><kbd>↓</kbd> to navigate</span><span><kbd>↵</kbd> to select</span><span><kbd>esc</kbd> to close</span></div></section></div>`, 'command', { focus: '#command-input' });
    renderCommandResults('');
  }

  const routeCommands = [
    { page: 'overview', label: 'Overview', description: 'Your studio at a glance', icon: 'overview' },
    { page: 'projects', label: 'Projects', description: 'Browse your work', icon: 'folder' },
    { page: 'canvas', label: 'Canvas', description: 'Think visually', icon: 'canvas' },
    { page: 'models', label: 'Models', description: 'Choose a creative model', icon: 'models' },
    { page: 'prompts', label: 'Prompt library', description: 'Find a useful starting point', icon: 'book' },
    { page: 'automations', label: 'Automations', description: 'Make repeatable work flow', icon: 'workflow' },
    { page: 'usage', label: 'Usage & billing', description: 'Check your plan and credits', icon: 'chart' },
    { page: 'settings', label: 'Settings', description: 'Manage your workspace', icon: 'settings' },
  ];

  function renderCommandResults(query) {
    const node = document.getElementById('command-results');
    if (!node) return;
    const term = query.trim().toLowerCase();
    const matchingRoutes = routeCommands.filter((command) => !term || `${command.label} ${command.description}`.toLowerCase().includes(term));
    const matchingProjects = state.projects.filter((project) => !term || `${project.title} ${project.type}`.toLowerCase().includes(term)).slice(0, 4);
    const showCreate = !term || 'new project create project'.includes(term);
    let html = '';
    if (showCreate) html += `<div class="command-group-label">Quick actions</div><button class="command-item" type="button" data-action="command-new-project"><span class="command-item-icon">${icon('plus')}</span><span>Create a new project</span><small>Start with a brief</small></button>`;
    if (matchingRoutes.length) html += `<div class="command-group-label">Workspace</div>${matchingRoutes.map((item) => `<button class="command-item" type="button" data-action="command-navigate" data-page="${escapeHTML(item.page)}"><span class="command-item-icon">${icon(item.icon)}</span><span>${escapeHTML(item.label)}</span><small>${escapeHTML(item.description)}</small></button>`).join('')}`;
    if (matchingProjects.length) html += `<div class="command-group-label">Projects</div>${matchingProjects.map((project) => `<button class="command-item" type="button" data-action="open-project" data-id="${escapeHTML(project.id)}"><span class="command-item-icon">${icon('folder')}</span><span>${escapeHTML(project.title)}</span><small>${escapeHTML(project.status)}</small></button>`).join('')}`;
    node.innerHTML = html || '<div class="command-empty">No matches yet. Try a shorter search.</div>';
  }

  function showToast(message, kind = 'success') {
    const region = document.getElementById('toast-region');
    const toast = document.createElement('div');
    toast.className = `toast ${kind === 'error' ? 'toast-error' : ''}`;
    toast.innerHTML = `<span class="toast-check">${icon(kind === 'error' ? 'close' : 'check')}</span><span>${escapeHTML(message)}</span>`;
    region.append(toast);
    window.setTimeout(() => toast.remove(), 3200);
  }

  function closePopover() {
    document.querySelector('.popover')?.remove();
    state.popover = null;
  }

  function placePopover(anchor, html, minWidth = 190) {
    closePopover();
    const popover = document.createElement('div');
    popover.className = 'popover';
    popover.style.minWidth = `${minWidth}px`;
    popover.innerHTML = html;
    document.body.append(popover);
    const box = anchor.getBoundingClientRect();
    const popBox = popover.getBoundingClientRect();
    const left = Math.min(Math.max(8, box.left), window.innerWidth - popBox.width - 8);
    const top = box.bottom + popBox.height + 12 > window.innerHeight ? Math.max(8, box.top - popBox.height - 7) : box.bottom + 7;
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
    state.popover = popover;
  }

  function showModelPicker(anchor) {
    // The picker mirrors what can actually run: live catalogue first, demo
    // catalogue only when there is no server to ask.
    const choices = ['Auto select', ...(Array.isArray(state.models) && state.models.length
      ? state.models.filter((model) => model.selectable).map((model) => model.name)
      : modelData.map((model) => model.name))];
    placePopover(anchor, `<div class="popover-title">Choose a model</div>${choices.map((model) => `<button class="popover-item" type="button" data-action="select-model" data-value="${escapeHTML(model)}">${icon(model === 'Auto select' ? 'sparkles' : 'models')}<span>${escapeHTML(model)}</span>${state.selectedModel === model ? `<span class="popover-check">${icon('check')}</span>` : ''}</button>`).join('')}`, 212);
  }

  function showModePicker(anchor) {
    const choices = ['Image', 'Video', 'Writing', 'Audio', 'Code'];
    placePopover(anchor, `<div class="popover-title">What are we making?</div>${choices.map((mode) => `<button class="popover-item" type="button" data-action="select-mode" data-value="${escapeHTML(mode)}">${icon(modeIcon(mode))}<span>${escapeHTML(mode)}</span>${state.promptMode === mode ? `<span class="popover-check">${icon('check')}</span>` : ''}</button>`).join('')}`, 180);
  }

  function showProjectMenu(anchor, id) {
    const project = state.projects.find((item) => item.id === id);
    if (!project) return;
    placePopover(anchor, `<div class="popover-title">Project actions</div><button class="popover-item" type="button" data-action="open-project" data-id="${escapeHTML(id)}">${icon('file')}<span>Open overview</span></button><button class="popover-item" type="button" data-action="duplicate-project" data-id="${escapeHTML(id)}">${icon('copy')}<span>Make a copy</span></button><div class="popover-divider"></div><button class="popover-item" type="button" data-action="archive-project" data-id="${escapeHTML(id)}">${icon('folder')}<span>Archive from workspace</span></button>`, 190);
  }

  function workspaceMenu(anchor) {
    placePopover(anchor, `<div class="popover-title">Your workspace</div><button class="popover-item" type="button" data-action="workspace-info">${icon('folder')}<span>Northstar Studio</span>${icon('check', 'popover-check')}</button><div class="popover-divider"></div><button class="popover-item" type="button" data-action="workspace-info">${icon('plus')}<span>Create a workspace</span></button><button class="popover-item" type="button" data-page="settings">${icon('settings')}<span>Workspace settings</span></button>`, 204);
  }

  function profileMenu(anchor) {
    placePopover(anchor, `<div class="popover-title">Alex Chen · Pro member</div><button class="popover-item" type="button" data-page="settings">${icon('settings')}<span>Account settings</span></button><button class="popover-item" type="button" data-page="usage">${icon('wallet')}<span>Plan & billing</span></button><div class="popover-divider"></div><button class="popover-item" type="button" data-action="profile-info">${icon('help')}<span>About this prototype</span></button>`, 190);
  }

  function artForType(type) {
    const normalized = type.toLowerCase();
    if (normalized.includes('audio')) return 'soundscape';
    if (normalized.includes('video') || normalized.includes('campaign')) return 'aurora';
    if (normalized.includes('brand')) return 'fieldnotes';
    if (normalized.includes('website')) return 'nimbus';
    if (normalized.includes('image')) return 'atlas';
    return 'studio';
  }

  function createProject({ title, type = 'Campaign', model = state.selectedModel, prompt = '', toastMessage = '', toastKind = 'success' }) {
    const trimmedTitle = String(title || '').trim().slice(0, 72);
    if (!trimmedTitle) {
      showToast('Add a project name to get started.', 'error');
      return false;
    }
    const hasPrompt = Boolean(String(prompt || '').trim());
    const chosenModel = model && model !== 'Auto select' ? model : 'Auto select';

    // With a server running, SQLite owns projects; the browser is a cache.
    if (api.online) {
      api.request('/api/projects', {
        method: 'POST',
        body: { title: trimmedTitle, type, model: chosenModel, prompt: String(prompt || '').trim(), status: hasPrompt ? 'In progress' : 'Draft' },
      }).then((payload) => {
        applyServerState(payload);
        renderPage();
        showToast(toastMessage || `“${payload.project.title}” is ready.`, toastKind);
      }).catch((error) => showToast(error.message, 'error'));
      return true;
    }

    const project = {
      id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      title: trimmedTitle,
      type: String(type || 'Campaign'),
      model: chosenModel,
      status: hasPrompt ? 'In progress' : 'Draft',
      updated: 'Just now',
      art: artForType(String(type || 'Campaign')),
      prompt: String(prompt || '').trim(),
      outputs: 0,
    };
    state.projects.unshift(project);
    saveStorage(STORAGE.projects, state.projects);
    state.activity.unshift({ icon: hasPrompt ? 'sparkles' : 'file', tone: hasPrompt ? '' : 'orange', line: `<strong>${escapeHTML(chosenModel)}</strong> ${hasPrompt ? 'added a new idea to the studio' : 'created a new project'}`, project: trimmedTitle, time: 'Just now' });
    state.activity = state.activity.slice(0, 5);
    updateShell();
    renderPage();
    showToast(toastMessage || 'Project created. Add a brief whenever you’re ready.', toastKind);
    return true;
  }

  function duplicateProject(id) {
    const original = state.projects.find((project) => project.id === id);
    if (!original) return;
    if (api.online) {
      closePopover();
      api.request(`/api/projects/${encodeURIComponent(id)}/duplicate`, { method: 'POST' })
        .then((payload) => { applyServerState(payload); renderPage(); showToast(`“${payload.project.title}” is ready.`); })
        .catch((error) => showToast(error.message, 'error'));
      return;
    }
    const copy = { ...original, id: `p-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, title: `${original.title} — copy`, status: 'Draft', updated: 'Just now', outputs: 0 };
    state.projects.unshift(copy);
    saveStorage(STORAGE.projects, state.projects);
    closeModal(false);
    closePopover();
    updateShell();
    renderPage();
    showToast('A copy is ready in your projects.');
  }

  function archiveProject(id) {
    const project = state.projects.find((item) => item.id === id);
    if (!project) return;
    if (api.online) {
      closePopover();
      closeModal(false);
      api.request(`/api/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
        .then((payload) => { applyServerState(payload); renderPage(); showToast(`“${project.title}” was removed from this workspace.`); })
        .catch((error) => showToast(error.message, 'error'));
      return;
    }
    state.projects = state.projects.filter((item) => item.id !== id);
    saveStorage(STORAGE.projects, state.projects);
    closePopover();
    closeModal(false);
    updateShell();
    renderPage();
    showToast(`“${project.title}” was removed from this workspace.`);
  }

  function openNewAutomationModal() {
    openModal(`<div class="modal-scrim" data-scrim="true"><section class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="automation-modal-title"><div class="modal-header"><div><h2 id="automation-modal-title">Create an automation</h2><p>Start with one small, repeatable thing.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div><form id="automation-form"><div class="modal-body"><div class="form-field"><label for="automation-name">Automation name</label><input id="automation-name" name="name" placeholder="e.g. Share a Friday round-up" required maxlength="60" /></div><div class="form-field"><label for="automation-kind">When should it run?</label><select name="kind" id="automation-kind" data-schedule-kind><option value="daily">Every day at a set time</option><option value="weekly">Every week on a set day</option><option value="monthly">Every month on a set date</option><option value="interval">On a repeating interval</option><option value="event">When something happens in the studio</option><option value="manual">Only when I press run</option></select>
            <div class="schedule-fields" data-schedule-fields="daily weekly monthly"><label for="automation-time">Time of day</label><input type="time" id="automation-time" name="time" value="09:00" /></div>
            <div class="schedule-fields" data-schedule-fields="weekly"><label for="automation-weekday">Day of week</label><select id="automation-weekday" name="weekday"><option value="1">Monday</option><option value="2">Tuesday</option><option value="3">Wednesday</option><option value="4">Thursday</option><option value="5">Friday</option><option value="6">Saturday</option><option value="0">Sunday</option></select></div>
            <div class="schedule-fields" data-schedule-fields="monthly"><label for="automation-day">Day of month</label><input type="number" id="automation-day" name="day" min="1" max="28" value="1" /></div>
            <div class="schedule-fields" data-schedule-fields="interval"><label for="automation-every">Every (minutes)</label><input type="number" id="automation-every" name="everyMinutes" min="1" max="43200" value="60" /></div>
            <div class="schedule-fields" data-schedule-fields="event"><label for="automation-event">Event</label><select id="automation-event" name="event"><option value="project.status:In review">A project is marked “In review”</option><option value="project.status:Published">A project is marked “Published”</option><option value="project.status:Complete">A project is marked “Complete”</option></select></div>
            <span class="modal-note">Times use the workspace timezone (${escapeHTML(state.settings.timezone || 'UTC')}).</span></div><div class="form-field"><label for="automation-action">What should it do?</label><select name="action" id="automation-action"><option>Curate & summarize</option><option>Draft a handoff</option><option>Organize projects</option><option>Prepare a creative brief</option></select></div><div class="form-field"><label for="automation-description">A note for future you <span style="color:#a6a4b0;font-weight:400">(optional)</span></label><textarea name="description" id="automation-description" placeholder="What should this workflow take care of?"></textarea></div></div><div class="modal-footer"><span class="modal-note">Scheduled workflows run on the server, even when this tab is closed.</span><button class="secondary-button" type="button" data-action="close-modal">Cancel</button><button class="primary-button" type="submit">Create automation ${icon('arrow-right')}</button></div></form></section></div>`, 'new-automation', { focus: '#automation-name' });
    syncScheduleFields(document);
  }

  // -------------------------------------------------------------------------
  // Generation
  // -------------------------------------------------------------------------

  const kindForMode = (mode) => (mode === 'Image' || mode === 'Video' ? 'image' : 'text');
  const projectTypeForMode = (mode) => ({ Image: 'Image', Video: 'Video', Writing: 'Writing', Audio: 'Audio', Code: 'Code' }[mode] || 'Campaign');

  function openGenerationModal({ prompt, mode, model }) {
    const kind = kindForMode(mode);
    openModal(`<div class="modal-scrim" data-scrim="true"><section class="modal-dialog modal-wide" role="dialog" aria-modal="true" aria-labelledby="output-title">
      <div class="modal-header"><div><h2 id="output-title">Studio output</h2><p id="output-subtitle">${escapeHTML(String(model || 'Auto select'))} · ${escapeHTML(mode)}</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div>
      <div class="modal-body">
        <div class="output-status" id="output-status"><span class="spinner"></span><span id="output-status-text">Contacting the model…</span></div>
        <div id="output-notices"></div>
        ${kind === 'image'
          ? `<div id="output-image-slot"></div><div class="output-stream is-empty" id="output-stream" hidden></div>`
          : `<div class="output-stream is-streaming is-empty" id="output-stream">Waiting for the first token…</div>`}
        <div class="output-stats" id="output-stats"></div>
      </div>
      <div class="modal-footer">
        <div class="output-footer-actions" id="output-actions"></div>
        <span class="modal-note" id="output-note"></span>
        <button class="secondary-button" id="output-stop" type="button">Stop</button>
        <button class="primary-button" id="output-close" type="button" data-action="close-modal">Done</button>
      </div>
    </section></div>`, 'generation', { focus: '#output-close' });
    return {
      prompt,
      mode,
      kind,
      stream: document.getElementById('output-stream'),
      status: document.getElementById('output-status-text'),
      statusRow: document.getElementById('output-status'),
      notices: document.getElementById('output-notices'),
      imageSlot: document.getElementById('output-image-slot'),
      stats: document.getElementById('output-stats'),
      actions: document.getElementById('output-actions'),
      note: document.getElementById('output-note'),
      stop: document.getElementById('output-stop'),
      subtitle: document.getElementById('output-subtitle'),
      text: '',
    };
  }

  const pushNotice = (view, message, isError = false, hint = '') => {
    if (!view?.notices) return;
    const node = document.createElement('div');
    node.className = `output-notice${isError ? ' is-error' : ''}`;
    node.innerHTML = `${icon(isError ? 'close' : 'sparkles')}<div>${escapeHTML(message)}${hint ? `<span class="output-error-hint">${escapeHTML(hint)}</span>` : ''}</div>`;
    view.notices.appendChild(node);
  };

  function renderOutputStats(view, generation) {
    if (!view?.stats) return;
    const rows = [
      ['Model', generation.model || '—'],
      ['Through', providerLabel(generation.provider)],
      ['Tokens', `${(generation.tokensIn || 0) + (generation.tokensOut || 0)}`],
      ['Credits', `${Math.round(generation.credits || 0)}`],
      ['Time', `${((generation.latencyMs || 0) / 1000).toFixed(1)}s`],
    ];
    view.stats.innerHTML = rows.map(([label, value]) => `<div class="output-stat"><strong>${escapeHTML(String(value))}</strong><span>${escapeHTML(label)}</span></div>`).join('');
  }

  function finishOutput(view, payload) {
    const generation = payload?.generation || {};
    // The stream shows the image as it arrives; once it is saved, the dialog
    // shows the file the workspace actually keeps.
    if (generation.assetUrl && !String(generation.assetUrl).startsWith('data:') && view.imageSlot) {
      view.imageSlot.innerHTML = `<img class="output-image" alt="Generated output" src="${escapeHTML(generation.assetUrl)}">`;
    }
    if (view.statusRow) view.statusRow.innerHTML = payload?.failed ? `${icon('close')}<span>Generation failed</span>` : `${icon('check')}<span>Saved to your project</span>`;
    if (view.stream) {
      view.stream.classList.remove('is-streaming');
      view.stream.classList.toggle('is-empty', !view.text);
      if (!view.text && payload?.failed) view.stream.textContent = 'Nothing was generated for this request.';
    }
    renderOutputStats(view, generation);
    if (view.note) view.note.textContent = generation.id ? `Generation ${generation.id}` : 'Nothing was saved.';
    if (view.stop) view.stop.remove();
    if (view.actions) {
      const projectId = payload?.project?.id || generation.projectId;
      view.actions.innerHTML = [
        view.text || generation.assetUrl ? `<button class="quiet-button" type="button" id="output-copy">${icon('copy')} Copy output</button>` : '',
        projectId ? `<button class="secondary-button" type="button" data-action="open-project" data-id="${escapeHTML(projectId)}">${icon('folder')} Open project</button>` : '',
        projectId ? `<button class="secondary-button" type="button" data-action="generate-again" data-id="${escapeHTML(projectId)}">${icon('refresh')} Generate again</button>` : '',
      ].join('');
      const copyButton = document.getElementById('output-copy');
      if (copyButton) copyButton.addEventListener('click', () => {
        const text = view.text || generation.assetUrl || '';
        navigator.clipboard?.writeText(text).then(() => showToast('Output copied to your clipboard.'), () => showToast('Copying is blocked in this browser.', 'error'));
      });
    }
    // The workspace changed underneath the dialog, so the page behind it has to
    // catch up — a finished generation should be visible without a reload.
    applyServerState(payload);
    renderPage();
  }

  /**
   * Runs a generation. Every event the server streams is reflected live, so the
   * user watches the model work rather than a spinner.
   */
  async function startGeneration({ prompt, mode, model, projectId = null, title = '', fileIds = [] }) {
    if (!api.online) {
      // No server: the brief is still worth keeping, and the message says why
      // nothing was generated rather than failing silently.
      createProject({
        title: title || prompt.slice(0, 48),
        type: projectTypeForMode(mode),
        model,
        prompt,
        toastMessage: 'Saved as a project. Start the Studio server (npm start) to generate with a model.',
        toastKind: 'error',
      });
      return;
    }

    const view = openGenerationModal({ prompt, mode, model });
    const controller = new AbortController();
    state.generation = { controller, view };
    view.stop?.addEventListener('click', () => {
      controller.abort();
      if (view.status) view.status.textContent = 'Stopped. Partial output was kept.';
    });

    try {
      await api.stream('/api/generate', {
        prompt, mode, model, projectId: projectId || undefined, title: title || undefined,
        type: projectTypeForMode(mode),
        fileIds: fileIds.length ? fileIds : undefined,
      }, {
        references: (event) => {
          const files = event.references || [];
          if (files.length) {
            const images = event.imagesSent ? `, ${event.imagesSent} sent as vision input` : '';
            pushNotice(view, `${files.length} reference file${files.length === 1 ? '' : 's'} attached (${files.map((file) => file.name).join(', ')})${images}.`);
          }
        },
        start: (event) => {
          if (view.subtitle) view.subtitle.textContent = `${event.modelLabel} · ${providerLabel(event.provider)}`;
          if (view.status) view.status.textContent = event.kind === 'image' ? 'Rendering an image…' : 'Streaming output…';
          if (event.isDemo) pushNotice(view, event.isDemoFallback
            ? 'No provider key is configured, so the Studio demo engine wrote this instead of a real model.'
            : 'Demo output from the local Studio engine — not a real model.');
          else if (event.pricingEstimated) pushNotice(view, 'Estimated usage: this provider did not report exact token counts.');
        },
        delta: (event) => {
          view.text += event.text;
          if (view.stream) {
            view.stream.classList.remove('is-empty');
            view.stream.textContent = view.text;
            view.stream.scrollTop = view.stream.scrollHeight;
          }
        },
        asset: (event) => {
          if (view.imageSlot) view.imageSlot.innerHTML = `<img class="output-image" alt="Generated output" src="${event.url}">`;
          if (view.status) view.status.textContent = 'Image ready.';
        },
        notice: (event) => pushNotice(view, event.message),
        error: (event) => pushNotice(view, event.message, true, event.hint),
        done: (payload) => finishOutput(view, payload),
      }, controller.signal);
      if (state.generation?.view === view) showToast('Generation complete.');
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (view.status) view.status.textContent = 'Stopped by you.';
        showToast('Generation stopped.');
      } else {
        pushNotice(view, error.message || 'The generation failed.', true, error.hint);
        if (view.statusRow) view.statusRow.innerHTML = `${icon('close')}<span>Could not generate</span>`;
        showToast(error.message || 'The generation failed.', 'error');
      }
    } finally {
      if (state.generation?.view === view) state.generation = null;
    }
  }

  /** Applies whatever the server says changed, so the UI never drifts. */
  function applyServerState(payload = {}) {
    if (Array.isArray(payload.projects)) state.projects = payload.projects;
    if (payload.project) {
      const index = state.projects.findIndex((item) => item.id === payload.project.id);
      if (index >= 0) state.projects[index] = payload.project;
      else state.projects.unshift(payload.project);
    }
    if (Array.isArray(payload.activity)) {
      state.activity = payload.activity;
    }
    if (payload.usage) state.usage = payload.usage;
    if (Array.isArray(payload.automations)) state.automations = payload.automations;
    if (Array.isArray(payload.files)) state.uploads = payload.files;
    if (payload.scheduler) state.scheduler = payload.scheduler;
    updateShell();
  }

  // -------------------------------------------------------------------------
  // Backend status, provider connections, exports
  // -------------------------------------------------------------------------

  function providerRowsHTML({ showProbe = false } = {}) {
    return api.providers.map((provider) => `
      <div class="provider-row ${provider.configured ? 'is-on' : ''}">
        <span class="provider-row-icon">${escapeHTML(provider.label.slice(0, 1))}</span>
        <div class="provider-row-main">
          <h3>${escapeHTML(provider.label)} ${provider.isDemo ? '<span class="badge badge-demo">DEMO</span>' : ''}</h3>
          <p>${provider.configured
            ? 'Connected on the server. Keys stay in .env and never reach this page.'
            : escapeHTML(provider.hint)}${provider.requiresKey ? ` <code>${escapeHTML(providerEnvVar(provider.id))}</code>` : ''}</p>
        </div>
        <div class="provider-row-side">
          <span class="badge ${provider.configured ? 'badge-live' : 'badge-off'}">${provider.configured ? 'CONNECTED' : 'NOT SET'}</span>
          ${showProbe && provider.configured && !provider.isDemo ? `<button class="quiet-button" type="button" data-action="provider-probe" data-provider="${escapeHTML(provider.id)}" aria-label="Test ${escapeHTML(provider.label)}">${icon('refresh')}</button>` : ''}
        </div>
      </div>`).join('');
  }

  const providerEnvVar = (id) => ({ openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', ollama: 'OLLAMA_ENABLED=1' }[id] || '');

  const nextStepHTML = () => (hasLiveProviders()
    ? `<p class="section-subtitle">Generations run through ${escapeHTML(configuredProviders().map((provider) => provider.label).join(', '))}. Models marked <span class="badge badge-demo">DEMO</span> stay local.</p>`
    : `<p class="section-subtitle">Add a provider key to <code>.env</code> and restart the server to generate with a real model. Until then, the Studio demo engine writes clearly-labelled placeholder output.</p>`);

  function backendStatusModal() {
    const mode = !api.online ? 'offline' : api.mode;
    const headline = {
      live: 'Generating with real models',
      demo: 'Demo engine',
      offline: 'Frontend only',
    }[mode];
    const detail = {
      live: 'Provider keys are configured on the server. Generations, credits, and usage are recorded in SQLite.',
      demo: 'The server is running, but no provider key is set, so generations come from the local Studio demo engine.',
      offline: `The Studio server is not reachable from this page${api.lastError ? ` (${escapeHTML(api.lastError)})` : ''}. Projects live in this browser until it is.`,
    }[mode];
    openModal(`<div class="modal-scrim" data-scrim="true"><section class="modal-dialog modal-wide" role="dialog" aria-modal="true" aria-labelledby="backend-title">
      <div class="modal-header"><div><h2 id="backend-title">Generation backend</h2><p>${escapeHTML(headline)}</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div>
      <div class="modal-body">
        <div class="output-notice">${icon('lightning')}<div>${detail}</div></div>
        ${nextStepHTML()}
        <div class="provider-list">${api.online ? providerRowsHTML({ showProbe: true }) : ''}</div>
        <p class="section-subtitle" style="margin-top:14px">Run <code>npm start</code> in the repository root, then reload this page.</p>
      </div>
      <div class="modal-footer"><span class="modal-note">Provider keys are read from .env on the server and are never sent to the browser.</span>
        <button class="secondary-button" type="button" data-action="close-modal">Close</button>
        <button class="primary-button" type="button" data-action="reconnect-backend">${icon('refresh')} Reconnect</button></div>
    </section></div>`, 'backend-status', { focus: '.modal-close' });
  }

  async function probeProvider(id) {
    showToast(`Testing ${providerLabel(id)}…`);
    try {
      const payload = await api.request('/api/health?probe=1');
      const check = payload.checks?.find((item) => item.id === id);
      showToast(check?.ok ? `${providerLabel(id)}: ${check.detail}` : `${providerLabel(id)}: ${check?.detail || 'No response.'}`, check?.ok ? 'success' : 'error');
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  function savePromptModal() {
    openModal(`<div class="modal-scrim" data-scrim="true"><section class="modal-dialog" role="dialog" aria-modal="true" aria-labelledby="save-prompt-title">
      <div class="modal-header"><div><h2 id="save-prompt-title">Save a prompt</h2><p>Keep a starter you keep coming back to.</p></div><button class="modal-close" type="button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div>
      <form id="save-prompt-form"><div class="modal-body">
        <div class="form-field"><label for="save-prompt-title-input">Title</label><input id="save-prompt-title-input" name="title" required maxlength="80" placeholder="e.g. Launch email in three beats" /></div>
        <div class="form-row">
          <div class="form-field"><label for="save-prompt-category">Category</label><select id="save-prompt-category" name="category"><option>Brand &amp; identity</option><option>Marketing</option><option>Product &amp; web</option><option>Film &amp; motion</option><option>Research</option><option>Audio</option><option>My prompts</option></select></div>
          <div class="form-field"><label for="save-prompt-mode">Made for</label><select id="save-prompt-mode" name="mode"><option>Writing</option><option>Image</option><option>Video</option><option>Audio</option><option>Code</option></select></div>
        </div>
        <div class="form-field"><label for="save-prompt-body">Prompt</label><textarea id="save-prompt-body" name="body" required placeholder="Write the prompt exactly as you would use it…"></textarea></div>
      </div>
      <div class="modal-footer"><span class="modal-note">${api.online ? 'Saved to your workspace in SQLite.' : 'Saved in this browser only — the Studio server is offline.'}</span>
        <button class="secondary-button" type="button" data-action="close-modal">Cancel</button>
        <button class="primary-button" type="submit">Save prompt ${icon('arrow-right')}</button></div></form>
    </section></div>`, 'save-prompt', { focus: '#save-prompt-title-input' });
  }

  function exportUsageCsv() {
    const usage = state.usage;
    const rows = [['activity', 'model', 'provider', 'project', 'date', 'credits', 'status']];
    const list = usage?.recent?.length ? usage.recent : [];
    for (const item of list) {
      const project = state.projects.find((entry) => entry.id === item.projectId);
      rows.push([
        `${item.kind === 'image' ? 'Image' : 'Text'} generation`, item.model, item.provider,
        project?.title || '—', item.created, Math.round(item.credits), item.status,
      ]);
    }
    if (!list.length) rows.push(['No generations recorded yet', '', '', '', '', '', '']);
    const csv = rows.map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `ai-studio-os-usage-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    showToast(list.length ? 'Usage exported as CSV.' : 'Usage exported — no generations recorded yet.', list.length ? 'success' : 'error');
  }

  function toggleAutomation(id) {
    const automation = state.automations.find((item) => item.id === id);
    if (!automation) return;
    const enabled = !automation.enabled;
    automation.enabled = enabled; // optimistic: a toggle should feel instant
    if (!api.online) {
      saveStorage(STORAGE.automations, state.automations);
      renderPage();
      showToast(`${automation.name} ${enabled ? 'is on' : 'is paused'}.`);
      return;
    }
    api.request(`/api/automations/${encodeURIComponent(id)}`, { method: 'PATCH', body: { enabled } })
      .then((payload) => { applyServerState({ automations: payload.automations }); renderPage(); showToast(`${automation.name} ${enabled ? 'is on' : 'is paused'}.`); })
      .catch((error) => { automation.enabled = !enabled; renderPage(); showToast(error.message, 'error'); });
  }

  /** "Run now" performs real work when the automation maps onto a generator step. */
  async function runAutomation(id) {
    const automation = state.automations.find((item) => item.id === id);
    if (!automation) return;
    if (!api.online) {
      showToast('Start the Studio server (npm start) to run this workflow.', 'error');
      return;
    }
    showToast(`Running “${automation.name}”…`);
    try {
      const payload = await api.request(`/api/automations/${encodeURIComponent(id)}/run`, { method: 'POST' });
      applyServerState({ automations: payload.automations });
      if (payload.status === 'skipped') {
        renderPage();
        showToast(payload.message, 'error');
        return;
      }
      renderPage();
      // The run response carries the list, not each workflow's history.
      loadAutomationRuns({ force: true });
      showToast(`“${automation.name}” finished${payload.isDemo ? ' in demo mode' : ''}.`);
      const view = openGenerationModal({ prompt: '', mode: 'Writing', model: payload.generation?.model || 'Auto select' });
      view.text = payload.output || '';
      if (view.stream) { view.stream.classList.remove('is-streaming', 'is-empty'); view.stream.textContent = view.text; }
      finishOutput(view, { generation: payload.generation, failed: false });
      if (view.status) view.status.textContent = `Automation output · ${automation.name}`;
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function refreshModels() {
    if (!api.online) { showToast('Start the Studio server to refresh the catalogue.', 'error'); return; }
    showToast('Asking each provider for its current models…');
    try {
      const payload = await api.request('/api/models?refresh=1');
      state.models = payload.models;
      if (Array.isArray(payload.providers)) api.providers = payload.providers;
      renderPage();
      showToast(`Catalogue refreshed — ${payload.models.length} models.`);
    } catch (error) {
      showToast(error.message, 'error');
    }
  }

  async function reconnectBackend() {
    closeModal(false);
    await bootstrap({ announce: true });
  }

  /**
   * Single boot call. If the server is not there, the prototype keeps working
   * from local storage and the UI says so instead of appearing broken.
   */
  async function bootstrap({ announce = false } = {}) {
    try {
      const data = await api.request('/api/bootstrap');
      api.online = true;
      api.mode = data.mode;
      api.providers = data.providers || [];
      api.capabilities = data.capabilities || {};
      api.lastError = '';
      applyServerState({
        projects: data.projects,
        activity: data.activity,
        automations: data.automations,
        usage: data.usage,
        files: data.files,
        scheduler: data.scheduler,
      });
      state.models = data.models;
      state.settings = { ...state.settings, ...data.settings };
      if (Array.isArray(data.prompts) && data.prompts.length) promptData = data.prompts;
      saveStorage(STORAGE.projects, state.projects);
      saveStorage(STORAGE.automations, state.automations);
      saveStorage(STORAGE.settings, state.settings);
      renderPage();
      if (announce) showToast(data.mode === 'live' ? 'Connected — generating with real models.' : 'Connected — the Studio demo engine is ready.');
      return true;
    } catch (error) {
      api.online = false;
      api.mode = 'offline';
      api.lastError = error.message;
      updateEnvPill();
      if (announce) showToast(`Still offline: ${error.message}`, 'error');
      return false;
    }
  }

  function handleAction(action, button, event) {
    const id = button.dataset.id;
    switch (action) {
      case 'open-command': commandModal(); break;
      case 'new-project': newProjectModal(); break;
      case 'choose-model': showModelPicker(button); break;
      case 'choose-mode': showModePicker(button); break;
      case 'select-model': {
        state.selectedModel = button.dataset.value || 'Auto select';
        closePopover();
        const label = document.getElementById('selected-model');
        if (label) label.textContent = state.selectedModel;
        showToast(`${state.selectedModel} selected for your next idea.`);
        break;
      }
      case 'select-mode': {
        state.promptMode = button.dataset.value || 'Image';
        closePopover();
        const label = document.getElementById('selected-mode');
        const modeButton = document.querySelector('[data-action="choose-mode"]');
        if (label) label.textContent = state.promptMode;
        // Re-render the mode icon while preserving the current selection label.
        if (modeButton) modeButton.innerHTML = `${icon(modeIcon(state.promptMode))}<span id="selected-mode">${escapeHTML(state.promptMode)}</span>${icon('chevron-down', 'icon-small')}`;
        showToast(`${state.promptMode} mode is ready.`);
        break;
      }
      case 'enhance-prompt': {
        const input = document.getElementById('main-prompt');
        if (!input || !input.value.trim()) {
          showToast('Add a rough idea first, then polish it.', 'error');
          input?.focus();
          break;
        }
        if (!input.value.trim().toLowerCase().startsWith('creative brief:')) input.value = `Creative brief: ${input.value.trim()}\n\nDirection: keep the result clear, considered, and specific.`;
        showToast('Your idea has a little more structure.');
        break;
      }
      case 'open-project': closePopover(); projectDetailModal(id); break;
      case 'project-menu': showProjectMenu(button, id); break;
      case 'duplicate-project': duplicateProject(id); break;
      case 'archive-project': archiveProject(id); break;
      case 'project-filter': {
        state.projectFilter = button.dataset.filter || 'All projects';
        document.querySelectorAll('.filter-tab[data-action="project-filter"]').forEach((tab) => {
          const selected = tab.dataset.filter === state.projectFilter;
          tab.classList.toggle('is-active', selected);
          tab.setAttribute('aria-selected', String(selected));
        });
        const results = document.getElementById('projects-results');
        if (results) results.innerHTML = projectListHTML();
        break;
      }
      case 'clear-project-filters': {
        state.projectFilter = 'All projects'; state.projectSearch = '';
        renderPage();
        break;
      }
      case 'create-canvas': {
        createProject({ title: `Untitled canvas ${state.projects.filter((p) => p.type === 'Canvas').length + 1}`, type: 'Canvas', model: state.selectedModel, prompt: '', toastMessage: 'Your new canvas is ready to shape.' });
        break;
      }
      case 'canvas-tips': showToast('Tip: start with a reference, a question, or a rough prompt — there is no wrong first move.'); break;
      case 'model-filter': {
        state.modelFilter = button.dataset.filter || 'All models';
        document.querySelectorAll('[data-action="model-filter"]').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.filter === state.modelFilter));
        const results = document.getElementById('model-results');
        if (results) results.innerHTML = modelCardsHTML(state.modelFilter);
        break;
      }
      case 'use-model':
        state.selectedModel = button.dataset.model || 'Auto select';
        navigate('overview');
        document.getElementById('main-prompt')?.focus();
        showToast(`${state.selectedModel} is selected for your next idea.`);
        break;
      case 'model-compare': showToast('Model comparison is a great next step for the workspace.'); break;
      case 'prompt-category': {
        state.promptCategory = button.dataset.filter || 'All prompts';
        document.querySelectorAll('[data-action="prompt-category"]').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.filter === state.promptCategory));
        const results = document.getElementById('prompts-results');
        if (results) results.innerHTML = promptCardsHTML();
        break;
      }
      case 'use-prompt': {
        const prompt = promptData.find((item) => item.id === id);
        if (!prompt) break;
        state.promptMode = prompt.mode;
        navigate('overview');
        const input = document.getElementById('main-prompt');
        if (input) { input.value = prompt.text; input.focus(); }
        showToast(`“${prompt.title}” is ready to edit.`);
        // Usage counts are real data, so they belong on the server.
        if (api.online) api.request(`/api/prompts/${encodeURIComponent(id)}/use`, { method: 'POST' }).catch(() => {});
        break;
      }
      case 'save-prompt-info': savePromptModal(); break;
      case 'attach-files': document.getElementById('attachment-input')?.click(); break;
      case 'remove-attachment': {
        const file = state.attachments.find((item) => item.id === id);
        state.attachments = state.attachments.filter((item) => item.id !== id);
        if (file && /^f-/.test(id)) api.request(`/api/files/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
        refreshAttachmentStrip();
        break;
      }
      case 'new-automation': openNewAutomationModal(); break;
      case 'toggle-automation': toggleAutomation(id); break;
      case 'run-automation': runAutomation(id); break;
      case 'automation-templates': showToast('Templates are on the roadmap; create a workflow by hand for now.'); break;
      case 'download-usage': exportUsageCsv(); break;
      case 'backend-status': backendStatusModal(); break;
      case 'reconnect-backend': reconnectBackend(); break;
      case 'provider-probe': probeProvider(button.dataset.provider); break;
      case 'refresh-models': refreshModels(); break;
      case 'generate-again': {
        const project = state.projects.find((item) => item.id === id);
        closeModal(false);
        if (!project) { showToast('That project is no longer here.', 'error'); break; }
        startGeneration({
          prompt: project.prompt || project.title,
          mode: project.type === 'Image' ? 'Image' : 'Writing',
          model: project.model || 'Auto select',
          projectId: project.id,
        });
        break;
      }
      case 'manage-plan': showToast('Plan management can be connected to your billing provider.'); break;
      case 'settings-tab': state.settingsTab = button.dataset.tab || 'Profile'; renderPage(); break;
      case 'notifications': notificationModal(); break;
      case 'help': helpModal(); break;
      case 'mark-notifications-read': state.notificationsRead = true; notificationModal(); const dot = document.querySelector('.notification-dot'); if (dot) dot.style.display = 'none'; break;
      case 'close-modal': closeModal(); break;
      case 'detail-open-canvas': {
        const project = state.projects.find((item) => item.id === id);
        closeModal(false);
        navigate('canvas');
        showToast(project ? `Opening a canvas for “${project.title}”.` : 'Canvas is ready.');
        break;
      }
      case 'command-new-project': closeModal(false); newProjectModal(); break;
      case 'command-navigate': closeModal(false); navigate(button.dataset.page || 'overview'); break;
      case 'profile-menu': profileMenu(button); break;
      case 'workspace-menu': workspaceMenu(button); break;
      case 'profile-info': closePopover(); showToast('Studio OS starter · your creative workspace prototype.'); break;
      case 'workspace-info': closePopover(); showToast('Workspace switching can be added when you connect an account.'); break;
      case 'activity-refresh': {
        if (!api.online) { showToast('You’re all caught up on recent activity.'); break; }
        api.request('/api/activity?limit=6')
          .then((payload) => { applyServerState(payload); renderPage(); showToast('Activity refreshed.'); })
          .catch((error) => showToast(error.message, 'error'));
        break;
      }
      case 'toggle-sidebar': document.getElementById('sidebar')?.classList.toggle('is-open'); document.getElementById('mobile-scrim')?.classList.toggle('is-visible'); break;
      default: break;
    }
    if (event) event.stopPropagation();
  }

  function closeSidebar() {
    document.getElementById('sidebar')?.classList.remove('is-open');
    document.getElementById('mobile-scrim')?.classList.remove('is-visible');
  }

  document.addEventListener('click', (event) => {
    const mobileScrim = event.target.closest('#mobile-scrim');
    if (mobileScrim) { closeSidebar(); return; }
    const modalScrim = event.target.closest('.modal-scrim');
    if (modalScrim && event.target === modalScrim) { closeModal(); return; }

    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      handleAction(actionButton.dataset.action, actionButton, event);
      return;
    }
    const pageTrigger = event.target.closest('[data-page]');
    if (pageTrigger) {
      event.preventDefault();
      closePopover();
      navigate(pageTrigger.dataset.page);
      return;
    }
    if (state.popover && !state.popover.contains(event.target)) closePopover();
  });

  document.addEventListener('input', (event) => {
    if (event.target.id === 'project-search') {
      state.projectSearch = event.target.value;
      const results = document.getElementById('projects-results');
      if (results) results.innerHTML = projectListHTML();
    }
    if (event.target.id === 'prompt-search') {
      state.promptSearch = event.target.value;
      const results = document.getElementById('prompts-results');
      if (results) results.innerHTML = promptCardsHTML();
    }
    if (event.target.id === 'command-input') renderCommandResults(event.target.value);
  });

  // File pickers and selects settle on `change`, not `input` — listening for
  // both would upload the same file twice.
  document.addEventListener('change', (event) => {
    if (event.target.matches?.('[data-schedule-kind]')) syncScheduleFields(event.target.closest('form') || document);
    if (event.target.id === 'attachment-input' && event.target.files?.length) {
      uploadAttachments(event.target.files);
    }
  });

  document.addEventListener('submit', (event) => {
    if (event.target.id === 'prompt-form') {
      event.preventDefault();
      const input = document.getElementById('main-prompt');
      const prompt = input?.value.trim() || '';
      if (!prompt) {
        showToast('Tell us a little about what you want to make.', 'error');
        input?.focus();
        return;
      }
      const title = prompt.replace(/\s+/g, ' ').split(/[.!?]/)[0].slice(0, 48).trim() || 'A new idea';
      const fullTitle = title.length < prompt.length ? `${title}…` : title;
      // The dashboard prompt box generates straight away; the brief becomes the
      // project and the model's output lands inside it.
      const fileIds = state.attachments.filter((file) => !file.uploading).map((file) => file.id);
      startGeneration({ prompt, mode: state.promptMode, model: state.selectedModel, title: fullTitle, fileIds });
      state.attachments = [];
      refreshAttachmentStrip();
      return;
    }
    if (event.target.id === 'create-project-form') {
      event.preventDefault();
      const form = event.target;
      const data = new FormData(form);
      const created = createProject({ title: data.get('title'), type: data.get('type'), model: data.get('model'), prompt: data.get('prompt') });
      if (created) closeModal(false);
      return;
    }
    if (event.target.id === 'automation-form') {
      event.preventDefault();
      const data = new FormData(event.target);
      const schedule = scheduleFromForm(data);
      api.request('/api/automations', {
        method: 'POST',
        body: {
          name: String(data.get('name') || '').trim(),
          description: String(data.get('description') || '').trim(),
          action: String(data.get('action') || 'Curate & summarize'),
          schedule,
        },
      }).then((payload) => {
        closeModal(false);
        applyServerState({ automations: payload.automations });
        renderPage();
        showToast(`“${payload.automation.name}” is ready — ${payload.automation.triggerLabel.toLowerCase()}.`);
      }).catch((error) => showToast(error.message, 'error'));
      return;
    }
    if (event.target.id === 'save-prompt-form') {
      event.preventDefault();
      const data = new FormData(event.target);
      const draft = {
        title: String(data.get('title') || '').trim(),
        category: String(data.get('category') || 'My prompts'),
        mode: String(data.get('mode') || 'Writing'),
        body: String(data.get('body') || '').trim(),
      };
      if (!draft.title || !draft.body) return;
      const locally = () => {
        promptData = [{ id: `p-${Date.now()}`, ...draft, icon: 'sparkles', uses: '0 uses' }, ...promptData];
        closeModal(false);
        renderPage();
        showToast(`“${draft.title}” was saved to your prompt library.`);
      };
      if (!api.online) return locally();
      api.request('/api/prompts', { method: 'POST', body: draft })
        .then((payload) => {
          promptData = payload.prompts;
          closeModal(false);
          navigate('prompts');
          showToast(`“${draft.title}” was saved to your prompt library.`);
        })
        .catch((error) => showToast(error.message, 'error'));
      return;
    }
    if (event.target.id === 'automation-form') {
      event.preventDefault();
      const data = new FormData(event.target);
      const automation = {
        id: `a-${Date.now()}`,
        name: String(data.get('name') || '').trim(),
        description: String(data.get('description') || '').trim() || 'A new workflow for the little things that add up.',
        trigger: String(data.get('trigger') || 'On demand'),
        action: String(data.get('action') || 'Curate & summarize'),
        lastRun: 'Not run yet',
        enabled: true,
        tone: 'purple',
      };
      if (!automation.name) return;
      state.automations.unshift(automation);
      saveStorage(STORAGE.automations, state.automations);
      closeModal(false);
      renderPage();
      showToast('Your new automation is ready.');
      return;
    }
    if (event.target.id === 'settings-form') {
      event.preventDefault();
      const data = new FormData(event.target);
      for (const key of ['name', 'email', 'workspace', 'timezone']) if (data.has(key)) state.settings[key] = String(data.get(key));
      saveStorage(STORAGE.settings, state.settings);
      if (!api.online) { showToast('Your settings have been saved in this browser.'); return; }
      api.request('/api/settings', { method: 'PUT', body: state.settings })
        .then((payload) => { state.settings = { ...state.settings, ...payload.settings }; updateShell(); renderPage(); showToast('Settings saved to your workspace.'); })
        .catch((error) => showToast(error.message, 'error'));
    }
  });

  document.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      commandModal();
      return;
    }
    if (event.key === 'Escape') {
      if (state.modalType) { closeModal(); return; }
      if (state.popover) { closePopover(); return; }
      closeSidebar();
    }
    if (event.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      event.preventDefault();
      commandModal();
    }
    if (state.modalType === 'command' && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      const items = Array.from(document.querySelectorAll('.command-item'));
      if (!items.length) return;
      let current = items.findIndex((item) => item.classList.contains('is-selected'));
      current = event.key === 'ArrowDown' ? (current + 1) % items.length : (current <= 0 ? items.length - 1 : current - 1);
      items.forEach((item, index) => item.classList.toggle('is-selected', index === current));
      items[current].scrollIntoView({ block: 'nearest' });
    }
    if (state.modalType === 'command' && event.key === 'Enter') {
      const selected = document.querySelector('.command-item.is-selected') || document.querySelector('.command-item');
      if (selected) { event.preventDefault(); selected.click(); }
    }
    if (state.modalType && event.key === 'Tab') {
      const root = document.getElementById('modal-root');
      const focusable = Array.from(root.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  });

  window.addEventListener('resize', () => { if (state.popover) closePopover(); });
  window.addEventListener('scroll', () => { if (state.popover) closePopover(); }, true);

  updateShell();
  renderPage();

  /**
   * Boot: render the offline workspace immediately (never a blank screen), then
   * upgrade to the server's data. A few quiet retries cover the case where the
   * frontend is opened moments before the server finishes starting.
   */
  (async () => {
    let attempts = 0;
      while (!(await bootstrap()) && attempts < 3) {
        attempts += 1;
        await new Promise((resolve) => setTimeout(resolve, 4_000));
      }
  })();
})();

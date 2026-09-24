/**
 * Seed content.
 *
 * The prototype's demo workspace lives here so a fresh database opens with a
 * workspace worth exploring. Seeding runs once, only when the projects table is
 * empty; after that the database (not this file) is the source of truth.
 */

export const SEED_PROJECTS = [
  {
    id: 'p-aurora',
    title: 'Aurora — skincare launch film',
    type: 'Campaign',
    model: 'Flux 1.1 Pro',
    status: 'Completed',
    art: 'aurora',
    outputs: 8,
    prompt: 'A slow, sunlit film for a new botanical skincare line. Warm peach and rose tones, tactile close-ups of glass and water, soft morning shadows, calm editorial pacing.',
    ageMinutes: 12,
  },
  {
    id: 'p-fieldnotes',
    title: 'Fieldnotes — visual identity',
    type: 'Brand identity',
    model: 'Claude Sonnet',
    status: 'In progress',
    art: 'fieldnotes',
    outputs: 14,
    prompt: 'Build a quiet, tactile identity for Fieldnotes, a sustainable outdoor journal. Pair warm paper, forest green, and understated editorial typography.',
    ageMinutes: 48,
  },
  {
    id: 'p-nimbus',
    title: 'Nimbus product launch page',
    type: 'Website',
    model: 'Claude Sonnet',
    status: 'In review',
    art: 'nimbus',
    outputs: 3,
    prompt: 'A thoughtful product landing page for Nimbus, a lightweight air-quality monitor. Calm coastal colors, generous space, clear product benefits and an editorial hero.',
    ageMinutes: 120,
  },
  {
    id: 'p-soundscape',
    title: 'Soundscape for slow mornings',
    type: 'Audio',
    model: 'Studio demo engine',
    status: 'Completed',
    art: 'soundscape',
    outputs: 4,
    prompt: 'Instrumental ambient audio for a slow Sunday morning. Soft felt piano, warm tape texture, subtle field recordings, no percussion, around three minutes.',
    ageMinutes: 1_500,
  },
  {
    id: 'p-atlas',
    title: 'Atlas — a weekend in Lisbon',
    type: 'Campaign',
    model: 'GPT-4.1',
    status: 'In progress',
    art: 'atlas',
    outputs: 11,
    prompt: 'A sun-faded travel editorial about finding a slower rhythm in Lisbon. Burnt terracotta, deep indigo, candid film photography and a little grain.',
    ageMinutes: 1_600,
  },
  {
    id: 'p-studio',
    title: 'Studio OS mobile dashboard',
    type: 'Product design',
    model: 'Claude Sonnet',
    status: 'Draft',
    art: 'studio',
    outputs: 1,
    prompt: 'Explore a mobile companion for a creative AI workspace. Make the project queue, model picker and quick capture feel calm and useful.',
    ageMinutes: 4_300,
  },
];

export const SEED_PROMPTS = [
  {
    id: 'p-brand',
    title: 'Brand world starter',
    category: 'Brand & identity',
    icon: 'sparkles',
    uses: 2400,
    mode: 'Image',
    text: 'Create a distinctive visual world for [brand]. Start with three mood directions, a considered palette, material references, and one memorable hero image. Keep it editorial, specific, and easy to art-direct.',
  },
  {
    id: 'p-campaign',
    title: 'Campaign concept sprint',
    category: 'Marketing',
    icon: 'wand',
    uses: 1800,
    mode: 'Writing',
    text: 'Develop three campaign routes for [product] and [audience]. For each route, include a one-line idea, the human insight behind it, a visual hook, sample headline, and a practical first activation.',
  },
  {
    id: 'p-product',
    title: 'Product page, with a point of view',
    category: 'Product & web',
    icon: 'globe',
    uses: 986,
    mode: 'Writing',
    text: 'Write a clear, characterful landing page for [product]. Lead with the customer’s real tension, make the value concrete, use short scannable sections, and finish with a confident call to action. Avoid empty superlatives.',
  },
  {
    id: 'p-film',
    title: 'A film in six beats',
    category: 'Film & motion',
    icon: 'video',
    uses: 842,
    mode: 'Video',
    text: 'Turn this idea into a 20-second film: [idea]. Write six distinct shots with framing, movement, light, sound, and transition. Keep the visual language coherent and leave room for a quiet final beat.',
  },
  {
    id: 'p-research',
    title: 'Make the research useful',
    category: 'Research',
    icon: 'book',
    uses: 721,
    mode: 'Writing',
    text: 'Synthesize the following research for a creative team: [notes]. Separate what we know from what we assume, surface three useful tensions, and end with five specific questions worth exploring next.',
  },
  {
    id: 'p-sound',
    title: 'Soundtrack in a sentence',
    category: 'Audio',
    icon: 'audio',
    uses: 603,
    mode: 'Audio',
    text: 'Compose an original instrumental soundscape for [scene or feeling]. Describe the tempo, core instruments, texture, dynamics, and emotional arc. Keep it original, understated, and vivid.',
  },
];

export const SEED_AUTOMATIONS = [
  {
    id: 'a-digest',
    name: 'Monday inspiration digest',
    description: 'Collect the week’s saved references and send a tidy Monday recap.',
    trigger: 'Every Monday · 9:00 AM',
    action: 'Curate & summarize',
    actionKind: 'text',
    lastRun: 'Today, 9:00 AM',
    enabled: true,
    tone: 'purple',
  },
  {
    id: 'a-review',
    name: 'Ready-for-review handoff',
    description: 'When a project is marked ready, create a short handoff with the latest outputs.',
    trigger: 'When status changes to review',
    action: 'Draft a handoff',
    actionKind: 'text',
    lastRun: 'Yesterday',
    enabled: true,
    tone: 'green',
  },
  {
    id: 'a-archive',
    name: 'Keep the workspace tidy',
    description: 'Find old experiments and group them into an archive collection.',
    trigger: 'On the first day of each month',
    action: 'Organize projects',
    actionKind: 'navigate',
    lastRun: 'Sep 1, 2026',
    enabled: false,
    tone: 'orange',
  },
];

export const SEED_ACTIVITY = [
  { icon: 'wand', tone: '', line: '<strong>Flux 1.1 Pro</strong> created 4 new variations', project: 'Fieldnotes identity', ageMinutes: 18 },
  { icon: 'check', tone: 'green', line: '<strong>Runway Gen-4</strong> finished a video generation', project: 'Aurora launch film', ageMinutes: 42 },
  { icon: 'file', tone: 'orange', line: '<strong>Claude Sonnet</strong> updated a project brief', project: 'Nimbus product page', ageMinutes: 120 },
];

export const SEED_SETTINGS = {
  name: 'Alex Chen',
  email: 'alex@northstar.studio',
  workspace: 'Northstar Studio',
  timezone: 'Asia/Kolkata',
  startPage: 'Overview',
  defaultModel: 'Auto select',
};

/**
 * Automation actions map onto the gateway so "run now" performs real work
 * instead of printing a toast. `navigate` actions are workspace chores that
 * stay local for now and are reported as such.
 */
export const AUTOMATION_TEMPLATES = {
  'Curate & summarize': {
    kind: 'text',
    buildPrompt: () => 'Write a short, warm Monday recap for a small creative studio. List three things worth picking back up this week, each as a single sentence with a clear next action.',
  },
  'Draft a handoff': {
    kind: 'text',
    buildPrompt: ({ project }) => `Write a concise handoff note for the project “${project?.title || 'Untitled project'}”. Include: what it is, the current status, what a reviewer should look at first, and two open questions. Keep it under 200 words.`,
  },
  'Prepare a creative brief': {
    kind: 'text',
    buildPrompt: ({ project }) => `Turn this into a one-page creative brief: “${project?.prompt || project?.title || 'A new idea'}”. Cover audience, tension, idea, tone, and the first deliverable.`,
  },
  'Organize projects': {
    kind: 'navigate',
    buildPrompt: () => '',
  },
};

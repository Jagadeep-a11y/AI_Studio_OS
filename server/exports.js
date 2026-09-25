import { createZip } from './zip.js';

/**
 * Project exports.
 *
 * An automation can hand a project back as something you can keep: a Markdown
 * brief with its generations, or a zip of the same plus every reference file and
 * generated asset. Both are built from rows the caller already fetched, so this
 * module has no database or storage access of its own — the one thing it needs
 * from the outside is a way to read file bytes, passed in as `read`.
 */

const MAX_OUTPUT_CHARS = 4_000;
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024; // keep an export downloadable

const slug = (value) => String(value ?? '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 60) || 'project';

const humanSize = (bytes = 0) => {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
};

const when = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';
};

/** A short, readable credit line for one generation row. */
const creditLine = (generation) => [
  generation.modelLabel || generation.modelId || 'unknown model',
  generation.mode || generation.kind || '',
  generation.credits ? `${generation.credits} credits` : '',
  generation.tokensOut ? `${generation.tokensOut} tokens out` : '',
].filter(Boolean).join(' · ');

/**
 * The Markdown view of a project: what it is, what was asked for, what came
 * back, and what is attached. Deliberately plain text — it should read well in
 * a git diff or a code review, not just in a Markdown viewer.
 */
export function buildProjectMarkdown({ project, generations = [], files = [], notes = [], now = new Date() }) {
  const title = project?.title || 'Untitled project';
  const lines = [];
  lines.push(`# ${title}`, '');
  lines.push(`_${[project?.type, project?.status, project?.model].filter(Boolean).join(' · ') || 'No metadata'}_`, '');
  lines.push(`Exported ${when(now).replace(' ', ' at ')} · ${generations.length} generation${generations.length === 1 ? '' : 's'} · ${Number(project?.outputs) || 0} recorded output${Number(project?.outputs) === 1 ? '' : 's'}`, '');

  lines.push('## Brief', '');
  lines.push(project?.prompt ? String(project.prompt).trim() : '_No brief recorded for this project._', '');

  lines.push('## Generations', '');
  if (!generations.length) {
    lines.push('_Nothing generated yet._', '');
  } else {
    generations.forEach((generation, index) => {
      const output = String(generation.output || '').trim();
      lines.push(`### ${index + 1}. ${generation.modelLabel || generation.modelId || 'Generation'}`, '');
      lines.push(`${creditLine(generation) || 'No usage recorded'}${generation.created ? ` · ${when(generation.created)}` : ''}`, '');
      if (generation.prompt) lines.push('> ' + String(generation.prompt).replace(/\n+/g, ' ').slice(0, 400), '');
      if (output) {
        const clipped = output.length > MAX_OUTPUT_CHARS;
        lines.push('', '```', clipped ? `${output.slice(0, MAX_OUTPUT_CHARS)}\n… (${output.length - MAX_OUTPUT_CHARS} more characters in the studio)` : output, '```');
      } else {
        lines.push('', `_Status: ${generation.status || 'unknown'}._`);
      }
      lines.push('');
    });
  }

  lines.push('## Files', '');
  if (!files.length) {
    lines.push('_No files stored for this project._', '');
  } else {
    for (const file of files) {
      lines.push(`- \`${file.name}\` — ${file.kind || 'file'}, ${humanSize(file.size)}${file.mime ? `, ${file.mime}` : ''}`);
    }
    lines.push('');
  }

  if (notes.length) {
    lines.push('## Notes', '');
    for (const note of notes) lines.push(`- ${note}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * The same export as a zip: the brief as `brief.md`, generation output as
 * individual files, and every stored file under `files/`.
 *
 * Files are read through the caller's `read(file)` so this works identically on
 * local disk and in a bucket. Anything that cannot be read is listed in the
 * returned `skipped` array instead of failing the whole export — a missing
 * thumbnail should not cost you the brief.
 */
export async function buildProjectArchive({ project, generations = [], files = [], read, now = new Date() }) {
  const entries = [];
  const skipped = [];
  const markdown = buildProjectMarkdown({ project, generations, files, now });
  entries.push({ name: 'brief.md', data: markdown });

  let budget = MAX_ARCHIVE_BYTES - Buffer.byteLength(markdown);

  const outputEntries = generations
    .map((generation, index) => ({ generation, index }))
    .filter(({ generation }) => String(generation.output || '').trim() && generation.kind !== 'image');
  for (const { generation, index } of outputEntries) {
    const body = String(generation.output);
    budget -= Buffer.byteLength(body);
    if (budget < 0) {
      skipped.push(`output ${index + 1} (export size limit reached)`);
      continue;
    }
    entries.push({ name: `generations/${String(index + 1).padStart(2, '0')}-${slug(generation.modelLabel || generation.mode || 'output')}.md`, data: body });
  }

  if (typeof read === 'function') {
    for (const file of files) {
      try {
        const body = await read(file);
        if (!body?.length) {
          skipped.push(`${file.name} (empty or unreadable)`);
          continue;
        }
        budget -= body.length;
        if (budget < 0) {
          skipped.push(`${file.name} (export size limit reached)`);
          continue;
        }
        entries.push({ name: `files/${file.name}`, data: body });
      } catch (error) {
        skipped.push(`${file.name} (${error.message})`);
      }
    }
  }

  if (skipped.length) entries.push({ name: 'skipped.txt', data: `Not included in this export:\n${skipped.map((line) => `- ${line}`).join('\n')}\n` });

  return {
    buffer: createZip(entries, { date: now }),
    entryCount: entries.length,
    skipped,
    markdown,
  };
}

export const exportFileName = (project, extension) => `${slug(project?.title || 'project')}.${extension}`;

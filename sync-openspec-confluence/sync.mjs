#!/usr/bin/env node
/**
 * Syncs archived OpenSpec changes to Confluence.
 *
 * Page hierarchy:
 *   CONFLUENCE_PARENT_PAGE_ID
 *     └── <repo-name>               ← summary page: table of all archived changes
 *           └── <change-name>       ← one page per archived change
 *
 * For each change in CHANGED_DIRS the individual page is created/updated.
 * After every run the repo summary page is fully rebuilt from all archived changes.
 *
 * Required env vars:
 *   CONFLUENCE_BASE_URL        https://gruppoeuris.atlassian.net/wiki  (hardcoded in workflow)
 *   CONFLUENCE_EMAIL           davide.finelli@euris.it  (hardcoded in workflow)
 *   CONFLUENCE_API_TOKEN       Atlassian personal API token (org secret)
 *   CONFLUENCE_SPACE_KEY       RES  (hardcoded in workflow)
 *   CONFLUENCE_PARENT_PAGE_ID  731578494  (hardcoded in workflow)
 *   REPO_NAME                  GitHub repository name (e.g. comparatore-bollette)
 *   CHANGED_DIRS               space-separated change names to sync
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ─── Config ──────────────────────────────────────────────────────────────────

const {
  CONFLUENCE_BASE_URL,
  CONFLUENCE_EMAIL,
  CONFLUENCE_API_TOKEN,
  CONFLUENCE_SPACE_KEY,
  CONFLUENCE_PARENT_PAGE_ID,
  REPO_NAME,
  CHANGED_DIRS,
} = process.env;

for (const key of ['CONFLUENCE_BASE_URL', 'CONFLUENCE_EMAIL', 'CONFLUENCE_API_TOKEN', 'CONFLUENCE_SPACE_KEY', 'CONFLUENCE_PARENT_PAGE_ID', 'REPO_NAME', 'CHANGED_DIRS']) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const ARCHIVE_DIR = 'openspec/changes/archive';
const changeNames = CHANGED_DIRS.trim().split(/\s+/).filter(Boolean);

// ─── Confluence helpers ───────────────────────────────────────────────────────

const basicAuth = Buffer.from(`${CONFLUENCE_EMAIL}:${CONFLUENCE_API_TOKEN}`).toString('base64');

const confluenceHeaders = {
  'Authorization': `Basic ${basicAuth}`,
  'Content-Type': 'application/json',
  'Accept': 'application/json',
};

async function confluenceRequest(method, path, body) {
  // CONFLUENCE_BASE_URL already includes /wiki (e.g. https://gruppoeuris.atlassian.net/wiki)
  const url = `${CONFLUENCE_BASE_URL}/rest/api${path}`;
  const res = await fetch(url, {
    method,
    headers: confluenceHeaders,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();

  if (!res.ok) {
    throw new Error(`Confluence API ${method} ${path} → ${res.status}: ${text}`);
  }

  return JSON.parse(text);
}

async function findPage(title) {
  const encoded = encodeURIComponent(title);
  const data = await confluenceRequest(
    'GET',
    `/content?title=${encoded}&spaceKey=${CONFLUENCE_SPACE_KEY}&type=page&expand=version`,
  );
  return data.size > 0 ? data.results[0] : null;
}

async function createPage(title, parentId, storageHtml) {
  return confluenceRequest('POST', '/content', {
    type: 'page',
    title,
    space: { key: CONFLUENCE_SPACE_KEY },
    ancestors: [{ id: parentId }],
    body: {
      storage: { value: storageHtml, representation: 'storage' },
    },
  });
}

async function updatePage(pageId, title, storageHtml, currentVersion) {
  return confluenceRequest('PUT', `/content/${pageId}`, {
    type: 'page',
    title,
    version: { number: currentVersion + 1 },
    body: {
      storage: { value: storageHtml, representation: 'storage' },
    },
  });
}

async function createOrUpdate(title, parentId, storageHtml) {
  const existing = await findPage(title);
  if (!existing) {
    const page = await createPage(title, parentId, storageHtml);
    return { page, created: true };
  }
  await updatePage(existing.id, title, storageHtml, existing.version.number);
  return { page: existing, created: false };
}

// ─── Markdown helpers ─────────────────────────────────────────────────────────

function readIfExists(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
}

/**
 * Extracts a short description from proposal.md:
 * the first non-empty paragraph under the first heading, or the first paragraph.
 */
function extractDescription(proposalMd) {
  if (!proposalMd) return '—';

  // Skip heading lines, grab first substantial paragraph
  const lines = proposalMd.split('\n');
  const paragraphLines = [];
  let inParagraph = false;

  for (const line of lines) {
    if (line.startsWith('#')) {
      if (inParagraph && paragraphLines.length > 0) break;
      continue;
    }
    if (line.trim() === '') {
      if (inParagraph && paragraphLines.length > 0) break;
      continue;
    }
    inParagraph = true;
    paragraphLines.push(line.trim());
  }

  const text = paragraphLines.join(' ').replaceAll(/\*\*(.+?)\*\*/g, '$1').trim();
  return text.length > 200 ? text.slice(0, 197) + '…' : text || '—';
}

/**
 * Builds a combined markdown document from all files in a change directory,
 * ordered: proposal → design → specs (alphabetical) → tasks.
 */
function buildChangeMarkdown(changeDir, changeName) {
  const sections = [];

  const proposal = readIfExists(join(changeDir, 'proposal.md'));
  if (proposal) sections.push(`# Proposal\n\n${proposal}`);

  const design = readIfExists(join(changeDir, 'design.md'));
  if (design) sections.push(`# Design\n\n${design}`);

  const specsDir = join(changeDir, 'specs');
  if (existsSync(specsDir)) {
    const specDirs = readdirSync(specsDir)
      .filter(name => statSync(join(specsDir, name)).isDirectory())
      .sort();

    for (const specName of specDirs) {
      const spec = readIfExists(join(specsDir, specName, 'spec.md'));
      if (spec) sections.push(`# Spec: ${specName}\n\n${spec}`);
    }
  }

  const tasks = readIfExists(join(changeDir, 'tasks.md'));
  if (tasks) sections.push(`# Tasks\n\n${tasks}`);

  if (sections.length === 0) {
    throw new Error(`No markdown content found in ${changeDir}`);
  }

  const header = `> **Change:** \`${changeName}\`  \n> **Repo:** \`${REPO_NAME}\`  \n> Synced from OpenSpec archive.\n\n---\n\n`;
  return header + sections.join('\n\n---\n\n');
}

/**
 * Converts markdown to Confluence storage HTML via pandoc.
 * pandoc is pre-installed on ubuntu-latest GitHub Actions runners.
 */
function markdownToStorageHtml(markdown) {
  return execSync('pandoc -f markdown -t html5 --no-highlight', {
    input: markdown,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

/**
 * Builds the HTML for the repo summary page.
 * Lists every archived change with description and a link to its child page.
 * Uses Confluence's ac:link macro so links resolve by title, not hardcoded URL.
 */
function buildRepoSummaryHtml(allChangeDirs) {
  const rows = allChangeDirs.map(({ name, dir }) => {
    const proposal = readIfExists(join(dir, 'proposal.md'));
    const description = extractDescription(proposal);
    const link = `<ac:link><ri:page ri:content-title="${escapeXml(name)}" ri:space-key="${CONFLUENCE_SPACE_KEY}" /></ac:link>`;
    return `<tr><td>${link}</td><td>${escapeXml(description)}</td></tr>`;
  });

  return [
    `<p>All archived OpenSpec changes for <strong>${escapeXml(REPO_NAME)}</strong>.</p>`,
    '<table>',
    '<tbody>',
    '<tr><th>Change</th><th>Description</th></tr>',
    ...rows,
    '</tbody>',
    '</table>',
  ].join('\n');
}

function escapeXml(str) {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

let exitCode = 0;

console.log(`\nRepo: ${REPO_NAME} | Changes to sync: ${changeNames.join(', ')}`);

// 1. Ensure the repo summary page exists and get its ID
let repoPage = await findPage(REPO_NAME);
if (!repoPage) {
  console.log(`\nCreating repo summary page "${REPO_NAME}"…`);
  repoPage = await createPage(REPO_NAME, CONFLUENCE_PARENT_PAGE_ID, `<p>Initialising…</p>`);
}
const repoPageId = repoPage.id;
console.log(`Repo page id=${repoPageId}`);

// 2. Sync individual change pages
for (const changeName of changeNames) {
  const changeDir = join(ARCHIVE_DIR, changeName);
  console.log(`\n── Syncing "${changeName}" ──────────────────────────`);

  if (!existsSync(changeDir)) {
    console.warn(`  Directory not found: ${changeDir} — skipping`);
    continue;
  }

  try {
    const storageHtml = markdownToStorageHtml(buildChangeMarkdown(changeDir, changeName));
    const { page, created } = await createOrUpdate(changeName, repoPageId, storageHtml);
    const link = `${CONFLUENCE_BASE_URL}${page._links?.webui ?? ''}`;
    console.log(`  ${created ? 'Created' : 'Updated'}: ${link}`);
  } catch (err) {
    console.error(`  ERROR syncing "${changeName}": ${err.message}`);
    exitCode = 1;
  }
}

// 3. Rebuild the repo summary page from ALL archived changes (not just this run)
console.log(`\n── Rebuilding repo summary page ──────────────────────────`);

const allChangeDirs = existsSync(ARCHIVE_DIR)
  ? readdirSync(ARCHIVE_DIR)
      .filter(name => statSync(join(ARCHIVE_DIR, name)).isDirectory())
      .sort()
      .map(name => ({ name, dir: join(ARCHIVE_DIR, name) }))
  : [];

if (allChangeDirs.length > 0) {
  try {
    const summaryHtml = buildRepoSummaryHtml(allChangeDirs);
    const freshRepoPage = await findPage(REPO_NAME);
    await updatePage(repoPageId, REPO_NAME, summaryHtml, freshRepoPage.version.number);
    console.log(`  Summary updated with ${allChangeDirs.length} change(s).`);
  } catch (err) {
    console.error(`  ERROR rebuilding summary: ${err.message}`);
    exitCode = 1;
  }
} else {
  console.log('  No archived changes found, summary left as-is.');
}

process.exit(exitCode);

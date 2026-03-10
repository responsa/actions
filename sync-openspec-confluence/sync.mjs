#!/usr/bin/env node
/**
 * Syncs OpenSpec capability specs to Confluence.
 *
 * Page hierarchy:
 *   CONFLUENCE_PARENT_PAGE_ID
 *     └── <repo-name>               ← summary page: table of all capability specs
 *           └── <capability-name>   ← one page per openspec/specs/<name>/spec.md
 *
 * For each capability name in CHANGED_DIRS (space-separated env var), reads:
 *   openspec/specs/<name>/spec.md
 *
 * After syncing individual pages, the repo summary page is fully rebuilt
 * from all capability specs currently in openspec/specs/.
 *
 * Required env vars:
 *   CONFLUENCE_BASE_URL        https://gruppoeuris.atlassian.net/wiki  (hardcoded in workflow)
 *   CONFLUENCE_EMAIL           davide.finelli@euris.it  (hardcoded in workflow)
 *   CONFLUENCE_API_TOKEN       Atlassian personal API token (org secret)
 *   CONFLUENCE_SPACE_KEY       RES  (hardcoded in workflow)
 *   CONFLUENCE_PARENT_PAGE_ID  731578494  (hardcoded in workflow)
 *   REPO_NAME                  GitHub repository name (e.g. comparatore-bollette)
 *   CHANGED_DIRS               space-separated capability names to sync
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

const SPECS_DIR = 'openspec/specs';
const capabilityNames = CHANGED_DIRS.trim().split(/\s+/).filter(Boolean);

// ─── Confluence helpers ───────────────────────────────────────────────────────

// Confluence REST API uses HTTP Basic auth: base64(email:api_token)
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

async function ensureRepoPage() {
  const existing = await findPage(REPO_NAME);
  if (existing) {
    console.log(`  Repo page found: "${REPO_NAME}" (id=${existing.id})`);
    return existing.id;
  }

  console.log(`  Repo page not found — creating "${REPO_NAME}" under parent ${CONFLUENCE_PARENT_PAGE_ID}`);
  const placeholder = `<p>OpenSpec capability specs for <strong>${REPO_NAME}</strong>.</p>`;
  const page = await createPage(REPO_NAME, CONFLUENCE_PARENT_PAGE_ID, placeholder);
  console.log(`  Created repo page: ${CONFLUENCE_BASE_URL}${page._links.webui}`);
  return page.id;
}

// ─── Spec helpers ─────────────────────────────────────────────────────────────

/**
 * Extracts a short description from a spec.md:
 * the first non-heading, non-empty paragraph.
 */
function extractDescription(specMd) {
  if (!specMd) return '—';

  const lines = specMd.split('\n');
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
 * Converts a spec.md to Confluence storage HTML via pandoc.
 * pandoc is pre-installed on ubuntu-latest GitHub Actions runners.
 */
function specToStorageHtml(specMd, capabilityName) {
  const decorated = `> **Capability:** \`${capabilityName}\`  \n> **Repo:** \`${REPO_NAME}\`  \n> Synced from OpenSpec.\n\n---\n\n${specMd}`;
  return execSync('pandoc -f markdown -t html5 --no-highlight', {
    input: decorated,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'inherit'],
  });
}

/**
 * Builds the HTML for the repo summary page.
 * Lists every capability with a description and a link to its child page.
 */
function buildRepoSummaryHtml(allCapabilities) {
  const rows = allCapabilities.map(({ name, specMd }) => {
    const description = extractDescription(specMd);
    const link = `<ac:link><ri:page ri:content-title="${escapeXml(name)}" ri:space-key="${CONFLUENCE_SPACE_KEY}" /></ac:link>`;
    return `<tr><td>${link}</td><td>${escapeXml(description)}</td></tr>`;
  });

  return [
    `<p>OpenSpec capability specs for <strong>${escapeXml(REPO_NAME)}</strong>.</p>`,
    '<table><tbody>',
    '<tr><th>Capability</th><th>Description</th></tr>',
    ...rows,
    '</tbody></table>',
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

console.log(`\nRepo: ${REPO_NAME} | Capabilities to sync: ${capabilityNames.join(', ')}`);

// 1. Ensure the repo summary page exists
let repoPage = await findPage(REPO_NAME);
if (!repoPage) {
  console.log(`\nCreating repo summary page "${REPO_NAME}"…`);
  repoPage = await createPage(REPO_NAME, CONFLUENCE_PARENT_PAGE_ID, `<p>Initialising…</p>`);
}
const repoPageId = repoPage.id;
console.log(`Repo page id=${repoPageId}`);

// 2. Sync individual capability pages
for (const capabilityName of capabilityNames) {
  const specFile = join(SPECS_DIR, capabilityName, 'spec.md');
  console.log(`\n── Syncing "${capabilityName}" ──────────────────────────`);

  if (!existsSync(specFile)) {
    console.warn(`  spec.md not found: ${specFile} — skipping`);
    continue;
  }

  try {
    const specMd = readFileSync(specFile, 'utf8');
    const storageHtml = specToStorageHtml(specMd, capabilityName);
    const { page, created } = await createOrUpdate(capabilityName, repoPageId, storageHtml);
    const link = `${CONFLUENCE_BASE_URL}${page._links?.webui ?? ''}`;
    console.log(`  ${created ? 'Created' : 'Updated'}: ${link}`);
  } catch (err) {
    console.error(`  ERROR syncing "${capabilityName}": ${err.message}`);
    exitCode = 1;
  }
}

// 3. Rebuild the repo summary page from ALL capability specs
console.log(`\n── Rebuilding repo summary page ──────────────────────────`);

const allCapabilities = existsSync(SPECS_DIR)
  ? readdirSync(SPECS_DIR)
      .filter(name => statSync(join(SPECS_DIR, name)).isDirectory())
      .sort()
      .map(name => {
        const specFile = join(SPECS_DIR, name, 'spec.md');
        return { name, specMd: existsSync(specFile) ? readFileSync(specFile, 'utf8') : null };
      })
      .filter(({ specMd }) => specMd !== null)
  : [];

if (allCapabilities.length > 0) {
  try {
    const summaryHtml = buildRepoSummaryHtml(allCapabilities);
    const freshRepoPage = await findPage(REPO_NAME);
    await updatePage(repoPageId, REPO_NAME, summaryHtml, freshRepoPage.version.number);
    console.log(`  Summary updated with ${allCapabilities.length} capability spec(s).`);
  } catch (err) {
    console.error(`  ERROR rebuilding summary: ${err.message}`);
    exitCode = 1;
  }
} else {
  console.log('  No capability specs found, summary left as-is.');
}

process.exit(exitCode);

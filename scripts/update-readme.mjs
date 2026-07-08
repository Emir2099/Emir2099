// update-readme.mjs
//
// Pulls live data straight from api.github.com — recent public activity and
// a real language breakdown computed from actual repo byte counts — and
// rewrites the marked sections of README.md. No third-party badge/widget
// services involved. Runs on a schedule via .github/workflows/update-readme.yml.

import { readFileSync, writeFileSync } from 'fs';

const USERNAME = process.env.GH_USERNAME || 'Emir2099';
const TOKEN = process.env.GH_TOKEN;
const MAX_REPOS_FOR_LANGUAGES = 30; // cap API calls on large accounts

const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
};

async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers });
  if (!res.ok) {
    throw new Error(`GitHub API ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function timeAgo(iso) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const hrs = Math.floor(diffMs / 3_600_000);
  if (hrs < 1) return 'just now';
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// Map GitHub event types to a readable, emoji-tagged line.
// Only event types worth surfacing are included; everything else is skipped.
const EVENT_LABELS = {
  PushEvent: (e) =>
    `🔨 Pushed ${e.payload.commits?.length ?? 0} commit(s) to \`${e.repo.name}\``,
  PullRequestEvent: (e) =>
    `🔀 ${e.payload.action} a pull request in \`${e.repo.name}\``,
  IssuesEvent: (e) =>
    `🐛 ${e.payload.action} an issue in \`${e.repo.name}\``,
  CreateEvent: (e) =>
    `✨ Created ${e.payload.ref_type}${e.payload.ref ? ` \`${e.payload.ref}\`` : ''} in \`${e.repo.name}\``,
  ReleaseEvent: (e) => `🚀 Published a release in \`${e.repo.name}\``,
  PublicEvent: (e) => `📢 Made \`${e.repo.name}\` public`,
};

async function buildActivitySection() {
  const events = await gh(`/users/${USERNAME}/events/public?per_page=30`);
  const lines = [];
  for (const e of events) {
    const fmt = EVENT_LABELS[e.type];
    if (!fmt) continue;
    lines.push(`- ${fmt(e)} · _${timeAgo(e.created_at)}_`);
    if (lines.length === 5) break;
  }
  return lines.length ? lines.join('\n') : '_No recent public activity in the last 90 days._';
}

async function buildLanguageSection() {
  const repos = await gh(
    `/users/${USERNAME}/repos?per_page=100&type=owner&sort=pushed`
  );
  const owned = repos.filter((r) => !r.fork).slice(0, MAX_REPOS_FOR_LANGUAGES);

  const totals = {};
  for (const repo of owned) {
    try {
      const langs = await gh(`/repos/${USERNAME}/${repo.name}/languages`);
      for (const [lang, bytes] of Object.entries(langs)) {
        totals[lang] = (totals[lang] || 0) + bytes;
      }
    } catch {
      // one repo failing shouldn't kill the whole run
      continue;
    }
  }

  const sum = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  const top = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  if (!top.length) return '_Not enough public repo data yet._';

  const BAR_WIDTH = 20;
  return top
    .map(([lang, bytes]) => {
      const pct = bytes / sum;
      const filled = Math.max(1, Math.round(pct * BAR_WIDTH));
      const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
      return `\`${lang.padEnd(12)}\` ${bar} ${(pct * 100).toFixed(1)}%`;
    })
    .join('\n');
}

function inject(content, marker, value) {
  const start = `<!--${marker}:START-->`;
  const end = `<!--${marker}:END-->`;
  const pattern = new RegExp(`${start}[\\s\\S]*?${end}`);
  if (!pattern.test(content)) {
    throw new Error(`Markers for "${marker}" not found in README.md`);
  }
  return content.replace(pattern, `${start}\n${value}\n${end}`);
}

async function main() {
  let readme = readFileSync('README.md', 'utf8');
  const [activity, languages] = await Promise.all([
    buildActivitySection(),
    buildLanguageSection(),
  ]);
  readme = inject(readme, 'RECENT_ACTIVITY', activity);
  readme = inject(readme, 'LANGUAGES', languages);
  writeFileSync('README.md', readme);
  console.log('README.md updated.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

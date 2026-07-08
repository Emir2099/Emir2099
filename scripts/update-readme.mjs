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
  'User-Agent': 'node-fetch',
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

// Custom badges for event types
const EVENT_BADGES = {
  PushEvent: '<img src="https://img.shields.io/badge/PUSH-6F3AFF?style=flat-square" alt="Push" valign="middle"/>',
  PullRequestEvent: '<img src="https://img.shields.io/badge/PR-2ea44f?style=flat-square" alt="PR" valign="middle"/>',
  IssuesEvent: '<img src="https://img.shields.io/badge/ISSUE-d73a49?style=flat-square" alt="Issue" valign="middle"/>',
  CreateEvent: '<img src="https://img.shields.io/badge/CREATE-8a2be2?style=flat-square" alt="Create" valign="middle"/>',
  ReleaseEvent: '<img src="https://img.shields.io/badge/RELEASE-0072b2?style=flat-square" alt="Release" valign="middle"/>',
  PublicEvent: '<img src="https://img.shields.io/badge/PUBLIC-22c55e?style=flat-square" alt="Public" valign="middle"/>',
};

async function getCommitsCount(e) {
  const before = e.payload.before;
  const head = e.payload.head;
  // If we can compare the commits, fetch the actual size from the compare API
  if (before && head && before !== '0000000000000000000000000000000000000000') {
    try {
      const compare = await gh(`/repos/${e.repo.name}/compare/${before}...${head}`);
      return compare.total_commits ?? 1;
    } catch {
      return 1;
    }
  }
  return 1;
}

async function formatEvent(e) {
  const badge = EVENT_BADGES[e.type] || `<code>${e.type}</code>`;
  let desc = '';
  if (e.type === 'PushEvent') {
    const commitsCount = await getCommitsCount(e);
    desc = `Pushed <b>${commitsCount} commit(s)</b> to <code>${e.repo.name}</code>`;
  } else if (e.type === 'PullRequestEvent') {
    desc = `<b>${e.payload.action}</b> a pull request in <code>${e.repo.name}</code>`;
  } else if (e.type === 'IssuesEvent') {
    desc = `<b>${e.payload.action}</b> an issue in <code>${e.repo.name}</code>`;
  } else if (e.type === 'CreateEvent') {
    desc = `Created <b>${e.payload.ref_type}</b> <code>${e.payload.ref || ''}</code> in <code>${e.repo.name}</code>`;
  } else if (e.type === 'ReleaseEvent') {
    desc = `Published a release in <code>${e.repo.name}</code>`;
  } else if (e.type === 'PublicEvent') {
    desc = `Made <code>${e.repo.name}</code> public`;
  } else {
    desc = `Action in <code>${e.repo.name}</code>`;
  }

  return `  <tr>
    <td style="padding: 8px; border-top: 1px solid #30363d; font-size: 13px;">${badge} ${desc}</td>
    <td style="padding: 8px; border-top: 1px solid #30363d; font-size: 13px;"><i>${timeAgo(e.created_at)}</i></td>
  </tr>`;
}

async function buildActivitySection() {
  const events = await gh(`/users/${USERNAME}/events/public?per_page=30`);
  const filtered = [];
  for (const e of events) {
    if (EVENT_BADGES[e.type]) {
      filtered.push(e);
      if (filtered.length === 5) break;
    }
  }

  if (!filtered.length) {
    return '<p><i>No recent public activity.</i></p>';
  }

  const rows = await Promise.all(filtered.map(formatEvent));

  return `<table width="100%" style="border: 1px solid #30363d; border-collapse: collapse; border-radius: 6px;">
  <thead>
    <tr style="background-color: #161b22;">
      <th align="left" style="padding: 8px; font-size: 13px;">Action Log</th>
      <th align="left" style="padding: 8px; font-size: 13px;">Timestamp</th>
    </tr>
  </thead>
  <tbody>
${rows.join('\n')}
  </tbody>
</table>`;
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
      continue;
    }
  }

  const sum = Object.values(totals).reduce((a, b) => a + b, 0) || 1;
  const top = Object.entries(totals)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  if (!top.length) {
    return '<p><i>Not enough public repo data yet.</i></p>';
  }

  const BAR_WIDTH = 12;
  const rows = top.map(([lang, bytes]) => {
    const pct = bytes / sum;
    const filled = Math.max(1, Math.round(pct * BAR_WIDTH));
    const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
    const badgeUrl = `https://img.shields.io/badge/${encodeURIComponent(lang)}-a855f7?style=flat-square`;
    const badge = `<img src="${badgeUrl}" alt="${lang}" valign="middle"/>`;

    return `  <tr>
    <td style="padding: 8px; border-top: 1px solid #30363d; font-size: 13px;">${badge}</td>
    <td style="padding: 8px; border-top: 1px solid #30363d; font-size: 13px;"><code>${bar}</code></td>
    <td style="padding: 8px; border-top: 1px solid #30363d; font-size: 13px;"><b>${(pct * 100).toFixed(1)}%</b></td>
  </tr>`;
  });

  return `<table width="100%" style="border: 1px solid #30363d; border-collapse: collapse; border-radius: 6px;">
  <thead>
    <tr style="background-color: #161b22;">
      <th align="left" style="padding: 8px; font-size: 13px;">Language</th>
      <th align="left" style="padding: 8px; font-size: 13px;">Distribution</th>
      <th align="left" style="padding: 8px; font-size: 13px;">Weight</th>
    </tr>
  </thead>
  <tbody>
${rows.join('\n')}
  </tbody>
</table>`;
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

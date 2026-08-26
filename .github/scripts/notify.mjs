// GitHub Actions から5分おきに実行される通知チェック。
// notify-config.json の予定を見て、指定分数前になったものを
// GitHubのIssueコメントとして投稿する（GitHubモバイルアプリがプッシュ通知してくれる）。

import { readFile, writeFile } from 'node:fs/promises';

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const NOTIFIED_TTL_MS = 24 * 60 * 60 * 1000; // 24時間経った送信済みログは間引く
const CATCHUP_WINDOW_MIN = -20; // 実行間隔(5分)や遅延を考慮した許容幅
const TRACKER_TITLE = '配膳お知らせ通知';

const [OWNER, REPO] = (process.env.GITHUB_REPOSITORY || '').split('/');
const TOKEN = process.env.GITHUB_TOKEN;

function itemDueAtUtcMs(iso, time, nextDay) {
  if (!iso || !time) return null;
  const [y, m, d] = iso.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return null;
  let ms = Date.UTC(y, m - 1, d, hh, mm) - JST_OFFSET_MS;
  if (nextDay) ms += 24 * 60 * 60 * 1000;
  return ms;
}

async function gh(path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${options.method || 'GET'} ${path} failed: ${res.status} ${await res.text()}`);
  }
  return res.status === 204 ? null : res.json();
}

async function findOrCreateTrackerIssue() {
  const openIssues = await gh(`/repos/${OWNER}/${REPO}/issues?state=open&per_page=100`);
  const found = openIssues.find((i) => !i.pull_request && i.title === TRACKER_TITLE);
  if (found) return found.number;
  const created = await gh(`/repos/${OWNER}/${REPO}/issues`, {
    method: 'POST',
    body: JSON.stringify({
      title: TRACKER_TITLE,
      body: 'このIssueへのコメントが配膳の通知です。GitHubアプリでこのリポジトリの通知をONにしておくとホーム画面に届きます。',
    }),
  });
  return created.number;
}

async function main() {
  if (!OWNER || !REPO || !TOKEN) throw new Error('GITHUB_REPOSITORY / GITHUB_TOKEN is not set');

  const config = JSON.parse(await readFile('notify-config.json', 'utf8'));
  let notified = [];
  try {
    notified = JSON.parse(await readFile('notified.json', 'utf8'));
  } catch {
    notified = [];
  }

  const now = Date.now();
  notified = notified.filter((n) => now - n.at < NOTIFIED_TTL_MS);
  const notifiedKeys = new Set(notified.map((n) => n.key));

  const due = [];
  for (const item of config.items || []) {
    const iso = config.dayDates[item.date];
    const dueMs = itemDueAtUtcMs(iso, item.time, item.nextDay);
    if (dueMs == null) continue;
    const diffMin = (dueMs - now) / 60000;
    const key = 'pre-' + item.id;
    if (diffMin <= config.notifyMinutes && diffMin > CATCHUP_WINDOW_MIN && !notifiedKeys.has(key)) {
      due.push({ item, diffMin, key });
    }
  }

  if (due.length === 0) {
    console.log('due items: 0');
    return;
  }

  const issueNumber = await findOrCreateTrackerIssue();

  for (const { item, diffMin, key } of due) {
    const label = diffMin <= 0 ? '設置時刻です' : Math.round(diffMin) + '分前';
    const lines = [
      `⏰ **${label}**`,
      `${item.time || ''} ${item.place}（${item.team}）`,
    ];
    if (item.note) lines.push(`📝 ${item.note}`);
    await gh(`/repos/${OWNER}/${REPO}/issues/${issueNumber}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: lines.join('\n') }),
    });
    notified.push({ key, at: now });
    console.log('notified:', key, label, item.place, item.team);
  }

  await writeFile('notified.json', JSON.stringify(notified, null, 2) + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

// Build script for "IT News for NSCT Team".
// Fetches RSS/Atom feeds (zero dependencies — uses Node's built-in fetch),
// parses them, and renders a static index.html.
//
// Usage: node scripts/build.mjs
//
// Designed to be resilient: a feed that fails (timeout, 4xx/5xx, bad XML)
// is skipped with a warning, never crashing the whole build.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const MAX_ITEMS_PER_CATEGORY = 18;
const FETCH_TIMEOUT_MS = 15000;

// Words that indicate a policy/politics/government story — always excluded.
const POLICY_BLOCK = [
  "policy", "policies", "legislation", "legislature", "regulation", "regulatory",
  "government", "senate", "congress", "parliament", "bill passed", "lawmakers",
  "politician", "political", "election", "antitrust", "lawsuit", "court ruling",
  "white house", "european commission", "ftc", "fcc", "doj", "gdpr", "act signed",
  "tax plan", "tariff", "sanction",
];
const POLICY_RE = new RegExp(
  `\\b(${POLICY_BLOCK.map((w) => w.replace(/\s+/g, "\\s+")).join("|")})\\b`,
  "i"
);
function isPolicy(item) {
  return POLICY_RE.test(item.title) || POLICY_RE.test(item.summary);
}
const USER_AGENT =
  "Mozilla/5.0 (compatible; NSCT-IT-News-Bot/1.0; +https://github.com/jack020619/IT-news-for-NSCT-team)";

// ---------------------------------------------------------------------------
// Small HTML-entity / CDATA helpers
// ---------------------------------------------------------------------------
function decodeEntities(str = "") {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function stripTags(html = "") {
  return decodeEntities(html.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// Escape text before injecting into our generated HTML.
function esc(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Minimal RSS + Atom parser
// ---------------------------------------------------------------------------
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decodeEntities(m[1]).trim() : "";
}

function atomLink(block) {
  // Prefer rel="alternate", else first <link href="...">
  const links = [...block.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  if (!links.length) return "";
  const alt = links.find((l) => /rel=["']?alternate/i.test(l)) || links[0];
  const href = alt.match(/href=["']([^"']+)["']/i);
  return href ? decodeEntities(href[1]).trim() : "";
}

function parseFeed(xml, sourceName) {
  const items = [];
  const isAtom = /<feed\b[^>]*>/i.test(xml) && /<entry\b/i.test(xml);
  const blockRe = isAtom
    ? /<entry\b[\s\S]*?<\/entry>/gi
    : /<item\b[\s\S]*?<\/item>/gi;

  for (const m of xml.matchAll(blockRe)) {
    const block = m[0];
    const title = stripTags(tag(block, "title"));
    let link = isAtom ? atomLink(block) : tag(block, "link");
    if (!link) link = stripTags(tag(block, "guid"));
    const dateRaw =
      tag(block, "pubDate") ||
      tag(block, "published") ||
      tag(block, "updated") ||
      tag(block, "dc:date") ||
      "";
    const descRaw =
      tag(block, "description") ||
      tag(block, "summary") ||
      tag(block, "content") ||
      "";
    const date = dateRaw ? new Date(dateRaw) : null;

    if (!title || !link) continue;
    items.push({
      title,
      link: link.trim(),
      source: sourceName,
      date: date && !isNaN(date) ? date : null,
      summary: stripTags(descRaw).slice(0, 220),
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------
async function fetchFeed(feed) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    const items = parseFeed(xml, feed.name);
    console.log(`  ✓ ${feed.name}: ${items.length} items`);
    return items;
  } catch (err) {
    console.warn(`  ✗ ${feed.name}: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function timeAgo(date, now) {
  if (!date) return "";
  const diff = Math.max(0, now - date.getTime());
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function renderItem(item, now) {
  const ago = timeAgo(item.date, now);
  const meta = [esc(item.source), ago].filter(Boolean).join(" · ");
  const summary = item.summary
    ? `<p class="summary">${esc(item.summary)}${item.summary.length >= 220 ? "…" : ""}</p>`
    : "";
  return `
        <li class="card">
          <a class="card-link" href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">
            <h3 class="card-title">${esc(item.title)}</h3>
            ${summary}
            <span class="card-meta">${meta}</span>
          </a>
        </li>`;
}

function renderCategory(cat, items, now) {
  if (!items.length) return "";
  const cards = items.map((it) => renderItem(it, now)).join("");
  return `
      <section class="category" id="cat-${esc(cat.id)}">
        <div class="category-head">
          <h2>${cat.emoji} ${esc(cat.title)}</h2>
          <p class="blurb">${esc(cat.blurb)}</p>
        </div>
        <ul class="cards">${cards}
        </ul>
      </section>`;
}

function renderPage({ sections, navLinks, builtAt, totalItems, sourceCount }) {
  const dateLabel = builtAt.toUTCString().replace("GMT", "UTC");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>IT News for NSCT Team · Web &amp; AI Daily</title>
  <meta name="description" content="Daily IT news for the NSCT team — web development, AI, developer community and remote/freelance jobs. Auto-updated every day." />
  <style>
    :root {
      --bg: #0d1117; --panel: #161b22; --panel-2: #1c2230;
      --border: #2a313c; --text: #e6edf3; --muted: #8b949e;
      --accent: #58a6ff; --accent-2: #7ee787; --shadow: rgba(0,0,0,.4);
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #f6f8fa; --panel: #ffffff; --panel-2: #f0f3f6;
        --border: #d0d7de; --text: #1f2328; --muted: #57606a;
        --accent: #0969da; --accent-2: #1a7f37; --shadow: rgba(140,149,159,.2);
      }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; background: var(--bg); color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5; -webkit-font-smoothing: antialiased;
    }
    a { color: var(--accent); text-decoration: none; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 0 20px 64px; }
    header.site {
      background: linear-gradient(135deg, var(--panel) 0%, var(--panel-2) 100%);
      border-bottom: 1px solid var(--border); padding: 36px 0 28px; margin-bottom: 28px;
    }
    .site-inner { max-width: 1100px; margin: 0 auto; padding: 0 20px; }
    .brand { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .brand h1 { font-size: 1.6rem; margin: 0; letter-spacing: -.02em; }
    .brand .tag {
      font-size: .72rem; text-transform: uppercase; letter-spacing: .08em;
      color: var(--accent-2); border: 1px solid var(--border);
      padding: 3px 8px; border-radius: 999px; background: var(--panel);
    }
    .sub { color: var(--muted); margin: 10px 0 0; font-size: .95rem; }
    .meta-bar {
      display: flex; flex-wrap: wrap; gap: 16px; margin-top: 16px;
      font-size: .82rem; color: var(--muted);
    }
    .meta-bar b { color: var(--text); }
    nav.cats {
      display: flex; flex-wrap: wrap; gap: 8px; margin: 22px 0 6px;
    }
    nav.cats a {
      font-size: .85rem; padding: 6px 12px; border: 1px solid var(--border);
      border-radius: 999px; background: var(--panel); color: var(--text);
    }
    nav.cats a:hover { border-color: var(--accent); color: var(--accent); }
    .category { margin-top: 40px; scroll-margin-top: 20px; }
    .category-head h2 { font-size: 1.25rem; margin: 0; }
    .category-head .blurb { color: var(--muted); margin: 4px 0 0; font-size: .9rem; }
    ul.cards {
      list-style: none; padding: 0; margin: 18px 0 0;
      display: grid; gap: 14px;
      grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    }
    .card {
      background: var(--panel); border: 1px solid var(--border);
      border-radius: 12px; overflow: hidden; transition: transform .12s ease, border-color .12s ease, box-shadow .12s ease;
    }
    .card:hover { transform: translateY(-2px); border-color: var(--accent); box-shadow: 0 6px 20px var(--shadow); }
    .card-link { display: block; padding: 16px 18px; height: 100%; }
    .card-title { font-size: 1rem; margin: 0 0 8px; color: var(--text); line-height: 1.35; }
    .card:hover .card-title { color: var(--accent); }
    .summary { color: var(--muted); font-size: .86rem; margin: 0 0 10px; }
    .card-meta { color: var(--muted); font-size: .76rem; }
    footer.site {
      margin-top: 56px; padding-top: 24px; border-top: 1px solid var(--border);
      color: var(--muted); font-size: .82rem; text-align: center;
    }
    footer.site a { color: var(--accent); }
    .empty { color: var(--muted); padding: 40px 0; text-align: center; }
  </style>
</head>
<body>
  <header class="site">
    <div class="site-inner">
      <div class="brand">
        <h1>📡 IT News for NSCT Team</h1>
        <span class="tag">Web &amp; AI · Daily</span>
      </div>
      <p class="sub">A daily digest for the NSCT team — web development, AI, developer trends and remote/freelance opportunities. For the freelancers and the job-seekers among us.</p>
      <div class="meta-bar">
        <span>🕒 Updated: <b>${esc(dateLabel)}</b></span>
        <span>📰 <b>${totalItems}</b> stories</span>
        <span>🔗 <b>${sourceCount}</b> sources</span>
      </div>
      <nav class="cats">${navLinks}
      </nav>
    </div>
  </header>
  <main class="wrap">
${sections || '<p class="empty">No stories could be fetched this run. Please check back after the next update.</p>'}
    <footer class="site">
      <p>Built automatically for the <b>NSCT team</b> · Updated daily via GitHub Actions.<br>
      Maintained by <a href="https://github.com/jack020619">jack020619</a> ·
      <a href="https://github.com/jack020619/IT-news-for-NSCT-team">Source on GitHub</a></p>
      <p>Headlines link to their original publishers. All rights belong to the respective sources.</p>
    </footer>
  </main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const now = Date.now();
  const builtAt = new Date(now);
  const config = JSON.parse(await readFile(join(ROOT, "src", "feeds.json"), "utf8"));

  let totalItems = 0;
  const sourceNames = new Set();
  const sectionHtml = [];
  const navHtml = [];

  for (const cat of config.categories) {
    console.log(`\n[${cat.title}]`);
    const results = await Promise.all(cat.feeds.map(fetchFeed));
    let items = results.flat();

    // Drop any policy / politics / government stories.
    const before = items.length;
    items = items.filter((it) => !isPolicy(it));
    const dropped = before - items.length;
    if (dropped) console.log(`  ⛔ Filtered ${dropped} policy item(s)`);

    // Dedupe by link, then by title.
    const seen = new Set();
    items = items.filter((it) => {
      const key = (it.link || it.title).toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort: dated items newest-first, undated items after.
    items.sort((a, b) => {
      if (a.date && b.date) return b.date - a.date;
      if (a.date) return -1;
      if (b.date) return 1;
      return 0;
    });

    items = items.slice(0, MAX_ITEMS_PER_CATEGORY);
    items.forEach((it) => sourceNames.add(it.source));
    totalItems += items.length;

    const html = renderCategory(cat, items, now);
    if (html) {
      sectionHtml.push(html);
      navHtml.push(`\n        <a href="#cat-${esc(cat.id)}">${cat.emoji} ${esc(cat.title)}</a>`);
    }
  }

  const page = renderPage({
    sections: sectionHtml.join("\n"),
    navLinks: navHtml.join(""),
    builtAt,
    totalItems,
    sourceCount: sourceNames.size,
  });

  await writeFile(join(ROOT, "index.html"), page, "utf8");
  console.log(`\n✅ Wrote index.html — ${totalItems} stories from ${sourceNames.size} sources.`);
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});

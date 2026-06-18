// Build script for "IT News for NSCT Team".
// Fetches RSS/Atom feeds (zero dependencies — uses Node's built-in fetch),
// translates non-English headlines/summaries to English, and renders a modern,
// interactive static index.html.
//
// Usage: node scripts/build.mjs
//
// Designed to be resilient: a feed that fails (timeout, 4xx/5xx, bad XML) — or a
// translation that fails — is skipped/kept-as-is, never crashing the whole build.

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const MAX_ITEMS_PER_CATEGORY = 18;
// How much of each story's key point we keep. Collapsed view clamps it to a
// couple of lines; the "More" button reveals the rest, so keep this generous.
const SUMMARY_MAX = 700;
const FETCH_TIMEOUT_MS = 15000;
const TRANSLATE_TIMEOUT_MS = 10000;
const USER_AGENT =
  "Mozilla/5.0 (compatible; NSCT-IT-News-Bot/1.0; +https://github.com/jack020619/IT-news-for-NSCT-team)";

// ---------------------------------------------------------------------------
// Daily-rotating, IT-related background images — one POOL PER CATEGORY.
// Each category shows its own themed image; a new one is picked per day
// (by day-of-year). The page crossfades between them as you scroll.
// All IDs are verified-working Unsplash CDN photos.
// ---------------------------------------------------------------------------
const BG_QUERY = "?auto=format&fit=crop&w=2070&q=80";
// IT News page — one image pool per category.
const CATEGORY_BG = {
  all: ["1451187580459-43490279c0fa", "1550751827-4bd374c3f58b", "1639322537228-f710d846310a", "1531297484001-80022131f5a1"],
  ai:  ["1633356122544-f134324a6cee", "1620712943543-bcc4688e7485", "1639322537228-f710d846310a", "1531297484001-80022131f5a1"],
  web: ["1517694712202-14dd9538aa97", "1542831371-29b0f74f9713", "1518770660439-4636190af475", "1531297484001-80022131f5a1"],
  dev: ["1526374965328-7f61d4dc18c5", "1558494949-ef010cbdcc31", "1591405351990-4726e331f141", "1518770660439-4636190af475"],
  jobs:["1504384308090-c894fdcc538d", "1488590528505-98d2b5aba04b", "1591405351990-4726e331f141", "1517694712202-14dd9538aa97"],
  freelancer: ["1488590528505-98d2b5aba04b", "1504384308090-c894fdcc538d", "1542831371-29b0f74f9713", "1591405351990-4726e331f141"],
};
// Football page — stadium / pitch / crowd imagery (graceful: falls back to the
// animated gradient if any image fails to load).
const FOOTBALL_BG = {
  all:      ["1522778119026-d647f0596c20", "1431324155629-1a6deb1dec8d", "1574629810360-7efbbe195018", "1459865264687-595d652de67e"],
  worldcup: ["1459865264687-595d652de67e", "1551958219-acbc608c6377", "1522778119026-d647f0596c20", "1574629810360-7efbbe195018"],
  olympic:  ["1517466787929-bc90951d0974", "1431324155629-1a6deb1dec8d", "1461896836934-ffe607ba8211", "1459865264687-595d652de67e"],
  europe:   ["1574629810360-7efbbe195018", "1508098682722-e99c43a406b2", "1431324155629-1a6deb1dec8d", "1522778119026-d647f0596c20"],
  england:  ["1431324155629-1a6deb1dec8d", "1574629810360-7efbbe195018", "1577223625816-7546f13df25d", "1522778119026-d647f0596c20"],
  italy:    ["1508098682722-e99c43a406b2", "1522778119026-d647f0596c20", "1574629810360-7efbbe195018", "1431324155629-1a6deb1dec8d"],
  spain:    ["1543326727-cf6c39e8f84c", "1574629810360-7efbbe195018", "1522778119026-d647f0596c20", "1459865264687-595d652de67e"],
  world:    ["1486286701208-1d58e9338013", "1522778119026-d647f0596c20", "1574629810360-7efbbe195018", "1431324155629-1a6deb1dec8d"],
  players:  ["1551958219-acbc608c6377", "1459865264687-595d652de67e", "1522778119026-d647f0596c20", "1574629810360-7efbbe195018"],
};
function imgUrl(id) {
  return "https://images.unsplash.com/photo-" + id + BG_QUERY;
}
function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  return Math.floor((today - start) / 86400000);
}
function pickCategoryImages(date, pools) {
  const d = dayOfYear(date);
  const out = {};
  for (const key of Object.keys(pools)) {
    const pool = pools[key];
    out[key] = imgUrl(pool[d % pool.length]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Policy filter — client + team dislike policy/politics/government news.
// ---------------------------------------------------------------------------
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
// Translation — auto-detect non-English (non-Latin script) text and translate
// to English via the free Google endpoint. English text is left untouched.
// ---------------------------------------------------------------------------
const _trCache = new Map();
function needsTranslation(text) {
  if (!text) return false;
  const letters = text.match(/[\p{L}]/gu) || [];
  if (!letters.length) return false;
  let nonLatin = 0;
  for (const ch of letters) {
    // Beyond Latin Extended-B (U+024F) → CJK, Hangul, Cyrillic, Arabic, Thai, etc.
    if (ch.codePointAt(0) > 0x024f) nonLatin++;
  }
  return nonLatin / letters.length > 0.15;
}
async function translateText(text) {
  if (!text || !needsTranslation(text)) return text;
  if (_trCache.has(text)) return _trCache.get(text);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);
  try {
    const url =
      "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=" +
      encodeURIComponent(text);
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const out = (data[0] || []).map((seg) => seg[0]).join("");
    const result = out || text;
    _trCache.set(text, result);
    return result;
  } catch {
    return text; // graceful: keep original if translation fails
  } finally {
    clearTimeout(timer);
  }
}
async function translateItems(items) {
  let count = 0;
  await Promise.all(
    items.map(async (it) => {
      const before = it.title;
      it.title = await translateText(it.title);
      it.summary = await translateText(it.summary);
      if (it.title !== before) count++;
    })
  );
  return count;
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
      summary: stripTags(descRaw).slice(0, SUMMARY_MAX),
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
// Freelancer.com — live active projects via the public API (no key needed).
// ---------------------------------------------------------------------------
async function fetchFreelancer() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url =
      "https://www.freelancer.com/api/projects/0.1/projects/active/?limit=24&full_description=true&job_details=true&sort_field=time_updated";
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const projects = (data && data.result && data.result.projects) || [];
    const items = projects
      .filter((p) => !p.deleted && !p.nonpublic)
      .map((p) => {
        const cur = p.currency || {};
        const sign = cur.sign || "$";
        const code = cur.code || "";
        const b = p.budget || {};
        let budget = "";
        if (b.minimum != null && b.maximum != null) budget = `💰 ${sign}${b.minimum}–${sign}${b.maximum} ${code}`.trim();
        else if (b.minimum != null) budget = `💰 ${sign}${b.minimum}+ ${code}`.trim();
        const ts = p.time_submitted || p.submitdate;
        return {
          title: stripTags(p.title || "Untitled project"),
          link: p.seo_url ? `https://www.freelancer.com/projects/${p.seo_url}` : "https://www.freelancer.com/",
          source: "Freelancer.com",
          budget,
          date: ts ? new Date(ts * 1000) : null,
          summary: stripTags(p.preview_description || p.description || "").slice(0, SUMMARY_MAX),
        };
      });
    console.log(`  ✓ Freelancer.com projects: ${items.length} items`);
    return items;
  } catch (err) {
    console.warn(`  ✗ Freelancer.com: ${err.message}`);
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Famous footballers — face photo + short bio from Wikipedia (no key needed).
// Fully graceful: if Wikipedia is unreachable, we keep the player with no photo
// (the card shows an initials avatar instead) so the build never breaks.
// ---------------------------------------------------------------------------
async function fetchFootballer(p) {
  const fallbackLink =
    "https://news.google.com/search?q=" + encodeURIComponent(p.name + " football");
  const base = { name: p.name, country: p.country, flag: p.flag || "", role: p.role || "", img: "", newsLink: fallbackLink, wikiLink: "https://en.wikipedia.org/wiki/" + encodeURIComponent((p.wiki || p.name).replace(/ /g, "_")), bio: "" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = "https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(p.wiki || p.name);
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: controller.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const img = (j.thumbnail && j.thumbnail.source) || (j.originalimage && j.originalimage.source) || "";
    const extract = (j.extract || "").trim();
    const firstSentence = extract ? (extract.split(/(?<=\.)\s/)[0] || extract).slice(0, 160) : "";
    return { ...base, img, bio: firstSentence, wikiLink: (j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page) || base.wikiLink };
  } catch (err) {
    console.warn(`  ✗ Footballer ${p.name}: ${err.message}`);
    return base;
  } finally {
    clearTimeout(timer);
  }
}
async function fetchFootballers(list) {
  const out = await Promise.all(list.map(fetchFootballer));
  const withPhotos = out.filter((p) => p.img).length;
  console.log(`  ✓ Footballers: ${out.length} players (${withPhotos} with photos)`);
  return out;
}

// ---------------------------------------------------------------------------
// Rendering helpers
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

function renderItem(item, now, i) {
  const ago = timeAgo(item.date, now);
  const host = hostOf(item.link);
  const favicon = host ? `https://www.google.com/s2/favicons?domain=${esc(host)}&sz=64` : "";
  const budgetChip = item.budget ? `<span class="budget">${esc(item.budget)}</span>` : "";
  const meta = [esc(item.source), ago].filter(Boolean).join(" · ");
  const point = item.summary
    ? esc(item.summary) + (item.summary.length >= SUMMARY_MAX ? "…" : "")
    : "No summary available for this story.";
  const icon = favicon
    ? `<img src="${favicon}" alt="" loading="lazy" width="36" height="36" onerror="this.style.display='none';this.parentNode.classList.add('noimg')">`
    : "";
  const ts = item.date ? item.date.getTime() : 0;
  // Only show the More/Less toggle when the key point is long enough to be
  // clamped (short summaries already fit in the collapsed 2-line view).
  const expandBtn =
    item.summary && item.summary.length > 130
      ? `<button class="expand-btn" type="button" onclick="event.preventDefault();event.stopPropagation();var p=this.parentNode;p.classList.toggle('expanded');this.textContent=p.classList.contains('expanded')?'Less ▴':'More ▾'">More ▾</button>`
      : "";
  const pinned = item.pinned ? " pinned" : "";
  const pinBadge = item.pinned ? `<span class="point-label" style="color:#ffd27d;border-color:rgba(255,210,125,.4);background:rgba(255,210,125,.1)">📌 Pinned</span>` : "";
  return `
          <li class="item${pinned}" style="--i:${i}" data-ts="${ts}">
            <a class="item-link" href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">
              <span class="item-icon">${icon}</span>
              <span class="item-body">
                <span class="item-title">${esc(item.title)}</span>
                <span class="item-point"><span class="point-text"><span class="point-label">Key point</span>${pinBadge}${point}</span>${expandBtn}</span>
                <span class="item-meta">${budgetChip}${meta}</span>
              </span>
              <span class="item-arrow" aria-hidden="true">↗</span>
            </a>
          </li>`;
}

function renderCategory(cat, items, now) {
  if (!items.length) return "";
  const cards = items.map((it, i) => renderItem(it, now, i)).join("");
  const liveBadge = cat.live
    ? `<span class="live-badge" id="flLive"><span class="live-dot"></span> Live · refreshing every 60s</span>`
    : "";
  return `
      <section class="category" data-cat="${esc(cat.id)}" id="cat-${esc(cat.id)}">
        <div class="category-head">
          <h2><span class="cat-emoji">${cat.emoji}</span> ${esc(cat.title)} ${liveBadge}</h2>
          <p class="blurb">${esc(cat.blurb)}</p>
        </div>
        <ul class="items">${cards}
        </ul>
        <p class="range-empty" hidden>No stories in this time range — try a wider range.</p>
      </section>`;
}

// A footballer's face-card. `img` may be empty → CSS shows an initials avatar.
function renderPlayer(p) {
  const initials = (p.name || "?")
    .split(/\s+/)
    .map((w) => w[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();
  // Deterministic accent colour from the name (no randomness).
  let h = 0;
  for (const ch of p.name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  const photo = p.img
    ? `<img src="${esc(p.img)}" alt="${esc(p.name)}" loading="lazy" onerror="this.remove()">`
    : "";
  const bio = p.bio ? `<span class="pbio">${esc(p.bio)}</span>` : "";
  return `
          <div class="pcard">
            <span class="pavatar" style="--h:${h}">${esc(initials)}${photo}</span>
            <span class="pname">${esc(p.name)}</span>
            <span class="pmeta">${p.flag ? esc(p.flag) + " " : ""}${esc(p.country)}${p.role ? " · " + esc(p.role) : ""}</span>
            ${bio}
            <span class="plinks">
              <a href="${esc(p.newsLink)}" target="_blank" rel="noopener noreferrer">📰 Latest news</a>
              <a href="${esc(p.wikiLink)}" target="_blank" rel="noopener noreferrer">ℹ️ Profile</a>
            </span>
          </div>`;
}

function renderPlayersSection(cat, players) {
  if (!players || !players.length) return "";
  const cards = players.map(renderPlayer).join("");
  return `
      <section class="category" data-cat="${esc(cat.id)}" id="cat-${esc(cat.id)}">
        <div class="category-head">
          <h2><span class="cat-emoji">${cat.emoji}</span> ${esc(cat.title)}</h2>
          <p class="blurb">${esc(cat.blurb)}</p>
        </div>
        <div class="player-grid">${cards}
        </div>
      </section>`;
}

// Top navigation shared by both dashboards.
function renderNav(active) {
  const links = [
    ["it", "index.html", "💻", "IT News"],
    ["football", "football.html", "⚽", "Football"],
  ];
  return `<nav class="topnav">${links
    .map(
      ([id, href, ic, label]) =>
        `<a class="navlink${id === active ? " active" : ""}" href="${href}"><span class="nico">${ic}</span> ${label}</a>`
    )
    .join("")}</nav>`;
}

// Client-side live refresh for the Freelancer.com section — runs in the browser
// every 60s. The Freelancer API sends `Access-Control-Allow-Origin: *`, so this
// cross-origin fetch works directly from GitHub Pages. Injected only on the IT
// page. References applyFilters() from the surrounding IIFE scope.
const FL_LIVE_JS = `
      // ---- Live Freelancer.com updates (every 60s) ----
      (function () {
        var ul = document.querySelector('#cat-freelancer ul.items');
        var badge = document.getElementById('flLive');
        if (!ul) return;
        var API = 'https://www.freelancer.com/api/projects/0.1/projects/active/?limit=18&full_description=true&job_details=true&sort_field=time_updated';
        function he(s){ return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
        function ago(ms){ if(!ms) return ''; var d=Math.max(0,Date.now()-ms),m=Math.floor(d/6e4); if(m<60) return m+'m ago'; var h=Math.floor(m/60); if(h<24) return h+'h ago'; return Math.floor(h/24)+'d ago'; }
        function budget(p){ var c=p.currency||{},s=c.sign||'$',code=c.code||'',b=p.budget||{}; if(b.minimum!=null&&b.maximum!=null) return '💰 '+s+b.minimum+'–'+s+b.maximum+' '+code; if(b.minimum!=null) return '💰 '+s+b.minimum+'+ '+code; return ''; }
        function row(p,i){
          var link = p.seo_url ? 'https://www.freelancer.com/projects/'+p.seo_url : 'https://www.freelancer.com/';
          var ts = (p.time_submitted||p.submitdate||0)*1000;
          var sum = (p.preview_description||p.description||'').replace(/\\s+/g,' ').trim().slice(0,700);
          var bd = budget(p);
          var meta = ['Freelancer.com', ago(ts)].filter(Boolean).join(' · ');
          var btn = sum.length>130 ? '<button class="expand-btn" type="button" onclick="event.preventDefault();event.stopPropagation();var p=this.parentNode;p.classList.toggle(\\'expanded\\');this.textContent=p.classList.contains(\\'expanded\\')?\\'Less ▴\\':\\'More ▾\\'">More ▾</button>' : '';
          return '<li class="item" style="--i:'+i+'" data-ts="'+ts+'">'
            + '<a class="item-link" href="'+he(link)+'" target="_blank" rel="noopener noreferrer">'
            + '<span class="item-icon noimg"></span>'
            + '<span class="item-body">'
            + '<span class="item-title">'+he(p.title||'Untitled project')+'</span>'
            + '<span class="item-point"><span class="point-text"><span class="point-label">Key point</span>'+(sum?he(sum):'New project on Freelancer.com.')+'</span>'+btn+'</span>'
            + '<span class="item-meta">'+(bd?'<span class="budget">'+he(bd)+'</span>':'')+he(meta)+'</span>'
            + '</span><span class="item-arrow" aria-hidden="true">↗</span></a></li>';
        }
        function refresh(){
          fetch(API, { headers: { 'Accept': 'application/json' } })
            .then(function(r){ return r.ok ? r.json() : Promise.reject(r.status); })
            .then(function(d){
              var pr = (d && d.result && d.result.projects) || [];
              pr = pr.filter(function(p){ return !p.deleted && !p.nonpublic; });
              if (!pr.length) return;
              var olds = ul.querySelectorAll('li.item:not(.pinned)');
              for (var k=0;k<olds.length;k++) olds[k].parentNode.removeChild(olds[k]);
              ul.insertAdjacentHTML('beforeend', pr.map(row).join(''));
              if (badge) { badge.innerHTML = '<span class="live-dot"></span> Live · updated just now'; badge.classList.remove('fl-flash'); void badge.offsetWidth; badge.classList.add('fl-flash'); }
              applyFilters();
            })
            .catch(function(){ if (badge) badge.innerHTML = '<span class="live-dot"></span> Live · retrying…'; });
        }
        setTimeout(refresh, 2500);
        setInterval(refresh, 60000);
      })();`;

function renderPage({ sections, categories, builtAt, totalItems, sourceCount, bgImages, docTitle, metaDesc, kicker, heroTitle, heroSub, navActive, bodyClass, liveFreelancer }) {
  const dateLabel = builtAt.toUTCString().replace("GMT", "UTC");
  const DEFAULT_VIEW = "list";

  const filterButtons = [
    `<button class="chip active" data-cat="all" type="button">📚 All <em>${totalItems}</em></button>`,
    ...categories.map(
      (c) =>
        `<button class="chip" data-cat="${esc(c.id)}" type="button">${c.emoji} ${esc(c.title)} <em>${c.count}</em></button>`
    ),
  ].join("\n        ");

  const DEFAULT_RANGE = "all";
  const rangeButtons = [
    ["today", "Today"],
    ["week", "This Week"],
    ["month", "This Month"],
    ["year", "This Year"],
    ["all", "All"],
  ]
    .map(
      ([r, label]) =>
        `<button class="rbtn${r === DEFAULT_RANGE ? " active" : ""}" data-range="${r}" type="button">${label}</button>`
    )
    .join("\n          ");

  const viewButtons = [
    ["title", "≣", "Title"],
    ["list", "☰", "List"],
    ["details", "▤", "Details"],
    ["cards", "▦", "Cards"],
  ]
    .map(
      ([v, ic, label]) =>
        `<button class="vbtn${v === DEFAULT_VIEW ? " active" : ""}" data-view="${v}" type="button" title="${label} view"><span class="vico">${ic}</span><span class="vlabel">${label}</span></button>`
    )
    .join("\n        ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(docTitle)}</title>
  <meta name="description" content="${esc(metaDesc)}" />
  <style>
    :root {
      --bg: #07080d;
      --text: #eef2f8;
      --muted: #aeb6c6;
      --glass: rgba(17, 21, 32, 0.55);
      --glass-2: rgba(28, 34, 50, 0.5);
      --border: rgba(255, 255, 255, 0.10);
      --border-strong: rgba(255, 255, 255, 0.22);
      --accent: #7c93ff;
      --accent-2: #38e0c8;
      --grad: linear-gradient(120deg, #6366f1, #06b6d4 45%, #8b5cf6 90%);
    }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0; color: var(--text);
      font-family: "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.5; -webkit-font-smoothing: antialiased;
      background: var(--bg); min-height: 100vh;
    }
    a { color: var(--accent); text-decoration: none; }

    /* ---- Layered background: animated gradient + crossfading category images ---- */
    .bg-layer { position: fixed; inset: 0; z-index: -3; overflow: hidden; }
    .bg-gradient {
      position: absolute; inset: -20%;
      background:
        radial-gradient(45% 45% at 18% 20%, rgba(99,102,241,.45), transparent 60%),
        radial-gradient(40% 40% at 82% 18%, rgba(56,224,200,.30), transparent 60%),
        radial-gradient(55% 55% at 50% 90%, rgba(139,92,246,.38), transparent 60%),
        #06070c;
      filter: saturate(1.1);
      animation: drift 26s ease-in-out infinite alternate;
    }
    .bgx {
      position: absolute; inset: 0;
      background-size: cover; background-position: center;
      opacity: 0; transition: opacity 1.2s ease, transform 16s ease-out;
      filter: brightness(.42) saturate(1.05); transform: scale(1.06);
      will-change: opacity;
    }
    .bgx.show { opacity: .55; transform: scale(1.12); }
    .bg-veil {
      position: fixed; inset: 0; z-index: -2; pointer-events: none;
      background: linear-gradient(180deg, rgba(6,7,12,.35) 0%, rgba(6,7,12,.55) 45%, rgba(6,7,12,.86) 100%);
    }
    .blob { position: fixed; z-index: -1; border-radius: 50%; filter: blur(60px); opacity: .35; pointer-events: none; }
    .blob.b1 { width: 380px; height: 380px; background: #6366f1; top: 8%; left: -6%; animation: float1 18s ease-in-out infinite; }
    .blob.b2 { width: 320px; height: 320px; background: #06b6d4; bottom: 6%; right: -5%; animation: float2 22s ease-in-out infinite; }
    @keyframes drift { from { transform: translate3d(0,0,0) rotate(0deg);} to { transform: translate3d(0,-3%,0) rotate(4deg);} }
    @keyframes float1 { 0%,100%{ transform: translate(0,0);} 50%{ transform: translate(40px,30px);} }
    @keyframes float2 { 0%,100%{ transform: translate(0,0);} 50%{ transform: translate(-40px,-30px);} }

    #progress { position: fixed; top: 0; left: 0; height: 3px; width: 0; z-index: 50; background: var(--grad); box-shadow: 0 0 12px rgba(124,147,255,.8); transition: width .1s linear; }

    .wrap { max-width: 1140px; margin: 0 auto; padding: 0 20px 80px; }

    /* ---- Hero ---- */
    header.hero { text-align: center; padding: 76px 20px 30px; max-width: 1140px; margin: 0 auto; }
    .hero .kicker {
      display: inline-block; font-size: .72rem; letter-spacing: .22em; text-transform: uppercase;
      color: var(--accent-2); border: 1px solid var(--border-strong); padding: 6px 14px; border-radius: 999px;
      background: var(--glass); backdrop-filter: blur(8px); margin-bottom: 20px;
    }
    .hero h1 {
      font-size: clamp(2.1rem, 6vw, 3.7rem); line-height: 1.04; margin: 0 0 14px; letter-spacing: -.025em; font-weight: 800;
      background: linear-gradient(120deg, #fff 10%, #b9c4ff 40%, #7be6d6 70%, #fff 95%);
      background-size: 220% auto; -webkit-background-clip: text; background-clip: text; color: transparent;
      animation: shine 8s linear infinite;
    }
    @keyframes shine { to { background-position: 220% center; } }
    .hero .sub { color: var(--muted); max-width: 680px; margin: 0 auto; font-size: 1.02rem; }
    .stats { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-top: 26px; }
    .stat { background: var(--glass); border: 1px solid var(--border); border-radius: 14px; padding: 12px 18px; backdrop-filter: blur(10px); min-width: 96px; }
    .stat b { display: block; font-size: 1.35rem; background: var(--grad); -webkit-background-clip: text; background-clip: text; color: transparent; }
    .stat span { font-size: .72rem; color: var(--muted); text-transform: uppercase; letter-spacing: .08em; }

    /* ---- Sticky toolbar ---- */
    .toolbar {
      position: sticky; top: 0; z-index: 30; margin-top: 26px;
      background: rgba(8,10,16,.62); backdrop-filter: blur(16px) saturate(1.2);
      border: 1px solid var(--border); border-radius: 16px;
      padding: 12px; display: flex; flex-direction: column; gap: 12px;
      box-shadow: 0 10px 30px rgba(0,0,0,.35);
    }
    .toolbar-row { display: flex; gap: 14px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
    .filters { display: flex; gap: 8px; flex-wrap: wrap; }
    .ranges { display: flex; gap: 4px; background: var(--glass-2); border: 1px solid var(--border); border-radius: 12px; padding: 4px; flex-wrap: wrap; }
    .rlabel { color: var(--muted); font-size: .72rem; text-transform: uppercase; letter-spacing: .08em; align-self: center; padding: 0 6px 0 4px; }
    .rbtn { font: inherit; cursor: pointer; color: var(--muted); background: transparent; border: 0; padding: 7px 12px; border-radius: 9px; font-size: .82rem; transition: all .15s ease; }
    .rbtn:hover { color: var(--text); background: rgba(255,255,255,.06); }
    .rbtn.active { color: #fff; background: rgba(56,224,200,.22); box-shadow: inset 0 0 0 1px rgba(56,224,200,.5); }
    .chip {
      font: inherit; cursor: pointer; color: var(--text);
      background: var(--glass-2); border: 1px solid var(--border);
      padding: 8px 14px; border-radius: 999px; font-size: .86rem;
      display: inline-flex; align-items: center; gap: 6px; transition: all .18s ease;
    }
    .chip em { font-style: normal; font-size: .72rem; color: var(--muted); background: rgba(255,255,255,.08); padding: 1px 7px; border-radius: 999px; }
    .chip:hover { border-color: var(--border-strong); transform: translateY(-1px); }
    .chip.active { background: var(--grad); color: #fff; border-color: transparent; box-shadow: 0 6px 18px rgba(99,102,241,.45); }
    .chip.active em { color: #fff; background: rgba(255,255,255,.22); }

    .views { display: flex; gap: 4px; background: var(--glass-2); border: 1px solid var(--border); border-radius: 12px; padding: 4px; }
    .vbtn { font: inherit; cursor: pointer; color: var(--muted); background: transparent; border: 0; padding: 7px 11px; border-radius: 9px; display: inline-flex; align-items: center; gap: 7px; font-size: .82rem; transition: all .15s ease; }
    .vbtn .vico { font-size: 1rem; line-height: 1; }
    .vbtn:hover { color: var(--text); background: rgba(255,255,255,.06); }
    .vbtn.active { color: #fff; background: rgba(124,147,255,.28); box-shadow: inset 0 0 0 1px rgba(124,147,255,.5); }
    @media (max-width: 620px) { .vbtn .vlabel { display: none; } .hero { padding-top: 54px; } }

    /* ---- Categories & items ---- */
    .category { margin-top: 42px; scroll-margin-top: 80px; }
    .category-head h2 { font-size: 1.3rem; margin: 0; display: flex; align-items: center; gap: 10px; }
    .cat-emoji { font-size: 1.2em; }
    .category-head .blurb { color: var(--muted); margin: 4px 0 0; font-size: .9rem; }
    ul.items { list-style: none; padding: 0; margin: 18px 0 0; }

    .item { --i: 0; opacity: 0; transform: translateY(26px); }
    .item.in { opacity: 1; transform: none; transition: opacity .6s cubic-bezier(.2,.7,.2,1), transform .6s cubic-bezier(.2,.7,.2,1); transition-delay: calc(var(--i) * 45ms); }
    .item-link {
      display: flex; align-items: flex-start; gap: 14px;
      background: var(--glass); border: 1px solid var(--border); border-radius: 14px;
      padding: 15px 17px; backdrop-filter: blur(10px);
      transition: transform .16s ease, border-color .16s ease, box-shadow .16s ease, background .16s ease;
      position: relative; overflow: hidden;
    }
    .item-link::before { content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 3px; background: var(--grad); opacity: 0; transition: opacity .18s ease; }
    .item-link:hover { transform: translateY(-3px); border-color: var(--border-strong); box-shadow: 0 14px 34px rgba(0,0,0,.45); background: var(--glass-2); }
    .item-link:hover::before { opacity: 1; }
    .item-icon { flex: 0 0 auto; width: 36px; height: 36px; border-radius: 9px; display: grid; place-items: center; background: rgba(255,255,255,.06); border: 1px solid var(--border); overflow: hidden; }
    .item-icon img { width: 22px; height: 22px; border-radius: 4px; }
    .item-icon.noimg::after { content: "🔗"; font-size: .9rem; }
    .item-body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
    .item-title { font-size: 1rem; font-weight: 600; color: var(--text); line-height: 1.35; }
    .item-link:hover .item-title { color: #cdd6ff; }
    .item-point { color: #c8d0e0; font-size: .87rem; line-height: 1.45; }
    .point-label {
      display: inline-block; font-size: .62rem; font-weight: 700; letter-spacing: .07em; text-transform: uppercase;
      color: var(--accent-2); border: 1px solid rgba(56,224,200,.35); background: rgba(56,224,200,.08);
      padding: 1px 7px; border-radius: 999px; margin-right: 8px; vertical-align: 1px;
    }
    .item-meta { color: #8b93a7; font-size: .76rem; letter-spacing: .01em; }
    .budget { display: inline-block; color: #7ee0b8; background: rgba(126,224,184,.10); border: 1px solid rgba(126,224,184,.3); padding: 1px 8px; border-radius: 999px; margin-right: 8px; font-weight: 600; }
    .item.pinned .item-link { border-color: rgba(255,210,125,.4); background: rgba(255,210,125,.06); }
    .range-empty { color: var(--muted); font-size: .9rem; padding: 18px 2px; }
    .item-arrow { flex: 0 0 auto; color: var(--muted); font-size: 1rem; opacity: 0; transform: translate(-4px,2px); transition: all .18s ease; }
    .item-link:hover .item-arrow { opacity: 1; transform: none; color: var(--accent-2); }

    /* ===== VIEW MODES (Explorer-style) ===== */
    /* TITLE: pure headings */
    #content[data-view="title"] ul.items { display: flex; flex-direction: column; gap: 8px; }
    #content[data-view="title"] .item-icon,
    #content[data-view="title"] .item-point,
    #content[data-view="title"] .item-meta { display: none; }
    #content[data-view="title"] .item-link { padding: 11px 15px; align-items: center; }
    #content[data-view="title"] .item-title { font-weight: 500; font-size: .96rem; }

    /* LIST (default): heading + 1-line key point + meta */
    #content[data-view="list"] ul.items { display: flex; flex-direction: column; gap: 9px; }
    #content[data-view="list"] .point-text { -webkit-line-clamp: 1; }

    /* Key point: expandable text block */
    .item-point { display: flex; flex-direction: column; gap: 3px; }
    .point-text { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .item-point.expanded .point-text { display: block !important; overflow: visible !important; }
    .expand-btn { align-self: flex-start; font: inherit; font-size: .72rem; color: var(--accent-2); background: rgba(56,224,200,.07); border: 1px solid rgba(56,224,200,.28); border-radius: 999px; padding: 1px 10px; cursor: pointer; transition: background .15s, border-color .15s; margin-top: 1px; }
    .expand-btn:hover { background: rgba(56,224,200,.16); border-color: rgba(56,224,200,.55); color: #fff; }

    /* DETAILS: heading + full key point + meta */
    #content[data-view="details"] ul.items { display: flex; flex-direction: column; gap: 12px; }

    /* CARDS: grid of glass cards (full key point) */
    #content[data-view="cards"] ul.items { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); }
    #content[data-view="cards"] .item-link { flex-direction: column; align-items: flex-start; gap: 12px; height: 100%; padding: 18px; }
    #content[data-view="cards"] .item-icon { width: 46px; height: 46px; border-radius: 12px; }
    #content[data-view="cards"] .item-icon img { width: 28px; height: 28px; }
    #content[data-view="cards"] .item-arrow { position: absolute; top: 14px; right: 16px; }

    .empty { color: var(--muted); padding: 60px 0; text-align: center; }

    footer.site { margin-top: 64px; padding-top: 26px; border-top: 1px solid var(--border); color: var(--muted); font-size: .82rem; text-align: center; }
    footer.site a { color: var(--accent); }

    #toTop {
      position: fixed; bottom: 22px; right: 22px; z-index: 40;
      width: 46px; height: 46px; border-radius: 50%; border: 1px solid var(--border-strong);
      background: var(--glass); backdrop-filter: blur(10px); color: var(--text); cursor: pointer;
      font-size: 1.1rem; display: grid; place-items: center;
      opacity: 0; transform: translateY(12px); pointer-events: none; transition: all .25s ease;
    }
    #toTop.show { opacity: 1; transform: none; pointer-events: auto; }
    #toTop:hover { border-color: var(--accent); box-shadow: 0 8px 22px rgba(99,102,241,.5); }

    /* ---- Top navigation (IT ⇄ Football) ---- */
    .topnav { display: flex; gap: 8px; justify-content: center; padding: 22px 20px 0; }
    .navlink {
      display: inline-flex; align-items: center; gap: 8px; color: var(--muted);
      background: var(--glass); border: 1px solid var(--border); border-radius: 999px;
      padding: 9px 18px; font-size: .9rem; font-weight: 600; backdrop-filter: blur(10px);
      transition: all .18s ease;
    }
    .navlink .nico { font-size: 1.05rem; }
    .navlink:hover { color: var(--text); border-color: var(--border-strong); transform: translateY(-1px); }
    .navlink.active { color: #fff; background: var(--grad); border-color: transparent; box-shadow: 0 6px 18px rgba(99,102,241,.4); }

    /* ---- Live badge (Freelancer.com) ---- */
    .live-badge { display: inline-flex; align-items: center; gap: 6px; font-size: .68rem; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: #7ee0b8; background: rgba(126,224,184,.10); border: 1px solid rgba(126,224,184,.32); padding: 2px 10px; border-radius: 999px; vertical-align: 3px; }
    .live-dot { width: 8px; height: 8px; border-radius: 50%; background: #41e08a; box-shadow: 0 0 0 0 rgba(65,224,138,.7); animation: pulse 1.8s infinite; }
    @keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(65,224,138,.6);} 70% { box-shadow: 0 0 0 8px rgba(65,224,138,0);} 100% { box-shadow: 0 0 0 0 rgba(65,224,138,0);} }
    .fl-flash { animation: flFlash 1s ease; }
    @keyframes flFlash { 0% { background: rgba(126,224,184,.18); } 100% { background: var(--glass); } }

    /* ---- Famous footballers card grid ---- */
    .player-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); margin-top: 18px; }
    .pcard {
      display: flex; flex-direction: column; align-items: center; text-align: center; gap: 7px;
      background: var(--glass); border: 1px solid var(--border); border-radius: 16px;
      padding: 20px 16px; backdrop-filter: blur(10px); transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
    }
    .pcard:hover { transform: translateY(-4px); border-color: var(--border-strong); box-shadow: 0 16px 36px rgba(0,0,0,.45); }
    .pavatar {
      position: relative; width: 96px; height: 96px; border-radius: 50%; overflow: hidden;
      display: grid; place-items: center; font-size: 1.7rem; font-weight: 800; color: #fff;
      background: linear-gradient(140deg, hsl(var(--h),70%,45%), hsl(calc(var(--h) + 40),65%,38%));
      border: 2px solid rgba(255,255,255,.18); box-shadow: 0 8px 22px rgba(0,0,0,.4);
    }
    .pavatar img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
    .pname { font-weight: 700; font-size: 1.02rem; color: var(--text); }
    .pmeta { font-size: .78rem; color: var(--accent-2); }
    .pbio { font-size: .8rem; color: var(--muted); line-height: 1.4; }
    .plinks { display: flex; gap: 12px; margin-top: 6px; flex-wrap: wrap; justify-content: center; }
    .plinks a { font-size: .78rem; color: var(--accent); border: 1px solid var(--border); border-radius: 999px; padding: 3px 11px; transition: all .15s ease; }
    .plinks a:hover { border-color: var(--accent); background: rgba(124,147,255,.12); }

    /* ---- Football theme: green pitch gradient ---- */
    body.football {
      --accent: #56e08a; --accent-2: #c9f562;
      --grad: linear-gradient(120deg, #16a34a, #22c55e 45%, #84cc16 90%);
    }
    body.football .bg-gradient {
      background:
        radial-gradient(45% 45% at 18% 20%, rgba(34,197,94,.42), transparent 60%),
        radial-gradient(40% 40% at 82% 18%, rgba(132,204,22,.30), transparent 60%),
        radial-gradient(55% 55% at 50% 90%, rgba(16,185,129,.36), transparent 60%),
        #04100a;
    }
    body.football .blob.b1 { background: #16a34a; }
    body.football .blob.b2 { background: #84cc16; }

    @media (prefers-reduced-motion: reduce) { * { animation: none !important; transition-duration: .01ms !important; } .item { opacity: 1; transform: none; } }
  </style>
</head>
<body class="${esc(bodyClass || "")}">
  <div id="progress"></div>
  <div class="bg-layer"><div class="bg-gradient"></div><div class="bgx" id="bgA"></div><div class="bgx" id="bgB"></div></div>
  <div class="bg-veil"></div>
  <span class="blob b1"></span><span class="blob b2"></span>

  ${renderNav(navActive)}

  <header class="hero">
    <span class="kicker">${esc(kicker)}</span>
    <h1>${esc(heroTitle)}</h1>
    <p class="sub">${esc(heroSub)}</p>
    <div class="stats">
      <div class="stat"><b>${totalItems}</b><span>Stories</span></div>
      <div class="stat"><b>${sourceCount}</b><span>Sources</span></div>
      <div class="stat"><b>${categories.length}</b><span>Topics</span></div>
    </div>
  </header>

  <div class="wrap">
    <div class="toolbar">
      <div class="filters">
        ${filterButtons}
      </div>
      <div class="toolbar-row">
        <div class="ranges" role="group" aria-label="Time range">
          <span class="rlabel">When</span>
          ${rangeButtons}
        </div>
        <div class="views" role="group" aria-label="View mode">
          ${viewButtons}
        </div>
      </div>
    </div>

    <main id="content" data-view="${DEFAULT_VIEW}" data-cat="all" data-range="${DEFAULT_RANGE}">
${sections || '<p class="empty">No stories could be fetched this run. Please check back after the next daily update.</p>'}
    </main>

    <footer class="site">
      <p>🕒 Updated: <b>${esc(dateLabel)}</b></p>
      <p>Built automatically for the <b>NSCT team</b> · Refreshed daily via GitHub Actions · Non-English headlines auto-translated to English.<br>
      Maintained by <a href="https://github.com/jack020619">jack020619</a> ·
      <a href="https://github.com/jack020619/IT-news-for-NSCT-team">Source on GitHub</a></p>
      <p>Headlines link to their original publishers. All rights belong to the respective sources.</p>
    </footer>
  </div>

  <button id="toTop" type="button" title="Back to top" aria-label="Back to top">↑</button>

  <script>
    window.__BG__ = ${JSON.stringify(bgImages)};
    (function () {
      var content = document.getElementById("content");
      var BG = window.__BG__ || {};

      // ---- Crossfading background (two layers) ----
      var layers = [document.getElementById("bgA"), document.getElementById("bgB")];
      var active = 0, curUrl = "";
      function setBackground(url) {
        if (!url || url === curUrl) return;
        curUrl = url;
        var next = layers[active ^ 1];
        var pre = new Image();
        pre.onload = function () {
          next.style.backgroundImage = "url('" + url + "')";
          next.classList.add("show");
          layers[active].classList.remove("show");
          active = active ^ 1;
        };
        pre.src = url;
      }
      setBackground(BG.all);

      // Restore saved preferences.
      try {
        var sv = localStorage.getItem("nsct-view");
        var sc = localStorage.getItem("nsct-cat");
        var sr = localStorage.getItem("nsct-range");
        if (sv) setView(sv);
        if (sr) setRange(sr);
        if (sc) setCat(sc);
      } catch (e) {}

      // ---- View switcher ----
      function setView(v) {
        content.setAttribute("data-view", v);
        var btns = document.querySelectorAll(".vbtn");
        for (var i = 0; i < btns.length; i++) btns[i].classList.toggle("active", btns[i].getAttribute("data-view") === v);
        try { localStorage.setItem("nsct-view", v); } catch (e) {}
        revealAll();
      }
      var vbtns = document.querySelectorAll(".vbtn");
      for (var i = 0; i < vbtns.length; i++) vbtns[i].addEventListener("click", function () { setView(this.getAttribute("data-view")); });

      // ---- Combined category + time-range filtering ----
      function applyFilters() {
        var cat = content.getAttribute("data-cat");
        var range = content.getAttribute("data-range");
        var now = Date.now();
        var cut = 0;
        if (range === "today") cut = now - 864e5;
        else if (range === "week") cut = now - 7 * 864e5;
        else if (range === "month") cut = now - 31 * 864e5;
        else if (range === "year") cut = now - 366 * 864e5;
        var sections = document.querySelectorAll(".category");
        for (var s = 0; s < sections.length; s++) {
          var sec = sections[s];
          var catVisible = (cat === "all") || (sec.getAttribute("data-cat") === cat);
          if (!catVisible) { sec.style.display = "none"; continue; }
          sec.style.display = "";
          var items = sec.querySelectorAll(".item");
          var visible = 0;
          for (var n = 0; n < items.length; n++) {
            var it = items[n];
            var ts = parseInt(it.getAttribute("data-ts"), 10) || 0;
            var show = (range === "all") || ts === 0 || ts >= cut;
            it.style.display = show ? "" : "none";
            if (show) visible++;
          }
          var empty = sec.querySelector(".range-empty");
          if (empty) empty.hidden = visible !== 0;
        }
        revealAll();
      }

      function setCat(c) {
        content.setAttribute("data-cat", c);
        var chips = document.querySelectorAll(".chip");
        for (var k = 0; k < chips.length; k++) chips[k].classList.toggle("active", chips[k].getAttribute("data-cat") === c);
        try { localStorage.setItem("nsct-cat", c); } catch (e) {}
        setBackground(BG[c] || BG.all);
        applyFilters();
        window.scrollTo({ top: 0, behavior: "smooth" });
      }
      function setRange(r) {
        content.setAttribute("data-range", r);
        var rb = document.querySelectorAll(".rbtn");
        for (var k = 0; k < rb.length; k++) rb[k].classList.toggle("active", rb[k].getAttribute("data-range") === r);
        try { localStorage.setItem("nsct-range", r); } catch (e) {}
        applyFilters();
      }
      var chips = document.querySelectorAll(".chip");
      for (var k = 0; k < chips.length; k++) chips[k].addEventListener("click", function () { setCat(this.getAttribute("data-cat")); });
      var rbtns = document.querySelectorAll(".rbtn");
      for (var rk = 0; rk < rbtns.length; rk++) rbtns[rk].addEventListener("click", function () { setRange(this.getAttribute("data-range")); });

      // ---- Scroll-reveal animation ----
      var io = null;
      if ("IntersectionObserver" in window) {
        io = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } });
        }, { rootMargin: "0px 0px -8% 0px", threshold: 0.05 });
      }
      function revealAll() {
        var items = document.querySelectorAll(".item");
        for (var n = 0; n < items.length; n++) {
          var it = items[n];
          if (it.offsetParent === null) continue;
          if (io) { it.classList.remove("in"); io.observe(it); } else { it.classList.add("in"); }
        }
      }
      applyFilters();

      // ---- Background follows the category in view while scrolling ----
      var ratios = {};
      if ("IntersectionObserver" in window) {
        var bgObs = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) {
            var id = en.target.getAttribute("data-cat");
            ratios[id] = en.isIntersecting ? en.intersectionRatio : 0;
          });
          var best = null, bestR = 0;
          for (var key in ratios) { if (ratios[key] > bestR) { bestR = ratios[key]; best = key; } }
          if (best && BG[best]) setBackground(BG[best]);
          else if (!best) setBackground(BG.all);
        }, { threshold: [0, 0.2, 0.4, 0.6], rootMargin: "-12% 0px -45% 0px" });
        var sections = document.querySelectorAll(".category");
        for (var s = 0; s < sections.length; s++) bgObs.observe(sections[s]);
      }

      // ---- Scroll progress + back-to-top ----
      var prog = document.getElementById("progress");
      var toTop = document.getElementById("toTop");
      function onScroll() {
        var h = document.documentElement;
        var max = h.scrollHeight - h.clientHeight;
        var pct = max > 0 ? (h.scrollTop / max) * 100 : 0;
        prog.style.width = pct + "%";
        toTop.classList.toggle("show", h.scrollTop > 500);
      }
      window.addEventListener("scroll", onScroll, { passive: true });
      onScroll();
      toTop.addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });
${liveFreelancer ? FL_LIVE_JS : ""}
    })();
  </script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------
// Build one dashboard (a configFile → an output HTML page).
// ---------------------------------------------------------------------------
async function buildSite(opts) {
  const { configFile, outFile, bgPools, filterPolicy, page } = opts;
  const now = Date.now();
  const builtAt = new Date(now);
  const config = JSON.parse(await readFile(join(ROOT, "src", configFile), "utf8"));

  let totalItems = 0;
  let translatedTotal = 0;
  const sourceNames = new Set();
  const sectionHtml = [];
  const categoryMeta = [];

  // Optional "Famous Footballers" section — rendered first (football page).
  if (Array.isArray(config.footballers) && config.footballers.length) {
    console.log(`\n[Famous Footballers]`);
    const players = await fetchFootballers(config.footballers);
    const pcat = { id: "players", title: "Famous Footballers", emoji: "⭐", blurb: "Top footballers — face, country and their latest news." };
    const html = renderPlayersSection(pcat, players);
    if (html) {
      sectionHtml.push(html);
      categoryMeta.push({ id: pcat.id, title: pcat.title, emoji: pcat.emoji, count: players.length });
    }
  }

  for (const cat of config.categories) {
    console.log(`\n[${cat.title}]`);
    let items;
    if (cat.type === "freelancer") {
      items = await fetchFreelancer();
    } else {
      const results = await Promise.all(cat.feeds.map(fetchFeed));
      items = results.flat();
    }

    // Drop any policy / politics / government stories (IT page only).
    if (filterPolicy) {
      const before = items.length;
      items = items.filter((it) => !isPolicy(it));
      const dropped = before - items.length;
      if (dropped) console.log(`  ⛔ Filtered ${dropped} policy item(s)`);
    }

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

    // Pin the Freelancer.com Terms & Conditions at the top of its section.
    if (cat.type === "freelancer") {
      cat.live = true; // show the live badge + enable client-side refresh
      items.unshift({
        title: "Freelancer.com — Terms & Conditions (User Agreement)",
        link: "https://www.freelancer.com/about/terms",
        source: "Freelancer.com",
        date: null,
        pinned: true,
        summary:
          "Read the official Freelancer.com User Agreement — fees, payments, milestones, disputes and account policies — before bidding on or posting any project.",
      });
    }

    // Translate any non-English headlines/summaries to English.
    const translated = await translateItems(items);
    if (translated) console.log(`  🌐 Translated ${translated} non-English item(s) to English`);
    translatedTotal += translated;

    items.forEach((it) => sourceNames.add(it.source));
    totalItems += items.length;

    const html = renderCategory(cat, items, now);
    if (html) {
      sectionHtml.push(html);
      categoryMeta.push({ id: cat.id, title: cat.title, emoji: cat.emoji, count: items.length });
    }
  }

  const html = renderPage({
    sections: sectionHtml.join("\n"),
    categories: categoryMeta,
    builtAt,
    totalItems,
    sourceCount: sourceNames.size,
    bgImages: pickCategoryImages(builtAt, bgPools),
    ...page,
  });

  await writeFile(join(ROOT, outFile), html, "utf8");
  console.log(`\n✅ Wrote ${outFile} — ${totalItems} stories from ${sourceNames.size} sources (${translatedTotal} translated).`);
}

// ---------------------------------------------------------------------------
// Main — build both dashboards (IT News + Football).
// ---------------------------------------------------------------------------
async function main() {
  console.log("=== Building IT News dashboard ===");
  await buildSite({
    configFile: "feeds.json",
    outFile: "index.html",
    bgPools: CATEGORY_BG,
    filterPolicy: true,
    page: {
      docTitle: "IT News for NSCT Team · Web & AI Daily",
      metaDesc: "Daily IT news for the NSCT team — web development, AI, developer community and remote/freelance jobs. Translated to English, auto-updated every day.",
      kicker: "Web & AI · Translated · Updated Daily",
      heroTitle: "IT News for NSCT Team",
      heroSub: "A daily, no-noise digest for our team — web development, AI, developer trends and remote/freelance work. Headlines from around the world, translated to English. Built for the freelancers and the job-seekers among us.",
      navActive: "it",
      bodyClass: "",
      liveFreelancer: true,
    },
  });

  console.log("\n=== Building Football dashboard ===");
  await buildSite({
    configFile: "football.json",
    outFile: "football.html",
    bgPools: FOOTBALL_BG,
    filterPolicy: false,
    page: {
      docTitle: "Football News for NSCT Team · World, Europe & Stars",
      metaDesc: "Daily football news for the NSCT team — World Cup, Olympics, Champions League, Premier League, Serie A, La Liga, plus famous footballers and their latest news.",
      kicker: "World Cup · Europe · Leagues · Stars",
      heroTitle: "Football News for NSCT Team",
      heroSub: "A daily football digest — World Cup, Olympics, the Champions League and the top European leagues, plus profiles of the game's biggest stars and the news about them.",
      navActive: "football",
      bodyClass: "football",
      liveFreelancer: false,
    },
  });
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});

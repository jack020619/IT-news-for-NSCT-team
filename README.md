# 📡 IT News for NSCT Team

A **daily IT news website** for the NSCT team — focused on **Web development**, **AI**,
the **developer community**, and **remote/freelance jobs**. For the freelancers and the
job-seekers on the team.

> **Live site:** https://jack020619.github.io/IT-news-for-NSCT-team/
> _(available after the first deploy — see "Deploy" below)_

## How it works

1. A **GitHub Actions** workflow runs every day (06:00 UTC).
2. It runs `node scripts/build.mjs`, which fetches a set of **RSS/Atom feeds**
   (zero dependencies — uses Node's built-in `fetch`).
3. Articles are de-duplicated, sorted newest-first, and **policy / politics /
   government stories are filtered out** automatically.
4. A static `index.html` is generated and deployed to **GitHub Pages**.

No backend, no API keys, no cost.

## Topics & sources

| Category | Sources |
|---|---|
| 🤖 AI & Machine Learning | VentureBeat AI, Ars Technica AI, The Verge AI, Google AI Blog |
| 🌐 Web & General Tech | Smashing Magazine, TechCrunch, The Verge, Frontend Focus |
| 💻 Developer Community | Hacker News, DEV Community |
| 💼 Jobs & Freelance | We Work Remotely, Remote OK |

Edit [`src/feeds.json`](src/feeds.json) to add or remove sources.

## No-policy filter

Policy / political / government news is excluded by a keyword filter in
[`scripts/build.mjs`](scripts/build.mjs) (`POLICY_BLOCK`). Add words there to
block more topics.

## Run it locally

```bash
node scripts/build.mjs   # writes index.html
# then open index.html in a browser
```

Requires Node.js 20+.

## Deploy

Pushing to `main` and the daily schedule both trigger a rebuild + deploy.
GitHub Pages must be set to **"GitHub Actions"** as its source
(Settings → Pages → Build and deployment → Source: GitHub Actions).

## Customisation

- **Change update time:** edit the `cron` in [`.github/workflows/daily.yml`](.github/workflows/daily.yml).
- **More/fewer stories:** change `MAX_ITEMS_PER_CATEGORY` in `scripts/build.mjs`.
- **Look & feel:** the CSS lives inline in the `renderPage()` function of `scripts/build.mjs`.

---

Maintained by [jack020619](https://github.com/jack020619) ·
Headlines link to their original publishers; all rights belong to the respective sources.

# Blog

A personal blog built with [Astro](https://astro.build). Plain HTML and CSS, no client-side
JavaScript. Posts are Markdown files.

## Run it

```sh
npm install
npm run dev       # http://localhost:4321, rebuilds as you edit
npm run build     # static site in dist/
npm run preview   # serve dist/ locally
```

## Write a post

Add a Markdown file to `src/content/blog/`. The file name is the URL:
`src/content/blog/my-post.md` becomes `/posts/my-post/`.

```markdown
---
title: "The title"
description: "One or two sentences, shown under the title and in the post list."
date: 2026-09-26
updated: 2026-10-01          # optional
tags: [android, testing]     # optional; one word each, lowercase
draft: true                  # optional; a draft is not built at all
---

## First section

Start the body at a second-level heading. The title comes from the frontmatter,
and the table of contents is built from the `##` and `###` headings.
```

Only `title` and `date` are required.

## Change the site

- `src/site.ts`: title, author, description, and the words-per-minute used for reading times.
- `astro.config.mjs`: `site`, the public address of the blog, used by the RSS feed.
- `src/styles/global.css`: all the styling, in one short file.
- `src/pages/about.astro`: the About page.

## Layout

```text
src/
├── content/blog/      the posts
├── content.config.ts  what a post's frontmatter may contain
├── pages/             one file per route: index, about, posts/, tags/, rss.xml
├── layouts/Base.astro the page frame: head, header, footer
├── components/        the post list and the table of contents
├── lib/posts.ts       loading, sorting and formatting posts
└── styles/global.css
```

## Deploy

GitHub Pages publishes the site from the repository `elmehdimotaqi-ui/elmehdimotaqi-ui.github.io`.
Every push to `main` runs `.github/workflows/deploy.yml`, which builds the site and deploys
`dist/`. The repository's Pages source must be "GitHub Actions" (Settings → Pages →
Build and deployment).

Live at https://elmehdimotaqi-ui.github.io/ and, once the domain is attached, at
https://elmehdimotaqi.com/.

### Custom domain

1. At the registrar's DNS, add four A records on the apex `elmehdimotaqi.com`:
   `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`.
   Optionally the AAAA records `2606:50c0:8000::153`, `2606:50c0:8001::153`,
   `2606:50c0:8002::153`, `2606:50c0:8003::153`. Add `CNAME www → elmehdimotaqi-ui.github.io`.
2. Attach the domain in Settings → Pages → Custom domain, or:
   `gh api -X PUT repos/elmehdimotaqi-ui/elmehdimotaqi-ui.github.io/pages -f cname=elmehdimotaqi.com`
3. Once GitHub has issued the certificate (minutes to about an hour), tick "Enforce HTTPS", or:
   `gh api -X PUT repos/elmehdimotaqi-ui/elmehdimotaqi-ui.github.io/pages -F https_enforced=true`

`site` in `astro.config.mjs` is already the domain; it only affects the absolute links in the
RSS feed.

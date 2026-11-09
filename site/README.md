# site

Static landing page for MyFinances. Plain HTML, no build step, no JavaScript.

- Preview: `npx serve site` (or open `index.html`).
- Deploy: import the repo on Vercel with root directory `./`; the root `vercel.json` serves `site/` as output with no build.
- Domain change: replace `https://myfinances.vercel.app` in `index.html`, `robots.txt`, `sitemap.xml` and `llms.txt`.

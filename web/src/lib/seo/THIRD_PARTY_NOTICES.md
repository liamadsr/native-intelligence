# Third-party notices for `src/lib/seo`

Parts of the SEO area are adapted from OpenSEO (https://github.com/every-app/open-seo),
release v0.1.27:

- `dataforseo/`: the search-data client and its price table;
- `shared/`: shared domain rules (markets, scopes, rank and AI visibility constants);
- `audit/`: the site audit's page analysis, issue catalog, discovery and crawl pacing;
- `keywords/` and `domain/`: keyword research routing and blending, the merged
  results-page read, and the domain overview's shaping;
- `rank/`: the rank check's read and retry rules and its schedule arithmetic;
- `google/`: the Search Console and Google Analytics request building and report shaping;
- `backlinks/` and `ai-visibility/`: the backlinks filters, the brand mention matcher,
  the answer and citation parser, and the result and trend arithmetic;
- `local/`: the map grid geometry and the Google Business Profile shaping.

Each adapted file says so in its header. The ten system skills seeded for the SEO
area (`web/supabase/migrations/598_seo_skills.sql`) are adapted from the skills that
project ships. What was written here from scratch, with that project as a reference
for behaviour only: the database tables and functions, the background jobs, the
spend ledger and its rules, the routes, the tools, and every page.

OpenSEO is licensed under the MIT License:

```
MIT License

Copyright (c) 2026 Ben Senescu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The rest of this repository is under its own license (`LICENSE` at the repository
root); this notice covers only the adapted portions.

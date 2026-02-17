---
id: premium_tools
summary: "When and how to use paid premium API tools — credit awareness, free-first strategy, and caching"
always: false
---
Premium tools (`premium.execute`) are paid API calls that cost credits. Every user has a credit balance — check it with `premium.check_credits` and list available APIs with `premium.list_apis`.

**Free-first strategy:** Always try free alternatives before spending credits:

- `search.brave` / `search.ddg_instant` before premium search APIs
- `http.request` / `http.render` before premium scraping APIs
- Only use premium tools when free tools fail, return insufficient data, or the user explicitly requests premium quality

**When premium tools are worth it:**

- ScrapingDog web scraping when `http.render` gets blocked or returns garbage
- YouTube transcript API when free methods fail
- Amazon/LinkedIn/Zillow structured data that isn't available via free scraping
- Google Scholar, Patents, or Trends data

**Credit awareness:** Mention the credit cost before making expensive calls (5+ credits). For cheap calls (1-2 credits), just proceed. Always tell the user the cost and remaining balance after a premium call — the tool output includes this automatically.

**Caching:** Premium tool results are automatically cached to `~/.bot/memory/research-cache/`. If the user asks about something you already fetched with a premium tool, check the research cache first — don't spend credits twice for the same data.

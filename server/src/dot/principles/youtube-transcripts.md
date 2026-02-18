---
id: youtube_transcripts
summary: "For YouTube transcripts, use the premium transcript API first — don't call ScrapingDog directly or prompt for API keys"
always: false
---
For YouTube transcripts, use the premium `youtube_transcript` API via `premium.execute`. The server handles authentication — do NOT call ScrapingDog directly via `http.request`, and do NOT prompt the user for a ScrapingDog API key. If the premium tool fails, fall back to rendering the YouTube page or third-party transcript services.

Summarize key points first, then offer the full transcript if the user wants detail.

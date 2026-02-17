---
id: youtube_transcripts
summary: "How to fetch YouTube video transcripts — premium tool primary, with fallback strategies"
always: false
---
When the user asks about a YouTube video or you need to extract a transcript:

1. **Primary: Premium YouTube Transcript tool** — Use `premium.execute` with `api: "youtube_transcript"` and `video_id: "{id}"`. The video ID is the `v=` parameter from the YouTube URL. This is a server-managed API — do NOT call ScrapingDog directly via `http.request`, and do NOT prompt the user for a ScrapingDog API key. The server handles authentication automatically.

2. **Fallback A: Render the page** — Use `http.render` on the YouTube video page. The rendered text often includes auto-generated captions in the page content, though this is less reliable.

3. **Fallback B: Third-party transcript services** — Try `http.request` on `https://youtubetranscript.com/?server_vid2={video_id}` which sometimes provides plain-text transcripts without authentication.

Always cache the transcript result — the centralized cache system handles this automatically. If the user asks follow-up questions about the video, the transcript will be available in the research cache.

When presenting transcript content, summarize key points first, then offer to share the full transcript if the user wants detail.

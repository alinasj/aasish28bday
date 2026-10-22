# Aasish's birthday scavenger hunt

A static site for a one-day scavenger hunt (Sunday, October 26, 2026). No build step.

- `hunt.json`: every stop: clue, answers, map location, unlock radius, video.
- `app.js`, `style.css`, `index.html`: the site.
- `tools/sync_sheet.py`: copies clue text, addresses, map pins, no-video messages, extra answers and the welcome/final messages from the Google Sheet.
- `tools/sync_playlist.py`: copies videos from the YouTube playlist into `hunt.json`. Titles like "Clue 3" go to clue 3.

## Preview

```bash
python3 -m http.server 8728
```

Open http://localhost:8728/?test=1 for test mode: switch themes, jump between clues, pretend to arrive.

## Update videos

A GitHub Action (`.github/workflows/sync-videos.yml`) runs every 15 minutes. It copies stop details from the Google Sheet (`tools/sync_sheet.py`; the sheet must be link-shared) and new "Clue N" videos from the playlist, then publishes. To sync right away, run it from the Actions tab, or locally:

```bash
python3 tools/sync_playlist.py "https://youtube.com/playlist?list=PLdeufAIF-Wd4"
git commit -am "Sync videos" && git push
```

## Take it down (late November 2026)

1. Delete the `aasish28` CNAME record in GoDaddy (anicca26.org DNS). Do this first, so nobody else can claim the subdomain.
2. Delete this repo.
3. Delete the YouTube videos/playlist and the ntfy subscription.

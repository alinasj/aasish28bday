#!/usr/bin/env python3
"""Copy video links from a YouTube playlist into hunt.json.

Video titles decide where each video goes (case doesn't matter, order doesn't matter):
  "Clue 1 ..." / "Clue one ..."  -> that clue (digits or words, up to twenty)
  "Welcome ..."                  -> the welcome screen
  "Finale ..."                   -> the last screen, after he gets home

The playlist must be Public or Unlisted (not Private).

Usage: python3 tools/sync_playlist.py PLAYLIST_URL_OR_ID [--dry-run]
"""
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

HUNT = Path(__file__).resolve().parent.parent / "hunt.json"
UA = {"User-Agent": "Mozilla/5.0", "Accept-Language": "en-US,en;q=0.9"}


def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    return urllib.request.urlopen(req, timeout=30).read().decode("utf-8", "replace")


def playlist_id(arg):
    m = re.search(r"[?&]list=([\w-]+)", arg)
    return m.group(1) if m else arg.strip()


shorts = set()  # Shorts are always vertical


def playlist_videos(pid):
    # YouTube sometimes serves a page without the data; try a few times.
    for attempt in range(4):
        html = fetch(f"https://www.youtube.com/playlist?list={pid}&hl=en")
        m = re.search(r"var ytInitialData = (\{.*?\});</script>", html, re.S)
        if m:
            break
        time.sleep(2)
    if not m:
        sys.exit("Couldn't read the playlist. Is it set to Public or Unlisted?")
    data = json.loads(m.group(1))
    found = []

    def walk(o):
        if isinstance(o, dict):
            # Older page layout
            r = o.get("playlistVideoRenderer")
            if r and r.get("videoId"):
                t = r.get("title", {})
                title = t.get("simpleText") or "".join(x.get("text", "") for x in t.get("runs", []))
                found.append((r["videoId"], title))
            # Current page layout
            lk = o.get("lockupViewModel")
            if lk and lk.get("contentType") == "LOCKUP_CONTENT_TYPE_VIDEO" and lk.get("contentId"):
                title = lk.get("metadata", {}).get("lockupMetadataViewModel", {}).get("title", {}).get("content", "")
                found.append((lk["contentId"], title))
            # Shorts (vertical videos) in the current page layout
            sh = o.get("shortsLockupViewModel")
            if sh:
                url = sh.get("onTap", {}).get("innertubeCommand", {}).get("commandMetadata", {}) \
                        .get("webCommandMetadata", {}).get("url", "")
                vm = re.search(r"/shorts/([\w-]{11})", url)
                title = sh.get("overlayMetadata", {}).get("primaryText", {}).get("content", "")
                if vm:
                    found.append((vm.group(1), title))
                    shorts.add(vm.group(1))
            for v in o.values():
                walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(data)
    return found


WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
         "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"]


def clue_number(title):
    """'Clue 3', 'clue #3', 'Clue three', 'Clue Three - Unni' -> 3. None if not a clue."""
    m = re.search(r"\bclue\s*#?\s*(\d+)", title)
    if m:
        return int(m.group(1))
    m = re.search(r"\bclue\s*#?\s*([a-z]+)", title)
    if m and m.group(1) in WORDS:
        return WORDS.index(m.group(1)) + 1
    return None


def shape(video_id):
    """'portrait' for vertical videos, 'landscape' otherwise.

    Shorts are always vertical. For other videos, look at the 16:9 thumbnail:
    a vertical video shows up with black bars on both sides.
    """
    if video_id in shorts:
        return "portrait"
    try:
        req = urllib.request.Request(f"https://www.youtube.com/shorts/{video_id}", headers=UA)
        opener = urllib.request.build_opener(NoRedirect)
        if opener.open(req, timeout=20).status == 200:
            return "portrait"
    except Exception:
        pass  # a 303 redirect means it's a regular video
    try:
        from io import BytesIO
        from PIL import Image
        data = urllib.request.urlopen(f"https://i.ytimg.com/vi/{video_id}/mqdefault.jpg", timeout=20).read()
        im = Image.open(BytesIO(data)).convert("L")
        w, h = im.size

        def mean(x0, x1):
            px = [im.getpixel((x, y)) for x in range(x0, x1) for y in range(0, h, 3)]
            return sum(px) / len(px)

        edge = int(w * 0.15)
        bars = mean(0, edge) < 20 and mean(w - edge, w) < 20 and mean(w // 2 - 20, w // 2 + 20) > 25
        return "portrait" if bars else "landscape"
    except Exception:
        return "portrait"  # most of these are phone videos


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    dry = "--dry-run" in sys.argv
    hunt = json.loads(HUNT.read_text())
    videos = playlist_videos(playlist_id(args[0]))
    print(f"Playlist has {len(videos)} videos.")

    targets = {}
    for vid, title in videos:
        t = title.strip().lower()
        n = clue_number(t)
        if n:
            targets.setdefault(("clue", n), (vid, title))
        elif t.startswith("welcome"):
            targets.setdefault(("welcome", 0), (vid, title))
        elif t.startswith("finale") or t.startswith("final"):
            targets.setdefault(("finale", 0), (vid, title))
        else:
            print(f"  skipped (title doesn't start with Clue N / Welcome / Finale): {title}")

    changed = 0
    for (kind, n), (vid, title) in sorted(targets.items()):
        if kind == "clue":
            if not 1 <= n <= len(hunt["stops"]):
                print(f"  skipped (no clue {n}): {title}")
                continue
            item = hunt["stops"][n - 1]
            label = f"Clue {n} ({item['name']})"
        else:
            item = hunt[kind]
            label = kind.capitalize()
        url = f"https://youtu.be/{vid}"
        if item.get("video") != url or "shape" not in item:
            item["video"] = url
            item["shape"] = shape(vid)
            changed += 1
            print(f"  {label}: {title} -> {url} [{item['shape']}]")

    missing = [str(i + 1) for i, s in enumerate(hunt["stops"]) if not s.get("video") and s.get("from")]
    if missing:
        print("Clues still without a video: " + ", ".join(missing))
    if dry:
        print("Dry run: hunt.json not changed.")
    elif changed:
        HUNT.write_text(json.dumps(hunt, indent=2, ensure_ascii=False) + "\n")
        print(f"Updated {changed} video(s) in hunt.json.")
    else:
        print("No changes.")


if __name__ == "__main__":
    main()

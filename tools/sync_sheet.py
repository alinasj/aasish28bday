#!/usr/bin/env python3
"""Copy stop details from the Google Sheet into hunt.json.

The sheet must be shared as "Anyone with the link can view".

From the Stops tab (columns are found by their header, so they can be moved):
  Place                    -> stop name (anything in brackets is dropped)
  Exact address ...        -> address shown under the stop name, used for directions
  Map pin ...              -> exact unlock spot: a Google Maps link or "lat, lng"

Pins only move from the Map pin column. Address lookups put "2 King St W, Hamilton"
10 km away in testing, so an address is looked up only for a stop that has no pin
yet, and only kept if it lands near the stops before and after it.
  Clue that leads him here -> clue text
  Video from               -> who the video is from
  Text to show ...         -> message shown when there's no video
  Backup answer ...        -> extra accepted answers (comma separated)
From the Start and finish tab:
  Welcome message, Final message

Empty cells never erase what's already in hunt.json.

Usage: python3 tools/sync_sheet.py [--dry-run]
"""
import csv
import io
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

SHEET_ID = "1l41clJ2uLfJDBIZiOIPS___KW_ZTCiB3lOMkaM8-DA0"
STOPS_GID = "0"
START_FINISH_GID = "1808750465"
HUNT = Path(__file__).resolve().parent.parent / "hunt.json"
UA = {"User-Agent": "aasish28-hunt/1.0 (personal scavenger hunt site)"}

# Pins must land in Hamilton / Toronto / Vaughan. Anything outside is a bad lookup.
AREA = {"lat": (43.0, 44.1), "lng": (-80.3, -79.1)}


def fetch(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", "replace"), r.geturl()


def sheet_rows(gid):
    text, _ = fetch(f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=csv&gid={gid}")
    if text.lstrip().startswith("<"):
        sys.exit("Couldn't read the sheet. Is it shared as 'Anyone with the link can view'?")
    return list(csv.reader(io.StringIO(text)))


def in_area(lat, lng):
    return AREA["lat"][0] <= lat <= AREA["lat"][1] and AREA["lng"][0] <= lng <= AREA["lng"][1]


def coords_from_text(s):
    """'43.24, -79.86', or a Google Maps link (short links are followed)."""
    s = s.strip()
    if not s:
        return None
    m = re.fullmatch(r"(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)", s)
    if not m and ("goo.gl" in s or "maps.app" in s):
        try:
            _, s = fetch(s)  # follow the short link to the full Maps URL
        except Exception:
            return None
    if not m:
        s = urllib.parse.unquote(s)
        # Order matters: a dropped pin (!3d..!4d..) is more exact than the map's centre (@lat,lng).
        for pat in (r"!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)", r"[?&](?:q|query|destination|ll)=(-?\d+\.\d+),\s*(-?\d+\.\d+)",
                    r"/(-?\d+\.\d+),\+?\s*(-?\d+\.\d+)", r"@(-?\d+\.\d+),(-?\d+\.\d+)"):
            m = re.search(pat, s)
            if m:
                break
    if not m:
        return None
    lat, lng = float(m.group(1)), float(m.group(2))
    return (round(lat, 6), round(lng, 6)) if in_area(lat, lng) else None


def geocode(address):
    """OpenStreetMap lookup. Only used for addresses with a street number."""
    q = urllib.parse.urlencode({"q": address, "format": "json", "limit": 1, "countrycodes": "ca"})
    try:
        time.sleep(1.1)  # Nominatim's usage policy: at most 1 request a second
        d = json.loads(fetch(f"https://nominatim.openstreetmap.org/search?{q}")[0])
    except Exception:
        return None
    if not d:
        return None
    lat, lng = float(d[0]["lat"]), float(d[0]["lon"])
    return (round(lat, 6), round(lng, 6)) if in_area(lat, lng) else None


def has_street_number(address):
    return bool(re.match(r"\s*(unit\s*\w+,?\s*)?\d+[a-z]?\s+\w", address, re.I))


def km(a, b):
    r = math.pi / 180
    x = math.sin((b[0] - a[0]) * r / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin((b[1] - a[1]) * r / 2) ** 2
    return 2 * 6371 * math.asin(math.sqrt(x))


def find_col(header, *words):
    for i, h in enumerate(header):
        h = h.lower()
        if all(w in h for w in words):
            return i
    return None


def main():
    dry = "--dry-run" in sys.argv
    hunt = json.loads(HUNT.read_text())
    changes, warnings = [], []

    def setf(obj, key, value, label):
        if value is not None and obj.get(key) != value:
            obj[key] = value
            changes.append(label)

    rows = sheet_rows(STOPS_GID)
    hi = next((i for i, r in enumerate(rows) if r and r[0].strip().lower().startswith("stop")), None)
    if hi is None:
        sys.exit("Couldn't find the 'Stop #' header row in the Stops tab.")
    header = rows[hi]
    col = {
        "place": find_col(header, "place"),
        "address": find_col(header, "address"),
        "pin": find_col(header, "pin"),
        "clue": find_col(header, "clue"),
        "from": find_col(header, "video from"),
        "text": find_col(header, "text to show"),
        "answer": find_col(header, "backup answer"),
    }
    cell = lambda r, k: r[col[k]].strip() if col[k] is not None and col[k] < len(r) else ""

    def near_neighbours(n, p):
        others = [hunt["stops"][i] for i in (n - 2, n) if 0 <= i < len(hunt["stops"])]
        others = [(o["lat"], o["lng"]) for o in others if o.get("lat") is not None]
        return all(km(p, o) < 40 for o in others)

    for r in rows[hi + 1:]:
        m = re.match(r"\s*(\d+)", r[0] if r else "")
        if not m or not 1 <= int(m.group(1)) <= len(hunt["stops"]):
            continue
        n = int(m.group(1))
        stop = hunt["stops"][n - 1]
        tag = f"Clue {n} ({stop['name']})"

        place = re.sub(r"\s*\(.*?\)\s*", " ", cell(r, "place")).strip()
        setf(stop, "name", place or None, f"{tag}: name -> {place}")

        clue = cell(r, "clue").replace("\r\n", "\n")
        setf(stop, "clue", clue or None, f"{tag}: clue text")

        who = cell(r, "from")
        if who:
            setf(stop, "from", None if who.lower().startswith("none") else who, f"{tag}: video from -> {who}")

        text = cell(r, "text")
        setf(stop, "text", text or None, f"{tag}: no-video message")

        for a in [x.strip() for x in cell(r, "answer").split(",") if x.strip()]:
            if a.lower() not in [x.lower() for x in stop["answers"]]:
                stop["answers"].append(a)
                changes.append(f"{tag}: extra answer '{a}'")

        address = cell(r, "address")
        setf(stop, "address", address or None, f"{tag}: address -> {address}")

        # Where the stop unlocks.
        old = (stop["lat"], stop["lng"]) if stop.get("lat") is not None else None
        new = None
        pin = cell(r, "pin")
        if pin:
            new = coords_from_text(pin)
            if not new:
                warnings.append(f"{tag}: couldn't read the map pin '{pin}' (needs a Google Maps link or 'lat, lng' near Hamilton/Toronto)")
        elif not old and address and has_street_number(address):
            new = geocode(address)
            if new and not near_neighbours(n, new):
                warnings.append(f"{tag}: '{address}' was found too far from the stops around it; add a Map pin instead")
                new = None
            elif not new:
                warnings.append(f"{tag}: couldn't find '{address}' on the map; add a Map pin so GPS can unlock it")
        if new and new != old:
            stop["lat"], stop["lng"] = new
            changes.append(f"{tag}: unlock spot -> {new[0]}, {new[1]}" + (f" (moved {km(old, new):.2f} km)" if old else " (pin added)"))
            if old and km(old, new) > 3:
                warnings.append(f"{tag}: the pin moved {km(old, new):.1f} km. Check it's the right place.")

    # Start and finish tab
    for r in sheet_rows(START_FINISH_GID):
        if len(r) < 2 or not r[1].strip():
            continue
        label, value = r[0].strip().lower(), r[1].replace("\r\n", "\n").strip()
        if label.startswith("welcome message"):
            setf(hunt["welcome"], "text", value, "Welcome message")
        elif label.startswith("final message"):
            setf(hunt["finale"], "text", value, "Final message")

    for c in changes:
        print("  " + c)
    for w in warnings:
        print("  WARNING: " + w)
    if not changes:
        print("No changes.")
    elif dry:
        print(f"Dry run: {len(changes)} change(s), hunt.json not changed.")
    else:
        HUNT.write_text(json.dumps(hunt, indent=2, ensure_ascii=False) + "\n")
        print(f"Updated hunt.json ({len(changes)} change(s)).")


if __name__ == "__main__":
    main()

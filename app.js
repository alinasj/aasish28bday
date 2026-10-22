(() => {
  "use strict";

  // Flow for each stop:
  //   clue    -> video + clue text + guess box (state.solved = null)
  //   travel  -> answer known, directions + GPS check (state.solved = "guessed" | "revealed")
  //   arrived -> celebration, then the next stop's clue (state.phase = "arrived")
  // state.found = number of stops he has reached.

  const params = new URLSearchParams(location.search);
  if (params.has("test")) sessionStorage.setItem("hunt-test", params.get("test") === "0" ? "" : "1");
  const TEST = !!sessionStorage.getItem("hunt-test");
  const STATE_KEY = TEST ? "aasish28-test" : "aasish28";
  const QUEUE_KEY = "aasish28-ntfy-queue";
  const THEMES = { golden: "Golden hour", night: "Night drive", map: "Treasure map", garden: "Garden party" };
  const FRESH = () => ({ started: false, found: 0, phase: "hunt", tries: 0, solved: null });

  const app = document.getElementById("app");
  let hunt = null;
  let state = null;
  let watchId = null;
  let lastPos = null;

  // ---------- storage (never let a blocked storage break the page) ----------
  const store = {
    get(k, fallback) {
      try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
    },
    set(k, v) {
      try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
    },
  };
  const save = () => store.set(STATE_KEY, state);

  // ---------- helpers ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
  const pick = (list, i) => (list && list.length ? list[((i % list.length) + list.length) % list.length] : "");
  const maxTries = () => hunt.tries || 5;
  const triesUsed = () => Number(state.tries) || 0;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  function lev(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) d[0][j] = j;
    for (let i = 1; i <= a.length; i++)
      for (let j = 1; j <= b.length; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length][b.length];
  }

  function answerMatches(input, answers) {
    const x = norm(input);
    if (!x) return false;
    return answers.some((a) => {
      const y = norm(a);
      if (!y) return false;
      if (x === y) return true;
      if (y.length >= 4 && x.includes(y)) return true;
      return lev(x, y) <= (y.length > 6 ? 2 : 1);
    });
  }

  function distanceM(lat1, lng1, lat2, lng2) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`);

  function heat(m) {
    if (m < 300) return "Hot! You're almost there 🔥";
    if (m < 1000) return "Warm";
    if (m < 5000) return "Getting closer";
    if (m < 20000) return "Still a drive away";
    return "Far away";
  }

  // A video can be a YouTube link/ID, or a Google Drive link.
  function videoSrc(v) {
    if (!v) return null;
    const s = String(v).trim();
    if (s.includes("drive.google.com")) {
      const m = s.match(/\/d\/([\w-]{20,})/) || s.match(/[?&]id=([\w-]{20,})/);
      return m ? { embed: `https://drive.google.com/file/d/${m[1]}/preview`, open: `https://drive.google.com/file/d/${m[1]}/view` } : null;
    }
    const m = s.match(/(?:youtu\.be\/|v=|shorts\/|embed\/|live\/)([\w-]{11})/) || s.match(/^([\w-]{11})$/);
    if (!m) return null;
    return {
      embed: `https://www.youtube-nocookie.com/embed/${m[1]}?rel=0&playsinline=1&modestbranding=1`,
      open: `https://youtu.be/${m[1]}`,
    };
  }

  // ---------- notifications to Aileen (ntfy) ----------
  function notify(title, message) {
    if (!hunt.ntfyTopic) return;
    const queue = store.get(QUEUE_KEY, []);
    queue.push({ title: (TEST ? "[TEST] " : "") + title, message, at: Date.now() });
    store.set(QUEUE_KEY, queue);
    flushQueue();
  }

  let flushing = false;
  async function flushQueue() {
    if (flushing) return;
    flushing = true;
    try {
      let queue = store.get(QUEUE_KEY, []);
      while (queue.length) {
        const item = queue[0];
        const time = new Date(item.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        const res = await fetch(`https://ntfy.sh/${encodeURIComponent(hunt.ntfyTopic)}`, {
          method: "POST",
          body: `${item.message} (${time})`,
          headers: { Title: item.title.replace(/[^\x20-\x7e]/g, ""), Tags: "tada" },
        });
        if (!res.ok) break;
        queue = store.get(QUEUE_KEY, []).slice(1);
        store.set(QUEUE_KEY, queue);
      }
    } catch {
      // offline: try again later
    } finally {
      flushing = false;
    }
  }
  window.addEventListener("online", flushQueue);

  // ---------- confetti ----------
  function confetti() {
    const box = document.getElementById("confetti");
    const colors = ["var(--accent)", "var(--highlight)", "#f6c945", "#ff8fb1", "#7ad3ff"];
    for (let i = 0; i < 100; i++) {
      const p = document.createElement("i");
      p.style.left = Math.random() * 100 + "vw";
      p.style.background = colors[i % colors.length];
      p.style.animationDuration = 1.8 + Math.random() * 1.8 + "s";
      p.style.animationDelay = Math.random() * 0.4 + "s";
      box.appendChild(p);
    }
    setTimeout(() => (box.innerHTML = ""), 4200);
  }

  // ---------- geolocation ----------
  function stopWatching() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }

  function startWatching() {
    stopWatching();
    if (!("geolocation" in navigator)) return setStatus("This browser can't share location. Use \"I'm definitely here\" below when you arrive.");
    watchId = navigator.geolocation.watchPosition(onPosition, onPosError, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
  }

  function onPosError(err) {
    if (err.code === 1) {
      setStatus("Location is blocked. In Chrome: tap the icon left of the address, then Permissions → Location → Allow, and reload.");
    } else {
      setStatus("Can't get a GPS fix right now. Step outside and try again.");
    }
  }

  function isInside(pos, stop) {
    const d = distanceM(pos.lat, pos.lng, stop.lat, stop.lng);
    return { d, inside: d <= stop.radius + Math.min(pos.acc || 0, 100) };
  }

  function onPosition(p) {
    lastPos = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy };
    updateDistance();
  }

  function updateDistance() {
    const stop = currentStop();
    const el = document.getElementById("dist");
    if (!stop || !el || !lastPos || stop.lat == null) return;
    const { d, inside } = isInside(lastPos, stop);
    el.textContent = inside ? "You're here!" : fmtDist(d);
    document.getElementById("heat").textContent = inside ? "" : heat(d);
    if (inside) arrive("gps");
  }

  function checkHere() {
    const stop = currentStop();
    if (stop.lat == null) return setStatus("GPS isn't set up for this stop yet. If you're there, use \"I'm definitely here\" below.");
    setStatus("Checking where you are…");
    navigator.geolocation.getCurrentPosition(
      (p) => {
        onPosition(p);
        const { d, inside } = isInside(lastPos, stop);
        if (!inside) setStatus(`Not quite. You're about ${fmtDist(d)} away. Keep going!`);
      },
      onPosError,
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 }
    );
  }

  const setStatus = (msg) => {
    const el = document.getElementById("status");
    if (el) el.textContent = msg;
  };

  // ---------- progress ----------
  const currentStop = () => hunt.stops[state.found];

  function resetGuess() {
    state.tries = 0;
    state.solved = null;
  }

  function arrive(how) {
    if (state.phase !== "hunt" || !state.solved) return;
    const stop = currentStop();
    if (!stop) return;
    stopWatching();
    state.found += 1;
    state.phase = "arrived";
    resetGuess();
    save();
    const via = how === "gps" ? "" : how === "manual" ? " (GPS didn't work, he confirmed by hand)" : " (skipped)";
    notify(`${hunt.player} reached stop ${state.found} of ${hunt.stops.length}`, `${stop.name}${via}`);
    render();
    confetti();
  }

  function jumpTo(found) {
    state.started = true;
    state.found = Math.max(0, Math.min(hunt.stops.length, found));
    state.phase = "hunt";
    resetGuess();
    save();
    render();
  }

  // Aileen's skip code. "code" = reveal the answer; "code 7" = jump to stop 7's clue.
  function handleSkip(raw) {
    const skip = norm(hunt.skipCode);
    const x = norm(raw);
    if (!skip || !x.startsWith(skip)) return false;
    const rest = x.slice(skip.length);
    if (rest && /^\d+$/.test(rest)) {
      jumpTo(parseInt(rest, 10) - 1);
      notify(`${hunt.player}'s hunt moved to clue ${state.found + 1}`, "Skip code used");
    } else {
      state.solved = "revealed";
      save();
      render();
    }
    return true;
  }

  function submitGuess(e) {
    e.preventDefault();
    const input = document.getElementById("guess");
    const raw = input.value.trim();
    if (!raw || handleSkip(raw)) return;
    const stop = currentStop();
    const n = state.found + 1;
    if (answerMatches(raw, stop.answers || [])) {
      state.solved = "guessed";
      save();
      notify(`${hunt.player} solved clue ${n}`, `${stop.name}, in ${plural(triesUsed() + 1, "try", "tries")}`);
      render();
      window.scrollTo(0, 0);
      confetti();
      return;
    }
    state.tries = triesUsed() + 1;
    if (state.tries >= maxTries()) {
      state.solved = "revealed";
      save();
      notify(`${hunt.player} used all ${maxTries()} tries on clue ${n}`, `Answer shown: ${stop.name}`);
      render();
      window.scrollTo(0, 0);
      return;
    }
    save();
    const left = maxTries() - state.tries;
    const el = document.getElementById("guess-status");
    el.textContent = `${pick(hunt.wrongMessages, state.tries - 1) || "Not quite."} ${plural(left, "try", "tries")} left.`;
    el.classList.remove("shake");
    void el.offsetWidth;
    el.classList.add("shake");
    renderTries();
    input.value = "";
    input.focus();
  }

  // ---------- pieces ----------
  function header(label) {
    const total = hunt.stops.length;
    let trail = "";
    for (let i = 0; i < total; i++) {
      const cls = i < state.found ? "done" : i === state.found && state.started ? "now" : "";
      trail += `<span class="${cls}"></span>`;
    }
    return `<header class="top">
        <p class="brand">🗺️ ${esc(hunt.title || "Treasure Hunt")}</p>
        ${label ? `<p class="eyebrow">${label}</p>` : ""}
        <div class="trail" aria-label="${state.found} of ${total} stops found">${trail}</div>
      </header>`;
  }

  function videoBlock(item) {
    const v = videoSrc(item.video);
    if (!v) return "";
    const shape = item.shape === "landscape" ? " landscape" : "";
    return `<div class="video${shape}"><iframe src="${v.embed}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen title="Video from ${esc(item.from || "")}"></iframe></div>
      <p class="small muted center">Video not playing? <a href="${v.open}" target="_blank" rel="noopener">Open it here</a>.</p>`;
  }

  function clueCard(stop, n) {
    const hasVideo = !!videoSrc(stop.video);
    return `<section class="card scroll">
        <p class="eyebrow">Clue ${n}</p>
        ${videoBlock(stop)}
        ${stop.text && !hasVideo ? `<p class="note pre">${esc(stop.text)}</p>` : ""}
        <div class="clue pre">${esc(stop.clue)}</div>
      </section>`;
  }

  function triesDots() {
    let dots = "";
    for (let i = 0; i < maxTries(); i++) dots += `<span class="${i < triesUsed() ? "used" : ""}"></span>`;
    return dots;
  }

  function renderTries() {
    const el = document.getElementById("tries");
    if (el) el.innerHTML = triesDots();
  }

  function journeyCard() {
    if (!state.found) return "";
    const items = hunt.stops.slice(0, state.found).map((s) => `<li>${esc(s.name)}</li>`).join("");
    return `<details class="card journey"><summary>Places you've found (${state.found})</summary><ol>${items}</ol></details>`;
  }

  // ---------- screens ----------
  function renderWelcome() {
    const w = hunt.welcome || {};
    app.innerHTML = `
      ${header("")}
      <section class="card scroll hero">
        <div class="big">🗺️</div>
        <h1>${esc(w.heading || "Happy birthday")}</h1>
        <p class="pre">${esc(w.text || "")}</p>
        ${videoBlock(w)}
      </section>
      <section class="card how">
        <p class="eyebrow">How it works</p>
        <ol>
          <li>Watch the video and read the clue.</li>
          <li>Guess where it leads. You get ${maxTries()} tries.</li>
          <li>Follow the directions there.</li>
          <li>When you arrive, your next clue unlocks.</li>
        </ol>
      </section>
      <button class="btn" id="start">Open the first clue</button>
      <p class="small muted center" style="margin-top:10px">Chrome will ask to use your location. Tap <b>Allow</b>.</p>`;
    document.getElementById("start").onclick = () => {
      state.started = true;
      state.phase = "hunt";
      resetGuess();
      save();
      notify(`${hunt.player} started the hunt!`, "He's on clue 1");
      render();
      window.scrollTo(0, 0);
    };
  }

  function renderClue() {
    const stop = currentStop();
    const n = state.found + 1;
    const used = triesUsed();
    app.innerHTML = `
      ${header(`Clue ${n} of ${hunt.stops.length}`)}
      ${clueCard(stop, n)}
      <section class="card">
        <p class="eyebrow">Where does this clue lead?</p>
        <form class="answer-row" id="guess-form" autocomplete="off">
          <input id="guess" placeholder="Type your guess" autocapitalize="none" enterkeyhint="go">
          <button class="btn" type="submit">Guess</button>
        </form>
        <div class="tries-row"><div class="tries" id="tries">${triesDots()}</div>
          <p class="status small muted" id="guess-status">${used ? `${plural(maxTries() - used, "try", "tries")} left.` : `You get ${maxTries()} tries.`}</p></div>
      </section>
      ${journeyCard()}`;
    document.getElementById("guess-form").onsubmit = submitGuess;
  }

  function renderTravel() {
    const stop = currentStop();
    const n = state.found + 1;
    const hasGps = stop.lat != null;
    const dest = stop.address || (hasGps ? `${stop.lat},${stop.lng}` : stop.name);
    const maps = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}`;
    const guessed = state.solved === "guessed";
    app.innerHTML = `
      ${header(`Clue ${n} of ${hunt.stops.length}`)}
      <section class="card scroll hero">
        <div class="big">${guessed ? "🎉" : "😅"}</div>
        ${guessed
          ? `<h1>You got it!</h1><p>Awesome, that's the right answer.</p>`
          : `<p class="quip">${esc(pick(hunt.giveUpMessages, state.found))}</p>`}
        <p class="eyebrow">Your next stop</p>
        <h2 class="dest">${esc(stop.name)}</h2>
        ${stop.address ? `<p class="small muted">${esc(stop.address)}</p>` : ""}
        <a class="btn" href="${maps}" target="_blank" rel="noopener">Get directions to ${esc(stop.name)}</a>
      </section>
      <section class="card">
        ${hasGps ? `<p class="eyebrow">How close you are</p><p class="distance" id="dist">…</p><p class="heat" id="heat"></p>` : ""}
        <button class="btn ghost" id="here">I'm here</button>
        <p class="status small muted" id="status">Your next clue unlocks when you get there.</p>
        <details>
          <summary>You're there but it won't unlock?</summary>
          <p class="small">GPS can be off near tall buildings and in parks. If you're really there, tap below.</p>
          <button class="btn ghost" id="manual">I'm definitely here</button>
        </details>
      </section>
      <details class="card">
        <summary>See clue ${n} again</summary>
        <div class="clue pre small-clue">${esc(stop.clue)}</div>
      </details>
      ${journeyCard()}`;
    document.getElementById("here").onclick = checkHere;
    document.getElementById("manual").onclick = () => arrive("manual");
    if (hasGps) startWatching();
  }

  function renderArrived() {
    const stop = hunt.stops[state.found - 1];
    app.innerHTML = `
      ${header(`Stop ${state.found} of ${hunt.stops.length}`)}
      <section class="card scroll hero">
        <div class="big">❌</div>
        <p class="eyebrow">X marks the spot</p>
        <h1>You made it to ${esc(stop.name)}!</h1>
        <p class="muted">Clue ${state.found + 1} is waiting for you.</p>
      </section>
      <button class="btn" id="next">Open clue ${state.found + 1}</button>
      ${journeyCard()}`;
    document.getElementById("next").onclick = () => {
      state.phase = "hunt";
      save();
      render();
      window.scrollTo(0, 0);
    };
  }

  function renderFinale() {
    const f = hunt.finale || {};
    app.innerHTML = `
      ${header("The end of the trail")}
      <section class="card scroll hero">
        <div class="big">❤️</div>
        <h1>${esc(f.heading || "You made it!")}</h1>
        <p class="pre">${esc(f.text || "")}</p>
        ${videoBlock(f)}
      </section>
      ${journeyCard()}`;
    if (!state.finaleSent) {
      state.finaleSent = true;
      save();
      notify(`${hunt.player} finished the hunt!`, "He's home.");
    }
  }

  function render() {
    stopWatching();
    if (!state.started) return renderWelcome();
    if (state.found >= hunt.stops.length) return renderFinale();
    if (state.phase === "arrived") return renderArrived();
    if (!state.solved) return renderClue();
    return renderTravel();
  }

  // ---------- test mode ----------
  function applyTheme() {
    const t = params.get("theme") || (TEST && store.get("aasish28-theme", null)) || hunt.theme || "map";
    document.documentElement.dataset.theme = THEMES[t] ? t : "map";
  }

  function renderTestbar() {
    if (!TEST) return;
    const bar = document.getElementById("testbar");
    bar.hidden = false;
    const opts = Object.entries(THEMES)
      .map(([k, v]) => `<option value="${k}" ${document.documentElement.dataset.theme === k ? "selected" : ""}>${v}</option>`).join("");
    bar.innerHTML = `<b>TEST</b>
      <select id="t-theme">${opts}</select>
      <button id="t-prev">◀ Clue</button>
      <button id="t-next">Clue ▶</button>
      <button id="t-here">Pretend I'm there</button>
      <button id="t-reset">Reset</button>
      <button id="t-exit">Exit test</button>`;
    bar.querySelector("#t-theme").onchange = (e) => { store.set("aasish28-theme", e.target.value); applyTheme(); };
    bar.querySelector("#t-prev").onclick = () => jumpTo(state.found - 1);
    bar.querySelector("#t-next").onclick = () => jumpTo(state.found + 1);
    bar.querySelector("#t-here").onclick = () => {
      const s = currentStop();
      if (!state.started || state.phase !== "hunt" || !s) return;
      if (!state.solved) state.solved = "guessed";
      if (s.lat == null) return arrive("manual");
      lastPos = { lat: s.lat, lng: s.lng, acc: 10 };
      arrive("gps");
    };
    bar.querySelector("#t-reset").onclick = () => { state = FRESH(); save(); render(); };
    bar.querySelector("#t-exit").onclick = () => { sessionStorage.removeItem("hunt-test"); location.href = location.pathname; };
  }

  // ---------- start ----------
  fetch("hunt.json", { cache: "no-store" })
    .then((r) => r.json())
    .then((data) => {
      hunt = data;
      document.title = hunt.title || document.title;
      state = Object.assign(FRESH(), store.get(STATE_KEY, {}));
      if (state.phase === "found") state.phase = "arrived"; // saved by an earlier version
      state.tries = triesUsed();
      // Test-only shortcut to a screen: ?test=1&stop=3&tries=2&solved=revealed (or &arrived=1)
      if (TEST && params.has("stop")) {
        state = Object.assign(FRESH(), {
          started: true,
          found: +params.get("stop") - (params.has("arrived") ? 0 : 1),
          phase: params.has("arrived") ? "arrived" : "hunt",
          tries: +params.get("tries") || 0,
          solved: params.get("solved") || null,
        });
      }
      applyTheme();
      renderTestbar();
      render();
      flushQueue();
    })
    .catch(() => {
      app.innerHTML = '<p class="loading">Couldn\'t load the hunt. Check your connection and reload.</p>';
    });
})();

/**
 * bertie-page.js — the self-contained preview UI for BERTIE.
 *
 * Everything is hand-authored HTML/CSS/inline-SVG. NOTHING is generated: no
 * image models, no asset pipeline, ~£0. Bertie is drawn as inline SVG in his
 * 3D-render register (crisp gradients + specular highlights — never
 * watercoloured), living in Roberta's belly-cubby (a matryoshka of care). He
 * pops out of the cubby to take Amanda's note, gives a wee acknowledgement, then
 * tucks back in.
 *
 * The page holds NO secret unless Amanda provides one. It talks only to the
 * admin-gated /api/bertie/note endpoint.
 */

/**
 * @param {{ configured: boolean, presetKey?: string, ack: string, channel: string }} opts
 * @returns {string} a complete HTML document
 */
export function renderBertiePage({ configured, presetKey = '', ack, channel }) {
  const boot = JSON.stringify({ configured, presetKey, ack, channel });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>Bertie — Amanda's capture companion (admin)</title>
<style>
  :root {
    --bg1:#fef3e2; --bg2:#f7d9c4; --bg3:#e7c3e8;
    --ink:#3a2a3f; --muted:#8a7686;
    --bertie-pink:#ff79b8; --bertie-pink-dk:#d6418b;
    --cap-yellow:#ffd24a; --antenna:#e0259b; --belly-blue:#2bb8ff;
    --card:#fffdfb;
  }
  * { box-sizing:border-box; }
  html,body { margin:0; height:100%; }
  body {
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    color:var(--ink);
    background:radial-gradient(120% 120% at 20% 0%, var(--bg1) 0%, var(--bg2) 45%, var(--bg3) 100%);
    min-height:100%;
    display:flex; flex-direction:column; align-items:center;
    padding:24px 16px 48px;
  }
  .admin-flag {
    align-self:stretch; max-width:760px; margin:0 auto 14px; width:100%;
    background:#2a1730; color:#ffd9ef; border:1px solid #5a2a55;
    border-radius:10px; padding:8px 14px; font-size:13px; letter-spacing:.2px;
    display:flex; gap:8px; align-items:center;
  }
  .admin-flag b { color:#ff9cd6; }
  h1 { font-size:22px; margin:6px 0 2px; }
  .sub { color:var(--muted); font-size:14px; margin:0 0 18px; text-align:center; }

  /* ─── The scene: Roberta (carer) with Bertie in her belly-cubby ─────────── */
  .scene { position:relative; width:300px; height:300px; margin:4px 0 10px; }

  /* Roberta — soft, calm carer form (deliberately gentler than glossy Bertie). */
  .roberta {
    position:absolute; left:50%; bottom:0; transform:translateX(-50%);
    width:300px; height:270px;
    background:linear-gradient(180deg,#fbe7d3 0%,#f3cdb6 100%);
    border-radius:150px 150px 90px 90px;
    box-shadow:0 24px 50px rgba(120,70,90,.30), inset 0 6px 16px rgba(255,255,255,.65);
  }
  .roberta::before { /* a soft face hint, kept quiet */
    content:""; position:absolute; top:42px; left:50%; transform:translateX(-50%);
    width:120px; height:60px; border-radius:60px;
    background:radial-gradient(60% 80% at 50% 30%, rgba(255,255,255,.7), transparent 70%);
  }
  /* The belly-cubby — a recessed niche Bertie lives in. */
  .cubby {
    position:absolute; left:50%; bottom:34px; transform:translateX(-50%);
    width:150px; height:150px; border-radius:50%;
    background:radial-gradient(70% 70% at 50% 35%, #5a2c46 0%, #3a1c30 70%, #2a1322 100%);
    box-shadow:inset 0 10px 22px rgba(0,0,0,.55), 0 4px 8px rgba(255,255,255,.4);
    overflow:hidden;
  }
  .cubby-lip { /* glossy inner rim to read as a real cubby */
    position:absolute; left:50%; bottom:34px; transform:translateX(-50%);
    width:150px; height:150px; border-radius:50%;
    box-shadow:inset 0 6px 10px rgba(255,255,255,.18);
    pointer-events:none;
  }

  /* Bertie — glossy 3D-render robot. Sits tucked; pops out on capture. */
  .bertie {
    position:absolute; left:50%; bottom:30px;
    width:140px; height:160px;
    transform:translateX(-50%) translateY(46px) scale(.86);
    transition:transform .55s cubic-bezier(.34,1.56,.64,1);
    filter:drop-shadow(0 10px 14px rgba(80,20,60,.45));
    transform-origin:bottom center;
    z-index:3;
  }
  .bertie.out { transform:translateX(-50%) translateY(-66px) scale(1.04); }
  .bertie.bob { animation:bob 1.1s ease-in-out 1; }
  @keyframes bob { 0%,100%{ } 50%{ transform:translateX(-50%) translateY(-78px) scale(1.06);} }

  /* Speech bubble for the acknowledgement. */
  .bubble {
    position:absolute; left:50%; top:-6px; transform:translateX(-50%) translateY(-8px);
    background:var(--card); color:var(--ink); border:1px solid #f0d4e6;
    padding:10px 14px; border-radius:14px; max-width:240px; text-align:center;
    font-size:14px; line-height:1.35; box-shadow:0 10px 24px rgba(120,40,90,.22);
    opacity:0; pointer-events:none; transition:opacity .3s ease; z-index:5;
  }
  .bubble.show { opacity:1; }
  .bubble::after {
    content:""; position:absolute; left:50%; bottom:-7px; transform:translateX(-50%) rotate(45deg);
    width:14px; height:14px; background:var(--card); border-right:1px solid #f0d4e6; border-bottom:1px solid #f0d4e6;
  }

  /* ─── Controls ──────────────────────────────────────────────────────────── */
  .panel {
    width:100%; max-width:560px; background:var(--card);
    border:1px solid #f1dcea; border-radius:16px; padding:16px;
    box-shadow:0 14px 40px rgba(120,60,90,.16);
  }
  .row { display:flex; gap:8px; align-items:stretch; }
  textarea {
    flex:1; resize:vertical; min-height:64px; font:inherit; color:var(--ink);
    border:1px solid #e7cfe0; border-radius:12px; padding:10px 12px; background:#fffafd;
  }
  textarea:focus { outline:2px solid var(--bertie-pink); border-color:transparent; }
  .meta { display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; }
  .meta input {
    flex:1; min-width:160px; font:inherit; border:1px solid #e7cfe0; border-radius:10px;
    padding:8px 10px; background:#fffafd; color:var(--ink);
  }
  .actions { display:flex; gap:8px; margin-top:12px; align-items:center; flex-wrap:wrap; }
  button {
    font:inherit; font-weight:600; border:none; border-radius:12px; padding:11px 16px;
    cursor:pointer; transition:transform .08s ease, filter .15s ease;
  }
  button:active { transform:translateY(1px); }
  .send {
    background:linear-gradient(180deg,var(--bertie-pink),var(--bertie-pink-dk)); color:#fff;
    box-shadow:0 6px 14px rgba(214,65,139,.4);
  }
  .send:disabled { filter:grayscale(.5) opacity(.6); cursor:default; }
  .mic {
    background:#fff; color:var(--bertie-pink-dk); border:1px solid #f0c8e0;
    display:inline-flex; gap:6px; align-items:center;
  }
  .mic[disabled] { color:var(--muted); border-color:#eee; cursor:default; }
  .hint { color:var(--muted); font-size:12px; margin-left:auto; }
  .status { min-height:18px; margin-top:10px; font-size:13px; color:var(--muted); }
  .status.ok { color:#1f9d57; }
  .status.err { color:#c0392b; }
  .chip {
    display:inline-block; font-size:11px; color:var(--muted);
    border:1px solid #ecd6e6; border-radius:999px; padding:2px 8px; margin-top:14px;
  }

  /* Unlock screen */
  .unlock { width:100%; max-width:420px; text-align:center; }
  .unlock input { width:100%; font:inherit; padding:11px 12px; border-radius:12px; border:1px solid #e7cfe0; background:#fffafd; }
  .unlock button { margin-top:10px; width:100%; }
  .notcfg { max-width:520px; text-align:center; background:#2a1730; color:#ffd9ef; padding:18px; border-radius:14px; }
  .notcfg code { background:#3d2240; padding:2px 6px; border-radius:6px; }
</style>
</head>
<body>
  <div class="admin-flag">🔒 <span><b>Admin only.</b> Bertie keeps Amanda's notes — never customer content. Not visible to customers.</span></div>
  <h1>Bertie</h1>
  <p class="sub">Amanda's in-world capture companion. Spot a fix or an idea — tell Bertie, he passes it to Claude.</p>

  <div class="scene" aria-hidden="true">
    <div class="roberta"></div>
    <div class="cubby"></div>
    <div class="bertie" id="bertie">
      <div class="bubble" id="bubble"></div>
      <!-- Bertie: small pink robot, yellow cap, magenta antennae, blue belly-screen -->
      <svg viewBox="0 0 140 160" width="140" height="160" role="img" aria-label="Bertie the robot">
        <defs>
          <radialGradient id="bodyG" cx="38%" cy="30%" r="80%">
            <stop offset="0%" stop-color="#ffd0e8"/><stop offset="35%" stop-color="#ff8fc4"/>
            <stop offset="100%" stop-color="#d6418b"/>
          </radialGradient>
          <radialGradient id="headG" cx="38%" cy="28%" r="85%">
            <stop offset="0%" stop-color="#ffe0f0"/><stop offset="40%" stop-color="#ff8fc4"/>
            <stop offset="100%" stop-color="#d6418b"/>
          </radialGradient>
          <linearGradient id="capG" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#ffe27a"/><stop offset="100%" stop-color="#f5b400"/>
          </linearGradient>
          <radialGradient id="bellyG" cx="40%" cy="30%" r="80%">
            <stop offset="0%" stop-color="#bfecff"/><stop offset="45%" stop-color="#2bb8ff"/>
            <stop offset="100%" stop-color="#1577c4"/>
          </radialGradient>
          <radialGradient id="tipG" cx="50%" cy="40%" r="60%">
            <stop offset="0%" stop-color="#ffb3e6"/><stop offset="100%" stop-color="#e0259b"/>
          </radialGradient>
        </defs>

        <!-- antennae -->
        <path d="M52 40 C46 22 40 16 36 10" stroke="#e0259b" stroke-width="4" fill="none" stroke-linecap="round"/>
        <path d="M88 40 C94 22 100 16 104 10" stroke="#e0259b" stroke-width="4" fill="none" stroke-linecap="round"/>
        <circle cx="35" cy="9" r="7" fill="url(#tipG)"/>
        <circle cx="105" cy="9" r="7" fill="url(#tipG)"/>
        <circle cx="33" cy="6" r="2" fill="#fff" opacity=".8"/>
        <circle cx="103" cy="6" r="2" fill="#fff" opacity=".8"/>

        <!-- head -->
        <rect x="36" y="34" width="68" height="56" rx="22" fill="url(#headG)"/>
        <!-- yellow cap -->
        <path d="M34 50 Q70 16 106 50 Q92 40 70 40 Q48 40 34 50 Z" fill="url(#capG)"/>
        <rect x="58" y="20" width="24" height="10" rx="5" fill="#f5b400"/>
        <!-- eyes -->
        <circle cx="58" cy="62" r="9" fill="#2a1730"/><circle cx="86" cy="62" r="9" fill="#2a1730"/>
        <circle cx="61" cy="59" r="3" fill="#fff"/><circle cx="89" cy="59" r="3" fill="#fff"/>
        <!-- cheek smile -->
        <path d="M60 76 Q70 84 84 76" stroke="#a81f63" stroke-width="3" fill="none" stroke-linecap="round"/>

        <!-- body -->
        <rect x="30" y="88" width="80" height="62" rx="20" fill="url(#bodyG)"/>
        <!-- blue belly-screen -->
        <rect x="44" y="100" width="52" height="38" rx="10" fill="url(#bellyG)" stroke="#0f5e9c" stroke-width="2"/>
        <rect x="48" y="104" width="20" height="6" rx="3" fill="#eafaff" opacity=".7"/>
        <rect x="50" y="118" width="40" height="4" rx="2" fill="#eafaff" opacity=".55"/>
        <rect x="50" y="126" width="28" height="4" rx="2" fill="#eafaff" opacity=".45"/>
        <!-- specular gloss highlight (the 3D-render tell) -->
        <ellipse cx="50" cy="100" rx="14" ry="9" fill="#fff" opacity=".35"/>
        <!-- little arms -->
        <rect x="18" y="96" width="14" height="34" rx="7" fill="url(#bodyG)"/>
        <rect x="108" y="96" width="14" height="34" rx="7" fill="url(#bodyG)"/>
      </svg>
    </div>
    <div class="cubby-lip"></div>
  </div>

  <div id="app"></div>

<script>
(function () {
  var BOOT = ${boot};
  var app = document.getElementById('app');
  var bertie = document.getElementById('bertie');
  var bubble = document.getElementById('bubble');
  var KEY = BOOT.presetKey || '';

  function popBertie(text, isError) {
    bubble.textContent = text;
    bubble.classList.add('show');
    bertie.classList.add('out');
    bertie.classList.add('bob');
    setTimeout(function () { bertie.classList.remove('bob'); }, 1200);
    setTimeout(function () {
      bubble.classList.remove('show');
      bertie.classList.remove('out');
    }, isError ? 4200 : 3200);
  }

  function notConfigured() {
    app.innerHTML =
      '<div class="notcfg">Bertie isn\\'t switched on yet.<br><br>' +
      'Set <code>BERTIE_ADMIN_SECRET</code> on the proxy to enable him. ' +
      'Until then he is invisible and unusable — which is exactly why customers can never reach him.</div>';
  }

  function renderUnlock(msg) {
    app.innerHTML =
      '<div class="unlock"><p class="sub">Admin unlock</p>' +
      '<input id="key" type="password" placeholder="Paste admin secret" autocomplete="off" />' +
      '<button class="send" id="unlockBtn">Unlock Bertie</button>' +
      (msg ? '<p class="status err">' + msg + '</p>' : '') +
      '</div>';
    document.getElementById('unlockBtn').onclick = function () {
      KEY = document.getElementById('key').value.trim();
      if (!KEY) return;
      verifyAndRender();
    };
    document.getElementById('key').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') document.getElementById('unlockBtn').click();
    });
  }

  function verifyAndRender() {
    fetch('/api/bertie/info', { headers: { 'x-bertie-admin': KEY } })
      .then(function (r) {
        if (r.status === 401) { renderUnlock('That secret didn\\'t match. Try again.'); return null; }
        if (r.status === 503) { notConfigured(); return null; }
        return r.json();
      })
      .then(function (info) { if (info) renderConsole(info); })
      .catch(function () { renderUnlock('Could not reach the server. Try again.'); });
  }

  function renderConsole(info) {
    app.innerHTML =
      '<div class="panel">' +
        '<div class="row">' +
          '<textarea id="note" placeholder="Bertie, note: …  (e.g. the bothy door squeaks when you enter the cloud)"></textarea>' +
        '</div>' +
        '<div class="meta">' +
          '<input id="ctx" placeholder="Where were you? (room / zone — optional)" />' +
        '</div>' +
        '<div class="actions">' +
          '<button class="send" id="send">Pass it to Claude</button>' +
          '<button class="mic" id="mic" title="Voice capture">🎤 <span id="micLbl">Talk</span></button>' +
          '<span class="hint" id="hint"></span>' +
        '</div>' +
        '<div class="status" id="status"></div>' +
        '<span class="chip">relay → ' + info.channel + '  ·  sender: ' + info.sender + '</span>' +
      '</div>';

    var noteEl = document.getElementById('note');
    var ctxEl = document.getElementById('ctx');
    var sendBtn = document.getElementById('send');
    var statusEl = document.getElementById('status');
    var micBtn = document.getElementById('mic');
    var micLbl = document.getElementById('micLbl');
    var hint = document.getElementById('hint');

    var voiceMode = false; // set true while a voice capture is feeding the box

    function setStatus(msg, kind) {
      statusEl.textContent = msg || '';
      statusEl.className = 'status' + (kind ? ' ' + kind : '');
    }

    function send() {
      var note = noteEl.value.trim();
      if (!note) { setStatus('Type a note first.', 'err'); return; }
      sendBtn.disabled = true; setStatus('Bertie\\'s taking it…');
      fetch('/api/bertie/note', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bertie-admin': KEY },
        body: JSON.stringify({ note: note, context: ctxEl.value.trim() || undefined, mode: voiceMode ? 'voice' : 'type' })
      })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, j: j }; }); })
      .then(function (res) {
        sendBtn.disabled = false;
        if (res.status === 401) { renderUnlock('Session expired — unlock again.'); return; }
        if (res.j && res.j.ok) {
          popBertie(res.j.ack);
          setStatus(res.j.ack + (res.j.messageId ? '  (id ' + res.j.messageId + ')' : ''), 'ok');
          noteEl.value = ''; ctxEl.value = ''; voiceMode = false;
        } else {
          popBertie('Hmm — that didn\\'t go through. Your note is safe, try again.', true);
          setStatus((res.j && res.j.error) ? ('Relay failed: ' + res.j.error) : 'Relay failed.', 'err');
        }
      })
      .catch(function () { sendBtn.disabled = false; setStatus('Network hiccup — try again.', 'err'); });
    }
    sendBtn.onclick = send;
    noteEl.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send();
    });

    // ── Voice seam ────────────────────────────────────────────────────────
    // Both input modes: typing now; voice reuses the SAME push-to-talk seam
    // (browser SpeechRecognition today; swaps to Roberta's voice brain once it
    // goes live). Non-blocking: if the browser has no STT, the mic is disabled
    // and typing carries on untouched.
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      micBtn.disabled = true;
      micLbl.textContent = 'Voice soon';
      hint.textContent = 'Voice arrives with Roberta\\'s voice — type for now.';
    } else {
      var rec = new SR();
      rec.lang = 'en-GB'; rec.interimResults = true; rec.continuous = false;
      var listening = false;
      rec.onresult = function (ev) {
        var t = '';
        for (var i = 0; i < ev.results.length; i++) t += ev.results[i][0].transcript;
        noteEl.value = t; voiceMode = true;
      };
      rec.onend = function () { listening = false; micLbl.textContent = 'Talk'; micBtn.style.filter=''; };
      rec.onerror = function () { listening = false; micLbl.textContent = 'Talk'; setStatus('Didn\\'t catch that — try again or type.', 'err'); };
      micBtn.onclick = function () {
        if (listening) { rec.stop(); return; }
        try { rec.start(); listening = true; micLbl.textContent = 'Listening…'; micBtn.style.filter='brightness(1.05)'; setStatus('Listening — say your note.'); }
        catch (e) { /* already started */ }
      };
      hint.textContent = 'Tip: ⌘/Ctrl+Enter to send.';
    }

    noteEl.focus();
  }

  // ── Boot ────────────────────────────────────────────────────────────────
  if (!BOOT.configured) { notConfigured(); }
  else if (KEY) { verifyAndRender(); }
  else { renderUnlock(''); }
})();
</script>
</body>
</html>`;
}

// The event's link-preview card, drawn on a canvas.
//
// ONE COPY, TWO CALLERS, and that is the whole reason this is a file rather
// than a function inside admin.html. The back office draws a card when an
// operator saves an event; scripts/backfill-social-cards.mjs draws the same
// card for events that already existed. A second implementation would be a
// second thing to keep in step, and the first time somebody retuned the
// gradient the old events would quietly stop matching the new ones.
//
// Loaded as a plain script by both — no modules, no build step — so it defines
// globals and nothing imports anything. That is the same contract every other
// script on this site works under.

const OG_W = 1200, OG_H = 630;

function ogDateLine(ev){
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ev.date || ''));
  const d = m ? `${m[2]}-${m[3]}-${m[1].slice(2)}` : (ev.date || '');
  const t = ev.start ? ev.start + (ev.end ? ' – ' + ev.end : '') : '';
  return [d, t].filter(Boolean).join('  ·  ');
}

// Wrap on words, and hard-break a single word that is longer than the measure
// rather than letting it run off the card.
function ogWrap(ctx, text, maxW, maxLines){
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? line + ' ' + w : w;
    if (ctx.measureText(next).width <= maxW || !line) { line = next; continue; }
    lines.push(line); line = w;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}

// Load an image, or give up. Raced against a timer rather than trusting
// onerror alone: an <img> that neither loads nor errors leaves the promise
// pending forever, and this runs inside a save.
function ogImage(src, ms){
  return Promise.race([
    new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i); i.onerror = rej;
      i.src = src;
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('image timeout')), ms || 4000)),
  ]);
}

// The title, with the ampersand in brand red.
//
// The mark is MIX & GREET with a red ampersand — the same lockup the Wallet
// pass carries and the invite page sets. Drawn segment by segment because a
// canvas fillText is one colour: the parts are measured as they are drawn so
// the red & sits exactly where it would if the string were drawn in one go.
function drawTitle(x, text, left, baseline){
  const parts = String(text).split('&');
  let cx = left;
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) {
      x.fillStyle = '#EC1C24';
      x.fillText('&', cx, baseline);
      cx += x.measureText('&').width;
    }
    x.fillStyle = '#EDEAE3';
    x.fillText(parts[i], cx, baseline);
    cx += x.measureText(parts[i]).width;
  }
}

async function buildSocialCard(ev){
  const c = document.createElement('canvas');
  c.width = OG_W; c.height = OG_H;
  const x = c.getContext('2d');

  // 1. The header video's own still, cover-fitted. Falls through to flat black
  //    if it will not load, so a card is produced either way — a save must
  //    never fail because an image 404'd.
  x.fillStyle = '#0B0B0D';
  x.fillRect(0, 0, OG_W, OG_H);
  try {
    // Raced against a timer, not just onerror. An <img> that neither loads nor
    // errors — a hung connection, a CDN stalling on a cold edge — leaves the
    // promise pending forever, and this runs inside the save path: the button
    // stays disabled and the operator's event is never written. onerror only
    // covers the failures the browser is willing to admit to.
    const img = await ogImage('/hero-poster.jpg?v=og', 4000);
    const s = Math.max(OG_W / img.width, OG_H / img.height);
    const w = img.width * s, h = img.height * s;
    x.drawImage(img, (OG_W - w) / 2, (OG_H - h) / 2, w, h);
  } catch (_) {}

  // 2. The gradient. Two of them: a vertical one so the foot is solid enough
  //    for type, and a left-weighted one because every line below is set from
  //    the left edge and a busy frame under the first few words is what makes
  //    a card look like a screenshot rather than a design.
  //    Tuned by looking at the output, not by picking numbers: the first cut
  //    stacked 0.55->0.97 over 0.92->0.10 and the room underneath was gone —
  //    a photograph nobody can see is just an expensive black rectangle, and
  //    the whole point of using the header still is that the card looks like
  //    the party. These let the right two-thirds read while keeping the left
  //    column, where every line is set, dark enough for cream type.
  const v = x.createLinearGradient(0, 0, 0, OG_H);
  v.addColorStop(0, 'rgba(11,11,13,0.30)');
  v.addColorStop(0.5, 'rgba(11,11,13,0.46)');
  v.addColorStop(1, 'rgba(11,11,13,0.88)');
  x.fillStyle = v; x.fillRect(0, 0, OG_W, OG_H);

  const hgrad = x.createLinearGradient(0, 0, OG_W, 0);
  hgrad.addColorStop(0, 'rgba(11,11,13,0.86)');
  hgrad.addColorStop(0.42, 'rgba(11,11,13,0.34)');
  hgrad.addColorStop(1, 'rgba(11,11,13,0)');
  x.fillStyle = hgrad; x.fillRect(0, 0, OG_W, OG_H);

  // 3. Brand rule, then the type. Big Shoulders is already loaded by this page;
  //    await it explicitly or the first card of a session draws in the fallback.
  //    Also raced: document.fonts.ready is a promise the page controls, and a
  //    font that never resolves would stall the same save the image timeout
  //    above exists to protect. A card in the fallback face beats no event.
  try {
    await Promise.race([
      document.fonts.ready,
      new Promise((r) => setTimeout(r, 2500)),
    ]);
  } catch (_) {}

  const PAD = 72;
  x.fillStyle = '#EC1C24';
  x.fillRect(PAD, 96, 96, 8);

  // The academix wordmark itself, not the words typed out. It is a logo with a
  // red spindle over the i and its own letterforms; setting "ACADEMIX BEAT LAB"
  // in Plex Mono was a caption about the brand rather than the brand.
  //
  // Falls back to the typed line if the file will not load, because a card with
  // no identifying mark at all is worse than a card with a plain one.
  let headBottom = 172;
  try {
    const wm = await ogImage('/academix-logo.png?v=og', 3000);
    const h = 46;
    const w = wm.width * (h / wm.height);
    x.drawImage(wm, PAD, 126, w, h);
    headBottom = 126 + h;
  } catch (_) {
    x.fillStyle = 'rgba(237,234,227,.72)';
    x.font = '600 22px "Plex Mono", ui-monospace, monospace';
    x.letterSpacing = '6px';
    x.fillText('ACADEMIX BEAT LAB', PAD, 158);
    x.letterSpacing = '0px';
  }

  x.letterSpacing = '0px';
  x.fillStyle = '#EDEAE3';
  const titleSize = 96;
  x.font = `800 ${titleSize}px "Big Shoulders", Impact, sans-serif`;
  const lines = ogWrap(x, String(ev.title || 'Mix & Greet').toUpperCase(), OG_W - PAD * 2, 2);
  let y = Math.max(300, headBottom + titleSize + 18);
  for (const ln of lines) { drawTitle(x, ln, PAD, y); y += titleSize * 0.94; }

  if (ev.subtitle) {
    x.fillStyle = 'rgba(237,234,227,.86)';
    x.font = '800 40px "Big Shoulders", Impact, sans-serif';
    x.fillText(String(ev.subtitle).toUpperCase(), PAD, y + 8);
    y += 56;
  }

  x.fillStyle = '#EDEAE3';
  x.font = '700 34px "Plex Mono", ui-monospace, monospace';
  x.fillText(ogDateLine(ev), PAD, Math.max(y + 42, OG_H - 132));

  if (ev.location) {
    x.fillStyle = 'rgba(237,234,227,.68)';
    x.font = '400 24px "Plex Mono", ui-monospace, monospace';
    // Street only. The card is a public link preview and the suite number is
    // an invite-only detail — the same split the waitlist email makes.
    x.fillText(String(ev.location).split(',')[0].trim(), PAD, OG_H - 88);
  }

  x.fillStyle = 'rgba(237,234,227,.55)';
  x.font = '700 20px "Plex Mono", ui-monospace, monospace';
  x.letterSpacing = '4px';
  x.fillText('MIXANDGREET.COM', PAD, OG_H - 44);
  x.letterSpacing = '0px';

  // JPEG, not PNG. This is a photograph with type over it: the PNG came out at
  // 806 KB, the JPEG at a tenth of that with nothing visible lost. Preview bots
  // fetch this over whatever connection the reader is on, and every platform
  // takes JPEG.
  return await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.86));
}


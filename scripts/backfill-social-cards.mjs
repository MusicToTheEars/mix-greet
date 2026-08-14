#!/usr/bin/env node
/**
 * Draw and attach a link-preview card for every event that has not got one.
 *
 *   ADMIN_PASSWORD=... node scripts/backfill-social-cards.mjs
 *   ADMIN_PASSWORD=... node scripts/backfill-social-cards.mjs --force   # redraw all
 *   ADMIN_PASSWORD=... node scripts/backfill-social-cards.mjs --dry-run
 *
 * WHY THIS EXISTS. Cards are drawn by the back office when an operator saves an
 * event, so every event that existed before that shipped has none and still
 * previews with the site-wide image. Rather than asking somebody to open and
 * re-save four events by hand — and to remember to do it again after the next
 * design change — this draws them the same way, headlessly.
 *
 * THE SAME WAY IS LOAD-BEARING. It loads /social-card.js, the identical file
 * admin.html loads, into a real page on the real site. Not a port of it: a port
 * would look right today and drift the first time the gradient is retuned. The
 * page it loads is the live site, so the fonts and the header still are the
 * ones a visitor gets.
 *
 * It attaches through `action:"socialCard"`, which sets one field. The obvious
 * alternative — read an event back and re-run `update` with the id added —
 * re-normalises featured rows, re-resolves rsvpMode from a URL and re-clamps
 * every string, so a script whose only job is attaching an image could quietly
 * rewrite an event's RSVP behaviour.
 */

import { chromium } from "playwright";

const SITE = process.env.SITE_ORIGIN || "https://mixandgreet.com";
const API = process.env.CONVEX_SITE || "https://good-labrador-980.convex.site";
const PASSWORD = process.env.ADMIN_PASSWORD;
const FORCE = process.argv.includes("--force");
const DRY = process.argv.includes("--dry-run");

if (!PASSWORD) {
  console.error("ADMIN_PASSWORD is required.");
  console.error("  ADMIN_PASSWORD=$(npx convex env get ADMIN_PASSWORD) node scripts/backfill-social-cards.mjs");
  process.exit(2);
}

const post = async (path, body, headers = {}) => {
  const r = await fetch(API + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// --- 1. sign in -------------------------------------------------------------
const login = await post("/api/admin/login", { password: PASSWORD });
if (!login.body?.token) {
  console.error(`login failed (${login.status}):`, JSON.stringify(login.body));
  process.exit(1);
}
const TOKEN = login.body.token;
const admin = (body) => post("/api/events", body, { "x-admin-token": TOKEN });

// --- 2. what needs one ------------------------------------------------------
const lists = await admin({ action: "list" });
const all = [...(lists.body.published || []), ...(lists.body.archived || [])];
if (!all.length) {
  console.error("no events came back — is the admin token valid?");
  process.exit(1);
}
const todo = FORCE ? all : all.filter((e) => !e.socialCardUrl);

console.log(`${all.length} events, ${todo.length} to draw${FORCE ? " (--force)" : ""}`);
if (!todo.length) {
  console.log("nothing to do.");
  process.exit(0);
}

// --- 3. draw them on the real site -----------------------------------------
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
// Any page on the site: it just has to be same-origin so /social-card.js and
// /hero-poster.jpg load exactly as they do for the back office.
await page.goto(`${SITE}/rsvp`, { waitUntil: "networkidle" });
await page.addScriptTag({ url: "/social-card.js" });
await page.waitForFunction(() => typeof globalThis.buildSocialCard === "function", null, {
  timeout: 15_000,
});

let done = 0;
for (const ev of todo) {
  const label = `${ev.date}  ${ev.title}`;
  try {
    // The canvas is drawn in the page and handed back as base64, because a Blob
    // cannot cross the evaluate boundary.
    const b64 = await page.evaluate(async (e) => {
      const blob = await globalThis.buildSocialCard(e);
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = "";
      for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i]);
      return btoa(s);
    }, {
      title: ev.title,
      subtitle: ev.subtitle,
      date: ev.date,
      start: ev.start,
      end: ev.end,
      location: ev.location,
    });
    const bytes = Buffer.from(b64, "base64");

    if (DRY) {
      console.log(`  would draw  ${label}  (${Math.round(bytes.length / 1024)} KB)`);
      continue;
    }

    const { body: up } = await admin({ action: "uploadUrl" });
    if (!up?.uploadUrl) throw new Error("no upload url");
    const put = await fetch(up.uploadUrl, {
      method: "POST",
      headers: { "content-type": "image/jpeg" },
      body: bytes,
    });
    if (!put.ok) throw new Error(`upload rejected (${put.status})`);
    const { storageId } = await put.json();

    const attach = await admin({ action: "socialCard", id: ev.id, socialCardId: storageId });
    if (attach.body?.ok !== true) throw new Error(JSON.stringify(attach.body));

    done++;
    console.log(`  ok  ${label}  (${Math.round(bytes.length / 1024)} KB)`);
  } catch (err) {
    // One bad event must not cost the rest of the run.
    console.log(`  FAIL  ${label}  ${err?.message || err}`);
  }
}

await browser.close();
console.log(DRY ? "dry run, nothing written." : `attached ${done}/${todo.length}.`);

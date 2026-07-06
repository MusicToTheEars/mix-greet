import { getStore } from "@netlify/blobs";

const cors = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "content-type, x-admin-pass",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const clean = (v, max = 300) => String(v ?? "").trim().slice(0, max);

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: cors });

  const store = getStore("beatlab-events");

  if (req.method === "GET") {
    const events = (await store.get("events", { type: "json" })) || [];
    events.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    return Response.json(events, { headers: cors });
  }

  if (req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    const pass = req.headers.get("x-admin-pass") || body.password || "";
    const expected = Netlify.env.get("ADMIN_PASSWORD") || "BEAT1202!";
    if (pass !== expected) {
      return Response.json({ error: "unauthorized" }, { status: 401, headers: cors });
    }

    if (body.action === "verify") return Response.json({ ok: true }, { headers: cors });

    const events = (await store.get("events", { type: "json" })) || [];

    if (body.action === "delete") {
      const next = events.filter((e) => e.id !== body.id);
      await store.setJSON("events", next);
      return Response.json(next, { headers: cors });
    }

    if (body.action === "create") {
      const e = body.event || {};
      if (!clean(e.title, 120) || !/^\d{4}-\d{2}-\d{2}$/.test(clean(e.date, 10))) {
        return Response.json({ error: "title and date (YYYY-MM-DD) required" }, { status: 400, headers: cors });
      }
      events.push({
        id: crypto.randomUUID(),
        title: clean(e.title, 120),
        subtitle: clean(e.subtitle, 160),
        date: clean(e.date, 10),
        start: clean(e.start, 20),
        end: clean(e.end, 20),
        location: clean(e.location, 200),
        parking: clean(e.parking, 300),
        notes: clean(e.notes, 500),
        rsvp: /^https?:\/\//i.test(clean(e.rsvp, 400)) ? clean(e.rsvp, 400) : "",
        inviteOnly: !!e.inviteOnly,
        createdAt: new Date().toISOString(),
      });
      events.sort((a, b) => String(a.date).localeCompare(String(b.date)));
      await store.setJSON("events", events);
      return Response.json(events, { headers: cors });
    }

    return Response.json({ error: "unknown action" }, { status: 400, headers: cors });
  }

  return Response.json({ error: "method not allowed" }, { status: 405, headers: cors });
};

export const config = { path: "/api/events" };

/**
 * The nightly sales report, met at the door.
 *
 * Oriel emails its Product-wise export to sales-krishnanagar@ or
 * sales-kanchrapara@agamanibasantifashion.com. Cloudflare Email Routing
 * hands the message to this Worker, which pulls the attachment off it
 * and posts the text to the `oriel-inbound` edge function. Everything
 * after that — recognising the layout, mapping columns, replacing the
 * day — happens there.
 *
 * This Worker stays deliberately thin. It knows about MIME and nothing
 * about sales, so a change to the report's columns never touches it.
 *
 * Two behaviours worth knowing:
 *
 *  - It does NOT reject a message it cannot read. A bounce would go back
 *    to Oriel's mail server where nobody is looking. Instead every
 *    message is forwarded to the function, which records it as an
 *    arrival that could not be read — visible on the dashboard, which is
 *    where somebody actually looks.
 *
 *  - If there is no attachment it falls back to the message body, since
 *    some ERP mailers paste the report inline as text rather than
 *    attaching it.
 */

/** Read a stream to a string, capped so a huge attachment cannot exhaust memory. */
async function readAll(stream, limit = 8 * 1024 * 1024) {
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) break;
    chunks.push(value);
  }
  const buf = new Uint8Array(size > limit ? limit : size);
  let at = 0;
  for (const c of chunks) { buf.set(c, at); at += c.length; }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/** decode a quoted-printable body, which is how most mailers send CSV inline */
function fromQuotedPrintable(s) {
  return s
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

/**
 * Pull the most likely report out of a raw MIME message.
 *
 * Hand-rolled rather than pulled from a library: an Email Worker has a
 * small bundle budget, and the shape we need is narrow — the first part
 * that looks like a spreadsheet, or failing that the plain-text body.
 */
function extractAttachment(raw) {
  const boundaryMatch = raw.match(/boundary="?([^"\r\n;]+)"?/i);
  if (!boundaryMatch) {
    const split = raw.indexOf("\r\n\r\n");
    return { filename: null, text: split >= 0 ? raw.slice(split + 4) : raw };
  }

  const parts = raw.split(new RegExp(`--${boundaryMatch[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  let fallback = null;

  for (const part of parts) {
    const split = part.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const head = part.slice(0, split);
    let body = part.slice(split + 4).replace(/\r\n--\s*$/, "").trim();
    if (!body) continue;

    const enc = (head.match(/Content-Transfer-Encoding:\s*([^\r\n]+)/i) || [])[1]?.toLowerCase();
    if (enc === "base64") {
      try { body = atob(body.replace(/\s+/g, "")); } catch { continue; }
    } else if (enc === "quoted-printable") {
      body = fromQuotedPrintable(body);
    }

    const name = (head.match(/filename="?([^"\r\n;]+)"?/i) || [])[1] ?? null;
    const type = (head.match(/Content-Type:\s*([^;\r\n]+)/i) || [])[1]?.toLowerCase() ?? "";

    // a real attachment that looks like a spreadsheet wins outright
    if (name && /\.(csv|txt|tsv)$/i.test(name)) return { filename: name, text: body };
    if (/csv|excel|spreadsheet|octet-stream/.test(type) && name) {
      return { filename: name, text: body };
    }
    // otherwise remember the first plain-text part in case there is no
    // attachment at all and the report was pasted into the message
    if (!fallback && type.startsWith("text/plain")) {
      fallback = { filename: null, text: body };
    }
  }
  return fallback ?? { filename: null, text: "" };
}

export default {
  async email(message, env) {
    let filename = null;
    let text = "";
    let note = null;

    try {
      const raw = await readAll(message.raw);
      const got = extractAttachment(raw);
      filename = got.filename;
      text = got.text;
    } catch (e) {
      note = `could not read the message: ${e}`;
    }

    try {
      const res = await fetch(env.ORIEL_FUNCTION_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-oriel-secret": env.ORIEL_INBOUND_SECRET,
        },
        body: JSON.stringify({
          filename,
          from: message.from,
          to: message.to,
          subject: message.headers.get("subject") ?? null,
          text,
          note,
        }),
      });
      // A non-2xx here means the function itself is down. Nothing useful
      // can be done from inside an email handler, and rejecting would
      // bounce to a mailbox nobody reads, so let it through and let the
      // dashboard's "days brought in" list show the gap.
      if (!res.ok) console.log("oriel-inbound replied", res.status, await res.text());
    } catch (e) {
      console.log("oriel-inbound unreachable:", String(e));
    }
  },
};

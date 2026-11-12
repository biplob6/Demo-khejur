const encoder = new TextEncoder();

export const products = {
  ajwa: { name: "আজওয়া", weight: "৫০০ গ্রাম", price: 1250 },
  medjool: { name: "মেডজুল", weight: "৫০০ গ্রাম", price: 950 },
  mariyam: { name: "মারিয়াম", weight: "১ কেজি", price: 690 }
};

export const deliveryRates = { inside: 70, outside: 130 };
export const allowedStatuses = ["নতুন", "নিশ্চিত", "প্রস্তুত", "পাঠানো হয়েছে", "সম্পন্ন", "বাতিল"];

export function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin"
    }
  });
}

export function isSameOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

export function isJsonRequest(request) {
  return /^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") || "");
}

export async function readJson(request) {
  const contentLength = Number(request.headers.get("Content-Length") || 0);
  if (contentLength > 16384) {
    return { error: "ফর্মের তথ্য অনেক বড়।", status: 413 };
  }

  const text = await request.text();
  if (encoder.encode(text).byteLength > 16384) {
    return { error: "ফর্মের তথ্য অনেক বড়।", status: 413 };
  }

  try {
    return { payload: JSON.parse(text) };
  } catch {
    return { error: "ফর্মের তথ্য পড়া যায়নি। আবার চেষ্টা করুন।", status: 400 };
  }
}

function fixedTimeEquals(candidate, expected) {
  const candidateBytes = encoder.encode(candidate);
  const expectedBytes = encoder.encode(expected);
  let difference = candidateBytes.length ^ expectedBytes.length;
  const length = Math.max(candidateBytes.length, expectedBytes.length);

  for (let index = 0; index < length; index++) {
    difference |= (candidateBytes[index] || 0) ^ (expectedBytes[index] || 0);
  }

  return difference === 0;
}

export function isAdminAuthorized(request, env) {
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    return false;
  }

  const header = request.headers.get("Authorization") || "";
  if (!/^Basic\s+/i.test(header)) {
    return false;
  }

  try {
    const binary = atob(header.replace(/^Basic\s+/i, "").trim());
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const decoded = new TextDecoder().decode(bytes);
    const separator = decoded.indexOf(":");
    if (separator < 1) {
      return false;
    }

    return fixedTimeEquals(decoded.slice(0, separator), env.ADMIN_USERNAME) &&
      fixedTimeEquals(decoded.slice(separator + 1), env.ADMIN_PASSWORD);
  } catch {
    return false;
  }
}

export async function takeOrderRateLimit(request, env) {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) {
    return true;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(env.ADMIN_PASSWORD),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(ip));
  const clientKey = Array.from(new Uint8Array(signature), byte => byte.toString(16).padStart(2, "0")).join("");
  const now = Math.floor(Date.now() / 1000);

  await env.DB.batch([
    env.DB.prepare("DELETE FROM order_rate_limits WHERE window_start < ?").bind(now - 86400),
    env.DB.prepare(`
      INSERT INTO order_rate_limits (client_key, window_start, request_count)
      VALUES (?, ?, 1)
      ON CONFLICT(client_key) DO UPDATE SET
        request_count = CASE WHEN window_start <= ? THEN 1 ELSE request_count + 1 END,
        window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END
    `).bind(clientKey, now, now - 600, now - 600)
  ]);

  const row = await env.DB.prepare(
    "SELECT request_count FROM order_rate_limits WHERE client_key = ?"
  ).bind(clientKey).first();

  return row && row.request_count <= 20;
}

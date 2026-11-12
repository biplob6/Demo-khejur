import {
  allowedStatuses,
  isAdminAuthorized,
  isJsonRequest,
  isSameOrigin,
  jsonResponse,
  readJson
} from "../../../_shared.js";

export async function onRequestPatch({ request, env, params }) {
  if (!isSameOrigin(request)) {
    return jsonResponse({ error: "এই request গ্রহণ করা যায়নি।" }, 403);
  }
  if (!isAdminAuthorized(request, env)) {
    const status = env.ADMIN_USERNAME && env.ADMIN_PASSWORD ? 401 : 503;
    return jsonResponse({ error: status === 401 ? "অ্যাডমিন ইউজারনেম বা পাসওয়ার্ড সঠিক নয়।" : "অ্যাডমিন লগইন configure করা হয়নি।" }, status);
  }
  if (!env.DB) {
    return jsonResponse({ error: "অর্ডার ডেটাবেস configure করা হয়নি।" }, 503);
  }
  if (!/^[a-fA-F0-9]{32}$/.test(params.id || "")) {
    return jsonResponse({ error: "অর্ডারটি পাওয়া যায়নি।" }, 404);
  }
  if (!isJsonRequest(request)) {
    return jsonResponse({ error: "নতুন status JSON হিসেবে পাঠান।" }, 415);
  }

  const parsed = await readJson(request);
  if (parsed.error) {
    return jsonResponse({ error: "নতুন status পড়া যায়নি।" }, parsed.status);
  }
  const statusValue = parsed.payload && parsed.payload.status;
  if (!allowedStatuses.includes(statusValue)) {
    return jsonResponse({ error: "এই status গ্রহণযোগ্য নয়।" }, 400);
  }

  try {
    const updatedAt = new Date().toISOString();
    const result = await env.DB.prepare(
      "UPDATE orders SET status = ?, updated_at = ? WHERE id = ?"
    ).bind(statusValue, updatedAt, params.id).run();
    if (result.meta.changes === 0) {
      return jsonResponse({ error: "অর্ডারটি পাওয়া যায়নি।" }, 404);
    }
    return jsonResponse({ status: statusValue });
  } catch (error) {
    console.error("Could not update order status:", error);
    return jsonResponse({ error: "অর্ডারের status বদলানো যায়নি। আবার চেষ্টা করুন।" }, 500);
  }
}

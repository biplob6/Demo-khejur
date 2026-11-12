import { isAdminAuthorized, jsonResponse } from "../../_shared.js";

export async function onRequestGet({ request, env }) {
  if (!isAdminAuthorized(request, env)) {
    const status = env.ADMIN_USERNAME && env.ADMIN_PASSWORD ? 401 : 503;
    return jsonResponse({ error: status === 401 ? "অ্যাডমিন ইউজারনেম বা পাসওয়ার্ড সঠিক নয়।" : "অ্যাডমিন লগইন configure করা হয়নি।" }, status);
  }
  if (!env.DB) {
    return jsonResponse({ error: "অর্ডার ডেটাবেস configure করা হয়নি।" }, 503);
  }

  try {
    const result = await env.DB.prepare(`
      SELECT id, created_at AS createdAt, name, phone, district, address, product,
        product_name AS productName, weight, quantity, addon, delivery,
        delivery_charge AS deliveryCharge, total, status, updated_at AS updatedAt
      FROM orders
      ORDER BY created_at DESC
      LIMIT 200
    `).all();
    return jsonResponse({ orders: result.results });
  } catch (error) {
    console.error("Could not load orders:", error);
    return jsonResponse({ error: "অর্ডারগুলো লোড করা যায়নি। আবার চেষ্টা করুন।" }, 500);
  }
}

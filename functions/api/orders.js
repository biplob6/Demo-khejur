import {
  deliveryRates,
  isJsonRequest,
  isSameOrigin,
  jsonResponse,
  products,
  readJson,
  takeOrderRateLimit
} from "../_shared.js";

export async function onRequestPost({ request, env }) {
  if (!isSameOrigin(request)) {
    return jsonResponse({ error: "এই request গ্রহণ করা যায়নি।" }, 403);
  }
  if (!isJsonRequest(request)) {
    return jsonResponse({ error: "অর্ডারের তথ্য JSON হিসেবে পাঠান।" }, 415);
  }
  if (!env.DB || !env.ADMIN_PASSWORD) {
    return jsonResponse({ error: "অর্ডার সার্ভার এখনো configure করা হয়নি।" }, 503);
  }

  try {
    if (!await takeOrderRateLimit(request, env)) {
      return jsonResponse({ error: "অনেকবার চেষ্টা হয়েছে। কিছুক্ষণ পরে আবার চেষ্টা করুন।" }, 429);
    }

    const parsed = await readJson(request);
    if (parsed.error) {
      return jsonResponse({ error: parsed.error }, parsed.status);
    }

    const payload = parsed.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return jsonResponse({ error: "নাম, ফোন, ঠিকানা, পণ্য ও পরিমাণ ঠিক করে আবার দিন।" }, 400);
    }

    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    const phone = typeof payload.phone === "string" ? payload.phone.trim() : "";
    const district = typeof payload.district === "string" ? payload.district.trim() : "";
    const address = typeof payload.address === "string" ? payload.address.trim() : "";
    const normalizedPhone = phone.replace(/[০-৯]/g, digit => String("০১২৩৪৫৬৭৮৯".indexOf(digit)));
    const phoneDigits = normalizedPhone.replace(/[\s+().-]/g, "");
    const quantity = Number(payload.quantity);
    const productKey = typeof payload.product === "string" ? payload.product : "";
    const delivery = typeof payload.delivery === "string" ? payload.delivery : "";
    const addonValid = payload.addon === undefined || payload.addon === null || typeof payload.addon === "boolean";

    if (!name || name.length > 100 ||
        !/^[0-9]{7,16}$/.test(phoneDigits) ||
        !district || district.length > 100 ||
        !address || address.length > 500 ||
        !Number.isInteger(quantity) || quantity < 1 || quantity > 5 ||
        !Object.hasOwn(products, productKey) ||
        !Object.hasOwn(deliveryRates, delivery) ||
        !addonValid) {
      return jsonResponse({ error: "নাম, ফোন, ঠিকানা, পণ্য ও পরিমাণ ঠিক করে আবার দিন।" }, 400);
    }

    const product = products[productKey];
    const addon = payload.addon === true;
    const deliveryCharge = deliveryRates[delivery];
    const total = product.price * quantity + deliveryCharge + (addon ? 190 : 0);
    const id = crypto.randomUUID().replace(/-/g, "");
    const createdAt = new Date().toISOString();

    await env.DB.prepare(`
      INSERT INTO orders (
        id, created_at, name, phone, district, address, product, product_name,
        weight, quantity, addon, delivery, delivery_charge, total, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
    `).bind(
      id, createdAt, name, phone, district, address, productKey, product.name,
      product.weight, quantity, addon ? 1 : 0, delivery, deliveryCharge, total, "নতুন"
    ).run();

    return jsonResponse({ id, total }, 201);
  } catch (error) {
    console.error("Could not save an order:", error);
    return jsonResponse({ error: "অর্ডারটি সংরক্ষণ করা যায়নি। অনুগ্রহ করে আবার চেষ্টা করুন।" }, 500);
  }
}

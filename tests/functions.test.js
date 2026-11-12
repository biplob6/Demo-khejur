import assert from "node:assert/strict";
import test from "node:test";
import { onRequestPost } from "../functions/api/orders.js";
import { onRequestGet } from "../functions/api/admin/orders.js";
import { onRequestPatch } from "../functions/api/admin/orders/[id].js";
import { takeOrderRateLimit } from "../functions/_shared.js";

function createDatabase({ orders = [], changes = 1 } = {}) {
  const statements = [];
  return {
    statements,
    prepare(query) {
      return {
        bind(...values) {
          return {
            run: async () => {
              statements.push({ query, values });
              return { meta: { changes } };
            },
            all: async () => ({ results: orders }),
            first: async () => null
          };
        },
        all: async () => ({ results: orders })
      };
    },
    batch: async () => []
  };
}

function createOrderRequest(payload, headers = {}) {
  return new Request("https://khejur-ghor.pages.dev/api/orders", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://khejur-ghor.pages.dev",
      ...headers
    },
    body: JSON.stringify(payload)
  });
}

const validOrder = {
  name: "Test buyer",
  phone: "০১৭০০০০০০০০",
  district: "ঢাকা",
  address: "Test road",
  product: "ajwa",
  quantity: 1,
  delivery: "inside",
  addon: false
};

test("order endpoint calculates the total from server prices", async () => {
  const DB = createDatabase();
  const response = await onRequestPost({
    request: createOrderRequest({ ...validOrder, price: 1, total: 1 }),
    env: { DB, ADMIN_PASSWORD: "test-password" }
  });

  assert.equal(response.status, 201);
  assert.equal((await response.json()).total, 1320);
  assert.equal(DB.statements[0].values[13], 1320);
  assert.equal(DB.statements[0].values[3], validOrder.phone);
});

test("order endpoint rejects unknown products without saving", async () => {
  const DB = createDatabase();
  const response = await onRequestPost({
    request: createOrderRequest({ ...validOrder, product: "unknown" }),
    env: { DB, ADMIN_PASSWORD: "test-password" }
  });

  assert.equal(response.status, 400);
  assert.equal(DB.statements.length, 0);
});

test("order endpoint rejects cross-origin submissions", async () => {
  const response = await onRequestPost({
    request: createOrderRequest(validOrder, { Origin: "https://attacker.example" }),
    env: { DB: createDatabase(), ADMIN_PASSWORD: "test-password" }
  });

  assert.equal(response.status, 403);
});

test("admin orders require credentials", async () => {
  const response = await onRequestGet({
    request: new Request("https://khejur-ghor.pages.dev/api/admin/orders"),
    env: { DB: createDatabase(), ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "correct-password" }
  });

  assert.equal(response.status, 401);
});

test("admin can list and update orders with valid credentials", async () => {
  const DB = createDatabase({ orders: [{ id: "a".repeat(32), name: "Test buyer" }] });
  const authorization = `Basic ${Buffer.from("admin:correct-password").toString("base64")}`;
  const list = await onRequestGet({
    request: new Request("https://khejur-ghor.pages.dev/api/admin/orders", {
      headers: { Authorization: authorization }
    }),
    env: { DB, ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "correct-password" }
  });

  assert.equal(list.status, 200);
  assert.equal((await list.json()).orders.length, 1);

  const update = await onRequestPatch({
    request: new Request("https://khejur-ghor.pages.dev/api/admin/orders/" + "a".repeat(32), {
      method: "PATCH",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
        Origin: "https://khejur-ghor.pages.dev"
      },
      body: JSON.stringify({ status: "নিশ্চিত" })
    }),
    params: { id: "a".repeat(32) },
    env: { DB, ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "correct-password" }
  });

  assert.equal(update.status, 200);
  assert.deepEqual(await update.json(), { status: "নিশ্চিত" });
});

test("order submissions are limited to 20 per IP in a 10-minute window", async () => {
  let windowStart = 0;
  let requestCount = 0;
  const DB = {
    prepare(query) {
      return {
        bind(...values) {
          return {
            query,
            values,
            first: async () => ({ request_count: requestCount })
          };
        }
      };
    },
    batch: async statements => {
      const upsert = statements.find(statement => statement.query.includes("INSERT INTO order_rate_limits"));
      const [, now, windowThreshold] = upsert.values;
      if (windowStart <= windowThreshold) {
        windowStart = now;
        requestCount = 1;
      } else {
        requestCount++;
      }
    }
  };
  const request = new Request("https://khejur-ghor.pages.dev/api/orders", {
    headers: { "CF-Connecting-IP": "203.0.113.8" }
  });
  const env = { DB, ADMIN_PASSWORD: "test-password" };

  for (let attempt = 0; attempt < 20; attempt++) {
    assert.equal(await takeOrderRateLimit(request, env), true);
  }
  assert.equal(await takeOrderRateLimit(request, env), false);
});

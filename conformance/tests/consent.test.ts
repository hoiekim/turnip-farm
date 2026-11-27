import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { consented, nextAddress, randomSub, sourceKey, videoId } from "../harness/apple";
import { seedConsent, seedSession } from "../harness/seed/contrib";
import { startStack, type Stack } from "../harness/stack";

const BLOCKED = [
  "AUT", "BEL", "BGR", "HRV", "CYP", "CZE", "DNK", "EST", "FIN", "FRA", "DEU", "GRC", "HUN", "IRL",
  "ITA", "LVA", "LTU", "LUX", "MLT", "NLD", "POL", "PRT", "ROU", "SVK", "SVN", "ESP", "SWE",
  "ISL", "LIE", "NOR", "GBR",
];

describe("consent", () => {
  let stack: Stack;
  beforeAll(async () => {
    stack = await startStack();
  });
  afterAll(() => stack?.stop());

  test("401 anonymous", async () => {
    const result = await stack.anonymous().post("/consent", {
      disclosure_version: 3,
      age_confirmed: true,
      storefront_country: "USA",
    });
    expect(result.status).toBe(401);
    expect(result.json).toEqual({
      error: { code: "UNAUTHENTICATED", message: "Missing session token", details: {} },
    });
    expect(result.headers.get("www-authenticate")).toBe("Bearer");
  });

  test("region gates run before auth: a missing storefront is 403 even with no session", async () => {
    const sessionsBefore = await stack.db.one<{ n: string }>(`SELECT count(*)::int AS n FROM sessions`);
    for (const body of [{}, { storefront_country: null }, { disclosure_version: 3, age_confirmed: true }]) {
      const result = await stack.anonymous().post("/consent", body);
      expect(result.status).toBe(403);
      expect(result.json).toEqual({
        error: {
          code: "REGION_UNAVAILABLE",
          message: "Contribution is not available in this region",
          details: { reason: "storefront_missing" },
        },
      });
    }
    const sessionsAfter = await stack.db.one<{ n: string }>(`SELECT count(*)::int AS n FROM sessions`);
    expect(sessionsAfter?.n).toBe(sessionsBefore?.n);
  });

  test("every blocked storefront code (all 31, plus lowercase) is 403 storefront_blocked", async () => {
    for (const code of [...BLOCKED, "deu"]) {
      const result = await stack.anonymous().post("/consent", {
        disclosure_version: 3,
        age_confirmed: true,
        storefront_country: code,
      });
      expect(result.status).toBe(403);
      expect(result.json).toEqual({
        error: {
          code: "REGION_UNAVAILABLE",
          message: "Contribution is not available in this region",
          details: { reason: "storefront_blocked" },
        },
      });
    }
  });

  test("disclosure_version validation: 0, negative, non-integer, and over 2^31-1 are 422", async () => {
    const { client } = await seedSession(stack, randomSub());
    for (const version of [0, -1, 1.5, "3", null, 2147483648]) {
      const result = await client.post("/consent", {
        disclosure_version: version,
        age_confirmed: true,
        storefront_country: "USA",
      });
      expect(result.status).toBe(422);
      expect(result.json).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message: "disclosure_version must be a positive integer",
          details: { field: "disclosure_version" },
        },
      });
    }
  });

  test("age_confirmed must be true: false, missing, and non-boolean are 422", async () => {
    const { client } = await seedSession(stack, randomSub());
    for (const age of [false, undefined, "yes", 1]) {
      const result = await client.post("/consent", {
        disclosure_version: 3,
        age_confirmed: age,
        storefront_country: "USA",
      });
      expect(result.status).toBe(422);
      expect(result.json).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message: "age_confirmed must be true",
          details: { field: "age_confirmed" },
        },
      });
    }
  });

  test("a malformed storefront is 422 with details.field, checked after version and age", async () => {
    const { client } = await seedSession(stack, randomSub());
    for (const storefront of ["US", "USAA", "12A", 42, ""]) {
      const result = await client.post("/consent", {
        disclosure_version: 3,
        age_confirmed: true,
        storefront_country: storefront,
      });
      expect(result.status).toBe(422);
      expect(result.json).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message: "storefront_country must be an ISO 3166-1 alpha-3 code",
          details: { field: "storefront_country" },
        },
      });
    }
    // Version errors come before the storefront-shape error, and so do age errors.
    const versionFirst = await client.post("/consent", {
      disclosure_version: 0,
      age_confirmed: true,
      storefront_country: "US",
    });
    expect(versionFirst.json).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "disclosure_version must be a positive integer",
        details: { field: "disclosure_version" },
      },
    });
    const ageFirst = await client.post("/consent", {
      disclosure_version: 3,
      age_confirmed: false,
      storefront_country: "US",
    });
    expect(ageFirst.json).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "age_confirmed must be true",
        details: { field: "age_confirmed" },
      },
    });
  });

  test("success is 204 with a consents row; re-consent to the same version is a no-op", async () => {
    const { client, userId } = await seedSession(stack, randomSub());
    const result = await client.post("/consent", {
      disclosure_version: 3,
      age_confirmed: true,
      storefront_country: "USA",
    });
    expect(result.status).toBe(204);
    expect(result.text).toBe("");
    let rows = await stack.db.query(`SELECT * FROM consents WHERE user_id = $1`, [userId]);
    expect(rows).toHaveLength(1);
    const again = await client.post("/consent", {
      disclosure_version: 3,
      age_confirmed: true,
      storefront_country: "USA",
    });
    expect(again.status).toBe(204);
    rows = await stack.db.query(`SELECT * FROM consents WHERE user_id = $1`, [userId]);
    expect(rows).toHaveLength(1);
  });

  test("consent to a newer version satisfies an older required version", async () => {
    const { client, userId } = await seedSession(stack, randomSub());
    await consented(client, { disclosureVersion: 4 });
    const rows = await stack.db.query(`SELECT disclosure_version FROM consents WHERE user_id = $1`, [userId]);
    expect(rows).toHaveLength(1);
    // Contributing works: the v4 consent satisfies the default v3 requirement.
    const sourceId = await videoId(`consent-newer-${userId}`);
    const result = await client.post("/sources", {
      video_id: sourceId,
      source_key: sourceKey(),
      frame_count: 100,
      sample_rate: 10,
      keypoint_format: "tkp1",
      storefront_country: "USA",
    });
    expect(result.status).toBe(201);
  });

  describe("CURRENT_DISCLOSURE_VERSION=4 stack", () => {
    test("a v3 consent is not enough; consenting to v4 unblocks", async () => {
      const v4 = await startStack({ env: { CURRENT_DISCLOSURE_VERSION: "4" } });
      try {
        const { client, userId } = await seedSession(v4, randomSub());
        await seedConsent(v4, userId, 3);
        const sourceId = await videoId(`consent-v4-${userId}`);
        const blocked = await client.post("/sources", {
          video_id: sourceId,
          source_key: sourceKey(),
          frame_count: 100,
          sample_rate: 10,
          keypoint_format: "tkp1",
          storefront_country: "USA",
        });
        expect(blocked.status).toBe(403);
        expect(blocked.json).toEqual({
          error: {
            code: "CONSENT_REQUIRED",
            message: "Agree to the current contribution disclosure first",
            details: { disclosure_version: 4 },
          },
        });
        await consented(client, { disclosureVersion: 4 });
        const ok = await client.post("/sources", {
          video_id: sourceId,
          source_key: sourceKey(),
          frame_count: 100,
          sample_rate: 10,
          keypoint_format: "tkp1",
          storefront_country: "USA",
        });
        expect(ok.status).toBe(201);
      } finally {
        await v4.stop();
      }
    });
  });
});

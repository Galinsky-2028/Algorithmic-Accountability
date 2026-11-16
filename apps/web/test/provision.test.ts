import assert from "node:assert/strict";
import test from "node:test";

import { DEMO_TENANT_FIXTURES, provisionDemoTenant, provisionDemoTenantOnStart } from "../lib/provision";

function fakeClient() {
  const resources: Array<{ id: string; resourceType: string; externalRef: string | null; attributes: Record<string, unknown>; name: string }> = [];
  let n = 0;
  return {
    resources,
    async listResources() { return resources as never; },
    async getResource(id: string) { const r = resources.find((x) => x.id === id); if (!r) throw new Error("missing"); return r as never; },
    async createResource(input: { resourceType: string; externalRef?: string | null; attributes?: Record<string, unknown>; name: string }) {
      const r = { id: "res-" + ++n, resourceType: input.resourceType, externalRef: input.externalRef ?? null,
        attributes: input.attributes ?? {}, name: input.name };
      resources.push(r);
      return r as never;
    },
  };
}

test("provisioning creates fictional inventory once and is idempotent", async () => {
  const client = fakeClient();
  const first = await provisionDemoTenant(client as never);
  assert.deepEqual(first, { created: DEMO_TENANT_FIXTURES.length * 3, existing: 0 });
  assert.ok(client.resources.every((r) => r.externalRef?.startsWith("aa-demo-tenant:")));
  assert.ok(client.resources.filter((r) => r.resourceType === "algorithmic-system").every((r) => /Fictional/.test(r.name)));
  const second = await provisionDemoTenant(client as never);
  assert.deepEqual(second, { created: 0, existing: DEMO_TENANT_FIXTURES.length * 3 });
});

test("provisioning resumes after a partial failure without duplicates", async () => {
  const client = fakeClient();
  const create = client.createResource.bind(client);
  let calls = 0;
  client.createResource = async (input) => { if (++calls === 4) throw new Error("synthetic outage"); return create(input); };
  await assert.rejects(provisionDemoTenant(client as never));
  client.createResource = create;
  await provisionDemoTenant(client as never);
  const refs = client.resources.map((r) => r.externalRef);
  assert.equal(new Set(refs).size, refs.length);
  assert.equal(refs.length, DEMO_TENANT_FIXTURES.length * 3);
});

test("startup hook is opt-in, refuses demo mode and retries then gives up quietly", async () => {
  let built = 0;
  const factory = () => { built++; throw new Error("engine asleep"); };
  const configured = { CAIAE_ORGANIZATION_ID: "8f0e2c1a-1b2c-4d3e-8f90-123456789abc", CAIAE_OPERATOR_TOKEN: "tok", CAIAE_API_BASE_URL: "https://engine.example.test" };
  await provisionDemoTenantOnStart({ ...configured }, { attempts: 2, delayMs: 1, clientFactory: factory as never });
  assert.equal(built, 0, "not opted in");
  await provisionDemoTenantOnStart({ ...configured, AA_PROVISION_DEMO_TENANT: "true", AA_DEMO_MODE: "true" }, { attempts: 2, delayMs: 1, clientFactory: factory as never });
  assert.equal(built, 0, "never in demo mode");
  await provisionDemoTenantOnStart({ AA_PROVISION_DEMO_TENANT: "true" }, { attempts: 2, delayMs: 1, clientFactory: factory as never });
  assert.equal(built, 0, "never without operator config");
  await provisionDemoTenantOnStart({ ...configured, CAIAE_ORGANIZATION_ID: "not-a-uuid", AA_PROVISION_DEMO_TENANT: "true" }, { attempts: 2, delayMs: 1, clientFactory: factory as never });
  assert.equal(built, 0, "invalid config never throws");
  await provisionDemoTenantOnStart({ ...configured, AA_PROVISION_DEMO_TENANT: "true" }, { attempts: 3, delayMs: 1, clientFactory: factory as never });
  assert.equal(built, 3);
});

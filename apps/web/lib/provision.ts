import {
  createAlgorithmicSystem,
  createDeploymentContext,
  createModelVersion,
  type AlgorithmicSystemInventoryInput,
  type DeploymentContextInventoryInput,
  type InventoryClient,
  type ModelVersionInventoryInput,
} from "@algorithmic-accountability/inventory";

import { isAlgorithmicAccountabilityDemoMode } from "./demo-mode";
import { createOperatorEngineClient, readOperatorReadiness, type OperatorEnvironment } from "./operator";

/**
 * Opt-in provisioning of a FICTIONAL demonstration tenant in real-data mode.
 * It runs only when AA_PROVISION_DEMO_TENANT=true, demo mode is off and the
 * operator client is configured. It creates fictional inventory through the
 * documented inventory package (and therefore through @caiae/sdk only).
 * Idempotent: each record has a stable externalRef and is skipped when present.
 */
export type ProvisionEnvironment = OperatorEnvironment & {
  AA_PROVISION_DEMO_TENANT?: string;
};

type Fixture = {
  system: Omit<AlgorithmicSystemInventoryInput, "externalRef">;
  version: Omit<ModelVersionInventoryInput, "externalRef" | "algorithmicSystemResourceId">;
  deployment: Omit<DeploymentContextInventoryInput, "externalRef" | "algorithmicSystemResourceId" | "modelVersionResourceId">;
  key: string;
};

const FICTIONAL = "Fictional demonstration record. Synthetic data only; not a real system, agency or person.";

export const DEMO_TENANT_FIXTURES: readonly Fixture[] = [
  {
    key: "benefits-triage",
    system: { name: "Fictional Benefits Triage Model", description: FICTIONAL, systemKind: "classification",
      primaryFunction: "Prioritize synthetic benefit applications for human review", ownerUnit: "Fictional Benefits Office",
      providerType: "internal", lifecycleState: "active", provenanceSummary: "Synthetic training data generated for the demo." },
    version: { name: "Benefits Triage v2.1 (fictional)", versionLabel: "2.1.0", lifecycleState: "active",
      changeSummary: "Fictional recalibration release.", releasedAt: "2026-09-01T00:00:00.000Z" },
    deployment: { name: "Benefits Triage: synthetic intake queue", purpose: "Order synthetic applications for reviewer attention",
      decisionProcess: "Human caseworker makes every decision", decisionDomain: "public-benefits",
      affectedPopulationDescription: "Synthetic applicants only", operatorUnit: "Fictional Benefits Office",
      geographicScope: "Fictional jurisdiction", humanRole: "decision-maker", decisionEffect: "ranking",
      inputDataCategories: ["synthetic application fields"], outputDescription: "Priority score for review ordering",
      appealOrReviewAvailable: true },
  },
  {
    key: "permit-screening",
    system: { name: "Fictional Permit Screening Rules", description: FICTIONAL, systemKind: "rules-engine",
      primaryFunction: "Flag incomplete synthetic permit filings", ownerUnit: "Fictional Permits Desk",
      providerType: "vendor", providerName: "Fictional Vendor Co.", lifecycleState: "validation" },
    version: { name: "Permit Screening 1.0 (fictional)", versionLabel: "1.0.0", lifecycleState: "validation",
      changeSummary: "Initial fictional rule set." },
    deployment: { name: "Permit Screening: completeness check", purpose: "Identify missing documents in synthetic permit filings",
      decisionProcess: "Flags are advisory; staff confirm", decisionDomain: "licensing-permits",
      affectedPopulationDescription: "Synthetic permit applicants", operatorUnit: "Fictional Permits Desk",
      geographicScope: "Fictional jurisdiction", humanRole: "reviewer", decisionEffect: "screening",
      inputDataCategories: ["synthetic permit metadata"], outputDescription: "Completeness flags",
      appealOrReviewAvailable: true },
  },
  {
    key: "fraud-alert-routing",
    system: { name: "Fictional Fraud Alert Router", description: FICTIONAL, systemKind: "scoring",
      primaryFunction: "Route synthetic payment anomalies to investigators", ownerUnit: "Fictional Program Integrity Unit",
      providerType: "mixed", lifecycleState: "paused" },
    version: { name: "Fraud Alert Router 3.0 (fictional)", versionLabel: "3.0.0", lifecycleState: "paused",
      changeSummary: "Fictional threshold change pending reassessment." },
    deployment: { name: "Fraud Alert Routing: synthetic payments", purpose: "Route synthetic anomaly alerts for investigation",
      decisionProcess: "Investigator decides; alerts never suspend payments automatically", decisionDomain: "program-integrity",
      affectedPopulationDescription: "Synthetic payees", operatorUnit: "Fictional Program Integrity Unit",
      geographicScope: "Fictional jurisdiction", humanRole: "override-capable", decisionEffect: "recommendation",
      inputDataCategories: ["synthetic payment records"], outputDescription: "Alert routing recommendation",
      appealOrReviewAvailable: true },
  },
];

const ref = (key: string, kind: string) => `aa-demo-tenant:${key}:${kind}`;

export async function provisionDemoTenant(client: InventoryClient): Promise<{ created: number; existing: number }> {
  const existing = new Map<string, string>();
  for (const resource of await client.listResources({})) {
    if (resource.externalRef) existing.set(resource.externalRef, resource.id);
  }
  let created = 0;
  let found = 0;
  async function ensure(externalRef: string, create: () => Promise<{ id: string }>): Promise<string> {
    const id = existing.get(externalRef);
    if (id) { found++; return id; }
    const resource = await create();
    existing.set(externalRef, resource.id);
    created++;
    return resource.id;
  }
  for (const f of DEMO_TENANT_FIXTURES) {
    const systemId = await ensure(ref(f.key, "system"), () =>
      createAlgorithmicSystem(client, { ...f.system, externalRef: ref(f.key, "system") }));
    const versionId = await ensure(ref(f.key, "version"), () =>
      createModelVersion(client, { ...f.version, externalRef: ref(f.key, "version"), algorithmicSystemResourceId: systemId }));
    await ensure(ref(f.key, "deployment"), () =>
      createDeploymentContext(client, { ...f.deployment, externalRef: ref(f.key, "deployment"),
        algorithmicSystemResourceId: systemId, modelVersionResourceId: versionId }));
  }
  return { created, existing: found };
}

const log = (event: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));

/** Startup entry point: retries while the (free-plan) engine wakes up. Never throws. */
export async function provisionDemoTenantOnStart(
  env: ProvisionEnvironment = process.env as ProvisionEnvironment,
  { attempts = 12, delayMs = 15_000, clientFactory = createOperatorEngineClient } = {},
): Promise<void> {
  if (env.AA_PROVISION_DEMO_TENANT?.trim().toLowerCase() !== "true") return;
  if (isAlgorithmicAccountabilityDemoMode(env)) { log("aa.demo_tenant.skipped", { reason: "demo_mode" }); return; }
  let configured = false;
  try { configured = readOperatorReadiness(env).configured; } catch { configured = false; }
  if (!configured) { log("aa.demo_tenant.skipped", { reason: "operator_unconfigured" }); return; }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await provisionDemoTenant(clientFactory(env));
      log("aa.demo_tenant.provisioned", { ...result, attempt });
      return;
    } catch (error) {
      log("aa.demo_tenant.retry", { attempt, error: error instanceof Error ? error.name + ": " + error.message.slice(0, 160) : "unknown" });
      if (attempt < attempts) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  log("aa.demo_tenant.failed", { attempts });
}

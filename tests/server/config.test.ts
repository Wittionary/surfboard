import { describe, expect, test } from "bun:test";
import { loadConfig, publicConfig } from "../../src/server/config.ts";

const fullEnv = {
  ADO_ORG: "goalliant",
  ADO_PROJECT: "Alliant",
  ADO_PAT: "secret-pat-value-1234567890",
  ADO_API_VERSION: "7.1",
  ADO_WORKSPACE_DIR: "/tmp/surfboard-test-workspace",
  ADO_TEMPLATE_DIR: "/tmp/surfboard-test-workspace/templates",
};

describe("loadConfig", () => {
  test("loads all required values when present", () => {
    const config = loadConfig({ env: { ...fullEnv } });

    expect(config.workspaceDir).toBe("/tmp/surfboard-test-workspace");
    expect(config.templateDir).toBe("/tmp/surfboard-test-workspace/templates");
    expect(config.ado).not.toBeNull();
    expect(config.ado?.org).toBe("goalliant");
    expect(config.ado?.project).toBe("Alliant");
    expect(config.ado?.apiVersion).toBe("7.1");
    expect(config.ado?.pat).toBe("secret-pat-value-1234567890");
    expect(config.issues).toEqual([]);
  });

  test("defaults ADO_API_VERSION to 7.1 when absent", () => {
    const env = { ...fullEnv };
    delete (env as Record<string, string | undefined>).ADO_API_VERSION;
    const config = loadConfig({ env });
    expect(config.ado?.apiVersion).toBe("7.1");
  });

  test("returns ado=null and structured issues when ADO env missing", () => {
    const config = loadConfig({
      env: {
        ADO_WORKSPACE_DIR: "/tmp/ws",
        ADO_TEMPLATE_DIR: "/tmp/ws/templates",
      },
    });

    expect(config.ado).toBeNull();
    expect(config.issues).toContain("ado_org_missing");
    expect(config.issues).toContain("ado_project_missing");
    expect(config.issues).toContain("ado_pat_missing");
    expect(config.issues).not.toContain("workspace_dir_missing");
  });

  test("flags missing workspace and template dirs", () => {
    const config = loadConfig({ env: {} });
    expect(config.issues).toContain("workspace_dir_missing");
    expect(config.issues).toContain("template_dir_missing");
  });

  test("ADO_WEBHOOK_SECRET is optional and defaults to null", () => {
    const config = loadConfig({ env: { ...fullEnv } });
    expect(config.webhookSecret).toBeNull();
  });

  test("ADO_WEBHOOK_SECRET is captured when present", () => {
    const config = loadConfig({
      env: { ...fullEnv, ADO_WEBHOOK_SECRET: "shh" },
    });
    expect(config.webhookSecret).toBe("shh");
  });

  test("treats whitespace-only values as missing", () => {
    const config = loadConfig({
      env: { ...fullEnv, ADO_PAT: "   " },
    });
    expect(config.ado).toBeNull();
    expect(config.issues).toContain("ado_pat_missing");
  });
});

describe("publicConfig", () => {
  test("never includes the PAT", () => {
    const config = loadConfig({ env: { ...fullEnv, ADO_WEBHOOK_SECRET: "shh" } });
    const pub = publicConfig(config);
    const serialized = JSON.stringify(pub);

    expect(serialized).not.toContain("secret-pat-value-1234567890");
    expect(serialized).not.toContain("shh");
    expect(pub.ado?.org).toBe("goalliant");
    expect(pub.webhookConfigured).toBe(true);
    // PublicAdoConfig has exactly three keys; PAT is structurally absent.
    expect(pub.ado && Object.keys(pub.ado).sort()).toEqual([
      "apiVersion",
      "org",
      "project",
    ]);
  });

  test("issues array is copied, not aliased", () => {
    const config = loadConfig({ env: {} });
    const pub = publicConfig(config);
    pub.issues.push("ado_org_missing");
    expect(config.issues.length).toBeLessThan(pub.issues.length);
  });
});

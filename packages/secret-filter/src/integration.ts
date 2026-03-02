import { classifyEnv } from "./classifier.ts";
import type { ClassifyEnvResult, ClassifyOptions } from "./types.ts";

export interface GondolinSecretDefinition {
  hosts: string[];
  value: string;
}

export interface GondolinIntegrationResult extends ClassifyEnvResult {
  secretsMap: Record<string, GondolinSecretDefinition>;
}

export function classifyEnvForGondolin(
  env: Record<string, string | undefined>,
  options?: ClassifyOptions,
): GondolinIntegrationResult {
  const classified = classifyEnv(env, options);
  const secretsMap: Record<string, GondolinSecretDefinition> = {};
  const secrets: typeof classified.secrets = [];
  const dropped = [...classified.dropped];

  for (const secret of classified.secrets) {
    const value = env[secret.name];
    if (typeof value !== "string") {
      dropped.push({
        ...secret,
        dropped: true,
        reason: "secret has undefined value",
      });
      continue;
    }

    secrets.push(secret);
    secretsMap[secret.name] = {
      hosts: secret.hosts,
      value,
    };
  }

  return {
    ...classified,
    secrets,
    dropped,
    secretsMap,
  };
}

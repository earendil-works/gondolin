export { classify, classifyEnv } from "./classifier.ts";
export type {
  GondolinIntegrationResult,
  GondolinSecretDefinition,
} from "./integration.ts";
export { classifyEnvForGondolin } from "./integration.ts";
export {
  getPatternStore,
  PatternCompilationError,
  PatternIntegrityError,
  PatternSchemaError,
} from "./patterns.ts";
export type {
  ClassifyEnvResult,
  ClassifyOptions,
  ClassifyResult,
  MatchSource,
  SecretMappingData,
} from "./types.ts";

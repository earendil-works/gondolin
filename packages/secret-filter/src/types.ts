export type MatchSource =
  | "override"
  | "value"
  | "name-exact"
  | "name-keyword"
  | "name-pattern";

export interface ClassifyResult {
  name: string;
  isSecret: boolean;
  hosts: string[];
  dropped: boolean;
  matchedBy?: MatchSource;
  patternId?: string;
  keyword?: string;
  reason?: string;
}

export interface ClassifyOptions {
  overrides?: Record<string, string[]>;
}

export interface ClassifyEnvResult {
  secrets: ClassifyResult[];
  dropped: ClassifyResult[];
  safe: string[];
}

export interface ValuePattern {
  id: string;
  keyword?: string;
  regex: string;
  keywords?: string[];
  secret_group?: number;
}

export interface SecretMappingData {
  schema_version: number;
  generated_at: string;
  keyword_host_map: Record<string, string[]>;
  exact_name_host_map: Record<string, string[]>;
  value_patterns: ValuePattern[];
}

# @earendil-works/secret-filter

Secret classifier for environment variables with host mapping output suitable for Gondolin.

## Usage

```ts
import { classifyEnvForGondolin } from "@earendil-works/secret-filter";

const { secretsMap, dropped, safe } = classifyEnvForGondolin(process.env);
```

`secretsMap` is shaped as:

```ts
Record<string, { hosts: string[]; value: string }>;
```

which can be passed directly to `createHttpHooks({ secrets })`.

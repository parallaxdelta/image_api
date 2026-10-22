import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const EnvSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: bool.default(false),

  // Source fetching
  MAX_SOURCE_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),
  FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(8_000),
  MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(3),

  // Decoding / output
  MAX_INPUT_PIXELS: z.coerce.number().int().positive().default(40_000_000),
  MAX_OUTPUT_DIMENSION: z.coerce.number().int().positive().default(4000),

  // Abuse + caching
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  CACHE_MAX_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
  CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  return parsed.data;
}

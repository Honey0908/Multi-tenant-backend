// Local dev Postgres (docker-compose) doesn't support SSL at all; managed
// providers (Render, etc.) require it for every external connection. `pg`
// doesn't infer this from the connection string on its own, so each
// PrismaPg adapter needs it passed explicitly.
//
// Keyed off the connection string's hostname rather than NODE_ENV: these
// clients get constructed from three different places (the running app's
// Docker image, prisma/seed.ts run via GitHub Actions, and prisma/seed.ts
// run locally via tsx), and NODE_ENV isn't set consistently across all of
// them, whereas "is this actually localhost" always is.
export function pgSslConfig(connectionString: string | undefined): { rejectUnauthorized: false } | undefined {
  if (!connectionString) return undefined;
  try {
    const { hostname } = new URL(connectionString);
    return hostname === 'localhost' || hostname === '127.0.0.1' ? undefined : { rejectUnauthorized: false };
  } catch {
    return undefined;
  }
}

// This guard must run before creating a PostgreSQL client. Never echo its input.
export function requireTestDatabaseUrl(value: string | undefined): string {
  if (!value?.trim()) throw new Error('TEST_DATABASE_URL must be set explicitly to a disposable PostgreSQL test database.');
  try {
    const url = new URL(value);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !database
      || database.includes('/') || !/test/i.test(database)) throw new Error();
    // pg accepts query parameters that override the database or connection options.
    // Only the TLS mode is allowed from outside the test runner.
    for (const [key, mode] of url.searchParams) {
      if (key !== 'sslmode' || !['disable', 'allow', 'prefer', 'require', 'verify-ca', 'verify-full'].includes(mode)) throw new Error();
    }
    return url.toString();
  } catch {
    throw new Error('TEST_DATABASE_URL must be a PostgreSQL URL whose database name contains "test"; only sslmode query parameters are allowed.');
  }
}

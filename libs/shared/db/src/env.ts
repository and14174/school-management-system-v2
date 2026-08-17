export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env (or otherwise export it) before using @sms/db.`,
    );
  }
  return value;
}

export default async function globalTeardown() {
  await (globalThis as { __lanesStop?: () => Promise<void> }).__lanesStop?.();
}

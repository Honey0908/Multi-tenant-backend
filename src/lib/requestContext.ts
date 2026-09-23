import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantTokenPayload } from './jwt.js';

const storage = new AsyncLocalStorage<TenantTokenPayload>();

export function runInTenantContext<T>(context: TenantTokenPayload, fn: () => T): T {
  return storage.run(context, fn);
}

export function getTenantContext(): TenantTokenPayload {
  const context = storage.getStore();
  if (!context) {
    throw new Error('getTenantContext() called outside of an authenticated request');
  }
  return context;
}

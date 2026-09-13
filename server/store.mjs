import { createCommunityStore } from './community-store.mjs';

export async function createStore(config) {
  if (!config.useDatabase) return createCommunityStore();
  const { createCloudbaseStore } = await import('./cloudbase-store.mjs');
  return createCloudbaseStore(config);
}

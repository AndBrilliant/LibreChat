import { InMemoryJobStore } from '../implementations/InMemoryJobStore';

describe('InMemoryJobStore user-job membership across owner changes', () => {
  let store: InMemoryJobStore;

  beforeEach(() => {
    store = new InMemoryJobStore();
  });

  afterEach(async () => {
    await store.destroy();
  });

  it('scrubs the previous owner when a replacement changes owners', async () => {
    await store.createJob('conv-shared', 'user-a');
    await expect(store.getActiveJobIdsByUser('user-a')).resolves.toEqual(['conv-shared']);

    // The stream id is client-supplied, so a replacement can belong to a DIFFERENT
    // user. The previous owner's account deletion must not enumerate (and abort)
    // the new owner's live generation.
    await store.createJob('conv-shared', 'user-b');

    await expect(store.getActiveJobIdsByUser('user-a')).resolves.toEqual([]);
    await expect(store.getActiveJobIdsByUser('user-b')).resolves.toEqual(['conv-shared']);
  });

  it('refuses stale membership whose job now belongs to another owner', async () => {
    await store.createJob('conv-stale', 'user-b');
    // Simulate membership left behind by an interleaving the createJob scrub
    // missed: the OWNER check on read is the backstop, mirroring the Redis path.
    (store as unknown as { userJobMap: Map<string, Set<string>> }).userJobMap.set(
      'user-a',
      new Set(['conv-stale']),
    );

    await expect(store.getActiveJobIdsByUser('user-a')).resolves.toEqual([]);
    await expect(store.getActiveJobIdsByUser('user-b')).resolves.toEqual(['conv-stale']);
  });

  it('keeps tenant-qualified owners distinct', async () => {
    await store.createJob('conv-tenant', 'user-a', undefined, 'tenant-1');

    await expect(store.getActiveJobIdsByUser('user-a', 'tenant-1')).resolves.toEqual([
      'conv-tenant',
    ]);
    await expect(store.getActiveJobIdsByUser('user-a')).resolves.toEqual([]);
    await expect(store.getActiveJobIdsByUser('user-a', 'tenant-2')).resolves.toEqual([]);
  });
});

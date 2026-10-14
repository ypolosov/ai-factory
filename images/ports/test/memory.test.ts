// Эталонный адаптер в памяти проходит контракт: так проверяется сам набор тестов.

import { forgeContract, jobsContract, trackerContract } from './contract.ts';
import { memoryForge, memoryJobs, memoryTracker } from './memory.ts';

trackerContract('в памяти', async () => ({ tracker: memoryTracker(), cleanup: async () => {} }));

forgeContract('в памяти', async () => {
  const m = memoryForge();
  return { forge: m.forge, openPull: m.openPull, pushBranch: async () => m.pushBranch(), cleanup: async () => {} };
});

jobsContract('в памяти', async () => ({
  jobs: memoryJobs({ quick: async () => 'success', slow: () => new Promise(() => {}) }),
  quick: 'quick',
  slow: 'slow',
  poll: { everyMs: 5, forMs: 1000 },
  cleanup: async () => {},
}));

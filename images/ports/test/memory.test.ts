// Эталонный адаптер в памяти проходит контракт: так проверяется сам набор тестов.

import { forgeContract, trackerContract } from './contract.ts';
import { memoryForge, memoryTracker } from './memory.ts';

trackerContract('в памяти', async () => ({ tracker: memoryTracker(), cleanup: async () => {} }));

forgeContract('в памяти', async () => {
  const m = memoryForge();
  return { forge: m.forge, openPull: async () => m.openPull(), cleanup: async () => {} };
});

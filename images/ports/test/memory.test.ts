// Эталонный адаптер в памяти проходит контракт: так проверяется сам набор тестов.
import { memoryForge, memoryTracker } from './memory.ts';
import { forgeContract, trackerContract } from './contract.ts';

trackerContract('в памяти', async () => ({ tracker: memoryTracker(), cleanup: async () => {} }));

forgeContract('в памяти', async () => {
  const m = memoryForge();
  return { forge: m.forge, openPull: async () => m.openPull(), cleanup: async () => {} };
});

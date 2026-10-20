// Эталонный адаптер в памяти проходит контракт: так проверяется сам набор тестов.

import {
  diagramsContract,
  forgeContract,
  jobsContract,
  KNOWLEDGE_DOCS,
  knowledgeContract,
  trackerContract,
  wikiContract,
} from './contract.ts';
import { memoryDiagrams, memoryForge, memoryJobs, memoryKnowledge, memoryTracker, memoryWiki } from './memory.ts';

trackerContract('в памяти', async () => ({ tracker: memoryTracker(), cleanup: async () => {} }));

forgeContract('в памяти', async () => {
  const m = memoryForge();
  return { forge: m.forge, openPull: m.openPull, pushBranch: async () => m.pushBranch(), tag: m.tag, cleanup: async () => {} };
});

jobsContract('в памяти', async () => ({
  jobs: memoryJobs({ quick: async () => 'success', slow: () => new Promise(() => {}) }),
  quick: 'quick',
  slow: 'slow',
  poll: { everyMs: 5, forMs: 1000 },
  cleanup: async () => {},
}));

knowledgeContract('в памяти', async () => ({ knowledge: memoryKnowledge(KNOWLEDGE_DOCS), cleanup: async () => {} }));

wikiContract('в памяти', async () => ({ wiki: memoryWiki(), cleanup: async () => {} }));

diagramsContract('в памяти', async () => ({ diagrams: memoryDiagrams(), cleanup: async () => {} }), { sequence: true });

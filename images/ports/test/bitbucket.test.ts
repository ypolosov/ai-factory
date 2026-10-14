// Контракт исполнителя заданий на живом Bitbucket Pipelines: репозиторий фабрики и свой
// раннер стенда (профиль bitbucket). Запуск - scripts/port-contract-saas.sh bitbucket;
// без BITBUCKET_TEST_REPO и BITBUCKET_TEST_TOKEN - пропуск.
import { test } from 'vitest';
import { bitbucketJobs } from '../bitbucket.ts';
import { jobsContract } from './contract.ts';

const workspace = process.env.BITBUCKET_TEST_WORKSPACE;
const repo = process.env.BITBUCKET_TEST_REPO;
const token = process.env.BITBUCKET_TEST_TOKEN;

if (!workspace || !repo || !token) {
  test.skip('контракт Bitbucket: нет BITBUCKET_TEST_WORKSPACE, BITBUCKET_TEST_REPO и BITBUCKET_TEST_TOKEN', () => {});
} else {
  // Задания hello и contract-sleep - в config/bitbucket/bitbucket-pipelines.yml.
  jobsContract('Bitbucket', async () => ({
    jobs: bitbucketJobs({ workspace, repo, token }),
    quick: 'hello',
    slow: 'contract-sleep',
    poll: { everyMs: 3000, forMs: 240_000 },
    cleanup: async () => {},
  }));
}

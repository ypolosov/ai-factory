// Контракт трекера на живой Jira: песочница - проект FCT. Запуск - scripts/port-contract-saas.sh;
// без JIRA_TEST_SITE, JIRA_TEST_EMAIL, JIRA_TEST_TOKEN и JIRA_TEST_PROJECT - пропуск.
// Задачи песочницы остаются (у токена нет права удалять задачи), это ожидаемо.
import { test } from 'vitest';
import { jiraTracker } from '../jira.ts';
import { trackerContract } from './contract.ts';

const site = process.env.JIRA_TEST_SITE;
const email = process.env.JIRA_TEST_EMAIL;
const token = process.env.JIRA_TEST_TOKEN;
const project = process.env.JIRA_TEST_PROJECT;

if (!site || !email || !token || !project) {
  test.skip('контракт Jira: нет JIRA_TEST_SITE, JIRA_TEST_EMAIL, JIRA_TEST_TOKEN, JIRA_TEST_PROJECT', () => {});
} else {
  trackerContract('Jira', async () => ({ tracker: jiraTracker({ site, email, token, project }), cleanup: async () => {} }));
}

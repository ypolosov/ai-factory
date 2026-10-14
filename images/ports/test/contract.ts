// Контрактные тесты портов: один набор для всех адаптеров. Адаптер считается
// заменяемым, только если проходит его целиком (заменяемость доказывает второй
// носитель, а не публичный API).

import assert from 'node:assert/strict';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { type Forge, PortError, type Tracker } from '../ports.ts';

export interface TrackerFixture {
  tracker: Tracker;
  cleanup(): Promise<void>;
}

export interface ForgeFixture {
  forge: Forge;
  // Ветка с одним изменённым файлом и открытый PR из неё в ветку по умолчанию.
  openPull(): Promise<{ n: number; branch: string; file: string }>;
  // Ветка с одним изменённым файлом без PR.
  pushBranch(): Promise<{ branch: string; file: string }>;
  cleanup(): Promise<void>;
}

const uniq = () => Math.random().toString(16).slice(2, 8);

async function rejectsNotFound(p: Promise<unknown>) {
  await assert.rejects(p, (e: unknown) => e instanceof PortError && e.code === 'not_found');
}

export function trackerContract(name: string, setup: () => Promise<TrackerFixture>) {
  describe(`трекер ${name}`, () => {
    let fx: TrackerFixture;
    let t: Tracker;
    beforeAll(async () => {
      fx = await setup();
      t = fx.tracker;
    });
    afterAll(async () => fx?.cleanup());

    it('созданная задача открыта и читается по ключу', async () => {
      const title = `задача ${uniq()}`;
      const made = await t.createIssue({ title, body: 'описание', labels: ['agent'] });
      assert.equal(made.state, 'open');
      const got = await t.getIssue(made.key);
      assert.equal(got.title, title);
      assert.equal(got.body, 'описание');
      assert.deepEqual(got.labels, ['agent']);
      assert.match(got.url, /^https?:\/\//);
    });

    it('нет задачи - ошибка not_found', async () => {
      await rejectsNotFound(t.getIssue('999999'));
    });

    it('список фильтруется по метке и состоянию', async () => {
      const label = `l-${uniq()}`;
      const a = await t.createIssue({ title: 'a', body: '', labels: [label] });
      const b = await t.createIssue({ title: 'b', body: '', labels: [label] });
      await t.createIssue({ title: 'c', body: '' });
      await t.close(b.key);
      const open = await t.listIssues({ label, state: 'open' });
      assert.deepEqual(
        open.map((i) => i.key),
        [a.key],
      );
      const all = await t.listIssues({ label, state: 'all' });
      assert.deepEqual(all.map((i) => i.key).sort(), [a.key, b.key].sort());
    });

    it('комментарий виден в списке комментариев', async () => {
      const i = await t.createIssue({ title: 'к', body: '' });
      await t.addComment(i.key, 'первый');
      const cs = await t.listComments(i.key);
      assert.deepEqual(
        cs.map((c) => c.body),
        ['первый'],
      );
      assert.ok(cs[0]?.author);
      assert.ok(!Number.isNaN(Date.parse(cs[0]?.createdAt ?? '')));
    });

    it('метку можно поставить и снять, даже если её ещё нет', async () => {
      const i = await t.createIssue({ title: 'м', body: '' });
      const label = `new-${uniq()}`;
      await t.addLabel(i.key, label);
      assert.deepEqual((await t.getIssue(i.key)).labels, [label]);
      await t.removeLabel(i.key, label);
      assert.deepEqual((await t.getIssue(i.key)).labels, []);
    });

    it('история меток: когда метку поставили', async () => {
      const i = await t.createIssue({ title: 'и', body: '' });
      await t.addLabel(i.key, 'agent');
      const ev = await t.labelEvents(i.key);
      const added = ev.find((e) => e.label === 'agent' && e.action === 'added');
      assert.ok(added);
      assert.ok(!Number.isNaN(Date.parse(added.at)));
    });

    it('задачу можно закрыть и открыть снова', async () => {
      const i = await t.createIssue({ title: 'з', body: '' });
      await t.close(i.key);
      assert.equal((await t.getIssue(i.key)).state, 'closed');
      await t.reopen(i.key);
      assert.equal((await t.getIssue(i.key)).state, 'open');
    });

    it('зависимость задачи видна в списке зависимостей', async () => {
      const a = await t.createIssue({ title: 'зав a', body: '' });
      const b = await t.createIssue({ title: 'зав b', body: '' });
      await t.linkDependency(b.key, a.key);
      assert.deepEqual(await t.listDependencies(b.key), [a.key]);
    });
  });
}

export function forgeContract(name: string, setup: () => Promise<ForgeFixture>) {
  describe(`хостинг ${name}`, () => {
    let fx: ForgeFixture;
    let f: Forge;
    let pr: { n: number; branch: string; file: string };
    beforeAll(async () => {
      fx = await setup();
      f = fx.forge;
      pr = await fx.openPull();
    });
    afterAll(async () => fx?.cleanup());

    it('репозиторий: адрес и ветка по умолчанию', async () => {
      const r = await f.repo();
      assert.match(r.webUrl, /^https?:\/\//);
      assert.ok(r.defaultBranch);
      assert.ok(await f.branchHead(r.defaultBranch));
    });

    it('нет ветки - голова не определена', async () => {
      assert.equal(await f.branchHead(`no-${uniq()}`), undefined);
    });

    it('открытый PR: ветки, голова и поиск по ветке', async () => {
      const p = await f.getPull(pr.n);
      const r = await f.repo();
      assert.equal(p.state, 'open');
      assert.equal(p.sourceBranch, pr.branch);
      assert.equal(p.targetBranch, r.defaultBranch);
      assert.equal(p.headSha, await f.branchHead(pr.branch));
      assert.equal((await f.findPullByBranch(pr.branch))?.number, pr.n);
      assert.equal(await f.findPullByBranch(`no-${uniq()}`), undefined);
      assert.ok((await f.listPulls({ state: 'open' })).some((x) => x.number === pr.n));
    });

    it('PR открывается из ветки', async () => {
      const b = await fx.pushBranch();
      const base = (await f.repo()).defaultBranch;
      const p = await f.openPull({ title: 'порт открыл PR', body: 'описание PR', head: b.branch, base });
      assert.equal(p.state, 'open');
      assert.equal(p.title, 'порт открыл PR');
      assert.equal(p.sourceBranch, b.branch);
      assert.equal(p.targetBranch, base);
      assert.equal(p.headSha, await f.branchHead(b.branch));
      assert.equal((await f.getPull(p.number)).body, 'описание PR');
    });

    it('нет PR - ошибка not_found', async () => {
      await rejectsNotFound(f.getPull(999999));
    });

    it('коммиты и дифф PR', async () => {
      const p = await f.getPull(pr.n);
      const cs = await f.pullCommits(pr.n);
      assert.ok(cs.some((c) => c.sha === p.headSha));
      assert.ok(!Number.isNaN(Date.parse(await f.commitDate(p.headSha))));
      assert.ok((await f.pullDiff(pr.n)).includes(pr.file));
      assert.ok(Array.isArray(await f.pullReviews(pr.n)));
    });

    it('комментарий к PR виден в списке', async () => {
      await f.commentPull(pr.n, 'замечание ревьюера');
      assert.ok((await f.listPullComments(pr.n)).some((c) => c.body === 'замечание ревьюера'));
    });

    it('статус коммита: последний по ключу побеждает', async () => {
      const sha = (await f.getPull(pr.n)).headSha;
      await f.setStatus(sha, { key: 'factory/gate', state: 'pending', description: 'идёт' });
      await f.setStatus(sha, { key: 'factory/gate', state: 'success', description: 'готово' });
      const st = (await f.statuses(sha)).filter((s) => s.key === 'factory/gate');
      assert.deepEqual(
        st.map((s) => s.state),
        ['success'],
      );
    });

    it('обязательные проверки ветки - список', async () => {
      assert.ok(Array.isArray(await f.requiredChecks((await f.repo()).defaultBranch)));
    });
  });
}

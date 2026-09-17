import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listBotProjects } from '../lib/project-catalog.js';

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'feishu-project-catalog-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = async name => {
    const path = join(root, name);
    await mkdir(path, { recursive: true });
    return path;
  };
  return { root, directory };
}

test('project choices use current Harness registrations and bot bindings without scanning unregistered children', async t => {
  const f = await fixture(t);
  const project = await f.directory('registered');
  const unregistered = await f.directory('registered/unregistered-child');
  const legacy = await f.directory('legacy-binding');
  const workspaces = [{ path: project, title: '课程项目' }];
  const ctx = { workspaceRegistry: { list: () => workspaces } };
  const bots = [{ id: 'default', name: '默认机器人', workspacePath: legacy }, { id: 'bot_a', name: '课程助理', workspacePath: project }];
  const result = await listBotProjects(ctx, bots);
  assert.deepEqual(result, { projects: [
    { path: project, name: '课程项目', available: true, botId: 'bot_a', botName: '课程助理' },
    { path: legacy, name: 'legacy-binding', available: true, botId: 'default', botName: '默认机器人' },
  ] });
  assert.equal(result.projects.some(row => row.path === unregistered), false);
  workspaces.push({ path: await f.directory('new-project'), title: '新项目' });
  assert.equal((await listBotProjects(ctx, bots)).projects.length, 3, 'registrations refresh without restarting');
});

test('project choices deduplicate symlinks and exclude private user directories and aliases', async t => {
  const f = await fixture(t);
  const project = await f.directory('project');
  const alias = join(f.root, 'alias');
  await symlink(project, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const user = await f.directory('project/.feishu-users/private-user');
  const userAlias = join(f.root, 'user-alias');
  await symlink(user, userAlias, process.platform === 'win32' ? 'junction' : 'dir');
  const ctx = { workspaceRegistry: { list: () => [
    { path: project, title: 'Main project' }, { path: alias, title: 'Alias' },
    { path: user, title: 'Private user' }, { path: userAlias, title: 'Private alias' },
    { path: 'relative/project', title: 'Invalid' },
  ] } };
  assert.deepEqual(await listBotProjects(ctx, [{ id: 'bot_a', name: 'Bot A', workspacePath: alias }]), { projects: [
    { path: project, name: 'Main project', available: true, botId: 'bot_a', botName: 'Bot A' },
  ] });
});

test('missing directories and file replacements are visible but unavailable, then recover on refresh', async t => {
  const f = await fixture(t);
  const missing = join(f.root, 'missing');
  const file = join(f.root, 'former-directory');
  await writeFile(file, 'file');
  const ctx = { workspaceRegistry: { list: () => [{ path: missing, title: 'Missing' }, { path: file, title: 'Former directory' }] } };
  const bots = [{ id: 'default', name: 'Default', workspacePath: missing }];
  const result = await listBotProjects(ctx, bots);
  assert.deepEqual(result.projects.map(row => [row.path, row.available]), [[missing, false], [file, false]]);
  assert.equal(result.projects[0].botId, 'default');
  await mkdir(missing);
  assert.equal((await listBotProjects(ctx, bots)).projects[0].available, true);
});

test('registry failures retain existing bot directories and report a safe actionable warning', async t => {
  const f = await fixture(t);
  const path = await f.directory('legacy');
  const result = await listBotProjects({ workspaceRegistry: { list() { throw new Error('private storage details'); } } }, [
    { id: 'default', name: 'Default', workspacePath: path },
  ]);
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].available, true);
  assert.match(result.warning, /刷新/u);
  assert.doesNotMatch(result.warning, /private storage details/u);
  assert.deepEqual((await listBotProjects({ workspaceRegistry: { list: () => [] } }, [])).projects, []);
});

test('directories without read or traversal permission are unavailable until access is restored', {
  skip: process.platform === 'win32' || process.getuid?.() === 0 ? 'POSIX mode checks require a non-root POSIX account' : false,
}, async t => {
  const f = await fixture(t);
  const path = await f.directory('restricted-project');
  const ctx = { workspaceRegistry: { list: () => [{ path, title: 'Restricted' }] } };
  try {
    await chmod(path, 0o300);
    assert.equal((await listBotProjects(ctx, [])).projects[0].available, false, 'write and traversal without read is insufficient');
    await chmod(path, 0o600);
    assert.equal((await listBotProjects(ctx, [])).projects[0].available, false, 'read without traversal is insufficient');
    await chmod(path, 0o700);
    assert.equal((await listBotProjects(ctx, [])).projects[0].available, true, 'restoring access makes the directory selectable on refresh');
  } finally {
    await chmod(path, 0o700);
  }
});

import { mkdir, readFile, writeFile, lstat, symlink, copyFile, realpath } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import yaml from 'js-yaml';

const plugin = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { name: pluginName } = JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8'));
if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/.test(pluginName)) throw new Error('Invalid plugin package name');
const profile = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'web');
async function readOptional(file, fallback) {
  try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
const manifestPath = join(profile, 'package.json');
const originalManifest = await readOptional(manifestPath, '');
const manifest = originalManifest ? JSON.parse(originalManifest) : {
  name: 'dsh-profile-web', private: true, dependencies: {},
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'], patchReload: 'live' } },
};
const patchPath = join(profile, 'cordis.patch.yml');
const originalPatch = await readOptional(patchPath, '');
// Parse identities without evaluating Harness's !!js expressions. Keep the
// original source intact, preserving comments, quoting, and expression text.
const schema = yaml.DEFAULT_SCHEMA.extend([
  new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', construct: value => value }),
]);
const patches = yaml.load(originalPatch, { schema }) ?? [];
if (!Array.isArray(patches)) throw new Error(`Expected a YAML patch list: ${patchPath}`);
const rows = patches.flatMap(patch => Array.isArray(patch?.insert) ? patch.insert : []);
const desired = [
  { id: 'webhook-runtime', name: '@deepseek-ai/dsh-webhook' },
  { id: 'feishu-bot', name: pluginName,
    config: { source: 'primary-feishu', path: '/webhook/feishu', appIdEnv: 'FEISHU_APP_ID', appSecretEnv: 'FEISHU_APP_SECRET', workspacePath: dirname(plugin), agentPreset: 'standard', permissionPreset: 'workspace-write' } },
];
const legacyName = '@deepseek-ai/dsh-feishu-bot';
if (pluginName !== legacyName && (rows.some(row => row?.name === legacyName) || manifest.dependencies?.[legacyName])) {
  throw new Error(`检测到旧版 ${legacyName}；请先手动迁移旧配置，避免重复飞书实例。`);
}
const additions = desired.filter(entry => {
  if (rows.some(row => row?.id === entry.id && row?.name !== entry.name)) throw new Error(`插件 ID ${entry.id} 已被其他配置占用，请先检查 ${patchPath}`);
  return !rows.some(row => row?.name === entry.name);
});
let nextPatch;
if (additions.length) {
  const prefix = originalPatch.replace(/^\s*\[\s*\](?=\s*(?:#.*)?$)/m, '');
  nextPatch = prefix + '\n# Feishu integration runtime\n' + yaml.dump([{ insert: additions }]);
  // Validate the final document before changing links or the profile manifest.
  // Unusual flow-style/document-end layouts must be converted manually first.
  const parsed = yaml.load(nextPatch, { schema });
  if (!Array.isArray(parsed)) throw new Error(`无法安全追加 YAML，请先将 ${patchPath} 转为普通列表格式。`);
}
const dependency = `file:${plugin}`;
if (manifest.dependencies?.[pluginName] && manifest.dependencies[pluginName] !== dependency) {
  throw new Error(`已有其他插件依赖 ${pluginName}，请先检查 ${manifestPath}`);
}
const link = join(profile, 'node_modules', ...pluginName.split('/'));
let createLink = false;
try {
  const stat = await lstat(link);
  let target;
  try { target = await realpath(link); } catch {}
  if (!stat.isSymbolicLink() || target !== await realpath(plugin)) throw new Error(`已有其他插件安装：${link}，请先检查该目录。`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  createLink = true;
}
await mkdir(dirname(link), { recursive: true });
if (createLink) await symlink(plugin, link, process.platform === 'win32' ? 'junction' : 'dir');
manifest.dependencies ||= {};
manifest.dependencies[pluginName] = dependency;
const backupSuffix = `.backup-${Date.now()}-${process.pid}`;
const nextManifest = JSON.stringify(manifest, null, 2) + '\n';
if (nextManifest !== originalManifest) {
  if (originalManifest) await copyFile(manifestPath, manifestPath + backupSuffix);
  await writeFile(manifestPath, nextManifest);
}
if (additions.length) {
  if (originalPatch) await copyFile(patchPath, patchPath + backupSuffix);
  await writeFile(patchPath, nextPatch);
}
console.log(`飞书插件已安装到 ${profile}；补充 ${additions.length} 个插件项。`);

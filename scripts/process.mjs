import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

// Observing early exit catches malformed arguments and missing credentials;
// remaining alive does not guarantee network/service readiness.
export async function launch(command, args, { background = false, runtimeDir, name, cwd } = {}) {
  if (!background) {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', error => { console.error(error.message); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
    return;
  }
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
  const pidPath = join(runtimeDir, `${name}.pid`);
  try {
    const pid = Number(await readFile(pidPath, 'utf8'));
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0); throw new Error(`已有启动记录 PID ${pid} 正在运行，请检查现有 ${name}。`); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const logPath = join(runtimeDir, `${name}.log`);
  const log = await open(logPath, 'a', 0o600);
  const child = spawn(command, args, { cwd, detached: true, stdio: ['ignore', log.fd, log.fd] });
  try {
    await new Promise((yes, no) => {
      let timer;
      const failed = error => { clearTimeout(timer); no(error); };
      child.once('error', failed);
      child.once('exit', (code, signal) => failed(new Error(`${name} 启动后退出 (${signal || code})；日志：${logPath}`)));
      child.once('spawn', () => { timer = setTimeout(yes, 1000); });
    });
    await writeFile(pidPath, String(child.pid), { mode: 0o600 });
    console.log(`${name} 后台进程已创建，PID ${child.pid}；服务是否就绪请查看日志：${logPath}`);
  } finally {
    child.unref();
    await log.close();
  }
}

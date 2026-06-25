/**
 * static-build-lambda — off-pod frontend build for greta_agentic containers.
 *
 * Pure compute: a ZIP of the project source comes in, a ZIP of the built `dist`
 * goes out. Holds NO cloud credentials — the container writes the dist to GCS.
 *
 * Contract (must match POST /_greta/build-static in greta-cloudrun):
 *   Request : body = zip of frontend source (no node_modules).
 *             `x-build-id` header optional (logging only).
 *             Behind a Lambda Function URL the binary body arrives base64 —
 *             handled via event.isBase64Encoded.
 *   Response: 200, Content-Type application/zip, body = zip whose ROOT is the
 *             dist contents (index.html, assets/, …). Non-200 ⇒ build failed.
 *
 * Build runs with `bun` (installed into the image) in /tmp, the only writable
 * path in a Lambda. node_modules + bun cache live under /tmp at runtime.
 */

import extractZip from 'extract-zip';
import archiver from 'archiver';
import { glob } from 'glob';
import { spawn } from 'child_process';
import { PassThrough } from 'stream';
import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import path from 'path';
import os from 'os';

function zipDirToBuffer(dir) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 1 } });
    const chunks = [];
    const collector = new PassThrough();
    collector.on('data', (c) => chunks.push(c));
    collector.on('end', () => resolve(Buffer.concat(chunks)));
    collector.on('error', reject);
    archive.on('error', reject);
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') reject(err); });
    archive.pipe(collector);
    archive.glob('**/*', { cwd: dir, dot: true });
    archive.finalize();
  });
}

function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: '/tmp',
        BUN_INSTALL_CACHE_DIR: '/tmp/.bun-cache',
        NODE_ENV: 'production',
      },
    });
    let out = '';
    p.stdout.on('data', (d) => { out += d; console.log(`[${cmd}] ${String(d).trim()}`); });
    p.stderr.on('data', (d) => { out += d; console.error(`[${cmd}] ${String(d).trim()}`); });
    p.on('error', reject);
    p.on('exit', (code) => code === 0
      ? resolve(out)
      : reject(new Error(`${cmd} ${args.join(' ')} exited ${code}\n${out.slice(-1200)}`)));
  });
}

export const handler = async (event) => {
  const buildId = event?.headers?.['x-build-id'] || 'build';
  const work = await fs.mkdtemp(path.join(os.tmpdir(), `build-${buildId}-`));
  const srcDir = path.join(work, 'src');
  const t0 = Date.now();
  const bunPath = process.env.BUN_PATH
    || (process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bin', 'bun') : 'bun');

  try {
    if (path.isAbsolute(bunPath)) {
      await fs.access(bunPath, fsConstants.R_OK | fsConstants.X_OK);
    }

    const body = event?.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event?.body ?? '');
    if (!body.length) throw new Error('empty request body (expected a source zip)');

    const srcZip = path.join(work, 'src.zip');
    await fs.mkdir(srcDir, { recursive: true });
    await fs.writeFile(srcZip, body);
    await extractZip(srcZip, { dir: srcDir });
    console.log(`[${buildId}] extracted source: ${(body.length / 1048576).toFixed(2)}MB`);

    // Install deps + build. bun reads bun.lock if present; cache lives in /tmp.
    await run(bunPath, ['install'], srcDir);
    await run(bunPath, ['run', 'build', '--', '--outDir', 'dist', '--minify', 'false'], srcDir);

    const distDir = path.join(srcDir, 'dist');
    const distFiles = await glob('**/*', { cwd: distDir, nodir: true, dot: true });
    if (distFiles.length === 0) throw new Error('build produced no dist files');
    console.log(`[${buildId}] built ${distFiles.length} dist files in ${Date.now() - t0}ms`);

    const distZip = await zipDirToBuffer(distDir);
    return {
      statusCode: 200,
      isBase64Encoded: true,
      headers: { 'Content-Type': 'application/zip' },
      body: distZip.toString('base64'),
    };
  } catch (err) {
    console.error(`[${buildId}] build failed:`, err.message);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  } finally {
    await fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
};

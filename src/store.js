// File-backed job store (demo scope: one JSON file per job, no database).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createJob } from './models.js';

export async function saveJob(dir, jobId, job) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${jobId}.json`);
  await fs.writeFile(file, JSON.stringify(createJob(job), null, 2), 'utf8');
  return file;
}

export async function loadJob(dir, jobId) {
  const file = path.join(dir, `${jobId}.json`);
  const raw = await fs.readFile(file, 'utf8');
  return createJob(JSON.parse(raw));
}

export async function listJobs(dir) {
  try {
    const names = await fs.readdir(dir);
    return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -'.json'.length));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

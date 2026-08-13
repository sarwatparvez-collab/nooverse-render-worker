import express from 'express';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 10000;
const SERVICE_KEY = process.env.SERVICE_KEY || '';
const jobs = new Map();

function authorized(req) {
  if (!SERVICE_KEY) return true;
  const auth = req.get('authorization') || '';
  return auth === `Bearer ${SERVICE_KEY}` || req.get('x-service-key') === SERVICE_KEY;
}

async function downloadToFile(url, filePath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(filePath, buf);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-5000) || `ffmpeg exited ${code}`));
    });
  });
}

async function renderJob(jobId, body) {
  const job = jobs.get(jobId);
  const workDir = path.join(os.tmpdir(), `nooverse-${jobId}`);
  await mkdir(workDir, { recursive: true });
  try {
    job.status = 'downloading';
    const clipUrls = Array.isArray(body.clips) ? body.clips.map(c => typeof c === 'string' ? c : c.url).filter(Boolean) : [];
    if (!clipUrls.length) throw new Error('At least one clip URL is required');

    const clipFiles = [];
    for (let i = 0; i < clipUrls.length; i++) {
      const f = path.join(workDir, `clip-${String(i).padStart(3,'0')}.mp4`);
      await downloadToFile(clipUrls[i], f);
      clipFiles.push(f);
    }

    let audioFile = null;
    if (body.audio_url) {
      audioFile = path.join(workDir, 'master-audio.mp3');
      await downloadToFile(body.audio_url, audioFile);
    }

    const concatFile = path.join(workDir, 'concat.txt');
    await writeFile(concatFile, clipFiles.map(f => `file '${f.replaceAll("'", "'\\''")}'`).join('\n'));

    const silentVideo = path.join(workDir, 'video-only.mp4');
    job.status = 'rendering';
    await runFfmpeg([
      '-y', '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
      silentVideo
    ]);

    const outputFile = path.join(workDir, 'final.mp4');
    if (audioFile) {
      await runFfmpeg([
        '-y', '-i', silentVideo, '-i', audioFile,
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
        '-shortest', '-movflags', '+faststart', outputFile
      ]);
    } else {
      const buf = await readFile(silentVideo);
      await writeFile(outputFile, buf);
    }

    if (body.output_upload_url) {
      job.status = 'uploading';
      const data = await readFile(outputFile);
      const up = await fetch(body.output_upload_url, {
        method: body.output_upload_method || 'PUT',
        headers: { 'content-type': 'video/mp4', ...(body.output_upload_headers || {}) },
        body: data
      });
      if (!up.ok) throw new Error(`Output upload failed ${up.status}`);
      job.output_url = body.output_public_url || body.output_upload_url.split('?')[0];
    } else {
      const data = await readFile(outputFile);
      job.output_base64 = data.toString('base64');
    }

    job.status = 'completed';
    job.progress = 100;
    job.completed_at = new Date().toISOString();
  } catch (err) {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

app.get('/', (_req, res) => res.json({ ok: true, service: 'NOOVERSE Render Worker', version: '1.0.0' }));
app.get('/health', (_req, res) => res.json({ ok: true, ffmpeg: Boolean(ffmpegPath) }));

app.post('/render', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  const jobId = randomUUID();
  const job = { id: jobId, status: 'queued', progress: 0, created_at: new Date().toISOString() };
  jobs.set(jobId, job);
  renderJob(jobId, req.body || {});
  res.status(202).json({ ok: true, job_id: jobId, status: 'queued' });
});

app.get('/jobs/:id', (req, res) => {
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ ok: false, error: 'JOB_NOT_FOUND' });
  res.json({ ok: true, ...job });
});

app.listen(PORT, () => console.log(`NOOVERSE Render Worker listening on ${PORT}`));

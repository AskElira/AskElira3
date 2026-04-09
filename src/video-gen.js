/**
 * MiniMax video generation — text-to-video, polled to completion.
 *
 * Flow:
 *   1. POST /v1/video_generation  → task_id
 *   2. GET  /v1/query/video_generation?task_id=X  (poll until Success/Fail)
 *   3. GET  /v1/files/retrieve?file_id=X  → download_url
 *   4. Download MP4 to a temp file, return the path
 *
 * Total time: typically 2-5 minutes per video.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { config } = require('./config');

const API_BASE = 'https://api.minimax.io/v1';
const DEFAULT_MODEL = process.env.MINIMAX_VIDEO_MODEL || 'MiniMax-Hailuo-2.3';
const POLL_INTERVAL_MS = 5000;  // 5 seconds
const MAX_POLL_MS = 10 * 60_000; // 10 min max

/**
 * Submit a text-to-video generation task.
 * Returns the task_id from MiniMax.
 */
async function createTask(prompt, { model = DEFAULT_MODEL, duration, resolution } = {}) {
  const body = { model, prompt };
  if (duration) body.duration = duration;
  if (resolution) body.resolution = resolution;

  const res = await fetch(`${API_BASE}/video_generation`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.llmApiKey}`,
    },
    body: JSON.stringify(body),
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`MiniMax video_generation error ${res.status}: ${JSON.stringify(data)}`);
  }
  if (!data.task_id) {
    throw new Error(`MiniMax returned no task_id: ${JSON.stringify(data)}`);
  }
  return data.task_id;
}

/**
 * Poll task status until Success or Fail. Returns { status, file_id }.
 */
async function pollTask(taskId, onProgress) {
  const start = Date.now();
  let lastStatus = null;

  while (Date.now() - start < MAX_POLL_MS) {
    const res = await fetch(`${API_BASE}/query/video_generation?task_id=${encodeURIComponent(taskId)}`, {
      headers: { 'Authorization': `Bearer ${config.llmApiKey}` },
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(`MiniMax query error ${res.status}: ${JSON.stringify(data)}`);
    }

    const status = data.status;
    if (status !== lastStatus) {
      lastStatus = status;
      if (onProgress) onProgress(status);
    }

    if (status === 'Success') {
      return { status, file_id: data.file_id };
    }
    if (status === 'Fail') {
      throw new Error(`Video generation failed: ${JSON.stringify(data)}`);
    }
    // Preparing / Queueing / Processing → keep polling
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Video generation timed out after ${MAX_POLL_MS / 1000}s`);
}

/**
 * Retrieve the download URL for a finished video file.
 */
async function retrieveFile(fileId) {
  const res = await fetch(`${API_BASE}/files/retrieve?file_id=${encodeURIComponent(fileId)}`, {
    headers: { 'Authorization': `Bearer ${config.llmApiKey}` },
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`MiniMax files/retrieve error ${res.status}: ${JSON.stringify(data)}`);
  }
  const downloadUrl = data.file?.download_url || data.download_url;
  if (!downloadUrl) {
    throw new Error(`MiniMax files/retrieve returned no download_url: ${JSON.stringify(data)}`);
  }
  return downloadUrl;
}

/**
 * Download a URL to a temp MP4 file, return the path.
 */
async function downloadTo(tmpPath, url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tmpPath, buf);
  return tmpPath;
}

/**
 * Full pipeline: prompt → generated MP4 file path.
 * @param {string} prompt — text description
 * @param {object} opts — { model, duration, resolution, onProgress }
 * @returns {Promise<{path, taskId, fileId, durationMs}>}
 */
async function generateVideo(prompt, opts = {}) {
  const start = Date.now();
  if (!config.llmApiKey) throw new Error('LLM_API_KEY not configured');
  if (!prompt || prompt.trim().length < 3) throw new Error('Prompt is required');

  const taskId = await createTask(prompt, opts);
  const { file_id } = await pollTask(taskId, opts.onProgress);
  const downloadUrl = await retrieveFile(file_id);

  const outDir = path.join(os.tmpdir(), 'askelira-videos');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${taskId}.mp4`);
  await downloadTo(outPath, downloadUrl);

  return {
    path: outPath,
    taskId,
    fileId: file_id,
    durationMs: Date.now() - start,
  };
}

module.exports = { generateVideo, createTask, pollTask, retrieveFile };

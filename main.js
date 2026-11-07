const { app, BrowserWindow, ipcMain, dialog, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let mainWindow = null;

// Resolve bundled static binaries (support both development and packaged asar.unpacked)
function resolveBinary(binPath) {
  if (!binPath) return null;
  const unpacked = binPath.replace('app.asar', 'app.asar.unpacked');
  if (fs.existsSync(unpacked)) {
    return unpacked;
  }
  return binPath;
}

const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');

const ffmpegPath = resolveBinary(ffmpegStatic);
const ffprobePath = resolveBinary(ffprobeStatic.path);

console.log('[MKV2MP4] FFmpeg binary:', ffmpegPath);
console.log('[MKV2MP4] FFprobe binary:', ffprobePath);

// Settings Persistence
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

const defaultSettings = {
  outputFolderMode: 'same', // 'same' | 'custom'
  customFolderPath: '',
  conflictMode: 'rename',   // 'rename' | 'overwrite'
  conversionMode: 'auto',   // 'auto' | 'remux' | 'reencode'
  crf: 23,                  // 18 | 23 | 28
  preset: 'medium',         // 'fast' | 'medium' | 'slow'
  concurrency: 1,           // 1 | 2 | 3
  deleteOriginal: false,
  ignorePgs: true
};

function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, 'utf8');
      return { ...defaultSettings, ...JSON.parse(data) };
    }
  } catch (err) {
    console.error('[MKV2MP4] Error loading settings:', err);
  }
  return { ...defaultSettings };
}

function saveSettings(settings) {
  try {
    const current = loadSettings();
    const updated = { ...current, ...settings };
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2), 'utf8');
    return updated;
  } catch (err) {
    console.error('[MKV2MP4] Error saving settings:', err);
    throw err;
  }
}

// Queue and Process Management
const activeProcesses = new Map(); // itemId -> { process, outputPath, inputPath }
let queueItems = [];
let queueSettings = defaultSettings;
let isQueueRunning = false;
let completedCount = 0;
let errorCount = 0;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 850,
    minHeight: 620,
    backgroundColor: '#0f1117',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Helper: Run FFprobe on a file to inspect codecs, duration, streams
function probeSingleFile(filePath) {
  return new Promise((resolve, reject) => {
    if (!ffprobePath || !fs.existsSync(ffprobePath)) {
      return reject(new Error('Binário do FFprobe não encontrado no sistema.'));
    }

    if (!fs.existsSync(filePath)) {
      return reject(new Error('Arquivo não encontrado: ' + filePath));
    }

    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration,size,bit_rate:stream=index,codec_name,codec_type,channels,width,height,r_frame_rate,disposition:stream_tags=language,title',
      '-of', 'json',
      filePath
    ];

    let stdout = '';
    let stderr = '';

    const child = spawn(ffprobePath, args, { windowsHide: true });

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      reject(new Error(`Falha ao executar FFprobe: ${err.message}`));
    });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Erro ao analisar arquivo (código ${code}): ${stderr || 'Arquivo corrompido ou formato inválido'}`));
      }

      try {
        const info = JSON.parse(stdout);
        const format = info.format || {};
        const streams = info.streams || [];

        const duration = parseFloat(format.duration) || 0;
        const size = parseInt(format.size, 10) || (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0);

        // Filter valid video streams (ignoring attached picture / cover art)
        const videoStreams = streams.filter(s => s.codec_type === 'video' && (!s.disposition || s.disposition.attached_pic !== 1));
        const audioStreams = streams.filter(s => s.codec_type === 'audio');
        const subtitleStreams = streams.filter(s => s.codec_type === 'subtitle');

        const primaryVideo = videoStreams[0] || null;
        const videoCodec = primaryVideo ? primaryVideo.codec_name.toLowerCase() : null;
        const resolution = primaryVideo ? `${primaryVideo.width}x${primaryVideo.height}` : null;

        const detailedAudioTracks = audioStreams.map((a, idx) => ({
          trackIndex: idx,
          streamIndex: a.index,
          codec: (a.codec_name || 'unknown').toLowerCase(),
          channels: a.channels || 2,
          channelLayout: a.channel_layout || (a.channels === 6 ? '5.1' : (a.channels === 8 ? '7.1' : (a.channels === 2 ? 'stereo' : `${a.channels}ch`))),
          language: (a.tags && (a.tags.language || a.tags.LANGUAGE)) ? (a.tags.language || a.tags.LANGUAGE).toLowerCase() : 'und',
          title: (a.tags && (a.tags.title || a.tags.TITLE)) ? (a.tags.title || a.tags.TITLE) : '',
          isDefault: a.disposition ? a.disposition.default === 1 : false
        }));

        const detailedSubtitleTracks = subtitleStreams.map((s, idx) => {
          const codec = (s.codec_name || 'unknown').toLowerCase();
          return {
            trackIndex: idx,
            streamIndex: s.index,
            codec,
            isPgs: codec.includes('pgs') || codec.includes('dvd'),
            isText: isTextSubtitle(codec),
            language: (s.tags && (s.tags.language || s.tags.LANGUAGE)) ? (s.tags.language || s.tags.LANGUAGE).toLowerCase() : 'und',
            title: (s.tags && (s.tags.title || s.tags.TITLE)) ? (s.tags.title || s.tags.TITLE) : '',
            isDefault: s.disposition ? s.disposition.default === 1 : false
          };
        });

        const audioCodecs = detailedAudioTracks.map(a => a.codec);
        const subtitleCodecs = detailedSubtitleTracks.map(s => s.codec);

        // Check PGS or DVD image subtitles
        const hasPgs = detailedSubtitleTracks.some(s => s.isPgs);
        const textSubtitleCount = detailedSubtitleTracks.filter(s => s.isText).length;

        // Codec compatibility for standard MP4
        const mp4VideoCodecs = ['h264', 'hevc', 'h265', 'av1', 'mpeg4'];
        const mp4AudioCodecs = ['aac', 'ac3', 'eac3', 'mp3'];

        const isVideoCompatible = videoCodec && mp4VideoCodecs.includes(videoCodec);
        const isAudioCompatible = audioCodecs.length > 0 && audioCodecs.every(c => mp4AudioCodecs.includes(c));

        let recommendedMode = 'reencode';
        if (isVideoCompatible && isAudioCompatible) {
          recommendedMode = 'remux';
        } else if (isVideoCompatible && !isAudioCompatible) {
          recommendedMode = 'copy_v_encode_a'; // Keep video copy, convert audio to AAC
        }

        resolve({
          path: filePath,
          duration,
          size,
          videoCodec,
          audioCodecs,
          subtitleCodecs,
          hasPgs,
          textSubtitleCount,
          resolution,
          recommendedMode,
          videoStreamIndex: primaryVideo ? primaryVideo.index : null,
          audioStreamIndices: audioStreams.map(a => a.index),
          subtitleStreams: subtitleStreams.map(s => ({ index: s.index, codec: s.codec_name })),
          audioTracks: detailedAudioTracks,
          subtitleTracks: detailedSubtitleTracks
        });
      } catch (e) {
        reject(new Error('Erro ao processar dados de metadados: ' + e.message));
      }
    });
  });
}

function isTextSubtitle(codec) {
  if (!codec) return false;
  const c = codec.toLowerCase();
  return c === 'subrip' || c === 'srt' || c === 'ass' || c === 'ssa' || c === 'mov_text' || c === 'webvtt' || c === 'text';
}

function resolveOutputPath(inputPath, settings) {
  let targetDir = path.dirname(inputPath);
  if (settings.outputFolderMode === 'custom' && settings.customFolderPath && fs.existsSync(settings.customFolderPath)) {
    targetDir = settings.customFolderPath;
  }

  const parsed = path.parse(inputPath);
  const baseName = parsed.name;
  let finalPath = path.join(targetDir, `${baseName}.mp4`);

  if (settings.conflictMode === 'rename' && fs.existsSync(finalPath)) {
    let counter = 1;
    while (fs.existsSync(path.join(targetDir, `${baseName} (${counter}).mp4`))) {
      counter++;
    }
    finalPath = path.join(targetDir, `${baseName} (${counter}).mp4`);
  }

  return finalPath;
}

// Convert a single item
function convertItem(item, settings) {
  return new Promise((resolve) => {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      return resolve({
        id: item.id,
        status: 'erro',
        error: 'Binário do FFmpeg não encontrado.'
      });
    }

    const outputPath = resolveOutputPath(item.path, settings);
    const mode = settings.conversionMode || 'auto';

    // Track selection support (Dual Audio / Multi-subtitle)
    const selectedAudioIndices = Array.isArray(item.selectedAudioStreamIndices)
      ? item.selectedAudioStreamIndices
      : (item.probe?.audioStreamIndices || []);

    const selectedSubtitleIndices = Array.isArray(item.selectedSubtitleStreamIndices)
      ? item.selectedSubtitleStreamIndices
      : ((item.probe?.subtitleTracks || []).filter(s => s.isText).map(s => s.streamIndex));

    // Dynamic Remux Evaluation based on remaining selected audio tracks
    const mp4AudioCodecs = ['aac', 'ac3', 'eac3', 'mp3'];
    const mp4VideoCodecs = ['h264', 'hevc', 'h265', 'av1', 'mpeg4'];
    const selectedAudioTracks = (item.probe?.audioTracks || []).filter(a => selectedAudioIndices.includes(a.streamIndex));
    const areSelectedAudiosCompatible = selectedAudioTracks.length === 0 || selectedAudioTracks.every(a => mp4AudioCodecs.includes(a.codec));
    const isVideoCompatible = item.probe?.videoCodec && mp4VideoCodecs.includes(item.probe.videoCodec);

    let effectiveProfile = 'remux';
    if (mode === 'remux') {
      effectiveProfile = 'remux';
    } else if (mode === 'reencode') {
      effectiveProfile = 'reencode';
    } else {
      // Auto detection: if remaining selected audios are compatible, use instant Remux!
      if (isVideoCompatible && areSelectedAudiosCompatible) {
        effectiveProfile = 'remux';
      } else if (isVideoCompatible && !areSelectedAudiosCompatible) {
        effectiveProfile = 'copy_v_encode_a';
      } else {
        effectiveProfile = 'reencode';
      }
    }

    const args = [
      '-hide_banner',
      '-y',
      '-progress', 'pipe:1',
      '-nostats',
      '-i', item.path
    ];

    // Video stream mapping
    if (item.probe && item.probe.videoStreamIndex !== null) {
      args.push('-map', `0:${item.probe.videoStreamIndex}`);
    } else {
      args.push('-map', '0:v?');
    }

    // Audio stream mapping (mapped to selected tracks)
    if (selectedAudioIndices.length > 0) {
      for (const aIdx of selectedAudioIndices) {
        args.push('-map', `0:${aIdx}`);
      }
    } else {
      args.push('-an'); // No audio tracks requested
    }

    // Subtitle stream mapping (text subtitles to mov_text; ignore PGS to prevent MP4 container crash)
    const filteredSubIndices = selectedSubtitleIndices.filter(subIdx => {
      const subTrack = (item.probe?.subtitleTracks || []).find(s => s.streamIndex === subIdx);
      if (!subTrack) return false;
      if (settings.ignorePgs && subTrack.isPgs) return false;
      return subTrack.isText;
    });

    if (filteredSubIndices.length > 0) {
      for (const sIdx of filteredSubIndices) {
        args.push('-map', `0:${sIdx}`);
      }
      args.push('-c:s', 'mov_text');
    } else {
      args.push('-sn'); // Disable subtitle mapping if no compatible text subtitles selected
    }

    // Codecs assignment
    if (effectiveProfile === 'remux') {
      args.push('-c:v', 'copy');
      if (selectedAudioIndices.length > 0) args.push('-c:a', 'copy');
    } else if (effectiveProfile === 'copy_v_encode_a') {
      args.push('-c:v', 'copy');
      if (selectedAudioIndices.length > 0) args.push('-c:a', 'aac', '-b:a', '192k');
    } else {
      // Full re-encode
      const crf = String(settings.crf || 23);
      const preset = settings.preset || 'medium';
      args.push('-c:v', 'libx264', '-crf', crf, '-preset', preset, '-pix_fmt', 'yuv420p');
      if (selectedAudioIndices.length > 0) args.push('-c:a', 'aac', '-b:a', '192k');
    }

    // HEVC tag compatibility in MP4 for Windows & QuickTime
    if (item.probe && (item.probe.videoCodec === 'hevc' || item.probe.videoCodec === 'h265')) {
      args.push('-tag:v', 'hvc1');
    }

    // Place MP4 moov atom at beginning for instant playback
    args.push('-movflags', '+faststart');
    args.push(outputPath);

    console.log(`[MKV2MP4] Starting conversion for "${item.name}":`, args.join(' '));

    let child = null;
    let stderr = '';
    const totalDuration = item.probe ? item.probe.duration : (item.duration || 0);

    try {
      child = spawn(ffmpegPath, args, { windowsHide: true });
    } catch (err) {
      return resolve({
        id: item.id,
        status: 'erro',
        error: `Falha ao iniciar processo: ${err.message}`
      });
    }

    activeProcesses.set(item.id, {
      process: child,
      outputPath,
      inputPath: item.path,
      cancelled: false
    });

    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ffmpeg:itemStatus', {
        id: item.id,
        status: 'convertendo',
        outputPath,
        effectiveProfile
      });
    }

    // Line parser for FFmpeg progress pipe
    let stdoutBuffer = '';
    let currentSpeed = '1.0x';
    let currentOutTimeUs = 0;

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop(); // keep last incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [key, value] = trimmed.split('=');
        if (!key || value === undefined) continue;

        if (key === 'out_time_us') {
          const us = parseInt(value, 10);
          if (!isNaN(us)) {
            currentOutTimeUs = us;
          }
        } else if (key === 'speed') {
          currentSpeed = value.trim();
        } else if (key === 'progress') {
          const currentSec = currentOutTimeUs / 1000000;
          let percent = 0;
          let etaSec = 0;

          if (totalDuration > 0) {
            percent = Math.min(99.9, Math.max(0, (currentSec / totalDuration) * 100));
            const speedMultiplier = parseFloat(currentSpeed.replace('x', '')) || 1.0;
            if (speedMultiplier > 0) {
              const remainingVideoSec = Math.max(0, totalDuration - currentSec);
              etaSec = Math.round(remainingVideoSec / speedMultiplier);
            }
          }

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ffmpeg:progress', {
              id: item.id,
              percent,
              speed: currentSpeed,
              etaSec,
              currentSec,
              totalDuration
            });
          }
        }
      }
    });

    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });

    child.on('error', (err) => {
      console.error(`[MKV2MP4] Process error for "${item.name}":`, err);
    });

    child.on('close', async (code) => {
      const entry = activeProcesses.get(item.id);
      activeProcesses.delete(item.id);

      if (entry && entry.cancelled) {
        // Clean up partial output file
        if (fs.existsSync(outputPath)) {
          try { fs.unlinkSync(outputPath); } catch (_) {}
        }
        return resolve({
          id: item.id,
          status: 'cancelado',
          error: 'Conversão cancelada pelo usuário.'
        });
      }

      if (code === 0) {
        // Verify output file exists and has content
        if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          // If delete original enabled
          if (settings.deleteOriginal) {
            try {
              if (fs.existsSync(item.path)) {
                fs.unlinkSync(item.path);
                console.log(`[MKV2MP4] Original deleted: ${item.path}`);
              }
            } catch (delErr) {
              console.error(`[MKV2MP4] Failed to delete original:`, delErr);
            }
          }

          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('ffmpeg:progress', {
              id: item.id,
              percent: 100,
              speed: currentSpeed,
              etaSec: 0,
              currentSec: totalDuration,
              totalDuration
            });
          }

          return resolve({
            id: item.id,
            status: 'concluído',
            outputPath
          });
        } else {
          return resolve({
            id: item.id,
            status: 'erro',
            error: 'Arquivo gerado vazio ou não encontrado após conversão.'
          });
        }
      } else {
        // Clean partial file
        if (fs.existsSync(outputPath)) {
          try { fs.unlinkSync(outputPath); } catch (_) {}
        }

        let userMsg = 'Erro durante a conversão.';
        if (stderr.includes('No space left on device') || stderr.includes('disk full')) {
          userMsg = 'Espaço em disco insuficiente na partição de destino.';
        } else if (stderr.includes('Invalid data found') || stderr.includes('corrupt')) {
          userMsg = 'Arquivo corrompido ou formato de dados inválido.';
        } else if (stderr.includes('Permission denied')) {
          userMsg = 'Permissão negada ao gravar no destino especificado.';
        } else {
          const lines = stderr.trim().split('\n').filter(l => l.includes('Error') || l.includes('error') || l.includes('failed'));
          if (lines.length > 0) {
            userMsg = lines[lines.length - 1].trim();
          }
        }

        return resolve({
          id: item.id,
          status: 'erro',
          error: userMsg
        });
      }
    });
  });
}

// Queue execution loop with configurable concurrency (1 to 3)
async function processQueue() {
  if (isQueueRunning) return;
  isQueueRunning = true;
  completedCount = 0;
  errorCount = 0;

  const concurrency = Math.min(3, Math.max(1, queueSettings.concurrency || 1));

  async function worker() {
    while (isQueueRunning) {
      const nextItem = queueItems.find(i => i.status === 'aguardando');
      if (!nextItem) break;

      nextItem.status = 'convertendo';
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ffmpeg:itemStatus', {
          id: nextItem.id,
          status: 'convertendo'
        });
      }

      const result = await convertItem(nextItem, queueSettings);
      nextItem.status = result.status;
      nextItem.outputPath = result.outputPath;
      nextItem.error = result.error;

      if (result.status === 'concluído') {
        completedCount++;
      } else if (result.status === 'erro') {
        errorCount++;
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ffmpeg:itemStatus', {
          id: nextItem.id,
          status: result.status,
          outputPath: result.outputPath,
          error: result.error
        });
      }
    }
  }

  const workers = [];
  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  isQueueRunning = false;

  // Notify Windows
  if (Notification.isSupported()) {
    try {
      const notif = new Notification({
        title: 'MKV2MP4',
        body: errorCount === 0
          ? `Todas as conversões foram concluídas com sucesso (${completedCount} arquivos)!`
          : `Fila finalizada: ${completedCount} concluído(s) e ${errorCount} com erro.`
      });
      notif.show();
    } catch (e) {
      console.error('[MKV2MP4] Notification error:', e);
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ffmpeg:queueFinished', {
      completedCount,
      errorCount,
      totalCount: queueItems.length
    });
  }
}

// IPC Handlers
ipcMain.handle('settings:get', () => {
  return loadSettings();
});

ipcMain.handle('settings:save', (_event, newSettings) => {
  return saveSettings(newSettings);
});

ipcMain.handle('dialog:selectFiles', async () => {
  if (!mainWindow) return [];
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecionar arquivos MKV',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Vídeos Matroska (*.mkv)', extensions: ['mkv'] },
      { name: 'Todos os arquivos', extensions: ['*'] }
    ]
  });
  if (result.canceled) return [];
  return result.filePaths.filter(f => f.toLowerCase().endsWith('.mkv'));
});

ipcMain.handle('dialog:selectFolder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecionar pasta de saída',
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('ffmpeg:probeFiles', async (_event, filePaths) => {
  const results = [];
  for (const fp of filePaths) {
    try {
      const probe = await probeSingleFile(fp);
      results.push({ success: true, path: fp, probe });
    } catch (err) {
      results.push({ success: false, path: fp, error: err.message });
    }
  }
  return results;
});

ipcMain.handle('ffmpeg:startQueue', async (_event, { items, settings }) => {
  queueItems = items;
  queueSettings = settings || loadSettings();
  processQueue();
  return { success: true };
});

ipcMain.handle('ffmpeg:cancelItem', async (_event, id) => {
  const entry = activeProcesses.get(id);
  if (entry) {
    entry.cancelled = true;
    try {
      entry.process.kill('SIGTERM');
    } catch (_) {
      try { entry.process.kill(); } catch (__) {}
    }
  }
  const item = queueItems.find(i => i.id === id);
  if (item && item.status === 'aguardando') {
    item.status = 'cancelado';
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('ffmpeg:itemStatus', {
        id: item.id,
        status: 'cancelado'
      });
    }
  }
  return { success: true };
});

ipcMain.handle('ffmpeg:cancelAll', async () => {
  isQueueRunning = false;
  for (const item of queueItems) {
    if (item.status === 'aguardando') {
      item.status = 'cancelado';
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('ffmpeg:itemStatus', {
          id: item.id,
          status: 'cancelado'
        });
      }
    }
  }

  for (const [id, entry] of activeProcesses.entries()) {
    entry.cancelled = true;
    try {
      entry.process.kill('SIGTERM');
    } catch (_) {
      try { entry.process.kill(); } catch (__) {}
    }
  }
  activeProcesses.clear();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('ffmpeg:queueFinished', {
      completedCount,
      errorCount,
      totalCount: queueItems.length,
      cancelled: true
    });
  }

  return { success: true };
});

ipcMain.handle('shell:openPath', async (_event, targetPath) => {
  if (targetPath) {
    let folder = targetPath;
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
      folder = path.dirname(targetPath);
    }
    await shell.openPath(folder);
  }
});

ipcMain.handle('shell:showItemInFolder', async (_event, filePath) => {
  if (filePath && fs.existsSync(filePath)) {
    shell.showItemInFolder(filePath);
  }
});

ipcMain.handle('fs:deleteOriginal', async (_event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return { success: true };
    }
    return { success: false, error: 'Arquivo não encontrado' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('system:info', async () => {
  const getVer = (bin) => new Promise((res) => {
    if (!bin || !fs.existsSync(bin)) return res('Não encontrado');
    const c = spawn(bin, ['-version'], { windowsHide: true });
    let out = '';
    c.stdout.on('data', d => { out += d.toString(); });
    c.on('close', () => {
      const firstLine = out.split('\n')[0] || 'Desconhecido';
      res(firstLine.trim());
    });
    c.on('error', () => res('Erro ao executar'));
  });

  const [ffmpegVer, ffprobeVer] = await Promise.all([
    getVer(ffmpegPath),
    getVer(ffprobePath)
  ]);

  return {
    ffmpegVersion: ffmpegVer,
    ffprobeVersion: ffprobeVer,
    ffmpegPath,
    ffprobePath
  };
});

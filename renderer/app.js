// MKV2MP4 — Application Logic

(function () {
  'use strict';

  // State
  let queue = [];
  let settings = {
    outputFolderMode: 'same',
    customFolderPath: '',
    conflictMode: 'rename',
    conversionMode: 'auto',
    crf: 23,
    preset: 'medium',
    concurrency: 1,
    deleteOriginal: false,
    ignorePgs: true
  };
  let isProcessing = false;

  // DOM Elements
  const dropZone = document.getElementById('drop-zone');
  const btnSelectFiles = document.getElementById('btn-select-files');
  const btnStart = document.getElementById('btn-start');
  const btnCancelCurrent = document.getElementById('btn-cancel-current');
  const btnCancelAll = document.getElementById('btn-cancel-all');
  const btnClearCompleted = document.getElementById('btn-clear-completed');
  const btnOpenFolder = document.getElementById('btn-open-folder');

  const queueCount = document.getElementById('queue-count');
  const queueStatusText = document.getElementById('queue-status-text');
  const queueList = document.getElementById('queue-list');
  const emptyState = document.getElementById('empty-state');

  const overallProgressCard = document.getElementById('overall-progress-container');
  const overallProgressFill = document.getElementById('overall-progress-fill');
  const overallProgressLabel = document.getElementById('overall-progress-label');
  const overallProgressStats = document.getElementById('overall-progress-stats');

  const customFolderRow = document.getElementById('custom-folder-row');
  const customFolderInput = document.getElementById('custom-folder-input');
  const btnBrowseFolder = document.getElementById('btn-browse-folder');
  const selectCrf = document.getElementById('select-crf');
  const selectPreset = document.getElementById('select-preset');
  const selectConflict = document.getElementById('select-conflict');
  const checkIgnorePgs = document.getElementById('check-ignore-pgs');
  const checkDeleteOriginal = document.getElementById('check-delete-original');
  const systemInfoText = document.getElementById('system-info-text');

  // Modals
  const modalDeleteConfirm = document.getElementById('modal-delete-confirm');
  const modalCancelDelete = document.getElementById('modal-cancel-delete');
  const modalConfirmDelete = document.getElementById('modal-confirm-delete');

  const modalErrorDetails = document.getElementById('modal-error-details');
  const modalErrorMessage = document.getElementById('modal-error-message');
  const modalCloseError = document.getElementById('modal-close-error');

  // Initialization
  async function init() {
    await loadSettings();
    await loadSystemInfo();
    setupEventListeners();
    setupIpcListeners();
    renderQueue();
  }

  // Load and apply settings
  async function loadSettings() {
    try {
      const saved = await window.electronAPI.getSettings();
      if (saved) {
        settings = { ...settings, ...saved };
      }
    } catch (e) {
      console.error('Falha ao carregar configurações:', e);
    }

    // Apply to UI
    const convRadio = document.querySelector(`input[name="conversionMode"][value="${settings.conversionMode}"]`);
    if (convRadio) convRadio.checked = true;

    const outRadio = document.querySelector(`input[name="outputFolderMode"][value="${settings.outputFolderMode}"]`);
    if (outRadio) outRadio.checked = true;

    if (settings.outputFolderMode === 'custom') {
      customFolderRow.classList.remove('hidden');
    } else {
      customFolderRow.classList.add('hidden');
    }
    customFolderInput.value = settings.customFolderPath || '';

    selectCrf.value = String(settings.crf || 23);
    selectPreset.value = settings.preset || 'medium';
    selectConflict.value = settings.conflictMode || 'rename';
    checkIgnorePgs.checked = settings.ignorePgs !== false;
    checkDeleteOriginal.checked = Boolean(settings.deleteOriginal);

    document.querySelectorAll('.seg-btn').forEach(btn => {
      if (parseInt(btn.dataset.val, 10) === settings.concurrency) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });
  }

  async function persistSettings() {
    try {
      await window.electronAPI.saveSettings(settings);
    } catch (e) {
      console.error('Falha ao salvar configurações:', e);
    }
  }

  async function loadSystemInfo() {
    try {
      const info = await window.electronAPI.getSystemInfo();
      if (info && info.ffmpegVersion) {
        const shortFfmpeg = info.ffmpegVersion.split(' ')[0] + ' ' + (info.ffmpegVersion.split(' ')[2] || '');
        systemInfoText.textContent = `FFmpeg ativo (${shortFfmpeg})`;
      }
    } catch (e) {
      systemInfoText.textContent = 'Binários estáticos carregados';
    }
  }

  // Event Listeners Setup
  function setupEventListeners() {
    // Drop zone & Window Drag & Drop
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
      window.addEventListener(eventName, preventDefaults, false);
      dropZone.addEventListener(eventName, preventDefaults, false);
    });

    ['dragenter', 'dragover'].forEach(eventName => {
      dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
      dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
    });

    dropZone.addEventListener('drop', handleDrop, false);
    dropZone.addEventListener('click', () => btnSelectFiles.click());
    btnSelectFiles.addEventListener('click', handleSelectFiles);

    // Queue action buttons
    btnStart.addEventListener('click', handleStartQueue);
    btnCancelCurrent.addEventListener('click', handleCancelCurrent);
    btnCancelAll.addEventListener('click', handleCancelAll);
    btnClearCompleted.addEventListener('click', handleClearCompleted);
    btnOpenFolder.addEventListener('click', handleOpenFolder);

    // Sidebar settings events
    document.querySelectorAll('input[name="conversionMode"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        settings.conversionMode = e.target.value;
        persistSettings();
      });
    });

    document.querySelectorAll('input[name="outputFolderMode"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
        settings.outputFolderMode = e.target.value;
        if (settings.outputFolderMode === 'custom') {
          customFolderRow.classList.remove('hidden');
        } else {
          customFolderRow.classList.add('hidden');
        }
        persistSettings();
      });
    });

    btnBrowseFolder.addEventListener('click', async () => {
      const folder = await window.electronAPI.selectFolder();
      if (folder) {
        settings.customFolderPath = folder;
        customFolderInput.value = folder;
        persistSettings();
      }
    });

    selectCrf.addEventListener('change', (e) => {
      settings.crf = parseInt(e.target.value, 10);
      persistSettings();
    });

    selectPreset.addEventListener('change', (e) => {
      settings.preset = e.target.value;
      persistSettings();
    });

    selectConflict.addEventListener('change', (e) => {
      settings.conflictMode = e.target.value;
      persistSettings();
    });

    document.querySelectorAll('.seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        settings.concurrency = parseInt(btn.dataset.val, 10);
        persistSettings();
      });
    });

    checkIgnorePgs.addEventListener('change', (e) => {
      settings.ignorePgs = e.target.checked;
      persistSettings();
    });

    // Delete Original with Confirmation Modal
    checkDeleteOriginal.addEventListener('click', (e) => {
      if (checkDeleteOriginal.checked) {
        e.preventDefault();
        modalDeleteConfirm.classList.remove('hidden');
      } else {
        settings.deleteOriginal = false;
        persistSettings();
      }
    });

    modalConfirmDelete.addEventListener('click', () => {
      checkDeleteOriginal.checked = true;
      settings.deleteOriginal = true;
      modalDeleteConfirm.classList.add('hidden');
      persistSettings();
    });

    modalCancelDelete.addEventListener('click', () => {
      checkDeleteOriginal.checked = false;
      modalDeleteConfirm.classList.add('hidden');
    });

    modalCloseError.addEventListener('click', () => {
      modalErrorDetails.classList.add('hidden');
    });
  }

  function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  // File Handlers
  async function handleDrop(e) {
    const dt = e.dataTransfer;
    const files = dt.files;
    if (!files || files.length === 0) return;

    const filePaths = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.path && file.path.toLowerCase().endsWith('.mkv')) {
        filePaths.push(file.path);
      }
    }

    if (filePaths.length > 0) {
      await addFilesToQueue(filePaths);
    }
  }

  async function handleSelectFiles() {
    const filePaths = await window.electronAPI.selectFiles();
    if (filePaths && filePaths.length > 0) {
      await addFilesToQueue(filePaths);
    }
  }

  async function addFilesToQueue(filePaths) {
    // Avoid adding exact duplicate active paths
    const newPaths = filePaths.filter(p => !queue.some(item => item.path === p && item.status !== 'concluído'));
    if (newPaths.length === 0) return;

    const newItems = newPaths.map(p => {
      const name = p.split(/[\\/]/).pop();
      return {
        id: 'item_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        path: p,
        name: name,
        size: 0,
        formattedSize: '--',
        duration: 0,
        formattedDuration: '--:--',
        videoCodec: null,
        audioCodecs: [],
        subtitleCodecs: [],
        hasPgs: false,
        resolution: null,
        status: 'analisando', // initial probing state
        progress: 0,
        speed: '--',
        etaSec: 0,
        outputPath: null,
        error: null,
        probe: null
      };
    });

    queue.push(...newItems);
    renderQueue();
    updateButtonStates();

    // Run FFprobe in parallel/batch
    const probeResults = await window.electronAPI.probeFiles(newPaths);
    for (const res of probeResults) {
      const item = queue.find(i => i.path === res.path && i.status === 'analisando');
      if (!item) continue;

      if (res.success && res.probe) {
        item.probe = res.probe;
        item.size = res.probe.size || 0;
        item.formattedSize = formatBytes(item.size);
        item.duration = res.probe.duration || 0;
        item.formattedDuration = formatDuration(item.duration);
        item.videoCodec = res.probe.videoCodec;
        item.audioCodecs = res.probe.audioCodecs || [];
        item.subtitleCodecs = res.probe.subtitleCodecs || [];
        item.hasPgs = Boolean(res.probe.hasPgs);
        item.resolution = res.probe.resolution;

        // Track selection defaults (Dual Audio / Subtitles)
        item.selectedAudioStreamIndices = (res.probe.audioTracks || []).map(a => a.streamIndex);
        item.selectedSubtitleStreamIndices = (res.probe.subtitleTracks || []).filter(s => s.isText).map(s => s.streamIndex);
        item.isTracksDrawerOpen = false;

        item.status = 'aguardando';
      } else {
        item.status = 'erro';
        item.error = res.error || 'Falha ao analisar metadados com FFprobe';
      }
    }

    renderQueue();
    updateButtonStates();
  }

  // Queue Operations
  async function handleStartQueue() {
    const pendingItems = queue.filter(i => i.status === 'aguardando');
    if (pendingItems.length === 0) return;

    isProcessing = true;
    updateButtonStates();
    overallProgressCard.classList.remove('hidden');
    updateOverallProgress();

    await window.electronAPI.startQueue(queue, settings);
  }

  async function handleCancelCurrent() {
    const currentItem = queue.find(i => i.status === 'convertendo');
    if (currentItem) {
      await window.electronAPI.cancelItem(currentItem.id);
    }
  }

  async function handleCancelAll() {
    await window.electronAPI.cancelAll();
    isProcessing = false;
    updateButtonStates();
  }

  function handleClearCompleted() {
    queue = queue.filter(i => i.status !== 'concluído' && i.status !== 'cancelado');
    renderQueue();
    updateButtonStates();
  }

  async function handleOpenFolder() {
    let target = null;
    if (settings.outputFolderMode === 'custom' && settings.customFolderPath) {
      target = settings.customFolderPath;
    } else {
      const doneItem = queue.find(i => i.outputPath && i.status === 'concluído');
      if (doneItem) {
        target = doneItem.outputPath;
      } else if (queue.length > 0) {
        target = queue[0].path;
      }
    }

    if (target) {
      await window.electronAPI.openPath(target);
    }
  }

  // IPC Event Listeners
  function setupIpcListeners() {
    window.electronAPI.onProgress((data) => {
      const item = queue.find(i => i.id === data.id);
      if (item) {
        item.progress = Math.min(100, Math.max(0, data.percent));
        item.speed = data.speed || '1.0x';
        item.etaSec = data.etaSec || 0;
        updateItemProgress(item);
      }
      updateOverallProgress();
    });

    window.electronAPI.onItemStatus((data) => {
      const item = queue.find(i => i.id === data.id);
      if (item) {
        item.status = data.status;
        if (data.outputPath) item.outputPath = data.outputPath;
        if (data.error) item.error = data.error;
        if (data.effectiveProfile) item.effectiveProfile = data.effectiveProfile;
        renderQueue();
      }
      updateButtonStates();
    });

    window.electronAPI.onQueueFinished((data) => {
      isProcessing = false;
      updateButtonStates();
      renderQueue();

      if (data.cancelled) {
        queueStatusText.textContent = 'Conversão cancelada pelo usuário';
      } else {
        queueStatusText.textContent = `Fila finalizada: ${data.completedCount} concluído(s), ${data.errorCount} erro(s)`;
      }

      setTimeout(() => {
        if (!isProcessing) {
          overallProgressCard.classList.add('hidden');
        }
      }, 5000);
    });
  }

  // Rendering
  function renderQueue() {
    queueCount.textContent = queue.length;

    if (queue.length === 0) {
      emptyState.classList.remove('hidden');
      queueList.innerHTML = '';
      queueStatusText.textContent = 'Pronto para conversão';
      return;
    }

    emptyState.classList.add('hidden');

    const pending = queue.filter(i => i.status === 'aguardando').length;
    const converting = queue.filter(i => i.status === 'convertendo').length;
    const done = queue.filter(i => i.status === 'concluído').length;

    if (converting > 0) {
      queueStatusText.textContent = `Processando (${converting} ativo, ${pending} restante)`;
    } else if (done > 0 && pending === 0) {
      queueStatusText.textContent = `Todos concluídos (${done})`;
    } else {
      queueStatusText.textContent = `${pending} aguardando conversão`;
    }

    queueList.innerHTML = queue.map(item => createItemCardHtml(item)).join('');

    // Attach card event listeners
    queue.forEach(item => {
      const card = document.getElementById(`card-${item.id}`);
      if (!card) return;

      const btnCancel = card.querySelector('.btn-item-cancel');
      if (btnCancel) {
        btnCancel.addEventListener('click', () => window.electronAPI.cancelItem(item.id));
      }

      const btnOpen = card.querySelector('.btn-item-open');
      if (btnOpen && item.outputPath) {
        btnOpen.addEventListener('click', () => window.electronAPI.showItemInFolder(item.outputPath));
      }

      const btnRemove = card.querySelector('.btn-item-remove');
      if (btnRemove) {
        btnRemove.addEventListener('click', () => {
          queue = queue.filter(i => i.id !== item.id);
          renderQueue();
          updateButtonStates();
        });
      }

      const statusBadge = card.querySelector('.status-badge');
      if (statusBadge && item.status === 'erro' && item.error) {
        statusBadge.addEventListener('click', () => {
          modalErrorMessage.textContent = item.error;
          modalErrorDetails.classList.remove('hidden');
        });
      }

      // Track drawer toggle
      const btnTracks = card.querySelector('.btn-toggle-tracks');
      const drawer = card.querySelector('.item-tracks-drawer');
      if (btnTracks && drawer) {
        btnTracks.addEventListener('click', (e) => {
          e.stopPropagation();
          item.isTracksDrawerOpen = !item.isTracksDrawerOpen;
          drawer.classList.toggle('hidden', !item.isTracksDrawerOpen);
          btnTracks.classList.toggle('open', item.isTracksDrawerOpen);
        });
      }

      // Checkbox changes for audio
      card.querySelectorAll('.chk-audio-track').forEach(chk => {
        chk.addEventListener('change', () => {
          const sIdx = parseInt(chk.dataset.streamIndex, 10);
          if (chk.checked) {
            if (!item.selectedAudioStreamIndices.includes(sIdx)) {
              item.selectedAudioStreamIndices.push(sIdx);
            }
          } else {
            item.selectedAudioStreamIndices = item.selectedAudioStreamIndices.filter(i => i !== sIdx);
          }
          renderQueue();
        });
      });

      // Checkbox changes for subtitles
      card.querySelectorAll('.chk-sub-track').forEach(chk => {
        chk.addEventListener('change', () => {
          const sIdx = parseInt(chk.dataset.streamIndex, 10);
          if (chk.checked) {
            if (!item.selectedSubtitleStreamIndices.includes(sIdx)) {
              item.selectedSubtitleStreamIndices.push(sIdx);
            }
          } else {
            item.selectedSubtitleStreamIndices = item.selectedSubtitleStreamIndices.filter(i => i !== sIdx);
          }
          renderQueue();
        });
      });

      // Mini action buttons
      const btnAudioAll = card.querySelector('.btn-audio-all');
      if (btnAudioAll && item.probe) {
        btnAudioAll.addEventListener('click', (e) => {
          e.stopPropagation();
          item.selectedAudioStreamIndices = (item.probe.audioTracks || []).map(a => a.streamIndex);
          renderQueue();
        });
      }

      const btnAudioFirst = card.querySelector('.btn-audio-first');
      if (btnAudioFirst && item.probe && item.probe.audioTracks && item.probe.audioTracks.length > 0) {
        btnAudioFirst.addEventListener('click', (e) => {
          e.stopPropagation();
          item.selectedAudioStreamIndices = [item.probe.audioTracks[0].streamIndex];
          renderQueue();
        });
      }

      const btnSubAll = card.querySelector('.btn-sub-all');
      if (btnSubAll && item.probe) {
        btnSubAll.addEventListener('click', (e) => {
          e.stopPropagation();
          item.selectedSubtitleStreamIndices = (item.probe.subtitleTracks || []).filter(s => s.isText).map(s => s.streamIndex);
          renderQueue();
        });
      }

      const btnSubNone = card.querySelector('.btn-sub-none');
      if (btnSubNone) {
        btnSubNone.addEventListener('click', (e) => {
          e.stopPropagation();
          item.selectedSubtitleStreamIndices = [];
          renderQueue();
        });
      }
    });
  }

  function createItemCardHtml(item) {
    const isDone = item.status === 'concluído';
    const isError = item.status === 'erro';
    const isActive = item.status === 'convertendo';
    const isAnalyzing = item.status === 'analisando';

    let cardClass = 'queue-item';
    if (isActive) cardClass += ' active';
    if (isDone) cardClass += ' done';
    if (isError) cardClass += ' error';

    const audioTracks = (item.probe && item.probe.audioTracks) || [];
    const subtitleTracks = (item.probe && item.probe.subtitleTracks) || [];
    const selectedAudios = item.selectedAudioStreamIndices || [];
    const selectedSubs = item.selectedSubtitleStreamIndices || [];

    // Codec compatibility calculations for dynamic Remux Turbo
    const mp4AudioCodecs = ['aac', 'ac3', 'eac3', 'mp3'];
    const mp4VideoCodecs = ['h264', 'hevc', 'h265', 'av1', 'mpeg4'];
    const selAudioTracks = audioTracks.filter(a => selectedAudios.includes(a.streamIndex));
    const isDynamicRemux = selAudioTracks.length > 0 &&
      selAudioTracks.every(a => mp4AudioCodecs.includes(a.codec)) &&
      mp4VideoCodecs.includes(item.videoCodec);

    // Tags
    let tagsHtml = '';
    if (item.videoCodec) {
      tagsHtml += `<span class="tag tag-codec">${escapeHtml(item.videoCodec)}</span>`;
    }
    if (item.resolution) {
      tagsHtml += `<span class="tag">${escapeHtml(item.resolution)}</span>`;
    }
    if (isDynamicRemux) {
      tagsHtml += `<span class="tag" style="background: rgba(16, 185, 129, 0.18); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.35);">⚡ Remux Rápido</span>`;
    } else if (item.audioCodecs && item.audioCodecs.length > 0) {
      tagsHtml += `<span class="tag">${escapeHtml(item.audioCodecs.join(', '))}</span>`;
    }
    if (item.hasPgs) {
      tagsHtml += `<span class="tag tag-pgs" title="Legenda PGS incompatível com MP4 - será ignorada para evitar erro">PGS Detectada</span>`;
    }

    // Toggle button for tracks
    let toggleTracksBtnHtml = '';
    if (audioTracks.length > 0 || subtitleTracks.length > 0) {
      const audiosText = `${selectedAudios.length}/${audioTracks.length} áudio${audioTracks.length > 1 ? 's' : ''}`;
      const subsText = subtitleTracks.length > 0 ? ` • ${selectedSubs.length}/${subtitleTracks.length} leg.` : '';
      toggleTracksBtnHtml = `
        <button type="button" class="btn-toggle-tracks ${item.isTracksDrawerOpen ? 'open' : ''}" data-item-id="${item.id}" title="Escolher faixas de áudio e legendas">
          <span>Faixas (${audiosText}${subsText})</span>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="6 9 12 15 18 9"/>
          </svg>
        </button>
      `;
    }

    // Status Badge
    let statusText = item.status;
    if (isAnalyzing) statusText = 'Analisando...';
    if (isActive) statusText = 'Convertendo';
    if (isDone) statusText = 'Concluído';
    if (isError) statusText = 'Erro (Clique para ver)';
    if (item.status === 'cancelado') statusText = 'Cancelado';
    if (item.status === 'aguardando') statusText = 'Aguardando';

    // Item Action Buttons
    let actionButtonsHtml = '';
    if (isActive) {
      actionButtonsHtml += `
        <button class="action-icon-btn btn-item-cancel" title="Cancelar este vídeo">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      `;
    } else if (isDone) {
      actionButtonsHtml += `
        <button class="action-icon-btn btn-item-open" title="Mostrar na pasta">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        </button>
      `;
    } else {
      actionButtonsHtml += `
        <button class="action-icon-btn btn-item-remove" title="Remover da fila">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </button>
      `;
    }

    // Audio list markup for drawer
    const audioRowsHtml = audioTracks.map((a) => {
      const isChecked = selectedAudios.includes(a.streamIndex);
      const langName = formatLangName(a.language);
      const isAacOrMp3 = mp4AudioCodecs.includes(a.codec);
      return `
        <label class="track-row" title="Clique para alternar esta faixa de áudio">
          <input type="checkbox" class="chk-audio-track" data-item-id="${item.id}" data-stream-index="${a.streamIndex}" ${isChecked ? 'checked' : ''} ${isActive ? 'disabled' : ''}>
          <span class="track-lang">${escapeHtml(a.language || 'UND')}</span>
          <span class="track-details"><strong>${escapeHtml(langName)}</strong> • ${escapeHtml(a.codec.toUpperCase())} (${escapeHtml(a.channelLayout)})${a.title ? ` • ${escapeHtml(a.title)}` : ''}</span>
          <div class="track-badges-col">
            ${a.isDefault ? '<span class="track-badge default">Padrão</span>' : ''}
            ${isAacOrMp3 ? '<span class="track-badge codec">Remux OK</span>' : '<span class="track-badge warn">Re-encode AAC</span>'}
          </div>
        </label>
      `;
    }).join('');

    // Subtitle list markup for drawer
    const subRowsHtml = subtitleTracks.map((s) => {
      const isChecked = selectedSubs.includes(s.streamIndex);
      const langName = formatLangName(s.language);
      return `
        <label class="track-row" title="${s.isPgs ? 'Legenda gráfica PGS incompatível com container MP4' : 'Clique para alternar esta legenda'}">
          <input type="checkbox" class="chk-sub-track" data-item-id="${item.id}" data-stream-index="${s.streamIndex}" ${isChecked ? 'checked' : ''} ${s.isPgs || isActive ? 'disabled' : ''}>
          <span class="track-lang">${escapeHtml(s.language || 'UND')}</span>
          <span class="track-details"><strong>${escapeHtml(langName)}</strong> • ${escapeHtml(s.codec.toUpperCase())}${s.title ? ` • ${escapeHtml(s.title)}` : ''}</span>
          <div class="track-badges-col">
            ${s.isDefault ? '<span class="track-badge default">Padrão</span>' : ''}
            ${s.isPgs ? '<span class="track-badge warn">PGS (Incompatível)</span>' : '<span class="track-badge codec">mov_text</span>'}
          </div>
        </label>
      `;
    }).join('');

    // Progress bar for active / done
    const percent = item.progress || (isDone ? 100 : 0);
    const speed = item.speed || '--';
    const etaFormatted = item.etaSec > 0 ? formatEta(item.etaSec) : '--';

    return `
      <div id="card-${item.id}" class="${cardClass}">
        <div class="item-header">
          <div class="item-main-info">
            <div class="file-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
                <polygon points="5 3 19 12 5 21 5 3"/>
              </svg>
            </div>
            <div>
              <div class="file-name" title="${escapeHtml(item.path)}">${escapeHtml(item.name)}</div>
              <div class="item-meta">
                <span>${item.formattedSize}</span>
                <span>•</span>
                <span>${item.formattedDuration}</span>
                <div class="item-tags">${tagsHtml}</div>
                ${toggleTracksBtnHtml}
              </div>
            </div>
          </div>

          <div class="item-status-col">
            <span class="status-badge ${item.status}">${statusText}</span>
            <div class="item-actions">
              ${actionButtonsHtml}
            </div>
          </div>
        </div>

        <!-- Expandable Track Selector Drawer -->
        <div class="item-tracks-drawer ${item.isTracksDrawerOpen ? '' : 'hidden'}" id="drawer-${item.id}">
          <div class="drawer-section">
            <div class="drawer-section-header">
              <span>Faixas de Áudio (${selectedAudios.length}/${audioTracks.length})</span>
              <div class="drawer-section-actions">
                <button type="button" class="btn-mini-action btn-audio-all">Todos</button>
                <button type="button" class="btn-mini-action btn-audio-first">Apenas Primeiro</button>
              </div>
            </div>
            <div class="track-list">
              ${audioRowsHtml || '<div class="text-dim">Nenhuma faixa de áudio detectada</div>'}
            </div>
          </div>

          ${subtitleTracks.length > 0 ? `
            <div class="drawer-section">
              <div class="drawer-section-header">
                <span>Faixas de Legenda (${selectedSubs.length}/${subtitleTracks.length})</span>
                <div class="drawer-section-actions">
                  <button type="button" class="btn-mini-action btn-sub-all">Todas de Texto</button>
                  <button type="button" class="btn-mini-action btn-sub-none">Sem Legendas</button>
                </div>
              </div>
              <div class="track-list">
                ${subRowsHtml}
              </div>
            </div>
          ` : ''}
        </div>

        ${isActive || isDone ? `
          <div class="item-progress-row">
            <div class="item-progress-stats">
              <span>${percent.toFixed(1)}% ${isActive ? `• Velocidade: ${speed}` : ''}</span>
              <span>${isActive ? `Restante: ${etaFormatted}` : (isDone ? 'Concluído com sucesso' : '')}</span>
            </div>
            <div class="item-progress-bg">
              <div class="item-progress-fill" style="width: ${percent}%"></div>
            </div>
          </div>
        ` : ''}
      </div>
    `;
  }

  function updateItemProgress(item) {
    const card = document.getElementById(`card-${item.id}`);
    if (!card) return;

    const fill = card.querySelector('.item-progress-fill');
    if (fill) {
      fill.style.width = `${item.progress.toFixed(1)}%`;
    }

    const stats = card.querySelectorAll('.item-progress-stats span');
    if (stats.length === 2) {
      stats[0].textContent = `${item.progress.toFixed(1)}% • Velocidade: ${item.speed}`;
      stats[1].textContent = item.etaSec > 0 ? `Restante: ${formatEta(item.etaSec)}` : 'Calculando...';
    }
  }

  function updateOverallProgress() {
    if (queue.length === 0) return;

    let totalDuration = 0;
    let completedDuration = 0;
    let activeSpeed = '1.0x';
    let maxEta = 0;

    queue.forEach(item => {
      const dur = item.duration || 100;
      totalDuration += dur;
      if (item.status === 'concluído') {
        completedDuration += dur;
      } else if (item.status === 'convertendo') {
        completedDuration += dur * ((item.progress || 0) / 100);
        if (item.speed) activeSpeed = item.speed;
        if (item.etaSec > maxEta) maxEta = item.etaSec;
      }
    });

    const percent = totalDuration > 0 ? Math.min(100, (completedDuration / totalDuration) * 100) : 0;
    overallProgressFill.style.width = `${percent.toFixed(1)}%`;
    overallProgressLabel.textContent = `Progresso Geral: ${percent.toFixed(1)}%`;
    overallProgressStats.textContent = `Velocidade: ${activeSpeed} | Restante estimado: ${maxEta > 0 ? formatEta(maxEta) : '--'}`;
  }

  function updateButtonStates() {
    const hasPending = queue.some(i => i.status === 'aguardando');
    const hasConverting = queue.some(i => i.status === 'convertendo');
    const hasDone = queue.some(i => i.status === 'concluído' || i.status === 'cancelado');

    btnStart.disabled = !hasPending || isProcessing;
    btnCancelCurrent.disabled = !hasConverting;
    btnCancelAll.disabled = !hasConverting && !hasPending;
    btnClearCompleted.disabled = !hasDone;
  }

  // Utilities
  function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }

  function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '--:--';
    const sec = Math.round(seconds);
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;

    const pad = (n) => String(n).padStart(2, '0');
    if (h > 0) {
      return `${pad(h)}:${pad(m)}:${pad(s)}`;
    }
    return `${pad(m)}:${pad(s)}`;
  }

  function formatEta(seconds) {
    if (!seconds || seconds <= 0) return '--';
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    if (m >= 60) {
      const h = Math.floor(m / 60);
      return `${h}h ${m % 60}m`;
    }
    return `${m}m ${s < 10 ? '0' : ''}${s}s`;
  }

  function formatLangName(code) {
    if (!code) return 'Indefinido';
    const c = code.toLowerCase().trim();
    const langMap = {
      'por': 'Português',
      'pt': 'Português',
      'pt-br': 'Português (Brasil)',
      'pob': 'Português (Brasil)',
      'eng': 'Inglês',
      'en': 'Inglês',
      'jpn': 'Japonês',
      'ja': 'Japonês',
      'spa': 'Espanhol',
      'es': 'Espanhol',
      'fra': 'Francês',
      'fre': 'Francês',
      'fr': 'Francês',
      'deu': 'Alemão',
      'ger': 'Alemão',
      'de': 'Alemão',
      'ita': 'Italiano',
      'it': 'Italiano',
      'kor': 'Coreano',
      'ko': 'Coreano',
      'chi': 'Chinês',
      'zho': 'Chinês',
      'zh': 'Chinês',
      'rus': 'Russo',
      'ru': 'Russo',
      'und': 'Sem idioma especificado'
    };
    return langMap[c] || c.toUpperCase();
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Event listener for mock preview generation
  window.addEventListener('render-mock-queue', (e) => {
    if (e.detail && Array.isArray(e.detail)) {
      queue = e.detail;
      renderQueue();
    }
  });

  // Kickstart on DOM ready
  document.addEventListener('DOMContentLoaded', init);
})();

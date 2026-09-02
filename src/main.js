import OBR from '@owlbear-rodeo/sdk';

const MAX_VARIANTS = 4;
const EXT_NS = 'com.changr-hotkeys';

const DIRECTION_CONFIG = [
  { label: 'FRONT', symbol: '↓', hotkey: '1' },
  { label: 'LEFT',  symbol: '←', hotkey: '2' },
  { label: 'RIGHT', symbol: '→', hotkey: '3' },
  { label: 'BACK',  symbol: '↑', hotkey: '4' },
];

const ANCHOR_PRESETS = {
  FEET:  { x: 0.5, y: 1.0 },
  TRUNK: { x: 0.5, y: 0.75 },
};

const DEFAULT_ANCHOR = ANCHOR_PRESETS.FEET;

// Extension Global State
let isExtensionEnabled = true;
let currentSelection = null;
let currentGridDpi = 150;

const knownItemStates = new Map(); // Stores base { x, y, scaleX, scaleY }
const variantCache = new Map();
const preloadedImageUrls = new Set();

let desiredVariantUrl = null;
let lastSyncedVariantUrl = null;
let isSyncingVariant = false;
let isApplyingBreath = false;
let lastOnChangeTime = 0;
let lastKeyPressTime = 0;
let uiUpdateScheduled = false;

// Breathing Animation State
let breathIntervalId = null;
let pauseBreathUntil = 0; // Timestamp to pause breathing during movement

// Warm GPU texture holding container
const preloadCacheContainer = document.createElement('div');
preloadCacheContainer.id = 'img-preload-cache';
preloadCacheContainer.style.cssText = 'position:absolute; width:0; height:0; overflow:hidden; opacity:0; pointer-events:none;';
document.body.appendChild(preloadCacheContainer);

// Cached DOM References
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const variantCount = document.getElementById('variantCount');
const variantStrip = document.getElementById('variantStrip');
const anchorLabel = document.getElementById('anchorLabel');

/**
 * Non-blocking GPU texture decoding offloaded to browser idle time.
 */
function preloadVariantImages(urls) {
  const toPreload = urls.filter(url => url && !preloadedImageUrls.has(url));
  if (!toPreload.length) return;

  const scheduleTask = window.requestIdleCallback || ((cb) => setTimeout(cb, 1));

  scheduleTask(() => {
    for (const url of toPreload) {
      preloadedImageUrls.add(url);
      const img = new Image();
      img.src = url;
      preloadCacheContainer.appendChild(img);
      if (img.decode) {
        img.decode().catch(() => {});
      }
    }
  }, { timeout: 1000 });
}

function getAnchorRatios(item) {
  const meta = item?.metadata?.[EXT_NS] || {};
  const x = typeof meta.anchorX === 'number' ? meta.anchorX : DEFAULT_ANCHOR.x;
  const y = typeof meta.anchorY === 'number' ? meta.anchorY : DEFAULT_ANCHOR.y;
  return { x, y };
}

function getItemIsoDepth(item) {
  if (!item || !item.position) return 0;
  const itemDpi = item.grid?.dpi || currentGridDpi || 150;
  const sceneDpi = currentGridDpi || itemDpi;
  const imgWidth = item.image?.width ?? itemDpi;
  const imgHeight = item.image?.height ?? itemDpi;
  const heightInUnits = (imgHeight / itemDpi) * (item.scale?.y ?? 1) * sceneDpi;
  const widthInUnits = (imgWidth / itemDpi) * (item.scale?.x ?? 1) * sceneDpi;
  const { x: anchorX, y: anchorY } = getAnchorRatios(item);

  const feetX = item.position.x + widthInUnits * anchorX;
  const feetY = item.position.y + heightInUnits * anchorY;
  return Math.floor((feetY * 10) + (feetX * 0.001));
}

function extractVariants(metadata, itemId = null) {
  if (!metadata) return [];
  const foundUrls = new Set();

  function scan(val) {
    if (!val) return;
    if (typeof val === 'string') {
      if (val.startsWith('http://') || val.startsWith('https://') || val.startsWith('data:image/') || val.startsWith('blob:') || val.startsWith('/')) {
        foundUrls.add(val);
      }
      return;
    }
    if (Array.isArray(val)) {
      for (let i = 0; i < val.length; i++) scan(val[i]);
      return;
    }
    if (typeof val === 'object') {
      for (const prop of ['url', 'src', 'image', 'href', 'uri']) {
        if (typeof val[prop] === 'string') scan(val[prop]);
      }
      for (const k of Object.keys(val)) scan(val[k]);
    }
  }

  scan(metadata);
  const urls = Array.from(foundUrls);
  if (itemId) variantCache.set(itemId, urls);
  
  if (urls.length) {
    queueMicrotask(() => preloadVariantImages(urls));
  }
  return urls;
}

function getVariantsForSync(item) {
  const cached = variantCache.get(item.id);
  return cached || extractVariants(item.metadata, item.id);
}

function scheduleUIUpdate() {
  if (uiUpdateScheduled) return;
  uiUpdateScheduled = true;

  requestAnimationFrame(() => {
    uiUpdateScheduled = false;
    performUIUpdate();
  });
}

function performUIUpdate() {
  if (statusText) {
    const powerBtnBg = isExtensionEnabled ? '#22c55e' : '#ef4444';
    const powerLabel = isExtensionEnabled ? 'ON' : 'OFF';

    statusText.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; width:100%;">
        <span>${!isExtensionEnabled ? 'Extension Paused' : currentSelection ? `4-Way Turnaround (${Math.min(currentSelection.variants.length, 4)}/4 set)` : 'No token selected'}</span>
        <button id="btnPowerToggle" style="padding:2px 10px; font-weight:bold; font-size:11px; border-radius:12px; border:none; background:${powerBtnBg}; color:#fff; cursor:pointer; transition:background 0.2s;">
          ${powerLabel}
        </button>
      </div>`;

    document.getElementById('btnPowerToggle')?.addEventListener('click', () => {
      isExtensionEnabled = !isExtensionEnabled;
      if (!isExtensionEnabled) {
        stopBreathingLoop();
      } else if (currentSelection) {
        startBreathingLoop();
      }
      scheduleUIUpdate();
    });
  }

  if (!isExtensionEnabled) {
    statusDot.className = 'status-dot inactive';
    variantCount.textContent = '';
    variantStrip.innerHTML = '<div class="no-selection" style="color:#888;">Extension is OFF. Hotkeys & auto-turnaround movement are paused.</div>';
    if (anchorLabel) anchorLabel.innerHTML = '';
    return;
  }

  if (!currentSelection) {
    statusDot.className = 'status-dot inactive';
    variantCount.textContent = '';
    variantStrip.innerHTML = '<div class="no-selection">Select 1 image token on map to view 4-way turnaround</div>';
    if (anchorLabel) anchorLabel.innerHTML = '';
    return;
  }

  const { variants, currentUrl, anchor } = currentSelection;
  const activeIndex = currentUrl ? variants.indexOf(currentUrl) : 0;

  statusDot.className = 'status-dot active';
  variantCount.textContent = variants.length > 4 ? `(+${variants.length - 4} extra)` : '';

  if (anchorLabel) {
    const isTrunk = Math.abs(anchor.y - ANCHOR_PRESETS.TRUNK.y) < 0.01;
    anchorLabel.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; margin-top:6px; font-size:12px; color:#aaa;">
        <span>Anchor Depth:</span>
        <button id="btnAnchorFeet" style="padding:2px 8px; border-radius:4px; border:1px solid ${!isTrunk ? '#4f46e5' : '#444'}; background:${!isTrunk ? '#4f46e5' : '#222'}; color:#fff; cursor:pointer;">Feet (1.0)</button>
        <button id="btnAnchorTrunk" style="padding:2px 8px; border-radius:4px; border:1px solid ${isTrunk ? '#4f46e5' : '#444'}; background:${isTrunk ? '#4f46e5' : '#222'}; color:#fff; cursor:pointer;">Trunk/Base (0.75)</button>
      </div>
    `;

    document.getElementById('btnAnchorFeet')?.addEventListener('click', () => setItemAnchor(currentSelection.id, ANCHOR_PRESETS.FEET));
    document.getElementById('btnAnchorTrunk')?.addEventListener('click', () => setItemAnchor(currentSelection.id, ANCHOR_PRESETS.TRUNK));
  }

  let html = '';
  for (let i = 0; i < MAX_VARIANTS; i++) {
    const config = DIRECTION_CONFIG[i];
    const url = variants[i];
    const isActive = i === activeIndex || (activeIndex === -1 && i === 0);

    if (url) {
      html += `
        <div class="variant-item ${isActive ? 'active' : ''}" data-index="${i}" title="Slot ${i + 1}: ${config.label}">
          <span class="direction-badge">${config.symbol} ${config.label}</span>
          <img src="${url}" alt="${config.label} View" loading="lazy" />
          <span class="hotkey-badge">#${config.hotkey}</span>
        </div>`;
    } else {
      html += `
        <div class="variant-item empty" title="Add Image #${i + 1} in Changr for ${config.label}">
          <span class="direction-badge" style="opacity:0.6;">${config.symbol} ${config.label}</span>
          <div style="font-size:10px; color:#666; text-align:center; padding: 12px 2px 0 2px;">Missing</div>
          <span class="hotkey-badge">#${config.hotkey}</span>
        </div>`;
    }
  }

  variantStrip.innerHTML = html;
  variantStrip.querySelectorAll('.variant-item[data-index]').forEach((el) => {
    el.addEventListener('click', () => applyVariant(parseInt(el.dataset.index, 10)));
  });
}

function applyVariant(index) {
  if (!isExtensionEnabled) return;

  const now = performance.now();
  const delta = lastKeyPressTime ? (now - lastKeyPressTime).toFixed(1) : '0.0';
  lastKeyPressTime = now;

  if (!currentSelection) return;
  const { id, variants } = currentSelection;
  if (index < 0 || index >= variants.length) return;

  const targetUrl = variants[index];
  const effectiveCurrentUrl = desiredVariantUrl || lastSyncedVariantUrl || currentSelection.currentUrl;

  if (targetUrl !== effectiveCurrentUrl) {
    console.log(`[HOTKEY] (+${delta}ms) Key triggered index=${index} (${DIRECTION_CONFIG[index]?.label})`);
    currentSelection.currentUrl = targetUrl;
    scheduleUIUpdate();
    desiredVariantUrl = targetUrl;
    flushVariantToOBR(id);
  }
}

async function flushVariantToOBR(itemId) {
  if (isSyncingVariant || !isExtensionEnabled) return;
  isSyncingVariant = true;

  try {
    while (desiredVariantUrl !== null && desiredVariantUrl !== lastSyncedVariantUrl && isExtensionEnabled) {
      const urlToSend = desiredVariantUrl;
      const t0 = performance.now();

      await OBR.scene.items.updateItems([itemId], (items) => {
        for (const item of items) {
          if (item.image) {
            item.image.url = urlToSend;
            item.zIndex = getItemIsoDepth(item);
          }
        }
      });

      console.log(`[IPC FLUSH] URL updated in ${(performance.now() - t0).toFixed(1)}ms ->`, urlToSend);
      lastSyncedVariantUrl = urlToSend;

      if (desiredVariantUrl === urlToSend) {
        desiredVariantUrl = null;
      }
    }
  } catch (err) {
    console.error('[IPC FLUSH] ERROR during variant sync:', err);
  } finally {
    isSyncingVariant = false;
    if (desiredVariantUrl !== null && desiredVariantUrl !== lastSyncedVariantUrl && isExtensionEnabled) {
      flushVariantToOBR(itemId);
    }
  }
}

async function updateItemDepthOnly(itemId) {
  await OBR.scene.items.updateItems([itemId], (items) => {
    for (const item of items) {
      item.zIndex = getItemIsoDepth(item);
    }
  });
}

/**
 * Feet-Grounded Breathing Animation Step
 * Calculates vertical scale reduction and offsets position.y so feet remain frozen on grid.
 */
async function applyBreathingFrame() {
  if (!isExtensionEnabled || !currentSelection || isSyncingVariant || Date.now() < pauseBreathUntil) return;
  
  const itemId = currentSelection.id;
  const baseState = knownItemStates.get(itemId);
  if (!baseState) return;

  const now = performance.now();
  // Smooth 2.8 second breathing loop
  const cycle = (now % 2800) / 2800;
  const sineVal = 0.5 + 0.5 * Math.sin(cycle * 2 * Math.PI);
  
  // Scale Y oscillates between 0.95 (breath out) and 1.00 (breath in)
  const scaleFactor = 1.0 - (0.05 * sineVal);

  isApplyingBreath = true;
  try {
    await OBR.scene.items.updateItems([itemId], (items) => {
      for (const item of items) {
        if (!item.image || !item.position || item.id !== itemId) continue;

        const itemDpi = item.grid?.dpi || currentGridDpi || 150;
        const sceneDpi = currentGridDpi || itemDpi;
        const imgHeight = item.image?.height ?? itemDpi;
        const baseScaleY = baseState.scaleY ?? item.scale?.y ?? 1;
        const baseScaleX = baseState.scaleX ?? item.scale?.x ?? 1;
        const heightInUnits = (imgHeight / itemDpi) * baseScaleY * sceneDpi;
        const { y: anchorY } = getAnchorRatios(item);

        // Vector Compensation: Offsets top-left position down so feet remain anchored
        const deltaY = heightInUnits * anchorY * (1.0 - scaleFactor);

        item.scale = {
          x: baseScaleX,
          y: baseScaleY * scaleFactor
        };
        item.position = {
          x: baseState.x,
          y: baseState.y + deltaY
        };
        item.zIndex = getItemIsoDepth(item);
      }
    });
  } catch (err) {
    // Quiet handling during rapid selection changes
  } finally {
    isApplyingBreath = false;
  }
}

function startBreathingLoop() {
  stopBreathingLoop();
  breathIntervalId = setInterval(applyBreathingFrame, 160); // ~6fps subtle update loop
}

function stopBreathingLoop() {
  if (breathIntervalId) {
    clearInterval(breathIntervalId);
    breathIntervalId = null;
  }
}

function processItemPositionUpdates(items) {
  if (!isExtensionEnabled || isApplyingBreath) return;

  const now = performance.now();
  const timeDelta = lastOnChangeTime ? (now - lastOnChangeTime).toFixed(1) : '0.0';
  lastOnChangeTime = now;
  const activeId = currentSelection?.id;

  for (const item of items) {
    if (!item.position) continue;
    const cached = knownItemStates.get(item.id);

    if (cached) {
      const dx = item.position.x - cached.x;
      const dy = item.position.y - cached.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > 0.1) {
        // Update base position reference during actual walking/dragging
        knownItemStates.set(item.id, { 
          x: item.position.x, 
          y: item.position.y,
          scaleX: item.scale?.x ?? cached.scaleX ?? 1,
          scaleY: item.scale?.y ?? cached.scaleY ?? 1
        });

        // Pause breathing briefly while walking to prevent motion jitter
        pauseBreathUntil = Date.now() + 800;

        // Update isometric zIndex on every movement frame
        if (item.layer === 'CHARACTER' || item.layer === 'MOUNT' || item.id === activeId) {
          updateItemDepthOnly(item.id);
        }

        if (item.id === activeId) {
          const variants = getVariantsForSync(item);
          if (variants.length >= 2) {
            let targetIndex = 0;
            if (Math.abs(dx) > Math.abs(dy) * 2.5) {
              targetIndex = dx > 0 ? 2 : 1;
            } else if (Math.abs(dy) > Math.abs(dx) * 2.5) {
              targetIndex = dy > 0 ? 0 : 3;
            } else {
              if (dx > 0 && dy >= 0) targetIndex = 2;
              else if (dx < 0 && dy >= 0) targetIndex = 0;
              else if (dx < 0 && dy < 0) targetIndex = 1;
              else if (dx > 0 && dy < 0) targetIndex = 3;
            }

            targetIndex = targetIndex % variants.length;
            const targetUrl = variants[targetIndex];
            const effectiveCurrentUrl = desiredVariantUrl || lastSyncedVariantUrl || currentSelection.currentUrl;

            if (targetUrl !== effectiveCurrentUrl) {
              console.log(`[STEP MOVE (+${timeDelta}ms)] dx: ${dx.toFixed(1)}, dy: ${dy.toFixed(1)} -> Turning to ${DIRECTION_CONFIG[targetIndex]?.label}`);
              currentSelection.currentUrl = targetUrl;
              scheduleUIUpdate();
              desiredVariantUrl = targetUrl;
              flushVariantToOBR(item.id);
            }
          }
        }
      }
    } else {
      knownItemStates.set(item.id, { 
        x: item.position.x, 
        y: item.position.y,
        scaleX: item.scale?.x ?? 1,
        scaleY: item.scale?.y ?? 1
      });
    }
  }
}

async function setItemAnchor(itemId, anchor) {
  await OBR.scene.items.updateItems([itemId], (items) => {
    for (const item of items) {
      if (!item.metadata) item.metadata = {};
      item.metadata[EXT_NS] = { ...(item.metadata[EXT_NS] || {}), anchorX: anchor.x, anchorY: anchor.y };
      item.zIndex = getItemIsoDepth(item);
    }
  });

  if (currentSelection && currentSelection.id === itemId) {
    currentSelection.anchor = { x: anchor.x, y: anchor.y };
    scheduleUIUpdate();
  }
}

async function syncSelection() {
  try {
    const selectedIds = await OBR.player.getSelection();
    if (!selectedIds || selectedIds.length !== 1) {
      stopBreathingLoop();
      currentSelection = null;
      lastSyncedVariantUrl = null;
      desiredVariantUrl = null;
      scheduleUIUpdate();
      return;
    }

    const items = await OBR.scene.items.getItems(selectedIds);
    const item = items[0];
    if (!item || item.type !== 'IMAGE') {
      stopBreathingLoop();
      currentSelection = null;
      lastSyncedVariantUrl = null;
      desiredVariantUrl = null;
      scheduleUIUpdate();
      return;
    }

    const currentUrl = item.image?.url || null;
    let extractedUrls = extractVariants(item.metadata, item.id);
    if (currentUrl && !extractedUrls.includes(currentUrl)) {
      extractedUrls.push(currentUrl);
      preloadVariantImages([currentUrl]);
    }

    currentSelection = {
      id: item.id,
      variants: extractedUrls,
      currentUrl,
      anchor: getAnchorRatios(item),
    };

    lastSyncedVariantUrl = currentUrl;
    if (item.position) {
      knownItemStates.set(item.id, { 
        x: item.position.x, 
        y: item.position.y,
        scaleX: item.scale?.x ?? 1,
        scaleY: item.scale?.y ?? 1
      });
    }
    
    updateItemDepthOnly(item.id);
    scheduleUIUpdate();

    if (isExtensionEnabled) {
      startBreathingLoop();
    }
  } catch (err) {
    console.error('[SELECTION] Error syncing selection:', err);
  }
}

window.addEventListener('keydown', (e) => {
  if (!isExtensionEnabled) return;
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;

  const num = parseInt(e.key, 10);
  if (!isNaN(num) && num >= 1 && num <= 4) {
    e.preventDefault();
    applyVariant(num - 1);
    return;
  }

  const arrowMap = { 'ArrowDown': 0, 'ArrowLeft': 1, 'ArrowRight': 2, 'ArrowUp': 3 };
  if (!e.shiftKey && e.key in arrowMap) {
    e.preventDefault();
    applyVariant(arrowMap[e.key]);
  }
}, true);

OBR.onReady(async () => {
  try { currentGridDpi = await OBR.scene.grid.getDpi(); } catch (e) { currentGridDpi = 150; }
  syncSelection();

  OBR.player.onChange(() => syncSelection());
  OBR.scene.items.onChange((items) => {
    processItemPositionUpdates(items);
    if (currentSelection && isExtensionEnabled) {
      const activeItem = items.find((i) => i.id === currentSelection.id);
      if (activeItem) {
        let uiNeedsUpdate = false;
        const isBusy = isSyncingVariant || desiredVariantUrl !== null;
        if (!isBusy && activeItem.image?.url && activeItem.image.url !== currentSelection.currentUrl) {
          currentSelection.currentUrl = activeItem.image.url;
          lastSyncedVariantUrl = activeItem.image.url;
          uiNeedsUpdate = true;
        }

        const newAnchor = getAnchorRatios(activeItem);
        if (newAnchor.x !== currentSelection.anchor.x || newAnchor.y !== currentSelection.anchor.y) {
          currentSelection.anchor = newAnchor;
          uiNeedsUpdate = true;
        }
        if (uiNeedsUpdate) scheduleUIUpdate();
      }
    }
  });
});
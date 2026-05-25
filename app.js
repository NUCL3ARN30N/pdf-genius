/* =====================================================================
   PDF Genius — app.js
   Unified PDF editor: merge, sort, crop, remove, rotate, watermark,
   annotate & draw — then download.
   100% client-side — no data leaves the browser.
   ===================================================================== */
(() => {
'use strict';

const { PDFDocument, rgb, degrees, StandardFonts } = PDFLib;

// ===================== GLOBAL STATE =====================

const state = {
    pages: [],
    selected: new Set(),
};

// page object: { srcFile, srcName, srcPageIdx, data, rotation, crop, annotations, _cacheKey }

// ===================== THUMBNAIL CACHE =====================
// Key: "arrayBufferId:pageIdx" → canvas element (base render, no rotation/crop)
// We assign a unique _id to each ArrayBuffer the first time we see it.

const thumbCache = new Map();
let _abIdCounter = 0;
const _abIdMap = new WeakMap();

function getAbId(ab) {
    if (_abIdMap.has(ab)) return _abIdMap.get(ab);
    const id = ++_abIdCounter;
    _abIdMap.set(ab, id);
    return id;
}

// PDF.js document cache — avoids re-parsing the same ArrayBuffer
const pdfDocCache = new Map();

async function getPdfDoc(ab) {
    const id = getAbId(ab);
    if (pdfDocCache.has(id)) return pdfDocCache.get(id);
    const doc = await pdfjsLib.getDocument({ data: ab.slice(0) }).promise;
    pdfDocCache.set(id, doc);
    return doc;
}

function invalidateCache(ab) {
    const id = getAbId(ab);
    // Remove all thumb entries for this buffer
    for (const [k] of thumbCache) {
        if (k.startsWith(id + ':')) thumbCache.delete(k);
    }
    pdfDocCache.delete(id);
}

async function getThumbCanvas(srcData, srcPageIdx, maxW) {
    const id = getAbId(srcData);
    const key = id + ':' + srcPageIdx + ':' + maxW;
    if (thumbCache.has(key)) {
        // Return a clone so each grid slot has its own canvas
        const cached = thumbCache.get(key);
        const c = document.createElement('canvas');
        c.width = cached.width; c.height = cached.height;
        c.getContext('2d').drawImage(cached, 0, 0);
        return c;
    }
    const pdf = await getPdfDoc(srcData);
    const page = await pdf.getPage(srcPageIdx + 1);
    const vp = page.getViewport({ scale: 1 });
    const scale = maxW / Math.max(vp.width, 1);
    const svp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = svp.width; canvas.height = svp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: svp }).promise;
    thumbCache.set(key, canvas);
    // Return clone
    const c = document.createElement('canvas');
    c.width = canvas.width; c.height = canvas.height;
    c.getContext('2d').drawImage(canvas, 0, 0);
    return c;
}

// ===================== UTILITIES =====================

function toast(msg) {
    const el = document.getElementById('toast');
    document.getElementById('toast-msg').textContent = msg;
    el.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.remove('show'), 2800);
}

function showProgress(pct, text) {
    const w = document.getElementById('main-progress');
    w.classList.add('on');
    document.getElementById('main-progress-fill').style.width = pct + '%';
    if (text) document.getElementById('main-progress-text').textContent = text;
}
function hideProgress() { document.getElementById('main-progress').classList.remove('on'); }

async function readFile(file) {
    return new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result);
        r.onerror = () => rej(r.error);
        r.readAsArrayBuffer(file);
    });
}

function downloadBlob(bytes, name) {
    const blob = new Blob([bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function updateStats() {
    document.getElementById('stat-pages').textContent = state.pages.length;
    document.getElementById('stat-selected').textContent = state.selected.size;
    const has = state.selected.size > 0;
    document.getElementById('btn-rotate').disabled = !has;
    document.getElementById('btn-crop').disabled = state.selected.size !== 1;
    document.getElementById('btn-annotate').disabled = state.selected.size !== 1;
    document.getElementById('btn-remove').disabled = !has;

    // Fill Form — enabled if any pages have form fields (works across all pages)
    const anyForms = state.pages.some(p => p.formFields.length > 0);
    document.getElementById('btn-fill-form').disabled = !anyForms;
}

// ===================== HISTORY / BACK BUTTON =====================

let activeModal = null;

function openModal(id) {
    activeModal = id;
    document.getElementById(id).classList.add('on');
    history.pushState({ modal: id }, '');
}

function closeModal(id) {
    if (!id && activeModal) id = activeModal;
    if (!id) return;
    document.getElementById(id).classList.remove('on');
    if (activeModal === id) activeModal = null;
}

window.addEventListener('popstate', (e) => {
    if (activeModal) {
        const closing = activeModal;
        activeModal = null;
        document.getElementById(closing).classList.remove('on');
        if (closing === 'modal-annotate') {
            annoState.pdfDoc = null;
            renderGrid();
        }
        if (closing === 'modal-form') {
            document.getElementById('form-fields-layer').innerHTML = '';
        }
    }
});

function closeModalAndGoBack(id) {
    closeModal(id);
    // Only go back if we pushed a state for this modal
    if (history.state && history.state.modal) {
        history.back();
    }
}

// ===================== SCREEN SWITCHING =====================

function showEditor() {
    document.getElementById('screen-upload').classList.remove('on');
    document.getElementById('screen-editor').classList.add('on');
}

// ===================== FILE LOADING =====================

async function loadFiles(files) {
    const pdfFiles = files.filter(f => f.type === 'application/pdf' || f.name.endsWith('.pdf'));
    if (!pdfFiles.length) { toast('Please select PDF files'); return; }

    for (let fi = 0; fi < pdfFiles.length; fi++) {
        const file = pdfFiles[fi];
        showProgress(((fi + 1) / pdfFiles.length) * 80, `Loading ${file.name}...`);
        const data = await readFile(file);
        const pdf = await getPdfDoc(data);

        // Detect form fields via pdf-lib
        let formFieldsByPage = {};
        try {
            const pdfLibDoc = await PDFDocument.load(data, { ignoreEncryption: true });
            const form = pdfLibDoc.getForm();
            const fields = form.getFields();
            for (const field of fields) {
                const widgets = field.acroField.getWidgets();
                for (const widget of widgets) {
                    const pageRef = widget.P();
                    if (!pageRef) continue;
                    const allPages = pdfLibDoc.getPages();
                    let pageIdx = -1;
                    for (let pi = 0; pi < allPages.length; pi++) {
                        if (allPages[pi].ref === pageRef) { pageIdx = pi; break; }
                    }
                    // Fallback: try matching by page object reference
                    if (pageIdx === -1) {
                        const catalog = pdfLibDoc.context.lookup(pdfLibDoc.context.trailerInfo.Root);
                        // Just assign to page 0 if we can't resolve
                        pageIdx = 0;
                        // Try brute force match
                        for (let pi = 0; pi < allPages.length; pi++) {
                            try {
                                const pRef = allPages[pi].node.dict.get(PDFLib.PDFName.of('Annots'));
                                // Check if this page's annotations include our widget
                            } catch(e) {}
                        }
                    }

                    const rect = widget.getRectangle();
                    const fieldName = field.getName();
                    const fieldType = field.constructor.name; // PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList

                    if (!formFieldsByPage[pageIdx]) formFieldsByPage[pageIdx] = [];

                    const fieldInfo = {
                        name: fieldName,
                        type: fieldType,
                        rect: rect, // {x, y, width, height} in PDF coords (bottom-left)
                        options: null,
                        value: null,
                    };

                    // Get current value and options
                    try {
                        if (fieldType === 'PDFTextField') {
                            fieldInfo.value = field.getText() || '';
                            fieldInfo.isMultiline = field.isMultiline ? field.isMultiline() : false;
                        } else if (fieldType === 'PDFCheckBox') {
                            fieldInfo.value = field.isChecked();
                        } else if (fieldType === 'PDFDropdown') {
                            fieldInfo.options = field.getOptions();
                            fieldInfo.value = field.getSelected ? field.getSelected()[0] || '' : '';
                        } else if (fieldType === 'PDFOptionList') {
                            fieldInfo.options = field.getOptions();
                            fieldInfo.value = field.getSelected ? field.getSelected() : [];
                        } else if (fieldType === 'PDFRadioGroup') {
                            fieldInfo.options = field.getOptions();
                            fieldInfo.value = field.getSelected();
                        }
                    } catch(e) { /* some fields may not support all methods */ }

                    // Avoid duplicate fields (same name on same page)
                    const existing = formFieldsByPage[pageIdx].find(f => f.name === fieldName);
                    if (!existing) {
                        formFieldsByPage[pageIdx].push(fieldInfo);
                    }
                }
            }
        } catch(e) {
            // No form or encrypted — that's fine
        }

        for (let pi = 0; pi < pdf.numPages; pi++) {
            state.pages.push({
                srcFile: data, srcName: file.name, srcPageIdx: pi,
                data: null, rotation: 0, crop: null, annotations: [],
                formFields: formFieldsByPage[pi] || [],
                formValues: {}, // fieldName → user value
            });
        }
    }

    showProgress(90, 'Rendering thumbnails...');
    showEditor();
    await renderGrid();
    hideProgress();

    // Check if any forms were found
    const totalFields = state.pages.reduce((s, p) => s + p.formFields.length, 0);
    if (totalFields > 0) {
        toast(`Loaded ${pdfFiles.length} file(s), ${state.pages.length} pages — ${totalFields} form field(s) detected`);
    } else {
        toast(`Loaded ${pdfFiles.length} file(s), ${state.pages.length} total pages`);
    }
}

const uploadZone = document.getElementById('upload-zone');
const fileInput = document.getElementById('file-input');
uploadZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { if (fileInput.files.length) loadFiles(Array.from(fileInput.files)); fileInput.value = ''; });
uploadZone.addEventListener('dragover', e => { e.preventDefault(); uploadZone.classList.add('drag'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag'));
uploadZone.addEventListener('drop', e => { e.preventDefault(); uploadZone.classList.remove('drag'); const f = Array.from(e.dataTransfer.files); if (f.length) loadFiles(f); });

const addMoreInput = document.getElementById('add-more-input');
document.getElementById('btn-add-more').addEventListener('click', () => addMoreInput.click());
addMoreInput.addEventListener('change', () => { if (addMoreInput.files.length) loadFiles(Array.from(addMoreInput.files)); addMoreInput.value = ''; });

// ===================== PAGE GRID =====================

const THUMB_W = 220;

async function renderGrid() {
    const grid = document.getElementById('page-grid');
    grid.innerHTML = '';
    state.selected.clear();

    // Batch render — kick off all thumb promises, then await in order
    const thumbPromises = state.pages.map(pg => {
        const srcData = pg.data || pg.srcFile;
        const srcIdx = pg.data ? 0 : pg.srcPageIdx;
        return getThumbCanvas(srcData, srcIdx, THUMB_W);
    });

    for (let i = 0; i < state.pages.length; i++) {
        if (i % 10 === 0) showProgress((i / state.pages.length) * 100, `Rendering page ${i + 1}/${state.pages.length}`);
        const pg = state.pages[i];
        let canvas = await thumbPromises[i];

        // Apply visual crop to thumbnail
        if (pg.crop) {
            const srcData = pg.data || pg.srcFile;
            const srcIdx = pg.data ? 0 : pg.srcPageIdx;
            const pdf = await getPdfDoc(srcData);
            const page = await pdf.getPage(srcIdx + 1);
            const vp = page.getViewport({ scale: 1 });
            const sx = canvas.width / vp.width;
            const sy = canvas.height / vp.height;

            // crop is in PDF coords (bottom-left origin) → convert to canvas (top-left)
            const cx = pg.crop.x * sx;
            const cy = (vp.height - pg.crop.y - pg.crop.h) * sy;
            const cw = pg.crop.w * sx;
            const ch = pg.crop.h * sy;

            const cropped = document.createElement('canvas');
            cropped.width = Math.max(1, Math.round(cw));
            cropped.height = Math.max(1, Math.round(ch));
            cropped.getContext('2d').drawImage(canvas, cx, cy, cw, ch, 0, 0, cropped.width, cropped.height);
            canvas = cropped;
        }

        // Apply rotation visually
        if (pg.rotation) {
            const rad = (pg.rotation * Math.PI) / 180;
            const sin = Math.abs(Math.sin(rad)), cos = Math.abs(Math.cos(rad));
            const rc = document.createElement('canvas');
            rc.width = canvas.width * cos + canvas.height * sin;
            rc.height = canvas.width * sin + canvas.height * cos;
            const rctx = rc.getContext('2d');
            rctx.translate(rc.width / 2, rc.height / 2);
            rctx.rotate(rad);
            rctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
            canvas = rc;
        }

        appendThumb(grid, canvas, i, pg);
    }
    updateStats();
    hideProgress();
}

function appendThumb(grid, canvas, idx, pg) {
    const el = document.createElement('div');
    el.className = 'page-thumb' + (pg.crop ? ' cropped' : '') + (pg.formFields.length ? ' has-form' : '');
    el.dataset.idx = idx;
    el.draggable = true;

    const shortName = pg.srcName.length > 14 ? pg.srcName.slice(0, 11) + '…' : pg.srcName;
    const badges = [];
    if (pg.rotation) badges.push(pg.rotation + '°');
    if (pg.crop) badges.push('cropped');
    if (pg.annotations.length) badges.push('✏️');

    const formBtn = pg.formFields.length
        ? `<button class="page-act" data-act="form" title="Fill Form"><i class="fas fa-wpforms"></i></button>`
        : '';

    el.innerHTML = `
        <div class="page-check"><i class="fas fa-check"></i></div>
        <div class="page-source" title="${pg.srcName}">${shortName}</div>
        <div class="page-actions">
            <button class="page-act" data-act="rotate" title="Rotate 90°"><i class="fas fa-redo"></i></button>
            <button class="page-act" data-act="crop" title="Crop"><i class="fas fa-crop-alt"></i></button>
            <button class="page-act" data-act="annotate" title="Annotate"><i class="fas fa-pen"></i></button>
            ${formBtn}
            <button class="page-act act-del" data-act="delete" title="Remove"><i class="fas fa-trash-alt"></i></button>
        </div>
        <div class="page-num">Page ${idx + 1}${badges.length ? ' · ' + badges.join(' · ') : ''}</div>
    `;
    el.insertBefore(canvas, el.firstChild);

    el.querySelector('.page-check').addEventListener('click', e => { e.stopPropagation(); toggleSelect(idx, el); });
    el.addEventListener('click', e => {
        if (e.target.closest('.page-act') || e.target.closest('.page-check')) return;
        toggleSelect(idx, el);
    });

    el.querySelectorAll('.page-act').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const act = btn.dataset.act;
            if (act === 'rotate') rotatePage(idx);
            else if (act === 'crop') openCrop(idx);
            else if (act === 'annotate') openAnnotate(idx);
            else if (act === 'form') openFormFill(idx);
            else if (act === 'delete') removePage(idx);
        });
    });

    // Drag reorder
    el.addEventListener('dragstart', e => { el.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(idx)); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', e => { e.preventDefault(); el.classList.add('drag-over'); });
    el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
    el.addEventListener('drop', e => {
        e.preventDefault(); el.classList.remove('drag-over');
        const from = parseInt(e.dataTransfer.getData('text/plain')), to = idx;
        if (from === to) return;
        const [moved] = state.pages.splice(from, 1);
        state.pages.splice(to, 0, moved);
        state.selected.clear();
        renderGrid();
    });

    grid.appendChild(el);
}

function toggleSelect(idx, el) {
    if (state.selected.has(idx)) { state.selected.delete(idx); el.classList.remove('selected'); }
    else { state.selected.add(idx); el.classList.add('selected'); }
    updateStats();
}

// ===================== TOOLBAR ACTIONS =====================

document.getElementById('btn-select-all').addEventListener('click', () => {
    state.pages.forEach((_, i) => state.selected.add(i));
    document.querySelectorAll('.page-thumb').forEach(t => t.classList.add('selected'));
    updateStats();
});
document.getElementById('btn-deselect').addEventListener('click', () => {
    state.selected.clear();
    document.querySelectorAll('.page-thumb').forEach(t => t.classList.remove('selected'));
    updateStats();
});

document.getElementById('btn-rotate').addEventListener('click', () => {
    state.selected.forEach(idx => { state.pages[idx].rotation = (state.pages[idx].rotation + 90) % 360; });
    renderGrid();
});

async function rotatePage(idx) {
    state.pages[idx].rotation = (state.pages[idx].rotation + 90) % 360;
    await renderGrid();
    toast('Page rotated');
}

document.getElementById('btn-remove').addEventListener('click', () => {
    const sorted = Array.from(state.selected).sort((a, b) => b - a);
    sorted.forEach(idx => state.pages.splice(idx, 1));
    state.selected.clear();
    renderGrid();
    toast(`Removed ${sorted.length} page(s)`);
});

function removePage(idx) {
    state.pages.splice(idx, 1);
    state.selected.clear();
    if (!state.pages.length) {
        document.getElementById('screen-editor').classList.remove('on');
        document.getElementById('screen-upload').classList.add('on');
    } else renderGrid();
    toast('Page removed');
}

document.getElementById('btn-crop').addEventListener('click', () => { if (state.selected.size === 1) openCrop(Array.from(state.selected)[0]); });
document.getElementById('btn-annotate').addEventListener('click', () => { if (state.selected.size === 1) openAnnotate(Array.from(state.selected)[0]); });

// ===================== CROP MODAL =====================

let cropState = { idx: -1, canvasRect: null, pageW: 0, pageH: 0 };

async function openCrop(idx) {
    cropState.idx = idx;
    const pg = state.pages[idx];
    const srcData = pg.data || pg.srcFile;
    const srcIdx = pg.data ? 0 : pg.srcPageIdx;

    // Always show the UNCROPPED page for crop editing
    const pdf = await getPdfDoc(srcData);
    const page = await pdf.getPage(srcIdx + 1);
    const vp = page.getViewport({ scale: 1 });
    cropState.pageW = vp.width;
    cropState.pageH = vp.height;

    const maxW = 700, maxH = window.innerHeight * 0.5;
    const scale = Math.min(maxW / vp.width, maxH / vp.height, 2);
    const svp = page.getViewport({ scale });

    const canvas = document.getElementById('crop-canvas');
    canvas.width = svp.width; canvas.height = svp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: svp }).promise;

    // Show/hide "Remove Crop" button
    document.getElementById('btn-crop-remove').style.display = pg.crop ? '' : 'none';

    const box = document.getElementById('crop-box');
    openModal('modal-crop');

    requestAnimationFrame(() => {
        const cr = canvas.getBoundingClientRect();
        const contR = document.getElementById('crop-container').getBoundingClientRect();
        cropState.canvasRect = {
            left: cr.left - contR.left, top: cr.top - contR.top,
            width: cr.width, height: cr.height,
        };

        if (pg.crop) {
            const sx = cr.width / vp.width, sy = cr.height / vp.height;
            box.style.left = (cropState.canvasRect.left + pg.crop.x * sx) + 'px';
            box.style.top = (cropState.canvasRect.top + (vp.height - pg.crop.y - pg.crop.h) * sy) + 'px';
            box.style.width = (pg.crop.w * sx) + 'px';
            box.style.height = (pg.crop.h * sy) + 'px';
        } else {
            box.style.left = cropState.canvasRect.left + 'px';
            box.style.top = cropState.canvasRect.top + 'px';
            box.style.width = cropState.canvasRect.width + 'px';
            box.style.height = cropState.canvasRect.height + 'px';
        }
        updateCropDim();
    });
}

function updateCropDim() {
    const box = document.getElementById('crop-box');
    const cr = cropState.canvasRect;
    if (!cr) return;
    const w = Math.round(parseFloat(box.style.width) * cropState.pageW / cr.width);
    const h = Math.round(parseFloat(box.style.height) * cropState.pageH / cr.height);
    document.getElementById('crop-dim').textContent = `${w} × ${h} pt`;
}

// Crop drag logic
(function() {
    const box = document.getElementById('crop-box');
    let mode = null, startX, startY, startL, startT, startW, startH;

    function onDown(e) {
        e.preventDefault();
        const t = e.target;
        if (t.classList.contains('crop-handle')) mode = t.dataset.h;
        else if (t === box || box.contains(t)) mode = 'move';
        else return;
        const ev = e.touches ? e.touches[0] : e;
        startX = ev.clientX; startY = ev.clientY;
        startL = parseFloat(box.style.left); startT = parseFloat(box.style.top);
        startW = parseFloat(box.style.width); startH = parseFloat(box.style.height);
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchmove', onMove, { passive: false });
        document.addEventListener('touchend', onUp);
    }
    function onMove(e) {
        if (!mode) return; e.preventDefault();
        const ev = e.touches ? e.touches[0] : e;
        const dx = ev.clientX - startX, dy = ev.clientY - startY;
        const cr = cropState.canvasRect; const minS = 20;
        let nl = startL, nt = startT, nw = startW, nh = startH;
        if (mode === 'move') { nl = startL + dx; nt = startT + dy; }
        else {
            if (mode.includes('l')) { nl = startL + dx; nw = startW - dx; }
            if (mode.includes('r')) { nw = startW + dx; }
            if (mode.includes('t')) { nt = startT + dy; nh = startH - dy; }
            if (mode.includes('b')) { nh = startH + dy; }
        }
        nw = Math.max(minS, nw); nh = Math.max(minS, nh);
        nl = Math.max(cr.left, Math.min(nl, cr.left + cr.width - nw));
        nt = Math.max(cr.top, Math.min(nt, cr.top + cr.height - nh));
        nw = Math.min(nw, cr.left + cr.width - nl);
        nh = Math.min(nh, cr.top + cr.height - nt);
        box.style.left = nl + 'px'; box.style.top = nt + 'px';
        box.style.width = nw + 'px'; box.style.height = nh + 'px';
        updateCropDim();
    }
    function onUp() {
        mode = null;
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onMove);
        document.removeEventListener('touchend', onUp);
    }
    box.addEventListener('mousedown', onDown);
    box.addEventListener('touchstart', onDown, { passive: false });
})();

document.getElementById('btn-crop-reset').addEventListener('click', () => {
    const box = document.getElementById('crop-box'), cr = cropState.canvasRect;
    box.style.left = cr.left + 'px'; box.style.top = cr.top + 'px';
    box.style.width = cr.width + 'px'; box.style.height = cr.height + 'px';
    updateCropDim();
});

document.getElementById('btn-crop-remove').addEventListener('click', () => {
    state.pages[cropState.idx].crop = null;
    closeModalAndGoBack('modal-crop');
    renderGrid();
    toast('Crop removed');
});

document.getElementById('crop-close').addEventListener('click', () => closeModalAndGoBack('modal-crop'));
document.getElementById('btn-crop-cancel').addEventListener('click', () => closeModalAndGoBack('modal-crop'));

document.getElementById('btn-crop-apply').addEventListener('click', () => {
    const box = document.getElementById('crop-box'), cr = cropState.canvasRect;
    const sx = cropState.pageW / cr.width, sy = cropState.pageH / cr.height;
    const bx = (parseFloat(box.style.left) - cr.left) * sx;
    const by = (parseFloat(box.style.top) - cr.top) * sy;
    const bw = parseFloat(box.style.width) * sx;
    const bh = parseFloat(box.style.height) * sy;

    // Check if crop is basically the full page (within 2pt tolerance)
    if (bx < 2 && by < 2 && Math.abs(bw - cropState.pageW) < 2 && Math.abs(bh - cropState.pageH) < 2) {
        state.pages[cropState.idx].crop = null;
    } else {
        state.pages[cropState.idx].crop = { x: bx, y: cropState.pageH - by - bh, w: bw, h: bh };
    }

    closeModalAndGoBack('modal-crop');
    renderGrid();
    toast('Crop applied');
});

// ===================== ANNOTATE MODAL =====================

const annoState = { idx: -1, tool: 'draw', drawing: false, pdfDoc: null, scale: 1.5, baseImage: null };
let currentStroke = null;

function getAnnoScale() {
    // On mobile, fit canvas to viewport width minus padding
    const wrap = document.getElementById('anno-canvas-wrap');
    const availW = wrap ? wrap.clientWidth - 32 : window.innerWidth - 64;
    if (availW < 700) {
        // We'll calculate the actual scale after getting the page viewport
        return null; // signal to use fit-to-width
    }
    return 1.5;
}

async function openAnnotate(idx) {
    annoState.idx = idx;
    const pg = state.pages[idx];
    const srcData = pg.data || pg.srcFile;
    const srcIdx = pg.data ? 0 : pg.srcPageIdx;

    const pdf = await getPdfDoc(srcData);
    annoState.pdfDoc = pdf;
    const page = await pdf.getPage(srcIdx + 1);

    // Determine scale: fit to width on mobile
    const baseVp = page.getViewport({ scale: 1 });
    const wrap = document.getElementById('anno-canvas-wrap');
    const availW = (wrap ? wrap.clientWidth : window.innerWidth) - 32;
    if (availW < baseVp.width * 1.5) {
        annoState.scale = Math.max(0.8, availW / baseVp.width);
    } else {
        annoState.scale = 1.5;
    }

    const vp = page.getViewport({ scale: annoState.scale });
    const canvas = document.getElementById('anno-canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    // Cache the base PDF render as an ImageData for fast redraws
    annoState.baseImage = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Draw existing stroke annotations on canvas (highlights are DOM overlays now)
    pg.annotations.filter(a => a.type === 'draw').forEach(a => drawAnno(ctx, a));

    // Build overlay DOM nodes for text and highlight annotations
    rebuildOverlayLayer();

    // Clear undo stack for fresh session
    undoStack.length = 0;

    openModal('modal-annotate');

    // Reset tool
    document.querySelectorAll('.anno-btn[data-tool]').forEach(b => b.classList.remove('on'));
    document.querySelector('.anno-btn[data-tool="draw"]').classList.add('on');
    annoState.tool = 'draw';
    canvas.style.cursor = 'crosshair';
    // Default: block touch scroll on canvas (draw mode)
    const wrapEl = document.getElementById('anno-canvas-wrap');
    wrapEl.style.touchAction = 'none';
    wrapEl.classList.remove('pan-mode');
}

// Font mapping: CSS font → pdf-lib StandardFont
const FONT_MAP = {
    'DM Sans': StandardFonts.Helvetica,
    'Helvetica': StandardFonts.Helvetica,
    'Times New Roman': StandardFonts.TimesRoman,
    'Courier New': StandardFonts.Courier,
    'Playfair Display': StandardFonts.TimesRoman, // closest match
    'JetBrains Mono': StandardFonts.Courier,
    'Georgia': StandardFonts.TimesRoman,
};

function drawAnno(ctx, a) {
    ctx.save();
    if (a.type === 'draw') {
        ctx.strokeStyle = a.color; ctx.lineWidth = a.size;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        a.points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
        ctx.stroke();
    }
    // highlights and text are DOM overlays — not drawn on canvas
    ctx.restore();
}

function redrawAnnoCanvas() {
    const canvas = document.getElementById('anno-canvas');
    const ctx = canvas.getContext('2d');
    if (annoState.baseImage) ctx.putImageData(annoState.baseImage, 0, 0);
    const pg = state.pages[annoState.idx];
    pg.annotations.filter(a => a.type === 'draw').forEach(a => drawAnno(ctx, a));
}

// ===================== OVERLAY LAYER (TEXT + HIGHLIGHTS) =====================

function rebuildOverlayLayer() {
    const layer = document.getElementById('anno-text-layer');
    layer.innerHTML = '';
    const pg = state.pages[annoState.idx];
    const canvas = document.getElementById('anno-canvas');
    const scaleX = canvas.offsetWidth / canvas.width;
    const scaleY = canvas.offsetHeight / canvas.height;

    pg.annotations.forEach((a, i) => {
        if (a.type === 'text') createTextNode(a, i, scaleX, scaleY);
        else if (a.type === 'highlight') createHighlightNode(a, i, scaleX, scaleY);
    });
}
// Keep old name as alias
const rebuildTextLayer = rebuildOverlayLayer;

// ===================== TEXT NODES =====================

function hasUnconfirmedText() {
    const pg = state.pages[annoState.idx];
    return pg.annotations.some(a => a.type === 'text' && !a.confirmed);
}

function createTextNode(a, annoIdx, scaleX, scaleY) {
    const layer = document.getElementById('anno-text-layer');
    const wrap = document.createElement('div');
    wrap.style.position = 'absolute';
    wrap.style.left = (a.x * scaleX) + 'px';
    wrap.style.top = ((a.y - a.size * 4) * scaleY) + 'px';
    wrap.style.zIndex = '5';

    const node = document.createElement('div');
    node.className = 'anno-text-node' + (a.confirmed ? ' confirmed' : ' unconfirmed');
    node.contentEditable = a.confirmed ? 'false' : 'true';
    node.textContent = a.text;
    node.style.fontSize = (a.size * 4 * scaleX) + 'px';
    node.style.color = a.color;
    node.style.fontFamily = `'${a.fontFamily || 'DM Sans'}', sans-serif`;
    node.dataset.annoIdx = annoIdx;

    // Action buttons (only shown when unconfirmed)
    const actions = document.createElement('div');
    actions.className = 'anno-text-actions';
    actions.style.display = a.confirmed ? 'none' : 'flex';

    const btnConfirm = document.createElement('button');
    btnConfirm.className = 'anno-text-act act-confirm';
    btnConfirm.innerHTML = '<i class="fas fa-check"></i>';
    btnConfirm.title = 'Confirm (Enter)';

    const btnDrag = document.createElement('button');
    btnDrag.className = 'anno-text-act act-drag';
    btnDrag.innerHTML = '<i class="fas fa-arrows-alt"></i>';
    btnDrag.title = 'Drag to move';

    const btnRemove = document.createElement('button');
    btnRemove.className = 'anno-text-act act-remove';
    btnRemove.innerHTML = '<i class="fas fa-times"></i>';
    btnRemove.title = 'Remove';

    actions.appendChild(btnConfirm);
    actions.appendChild(btnDrag);
    actions.appendChild(btnRemove);

    wrap.appendChild(actions);
    wrap.appendChild(node);

    // Confirm
    function confirmText() {
        a.text = node.textContent || '';
        if (!a.text.trim()) {
            removeThis(); return;
        }
        pushUndo();
        a.confirmed = true;
        node.classList.remove('unconfirmed', 'editing');
        node.classList.add('confirmed');
        node.contentEditable = 'false';
        actions.style.display = 'none';
    }

    // Remove
    function removeThis() {
        pushUndo();
        const pg = state.pages[annoState.idx];
        const idx = pg.annotations.indexOf(a);
        if (idx >= 0) pg.annotations.splice(idx, 1);
        rebuildOverlayLayer();
        redrawAnnoCanvas();
    }

    btnConfirm.addEventListener('click', e => { e.stopPropagation(); confirmText(); });
    btnRemove.addEventListener('click', e => { e.stopPropagation(); removeThis(); });

    // Drag via button
    function startDrag(e) {
        e.preventDefault();
        e.stopPropagation();
        pushUndo();
        node.classList.remove('editing');
        node.classList.add('dragging');
        const startX = e.clientX, startY = e.clientY;
        const origLeft = parseFloat(wrap.style.left), origTop = parseFloat(wrap.style.top);

        const onMove = e2 => {
            wrap.style.left = (origLeft + e2.clientX - startX) + 'px';
            wrap.style.top = (origTop + e2.clientY - startY) + 'px';
        };
        const onUp = () => {
            node.classList.remove('dragging');
            const canvas = document.getElementById('anno-canvas');
            const sx = canvas.width / canvas.offsetWidth;
            const sy = canvas.height / canvas.offsetHeight;
            a.x = parseFloat(wrap.style.left) * sx;
            a.y = (parseFloat(wrap.style.top) * sy) + a.size * 4;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }
    btnDrag.addEventListener('mousedown', startDrag);

    // Also allow drag from the node itself when unconfirmed + not editing
    node.addEventListener('mousedown', e => {
        if (node.classList.contains('editing')) return;
        if (a.confirmed && annoState.tool !== 'eraser') return;
        if (!a.confirmed) {
            // Start drag from the text body
            startDrag(e);
        }
    });

    // Double-click to re-edit confirmed text
    node.addEventListener('dblclick', e => {
        e.stopPropagation();
        if (hasUnconfirmedText()) {
            toast('Confirm or remove the current text before editing another');
            return;
        }
        a.confirmed = false;
        node.classList.remove('confirmed');
        node.classList.add('unconfirmed', 'editing');
        node.contentEditable = 'true';
        actions.style.display = 'flex';

        // Sync toolbar to this annotation's properties
        document.getElementById('anno-color').value = a.color;
        document.getElementById('anno-size').value = String(a.size);
        document.getElementById('anno-font').value = a.fontFamily || 'DM Sans';

        node.focus();
        const range = document.createRange();
        range.selectNodeContents(node);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    });

    // Click in text mode → start editing
    node.addEventListener('click', e => {
        if (annoState.tool === 'eraser') {
            e.stopPropagation(); removeThis(); return;
        }
        if (!a.confirmed && annoState.tool === 'text') {
            e.stopPropagation();
            node.classList.add('editing');
            node.focus();
        }
    });

    // Keyboard
    node.addEventListener('keydown', e => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            confirmText();
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            if (a.text === 'Text' && node.textContent === 'Text') removeThis();
            else confirmText();
        }
        // Shift+Enter → newline (default contentEditable behavior, just don't prevent)
    });

    // Blur → save text but don't auto-confirm
    node.addEventListener('blur', () => {
        node.classList.remove('editing');
        a.text = node.textContent || '';
    });

    layer.appendChild(wrap);
    return { wrap, node };
}

// ===================== HIGHLIGHT OVERLAY NODES =====================

function createHighlightNode(a, annoIdx, scaleX, scaleY) {
    const layer = document.getElementById('anno-text-layer');
    const canvas = document.getElementById('anno-canvas');

    if (!a.points || a.points.length < 2) return;

    const minX = Math.min(...a.points.map(p => p.x));
    const maxX = Math.max(...a.points.map(p => p.x));
    const minY = Math.min(...a.points.map(p => p.y));
    const maxY = Math.max(...a.points.map(p => p.y));
    const h = (maxY - minY) + a.size * 3;

    if (!a.rect) a.rect = { x: minX, y: minY, w: maxX - minX, h };

    const node = document.createElement('div');
    node.className = 'anno-highlight-node';
    node.style.left = (a.rect.x * scaleX) + 'px';
    node.style.top = (a.rect.y * scaleY) + 'px';
    node.style.width = (a.rect.w * scaleX) + 'px';
    node.style.height = (a.rect.h * scaleY) + 'px';
    node.style.backgroundColor = a.color;
    node.style.opacity = '0.3';
    node.dataset.annoIdx = annoIdx;

    // Delete button
    const del = document.createElement('button');
    del.className = 'anno-hl-delete';
    del.innerHTML = '<i class="fas fa-times"></i>';
    del.title = 'Remove highlight';
    del.addEventListener('click', e => {
        e.stopPropagation();
        pushUndo();
        const pg = state.pages[annoState.idx];
        const idx = pg.annotations.indexOf(a);
        if (idx >= 0) pg.annotations.splice(idx, 1);
        rebuildOverlayLayer();
        redrawAnnoCanvas();
    });
    node.appendChild(del);

    // Resize handles
    ['tl','tr','bl','br'].forEach(corner => {
        const handle = document.createElement('div');
        handle.className = 'anno-hl-handle hl-' + corner;
        handle.addEventListener('mousedown', e => {
            e.preventDefault(); e.stopPropagation();
            pushUndo();
            const startX = e.clientX, startY = e.clientY;
            const origL = parseFloat(node.style.left), origT = parseFloat(node.style.top);
            const origW = parseFloat(node.style.width), origH = parseFloat(node.style.height);

            const onMove = e2 => {
                const dx = e2.clientX - startX, dy = e2.clientY - startY;
                let nl = origL, nt = origT, nw = origW, nh = origH;
                if (corner.includes('l')) { nl = origL + dx; nw = origW - dx; }
                if (corner.includes('r')) { nw = origW + dx; }
                if (corner.includes('t')) { nt = origT + dy; nh = origH - dy; }
                if (corner.includes('b')) { nh = origH + dy; }
                nw = Math.max(10, nw); nh = Math.max(6, nh);
                node.style.left = nl + 'px'; node.style.top = nt + 'px';
                node.style.width = nw + 'px'; node.style.height = nh + 'px';
            };
            const onUp = () => {
                const sx = canvas.width / canvas.offsetWidth;
                const sy = canvas.height / canvas.offsetHeight;
                a.rect.x = parseFloat(node.style.left) * sx;
                a.rect.y = parseFloat(node.style.top) * sy;
                a.rect.w = parseFloat(node.style.width) * sx;
                a.rect.h = parseFloat(node.style.height) * sy;
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
        node.appendChild(handle);
    });

    // Drag to reposition
    node.addEventListener('mousedown', e => {
        if (e.target !== node) return; // don't drag from buttons/handles
        pushUndo();
        node.classList.add('dragging');
        const startX = e.clientX, startY = e.clientY;
        const origLeft = parseFloat(node.style.left), origTop = parseFloat(node.style.top);
        e.preventDefault();

        const onMove = e2 => {
            node.style.left = (origLeft + e2.clientX - startX) + 'px';
            node.style.top = (origTop + e2.clientY - startY) + 'px';
        };
        const onUp = () => {
            node.classList.remove('dragging');
            const sx = canvas.width / canvas.offsetWidth;
            const sy = canvas.height / canvas.offsetHeight;
            a.rect.x = parseFloat(node.style.left) * sx;
            a.rect.y = parseFloat(node.style.top) * sy;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });

    layer.appendChild(node);
}

// ===================== UNDO STACK (Ctrl+Z) =====================

const undoStack = []; // snapshots of annotations array (deep copies)
const MAX_UNDO = 50;

function pushUndo() {
    if (annoState.idx < 0) return;
    const pg = state.pages[annoState.idx];
    const snapshot = JSON.parse(JSON.stringify(pg.annotations));
    undoStack.push({ idx: annoState.idx, annotations: snapshot });
    if (undoStack.length > MAX_UNDO) undoStack.shift();
}

function performUndo() {
    if (!undoStack.length) { toast('Nothing to undo'); return; }
    const entry = undoStack.pop();
    state.pages[entry.idx].annotations = entry.annotations;
    if (annoState.idx === entry.idx) {
        redrawAnnoCanvas();
        rebuildOverlayLayer();
    }
}

document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        // Only when annotate modal is open
        if (activeModal === 'modal-annotate') {
            e.preventDefault();
            performUndo();
        }
    }
});

// Tool switching
document.querySelectorAll('.anno-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.anno-btn[data-tool]').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        annoState.tool = btn.dataset.tool;
        const canvas = document.getElementById('anno-canvas');
        const cursors = { draw:'crosshair', highlight:'crosshair', text:'text', eraser:'cell', pan:'grab' };
        canvas.style.cursor = cursors[annoState.tool] || 'crosshair';
        // Pan mode: allow touch scrolling on canvas wrap
        const wrap = document.getElementById('anno-canvas-wrap');
        wrap.style.touchAction = annoState.tool === 'pan' ? 'auto' : 'none';
        if (annoState.tool === 'pan') wrap.classList.add('pan-mode');
        else wrap.classList.remove('pan-mode');
    });
});

// Live toolbar → update active unconfirmed text node
function getActiveUnconfirmedText() {
    if (annoState.idx < 0) return null;
    const pg = state.pages[annoState.idx];
    return pg.annotations.find(a => a.type === 'text' && !a.confirmed) || null;
}

function getActiveTextDomNode(a) {
    if (!a) return null;
    const pg = state.pages[annoState.idx];
    const idx = pg.annotations.indexOf(a);
    const nodes = document.querySelectorAll('#anno-text-layer .anno-text-node');
    for (const n of nodes) {
        if (parseInt(n.dataset.annoIdx) === idx) return n;
    }
    return null;
}

document.getElementById('anno-font').addEventListener('change', e => {
    const a = getActiveUnconfirmedText();
    if (!a) return;
    a.fontFamily = e.target.value;
    const node = getActiveTextDomNode(a);
    if (node) node.style.fontFamily = `'${a.fontFamily}', sans-serif`;
});

document.getElementById('anno-color').addEventListener('input', e => {
    const a = getActiveUnconfirmedText();
    if (!a) return;
    a.color = e.target.value;
    const node = getActiveTextDomNode(a);
    if (node) node.style.color = a.color;
});

document.getElementById('anno-size').addEventListener('change', e => {
    const a = getActiveUnconfirmedText();
    if (!a) return;
    a.size = parseInt(e.target.value);
    const node = getActiveTextDomNode(a);
    if (node) {
        const canvas = document.getElementById('anno-canvas');
        const scaleX = canvas.offsetWidth / canvas.width;
        node.style.fontSize = (a.size * 4 * scaleX) + 'px';
    }
});

// Canvas events — draw / highlight strokes / text create / eraser / pan
const annoCanvas = document.getElementById('anno-canvas');

function getAnnoPos(e) {
    const r = annoCanvas.getBoundingClientRect();
    const clientX = e.clientX ?? (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
    const clientY = e.clientY ?? (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
    const cx = clientX - r.left;
    const cy = clientY - r.top;
    return { x: cx * (annoCanvas.width / r.width), y: cy * (annoCanvas.height / r.height) };
}

// Track touch count to distinguish draw (1 finger) from scroll (2 fingers)
let touchCount = 0;

function annoDown(e) {
    // Pan tool: don't capture, let native scroll work
    if (annoState.tool === 'pan') return;

    // Touch: only capture single-finger. Two+ fingers = native scroll/zoom
    if (e.touches) {
        touchCount = e.touches.length;
        if (touchCount > 1) return; // let browser handle pinch/scroll
    }

    e.preventDefault();
    const pg = state.pages[annoState.idx];

    if (annoState.tool === 'text') {
        if (hasUnconfirmedText()) {
            toast('Confirm or remove the current text before adding another');
            return;
        }
        pushUndo();
        const pos = getAnnoPos(e);
        const a = {
            type: 'text', text: 'Text', x: pos.x, y: pos.y,
            color: document.getElementById('anno-color').value,
            size: parseInt(document.getElementById('anno-size').value),
            fontFamily: document.getElementById('anno-font').value,
            confirmed: false,
        };
        pg.annotations.push(a);
        const canvas = document.getElementById('anno-canvas');
        const scaleX = canvas.offsetWidth / canvas.width;
        const scaleY = canvas.offsetHeight / canvas.height;
        const { wrap, node } = createTextNode(a, pg.annotations.length - 1, scaleX, scaleY);
        requestAnimationFrame(() => {
            node.classList.add('editing');
            node.focus();
            const range = document.createRange();
            range.selectNodeContents(node);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        });
        return;
    }

    if (annoState.tool === 'eraser') {
        const pos = getAnnoPos(e);
        for (let i = pg.annotations.length - 1; i >= 0; i--) {
            const a = pg.annotations[i];
            if (a.type === 'text') continue;
            if (a.type === 'highlight') continue;
            if (a.points) {
                for (const p of a.points) {
                    if (Math.abs(pos.x - p.x) < 20 && Math.abs(pos.y - p.y) < 20) {
                        pushUndo();
                        pg.annotations.splice(i, 1);
                        redrawAnnoCanvas();
                        rebuildOverlayLayer();
                        return;
                    }
                }
            }
        }
        return;
    }

    // Draw / Highlight stroke
    annoState.drawing = true;
    const pos = getAnnoPos(e);
    currentStroke = {
        type: annoState.tool, points: [pos],
        color: document.getElementById('anno-color').value,
        size: parseInt(document.getElementById('anno-size').value),
    };
}

function annoMove(e) {
    if (!annoState.drawing || !currentStroke) return;
    // If a second finger appeared during draw, cancel the stroke
    if (e.touches && e.touches.length > 1) {
        annoState.drawing = false;
        currentStroke = null;
        redrawAnnoCanvas();
        return;
    }
    e.preventDefault();
    const pos = getAnnoPos(e);
    currentStroke.points.push(pos);
    redrawAnnoCanvas();
    if (currentStroke.type === 'draw') {
        drawAnno(annoCanvas.getContext('2d'), currentStroke);
    } else if (currentStroke.type === 'highlight') {
        const ctx = annoCanvas.getContext('2d');
        ctx.save();
        ctx.fillStyle = currentStroke.color;
        ctx.globalAlpha = 0.3;
        const minX = Math.min(...currentStroke.points.map(p => p.x));
        const maxX = Math.max(...currentStroke.points.map(p => p.x));
        const minY = Math.min(...currentStroke.points.map(p => p.y));
        const maxY = Math.max(...currentStroke.points.map(p => p.y));
        ctx.fillRect(minX, minY, maxX - minX, (maxY - minY) + currentStroke.size * 3);
        ctx.restore();
    }
}

function annoUp(e) {
    if (!annoState.drawing || !currentStroke) return;
    annoState.drawing = false;
    if (currentStroke.points.length > 1) {
        pushUndo();
        state.pages[annoState.idx].annotations.push(currentStroke);
        if (currentStroke.type === 'highlight') {
            rebuildOverlayLayer();
            redrawAnnoCanvas();
        }
    }
    currentStroke = null;
}

annoCanvas.addEventListener('mousedown', annoDown);
annoCanvas.addEventListener('mousemove', annoMove);
annoCanvas.addEventListener('mouseup', annoUp);
annoCanvas.addEventListener('mouseleave', annoUp);

// Touch events: use {passive: false} only for touchmove so we can conditionally preventDefault
annoCanvas.addEventListener('touchstart', annoDown, { passive: false });
annoCanvas.addEventListener('touchmove', annoMove, { passive: false });
annoCanvas.addEventListener('touchend', annoUp);

document.getElementById('btn-anno-undo').addEventListener('click', () => {
    performUndo();
});

document.getElementById('btn-anno-clear').addEventListener('click', () => {
    pushUndo();
    state.pages[annoState.idx].annotations = [];
    redrawAnnoCanvas();
    rebuildOverlayLayer();
});

function closeAnnotate() {
    closeModal('modal-annotate');
    annoState.pdfDoc = null;
    annoState.baseImage = null;
    document.getElementById('anno-text-layer').innerHTML = '';
    renderGrid();
}
document.getElementById('anno-close').addEventListener('click', () => closeModalAndGoBack('modal-annotate'));
document.getElementById('btn-anno-cancel').addEventListener('click', () => closeModalAndGoBack('modal-annotate'));

document.getElementById('btn-anno-apply').addEventListener('click', () => {
    // Auto-confirm any unconfirmed text
    const pg = state.pages[annoState.idx];
    pg.annotations.forEach(a => { if (a.type === 'text' && !a.confirmed) a.confirmed = true; });

    closeModalAndGoBack('modal-annotate');
    annoState.pdfDoc = null;
    annoState.baseImage = null;
    document.getElementById('anno-text-layer').innerHTML = '';
    renderGrid();
    toast('Annotations saved');
});

// ===================== FORM FILL MODAL =====================

const formState = { startIdx: 0, currentPageIdx: 0, formPageIndices: [], scale: 1.5 };

// Toolbar button — opens form filler across all pages with forms
document.getElementById('btn-fill-form').addEventListener('click', () => {
    const formPages = state.pages.map((p, i) => ({ idx: i, pg: p })).filter(x => x.pg.formFields.length > 0);
    if (!formPages.length) return;
    formState.formPageIndices = formPages.map(x => x.idx);
    formState.currentPageIdx = 0;
    openFormFillModal();
});

function openFormFill(pageIdx) {
    // Open from a specific page — build list of all form pages but start at this one
    const formPages = state.pages.map((p, i) => ({ idx: i, pg: p })).filter(x => x.pg.formFields.length > 0);
    if (!formPages.length) { toast('No form fields on this page'); return; }
    formState.formPageIndices = formPages.map(x => x.idx);
    const pos = formState.formPageIndices.indexOf(pageIdx);
    formState.currentPageIdx = pos >= 0 ? pos : 0;
    openFormFillModal();
}

async function openFormFillModal() {
    document.getElementById('form-page-total').textContent = formState.formPageIndices.length;
    openModal('modal-form');
    await renderFormPage();
}

async function renderFormPage() {
    const realIdx = formState.formPageIndices[formState.currentPageIdx];
    const pg = state.pages[realIdx];
    const srcData = pg.data || pg.srcFile;
    const srcIdx = pg.data ? 0 : pg.srcPageIdx;

    document.getElementById('form-page-num').textContent = formState.currentPageIdx + 1;
    document.getElementById('form-page-info').textContent =
        `Page ${realIdx + 1} · ${pg.formFields.length} field(s)`;
    document.getElementById('form-prev').disabled = formState.currentPageIdx <= 0;
    document.getElementById('form-next').disabled = formState.currentPageIdx >= formState.formPageIndices.length - 1;

    // Render page
    const pdf = await getPdfDoc(srcData);
    const page = await pdf.getPage(srcIdx + 1);
    const vp = page.getViewport({ scale: formState.scale });
    const canvas = document.getElementById('form-canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;

    // Build form fields overlay
    const layer = document.getElementById('form-fields-layer');
    layer.innerHTML = '';

    // We need the PDF page dimensions (unscaled) to map field rects
    const baseVp = page.getViewport({ scale: 1 });

    // Wait for canvas to be laid out
    requestAnimationFrame(() => {
        const canvasRect = canvas.getBoundingClientRect();
        const layerRect = layer.parentElement.getBoundingClientRect();

        // Scale factors from PDF points to rendered pixels on screen
        const displayScaleX = canvasRect.width / baseVp.width;
        const displayScaleY = canvasRect.height / baseVp.height;

        // Offset of canvas within layer parent
        const offsetX = canvasRect.left - layerRect.left;
        const offsetY = canvasRect.top - layerRect.top;

        pg.formFields.forEach(field => {
            const r = field.rect;
            // PDF rect is bottom-left origin → convert to top-left
            const left = offsetX + r.x * displayScaleX;
            const top = offsetY + (baseVp.height - r.y - r.height) * displayScaleY;
            const width = r.width * displayScaleX;
            const height = r.height * displayScaleY;

            const wrap = document.createElement('div');
            wrap.className = 'form-field-wrap';
            wrap.style.left = left + 'px';
            wrap.style.top = top + 'px';
            wrap.style.width = Math.max(width, 20) + 'px';
            wrap.style.height = Math.max(height, 16) + 'px';
            wrap.title = field.name;

            // Get stored user value or default
            const userVal = pg.formValues.hasOwnProperty(field.name)
                ? pg.formValues[field.name]
                : field.value;

            let input;

            if (field.type === 'PDFCheckBox') {
                input = document.createElement('input');
                input.type = 'checkbox';
                input.className = 'form-field-input';
                input.checked = !!userVal;
                input.style.width = Math.min(height, width) + 'px';
                input.style.height = Math.min(height, width) + 'px';
                input.addEventListener('change', () => {
                    pg.formValues[field.name] = input.checked;
                });
            } else if (field.type === 'PDFDropdown' || field.type === 'PDFOptionList') {
                input = document.createElement('select');
                input.className = 'form-field-select';
                input.style.fontSize = Math.max(Math.round(height * 0.6), 10) + 'px';
                // Add empty option
                const emptyOpt = document.createElement('option');
                emptyOpt.value = ''; emptyOpt.textContent = '— Select —';
                input.appendChild(emptyOpt);
                (field.options || []).forEach(opt => {
                    const o = document.createElement('option');
                    o.value = opt; o.textContent = opt;
                    if (opt === userVal || (Array.isArray(userVal) && userVal.includes(opt))) o.selected = true;
                    input.appendChild(o);
                });
                input.addEventListener('change', () => {
                    pg.formValues[field.name] = input.value;
                });
            } else if (field.type === 'PDFRadioGroup') {
                // Render as dropdown for simplicity
                input = document.createElement('select');
                input.className = 'form-field-select';
                input.style.fontSize = Math.max(Math.round(height * 0.6), 10) + 'px';
                const emptyOpt = document.createElement('option');
                emptyOpt.value = ''; emptyOpt.textContent = '— Select —';
                input.appendChild(emptyOpt);
                (field.options || []).forEach(opt => {
                    const o = document.createElement('option');
                    o.value = opt; o.textContent = opt;
                    if (opt === userVal) o.selected = true;
                    input.appendChild(o);
                });
                input.addEventListener('change', () => {
                    pg.formValues[field.name] = input.value;
                });
            } else {
                // Text field (default)
                if (field.isMultiline) {
                    input = document.createElement('textarea');
                    input.className = 'form-field-textarea';
                } else {
                    input = document.createElement('input');
                    input.type = 'text';
                    input.className = 'form-field-input';
                }
                input.style.fontSize = Math.max(Math.round(height * 0.6), 10) + 'px';
                input.value = userVal || '';
                input.placeholder = field.name;
                input.addEventListener('input', () => {
                    pg.formValues[field.name] = input.value;
                });
            }

            wrap.appendChild(input);
            layer.appendChild(wrap);
        });
    });
}

// Page navigation
document.getElementById('form-prev').addEventListener('click', () => {
    if (formState.currentPageIdx > 0) { formState.currentPageIdx--; renderFormPage(); }
});
document.getElementById('form-next').addEventListener('click', () => {
    if (formState.currentPageIdx < formState.formPageIndices.length - 1) { formState.currentPageIdx++; renderFormPage(); }
});

// Apply & Close
document.getElementById('btn-form-apply').addEventListener('click', () => {
    closeModalAndGoBack('modal-form');
    document.getElementById('form-fields-layer').innerHTML = '';
    toast('Form values saved — they will be embedded on download');
});

// Reset
document.getElementById('btn-form-reset').addEventListener('click', () => {
    formState.formPageIndices.forEach(idx => {
        state.pages[idx].formValues = {};
    });
    renderFormPage();
    toast('All form fields reset');
});

// Cancel
document.getElementById('form-close').addEventListener('click', () => {
    closeModalAndGoBack('modal-form');
    document.getElementById('form-fields-layer').innerHTML = '';
});
document.getElementById('btn-form-cancel').addEventListener('click', () => {
    closeModalAndGoBack('modal-form');
    document.getElementById('form-fields-layer').innerHTML = '';
});

// ===================== WATERMARK MODAL =====================

document.getElementById('btn-watermark').addEventListener('click', () => {
    if (!state.pages.length) return;
    openModal('modal-watermark');
});

document.getElementById('wm-close').addEventListener('click', () => closeModalAndGoBack('modal-watermark'));
document.getElementById('btn-wm-cancel').addEventListener('click', () => closeModalAndGoBack('modal-watermark'));

document.getElementById('wm-size').addEventListener('input', e => { document.getElementById('wm-size-val').textContent = e.target.value + 'px'; });
document.getElementById('wm-rotation').addEventListener('input', e => { document.getElementById('wm-rot-val').textContent = e.target.value + '°'; });
document.getElementById('wm-opacity').addEventListener('input', e => { document.getElementById('wm-opacity-val').textContent = e.target.value + '%'; });
document.getElementById('wm-color').addEventListener('input', e => { document.getElementById('wm-color-hex').textContent = e.target.value; });

document.getElementById('btn-wm-apply').addEventListener('click', async () => {
    const text = document.getElementById('wm-text').value || 'WATERMARK';
    const fontSize = parseInt(document.getElementById('wm-size').value);
    const rotation = parseInt(document.getElementById('wm-rotation').value);
    const opacity = parseInt(document.getElementById('wm-opacity').value) / 100;
    const hex = document.getElementById('wm-color').value;
    const cr = parseInt(hex.slice(1, 3), 16) / 255;
    const cg = parseInt(hex.slice(3, 5), 16) / 255;
    const cb = parseInt(hex.slice(5, 7), 16) / 255;

    closeModalAndGoBack('modal-watermark');

    for (let i = 0; i < state.pages.length; i++) {
        showProgress(((i + 1) / state.pages.length) * 100, `Watermarking page ${i + 1}/${state.pages.length}`);
        const pg = state.pages[i];
        const srcData = pg.data || pg.srcFile;
        const srcIdx = pg.data ? 0 : pg.srcPageIdx;

        const src = await PDFDocument.load(srcData);
        const single = await PDFDocument.create();
        const [copied] = await single.copyPages(src, [srcIdx]);
        single.addPage(copied);

        const font = await single.embedFont(StandardFonts.HelveticaBold);
        const page = single.getPages()[0];
        const { width, height } = page.getSize();
        const tw = font.widthOfTextAtSize(text, fontSize);

        page.drawText(text, {
            x: (width - tw * Math.cos(rotation * Math.PI / 180)) / 2,
            y: height / 2, size: fontSize, font,
            color: rgb(cr, cg, cb), opacity, rotate: degrees(rotation),
        });

        const bytes = await single.save();
        const newBuf = bytes.buffer;
        // Invalidate old cache if page had custom data
        if (pg.data) invalidateCache(pg.data);
        pg.data = newBuf;
        pg.srcPageIdx = 0;
    }

    hideProgress();
    await renderGrid();
    toast('Watermark applied to all pages');
});

// ===================== DOWNLOAD PDF =====================

document.getElementById('btn-download').addEventListener('click', async () => {
    if (!state.pages.length) return;
    try {
        // First pass: apply form values to source PDFs that have them
        // Group pages by source file so we fill each form document once
        const formSources = new Map(); // abId → { ab, pages: [{pg, srcIdx}] }
        for (const pg of state.pages) {
            if (!pg.formFields.length || !Object.keys(pg.formValues).length) continue;
            const srcData = pg.data || pg.srcFile;
            const id = getAbId(srcData);
            if (!formSources.has(id)) formSources.set(id, { ab: srcData, pages: [] });
            formSources.get(id).pages.push({ pg, srcIdx: pg.data ? 0 : pg.srcPageIdx });
        }

        // Fill forms and bake into new single-page PDFs
        for (const [, info] of formSources) {
            try {
                const filledDoc = await PDFDocument.load(info.ab, { ignoreEncryption: true });
                const form = filledDoc.getForm();

                // Collect all form values from pages using this source
                const allValues = {};
                for (const { pg } of info.pages) {
                    Object.assign(allValues, pg.formValues);
                }

                // Apply values
                for (const [fieldName, val] of Object.entries(allValues)) {
                    try {
                        const field = form.getFieldMaybe ? form.getFieldMaybe(fieldName) : null;
                        let f = field;
                        if (!f) {
                            try { f = form.getTextField(fieldName); } catch(e) {}
                        }
                        if (!f) {
                            try { f = form.getCheckBox(fieldName); } catch(e) {}
                        }
                        if (!f) {
                            try { f = form.getDropdown(fieldName); } catch(e) {}
                        }
                        if (!f) {
                            try { f = form.getRadioGroup(fieldName); } catch(e) {}
                        }
                        if (!f) {
                            try { f = form.getOptionList(fieldName); } catch(e) {}
                        }

                        if (f) {
                            const typeName = f.constructor.name;
                            if (typeName === 'PDFTextField') {
                                f.setText(val || '');
                            } else if (typeName === 'PDFCheckBox') {
                                if (val) f.check(); else f.uncheck();
                            } else if (typeName === 'PDFDropdown') {
                                if (val) f.select(val); else f.clear();
                            } else if (typeName === 'PDFRadioGroup') {
                                if (val) f.select(val);
                            } else if (typeName === 'PDFOptionList') {
                                if (Array.isArray(val)) val.forEach(v => f.select(v));
                                else if (val) f.select(val);
                            }
                        }
                    } catch(e) { /* skip unresolvable fields */ }
                }

                // Flatten form so values are baked in
                try { form.flatten(); } catch(e) {}

                const filledBytes = await filledDoc.save();
                const filledBuf = filledBytes.buffer;

                // Now update each page that used this source with its own single-page extract
                for (const { pg, srcIdx } of info.pages) {
                    const filledSrc = await PDFDocument.load(filledBuf);
                    const single = await PDFDocument.create();
                    const [copied] = await single.copyPages(filledSrc, [srcIdx]);
                    single.addPage(copied);
                    const singleBytes = await single.save();
                    if (pg.data) invalidateCache(pg.data);
                    pg.data = singleBytes.buffer;
                    pg.srcPageIdx = 0;
                    pg.formFields = []; // Form is now flattened
                    pg.formValues = {};
                }
            } catch(e) {
                console.warn('Form fill error:', e);
            }
        }

        // Second pass: build final output
        const out = await PDFDocument.create();
        // Embed all fonts we might need
        const embeddedFonts = {};
        for (const [css, std] of Object.entries(FONT_MAP)) {
            if (!embeddedFonts[std]) embeddedFonts[std] = await out.embedFont(std);
        }
        const defaultFont = embeddedFonts[StandardFonts.Helvetica];

        for (let i = 0; i < state.pages.length; i++) {
            showProgress(((i + 1) / state.pages.length) * 95, `Building page ${i + 1}/${state.pages.length}`);
            const pg = state.pages[i];
            const srcData = pg.data || pg.srcFile;
            const srcIdx = pg.data ? 0 : pg.srcPageIdx;

            const src = await PDFDocument.load(srcData);
            const [copied] = await out.copyPages(src, [srcIdx]);

            if (pg.rotation) {
                const existing = copied.getRotation().angle || 0;
                copied.setRotation(degrees(existing + pg.rotation));
            }
            if (pg.crop) {
                copied.setCropBox(pg.crop.x, pg.crop.y, pg.crop.w, pg.crop.h);
                copied.setMediaBox(pg.crop.x, pg.crop.y, pg.crop.w, pg.crop.h);
            }

            out.addPage(copied);
            const outPage = out.getPages()[out.getPageCount() - 1];

            if (pg.annotations.length) {
                const origPage = src.getPages()[srcIdx];
                const { width: ow, height: oh } = origPage.getSize();
                const renderPdf = await pdfjsLib.getDocument({ data: srcData.slice(0) }).promise;
                const renderPage = await renderPdf.getPage(srcIdx + 1);
                const vp = renderPage.getViewport({ scale: annoState.scale || 1.5 });
                const sx = ow / vp.width, sy = oh / vp.height;

                for (const a of pg.annotations) {
                    const hx = a.color;
                    const ar = parseInt(hx.slice(1, 3), 16) / 255;
                    const ag = parseInt(hx.slice(3, 5), 16) / 255;
                    const ab = parseInt(hx.slice(5, 7), 16) / 255;
                    const color = rgb(ar, ag, ab);

                    if (a.type === 'text') {
                        const stdFont = FONT_MAP[a.fontFamily] || StandardFonts.Helvetica;
                        const font = embeddedFonts[stdFont] || defaultFont;
                        // Handle multiline text
                        const lines = (a.text || '').split('\n');
                        const fontSize = a.size * 4 * sx;
                        lines.forEach((line, li) => {
                            if (!line) return;
                            outPage.drawText(line, {
                                x: a.x * sx,
                                y: oh - a.y * sy - (li * fontSize * 1.3),
                                size: fontSize, font, color,
                            });
                        });
                    } else if (a.type === 'draw' && a.points.length > 1) {
                        for (let j = 1; j < a.points.length; j++) {
                            outPage.drawLine({
                                start: { x: a.points[j - 1].x * sx, y: oh - a.points[j - 1].y * sy },
                                end: { x: a.points[j].x * sx, y: oh - a.points[j].y * sy },
                                thickness: a.size * sx, color,
                            });
                        }
                    } else if (a.type === 'highlight') {
                        // Use stored rect if available (may have been dragged)
                        let rx, ry, rw, rh;
                        if (a.rect) {
                            rx = a.rect.x * sx;
                            ry = a.rect.y * sy;
                            rw = a.rect.w * sx;
                            rh = a.rect.h * sy;
                        } else if (a.points && a.points.length > 1) {
                            const minX = Math.min(...a.points.map(p => p.x));
                            const maxX = Math.max(...a.points.map(p => p.x));
                            const minY = Math.min(...a.points.map(p => p.y));
                            const maxY = Math.max(...a.points.map(p => p.y));
                            rx = minX * sx; ry = minY * sy;
                            rw = (maxX - minX) * sx;
                            rh = ((maxY - minY) + a.size * 3) * sy;
                        } else continue;

                        outPage.drawRectangle({
                            x: rx, y: oh - ry - rh,
                            width: rw, height: rh,
                            color, opacity: 0.3,
                        });
                    }
                }
            }
        }

        showProgress(97, 'Saving...');
        const bytes = await out.save();
        const names = [...new Set(state.pages.map(p => p.srcName))];
        let fname = 'edited.pdf';
        if (names.length === 1) fname = names[0].replace('.pdf', '') + '_edited.pdf';
        else if (names.length <= 3) fname = names.map(n => n.replace('.pdf', '')).join('_') + '_merged.pdf';
        else fname = 'merged_' + state.pages.length + 'pages.pdf';

        downloadBlob(bytes, fname);
        showProgress(100, 'Done!');
        toast('PDF downloaded!');
    } catch (err) {
        console.error(err);
        toast('Error: ' + err.message);
    }
    setTimeout(hideProgress, 1500);
});

// ===================== PWA =====================

// ===================== PWA INSTALL =====================

let deferredPrompt;
const pwaBtn = document.getElementById('pwa-install');
const iosBanner = document.getElementById('ios-install-banner');

// Detect if already running as installed PWA
function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches
        || window.navigator.standalone === true;
}

// Detect iOS Safari (not Chrome/Firefox on iOS, not already standalone)
function isIosSafari() {
    const ua = navigator.userAgent;
    const isIos = /iP(hone|ad|od)/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|OPiOS|EdgiOS/.test(ua);
    return isIos && isSafari && !isStandalone();
}

// Chrome/Android/Edge/desktop install prompt
window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    pwaBtn.style.display = '';
});

pwaBtn.addEventListener('click', () => {
    if (deferredPrompt) {
        deferredPrompt.prompt();
        deferredPrompt.userChoice.then(result => {
            deferredPrompt = null;
            if (result.outcome === 'accepted') pwaBtn.style.display = 'none';
        });
    } else if (isIosSafari()) {
        // Fallback: show the iOS banner from the button too
        iosBanner.classList.add('show');
    }
});

// Hide install button once app is installed
window.addEventListener('appinstalled', () => {
    pwaBtn.style.display = 'none';
    deferredPrompt = null;
    toast('App installed!');
});

// iOS Safari: show the banner after a short delay if not dismissed before
if (isIosSafari()) {
    const dismissed = sessionStorage.getItem('pwa-ios-dismissed');
    if (!dismissed) {
        // Show the install button in header too (for iOS it opens the banner)
        pwaBtn.style.display = '';
        // Show banner after 2s
        setTimeout(() => {
            iosBanner.classList.add('show');
        }, 2000);
    } else {
        // Still show the header button even if banner was dismissed
        pwaBtn.style.display = '';
    }
}

document.getElementById('ios-install-close').addEventListener('click', () => {
    iosBanner.classList.remove('show');
    sessionStorage.setItem('pwa-ios-dismissed', '1');
});

// Service worker
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

})();

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
    password: null,
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

async function getPdfDoc(ab, password) {
    const id = getAbId(ab);
    const cacheKey = id + (password ? ':' + password : '');
    if (pdfDocCache.has(cacheKey)) return pdfDocCache.get(cacheKey);
    const opts = { data: ab.slice(0) };
    if (password) opts.password = password;
    const doc = await pdfjsLib.getDocument(opts).promise;
    pdfDocCache.set(cacheKey, doc);
    return doc;
}

// Ask user for a PDF password — returns the password string or null (skip)
function promptPdfPassword(filename, isRetry) {
    return new Promise(resolve => {
        document.getElementById('pdf-pw-filename').textContent = `"${filename}" is password protected`;
        document.getElementById('pdf-pw-input').value = '';
        document.getElementById('pdf-pw-error').style.display = isRetry ? 'block' : 'none';
        document.getElementById('modal-pdf-password').classList.add('on');
        requestAnimationFrame(() => document.getElementById('pdf-pw-input').focus());

        function submit() {
            cleanup();
            resolve(document.getElementById('pdf-pw-input').value || null);
        }
        function skip() {
            cleanup();
            resolve(null);
        }
        function onKey(e) {
            if (e.key === 'Enter') submit();
        }

        function cleanup() {
            document.getElementById('modal-pdf-password').classList.remove('on');
            document.getElementById('btn-pdf-pw-ok').removeEventListener('click', submit);
            document.getElementById('btn-pdf-pw-skip').removeEventListener('click', skip);
            document.getElementById('pdf-pw-input').removeEventListener('keydown', onKey);
        }

        document.getElementById('btn-pdf-pw-ok').addEventListener('click', submit);
        document.getElementById('btn-pdf-pw-skip').addEventListener('click', skip);
        document.getElementById('pdf-pw-input').addEventListener('keydown', onKey);
    });
}

// Load a PDF with automatic password prompting
async function loadPdfWithPassword(data, filename) {
    let password = undefined;
    let isRetry = false;
    while (true) {
        try {
            const pdf = await getPdfDoc(data, password);
            return { pdf, password }; // success
        } catch (err) {
            // PDF.js throws PasswordException for encrypted files
            const isPasswordError = err && (
                err.name === 'PasswordException' ||
                err.code === 1 || // NEED_PASSWORD
                err.code === 2 || // INCORRECT_PASSWORD
                (err.message && err.message.toLowerCase().includes('password'))
            );
            if (!isPasswordError) throw err; // other error — propagate

            // Prompt user
            password = await promptPdfPassword(filename, isRetry);
            if (!password) return null; // user skipped
            isRetry = true;
        }
    }
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
    const hasPages = state.pages.length > 0;
    const has = state.selected.size > 0;

    document.getElementById('stat-pages').textContent = state.pages.length;
    document.getElementById('stat-selected').textContent = state.selected.size;

    // Needs pages to exist
    document.getElementById('btn-select-all').disabled = !hasPages;
    document.getElementById('btn-deselect').disabled = !hasPages;
    document.getElementById('btn-watermark').disabled = !hasPages;
    document.getElementById('btn-download').disabled = !hasPages;
    document.getElementById('btn-compress').disabled = !hasPages;

    // Needs a selection
    document.getElementById('btn-rotate').disabled = !has;
    document.getElementById('btn-remove').disabled = !has;
    document.getElementById('btn-crop').disabled = state.selected.size !== 1;
    document.getElementById('btn-annotate').disabled = state.selected.size !== 1;

    // New buttons that need pages
    ['btn-insert-blank','btn-stamp','btn-page-numbers','btn-header-footer','btn-password','btn-share','btn-redact','btn-resize-page'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = !hasPages;
    });

    // Fill Form — any page has form fields
    const anyForms = state.pages.some(p => p.formFields && p.formFields.length > 0);
    document.getElementById('btn-fill-form').disabled = !anyForms;
}

// ===================== RESET PROJECT =====================

document.getElementById('btn-reset').addEventListener('click', () => {
    openModal('modal-reset');
});
document.getElementById('btn-reset-cancel').addEventListener('click', () => closeModalAndGoBack('modal-reset'));
document.getElementById('btn-reset-confirm').addEventListener('click', () => {
    closeModal('modal-reset');
    if (history.state && history.state.modal) history.back();
    state.pages = [];
    state.selected.clear();
    state.password = null;
    thumbCache.clear();
    pdfDocCache.clear();
    document.getElementById('screen-editor').classList.remove('on');
    document.getElementById('screen-upload').classList.add('on');
    updateStats();
    toast('Project reset');
});

// ===================== CTRL/STRG + A — SELECT ALL =====================

document.addEventListener('keydown', e => {
    const editorActive = document.getElementById('screen-editor').classList.contains('on');
    const inputFocused = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
    if (editorActive && !activeModal && !inputFocused && (e.ctrlKey || e.metaKey) && e.key === 'a') {
        e.preventDefault();
        state.pages.forEach((_, i) => state.selected.add(i));
        document.querySelectorAll('.page-thumb').forEach(t => t.classList.add('selected'));
        updateStats();
    }
});

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
        if (closing === 'modal-reset') {
            // no special cleanup needed
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
    const pdfFiles = files.filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    const imgFiles = files.filter(f => f.type.startsWith('image/'));
    if (!pdfFiles.length && !imgFiles.length) { toast('Please select PDF or image files'); return; }

    const total = pdfFiles.length + imgFiles.length;
    let done = 0;

    for (const file of pdfFiles) {
        showProgress(((done + 1) / total) * 80, `Loading ${file.name}...`);
        const data = await readFile(file);

        // Try loading — will prompt for password if encrypted
        const result = await loadPdfWithPassword(data, file.name);
        if (!result) { done++; continue; } // user skipped this file
        const { pdf, password } = result;

        // If password-protected, decrypt to a plain buffer so all later operations work
        let workingData = data;
        if (password) {
            try {
                showProgress(((done + 1) / total) * 80, `Decrypting ${file.name}...`);
                const encrypted = await PDFDocument.load(data, { password, ignoreEncryption: false });
                const decrypted = await PDFDocument.create();
                const pages = await decrypted.copyPages(encrypted, encrypted.getPageIndices());
                pages.forEach(p => decrypted.addPage(p));
                const decBytes = await decrypted.save();
                // Make a clean ArrayBuffer copy — decBytes may be a view into a larger buffer
                workingData = decBytes.slice(0).buffer;
            } catch(e) {
                toast(`Could not decrypt ${file.name}: ${e.message}`);
                done++; continue;
            }
        }

        // Detect form fields via pdf-lib
        let formFieldsByPage = {};
        try {
            const pdfLibDoc = await PDFDocument.load(workingData, { ignoreEncryption: true });
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
                srcFile: workingData, srcName: file.name, srcPageIdx: pi,
                data: null, rotation: 0, crop: null, annotations: [],
                formFields: formFieldsByPage[pi] || [],
                formValues: {},
            });
        }
        done++;
    }

    // Convert image files to single-page PDFs
    for (const file of imgFiles) {
        showProgress(((done + 1) / total) * 80, `Converting ${file.name}…`);
        const bytes = await convertImageToPdfBytes(file);
        state.pages.push({
            srcFile: bytes, srcName: file.name.replace(/\.[^.]+$/, '') + '.pdf',
            srcPageIdx: 0, data: null, rotation: 0, crop: null, annotations: [],
            formFields: [], formValues: {},
        });
        done++;
    }

    showProgress(90, 'Rendering thumbnails...');
    showEditor();
    await renderGrid();
    hideProgress();

    const totalFields = state.pages.reduce((s, p) => s + p.formFields.length, 0);
    const summary = [];
    if (pdfFiles.length) summary.push(`${pdfFiles.length} PDF(s)`);
    if (imgFiles.length) summary.push(`${imgFiles.length} image(s)`);
    const base = `Loaded ${summary.join(', ')} — ${state.pages.length} page(s)`;
    toast(totalFields > 0 ? base + ` — ${totalFields} form field(s) detected` : base);
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

    // Reset tool to pan (default)
    document.querySelectorAll('.anno-btn[data-tool]').forEach(b => b.classList.remove('on'));
    document.querySelector('.anno-btn[data-tool="pan"]').classList.add('on');
    annoState.tool = 'pan';
    canvas.style.cursor = 'grab';
    // Default: allow touch scroll on canvas (pan mode)
    const wrapEl = document.getElementById('anno-canvas-wrap');
    wrapEl.style.touchAction = 'auto';
    wrapEl.classList.add('pan-mode');
    // Update zoom display
    updateZoomDisplay();
}

function updateZoomDisplay() {
    document.getElementById('anno-zoom-level').textContent = Math.round(annoState.scale * 100) + '%';
}

async function reRenderAnnotateAtScale() {
    if (annoState.idx < 0 || !annoState.pdfDoc) return;
    const pg = state.pages[annoState.idx];
    const srcData = pg.data || pg.srcFile;
    const srcIdx = pg.data ? 0 : pg.srcPageIdx;

    const page = await annoState.pdfDoc.getPage(srcIdx + 1);
    const vp = page.getViewport({ scale: annoState.scale });
    const canvas = document.getElementById('anno-canvas');
    canvas.width = vp.width; canvas.height = vp.height;
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport: vp }).promise;

    annoState.baseImage = ctx.getImageData(0, 0, canvas.width, canvas.height);
    pg.annotations.filter(a => a.type === 'draw').forEach(a => drawAnno(ctx, a));
    rebuildOverlayLayer();
    updateZoomDisplay();

    // If canvas is wider than the wrap, auto-switch to pan so user can scroll
    const wrap = document.getElementById('anno-canvas-wrap');
    if (canvas.width > wrap.clientWidth || canvas.height > wrap.clientHeight) {
        // Auto-activate pan if on a touch device
        if ('ontouchstart' in window) {
            annoState.tool = 'pan';
            document.querySelectorAll('.anno-btn[data-tool]').forEach(b => b.classList.remove('on'));
            const panBtn = document.querySelector('.anno-btn[data-tool="pan"]');
            if (panBtn) panBtn.classList.add('on');
            wrap.style.touchAction = 'auto';
            wrap.classList.add('pan-mode');
            canvas.style.cursor = 'grab';
        }
    }
}

document.getElementById('btn-anno-zoom-in').addEventListener('click', () => {
    annoState.scale = Math.min(3, +(annoState.scale + 0.25).toFixed(2));
    reRenderAnnotateAtScale();
});

document.getElementById('btn-anno-zoom-out').addEventListener('click', () => {
    annoState.scale = Math.max(0.25, +(annoState.scale - 0.25).toFixed(2));
    reRenderAnnotateAtScale();
});

// ===================== STAMP MINI-PAD (in annotate) =====================

const stampMiniState = { type: 'draw-sig', imgDataUrl: null };

// Type switching
document.querySelectorAll('[data-stype]').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('[data-stype]').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        stampMiniState.type = btn.dataset.stype;
        document.querySelectorAll('.stamp-input-panel').forEach(p => p.classList.remove('on'));
        document.getElementById('sip-' + btn.dataset.stype).classList.add('on');
    });
});

// Mini draw pad
const miniCanvas = document.getElementById('stamp-mini-canvas');
const miniCtx = miniCanvas.getContext('2d');
miniCtx.strokeStyle = '#1a1820'; miniCtx.lineWidth = 2.5; miniCtx.lineCap = 'round';
let miniDrawing = false;
function miniPos(e) {
    const r = miniCanvas.getBoundingClientRect();
    const cx = (e.clientX ?? e.touches[0].clientX) - r.left;
    const cy = (e.clientY ?? e.touches[0].clientY) - r.top;
    return { x: cx * miniCanvas.width / r.width, y: cy * miniCanvas.height / r.height };
}
miniCanvas.addEventListener('mousedown', e => { miniDrawing = true; const p = miniPos(e); miniCtx.beginPath(); miniCtx.moveTo(p.x, p.y); e.preventDefault(); });
miniCanvas.addEventListener('mousemove', e => { if (!miniDrawing) return; const p = miniPos(e); miniCtx.lineTo(p.x, p.y); miniCtx.stroke(); });
miniCanvas.addEventListener('mouseup', () => miniDrawing = false);
miniCanvas.addEventListener('mouseleave', () => miniDrawing = false);
miniCanvas.addEventListener('touchstart', e => { e.preventDefault(); miniDrawing = true; const p = miniPos(e); miniCtx.beginPath(); miniCtx.moveTo(p.x, p.y); }, { passive:false });
miniCanvas.addEventListener('touchmove', e => { e.preventDefault(); if (!miniDrawing) return; const p = miniPos(e); miniCtx.lineTo(p.x, p.y); miniCtx.stroke(); }, { passive:false });
miniCanvas.addEventListener('touchend', () => miniDrawing = false);
document.getElementById('btn-stamp-mini-clear').addEventListener('click', () => miniCtx.clearRect(0, 0, miniCanvas.width, miniCanvas.height));

// Image pick
document.getElementById('btn-stamp-img-pick').addEventListener('click', () => document.getElementById('stamp-img-file').click());
document.getElementById('stamp-img-file').addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
        stampMiniState.imgDataUrl = ev.target.result;
        document.getElementById('stamp-img-name').textContent = file.name;
    };
    reader.readAsDataURL(file);
    e.target.value = '';
});

// Size slider
document.getElementById('stamp-size-range').addEventListener('input', e => {
    document.getElementById('stamp-size-pct').textContent = e.target.value + '%';
});

// Build stamp image data URL from current settings
function buildStampDataUrl() {
    const type = stampMiniState.type;
    if (type === 'draw-sig') {
        return miniCanvas.toDataURL('image/png');
    }
    if (type === 'upload-img') {
        return stampMiniState.imgDataUrl;
    }
    if (type === 'text-stamp') {
        const text = document.getElementById('stamp-text-input').value || 'STAMP';
        const color = document.getElementById('stamp-text-color-sel').value;
        const style = document.getElementById('stamp-text-style-sel').value;
        const tc = document.createElement('canvas'); tc.width = 400; tc.height = 140;
        const tctx = tc.getContext('2d');
        tctx.clearRect(0, 0, 400, 140);
        tctx.font = 'bold 64px Arial, sans-serif';
        tctx.fillStyle = color; tctx.textAlign = 'center'; tctx.textBaseline = 'middle';
        if (style === 'box') { tctx.strokeStyle = color; tctx.lineWidth = 8; tctx.strokeRect(10, 10, 380, 120); }
        if (style === 'circle') { tctx.strokeStyle = color; tctx.lineWidth = 8; tctx.beginPath(); tctx.arc(200, 70, 64, 0, Math.PI * 2); tctx.stroke(); }
        tctx.fillText(text, 200, 70);
        return tc.toDataURL('image/png');
    }
    return null;
}

// Place stamp on canvas click
async function placeStamp(pos) {
    const dataUrl = buildStampDataUrl();
    if (!dataUrl) { toast('Nothing to stamp — draw a signature or select an image'); return; }

    const img = new Image(); img.src = dataUrl;
    await new Promise(res => { img.onload = res; });

    const sizePct = parseInt(document.getElementById('stamp-size-range').value) / 100;
    // Width in PDF points = sizePct * page width
    const pg = state.pages[annoState.idx];
    const srcData = pg.data || pg.srcFile;
    const srcIdx = pg.data ? 0 : pg.srcPageIdx;
    const pdfDoc = await getPdfDoc(srcData);
    const page = await pdfDoc.getPage(srcIdx + 1);
    const baseVp = page.getViewport({ scale: 1 });
    const wPt = baseVp.width * sizePct;
    const hPt = wPt * img.naturalHeight / img.naturalWidth;

    pushUndo();
    const a = {
        type: 'stamp',
        x: pos.x - wPt / 2,   // PDF points, top-left
        y: pos.y - hPt / 2,
        w: wPt, h: hPt,
        dataUrl,
        confirmed: false,
    };
    pg.annotations.push(a);
    rebuildOverlayLayer();
}

// Stamp overlay nodes
function createStampNode(a, annoIdx, s) {
    const layer = document.getElementById('anno-text-layer');
    const wrap = document.createElement('div');
    wrap.className = 'anno-stamp-node' + (a.confirmed ? ' anno-stamp-confirmed' : '');
    wrap.style.left = (a.x * s) + 'px';
    wrap.style.top = (a.y * s) + 'px';
    wrap.style.width = (a.w * s) + 'px';
    wrap.style.position = 'absolute';
    wrap.style.zIndex = '6';

    const img = document.createElement('img');
    img.src = a.dataUrl;
    img.style.width = '100%';
    img.style.display = 'block';
    img.draggable = false;

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'anno-stamp-actions';
    actions.style.display = a.confirmed ? 'none' : 'flex';

    const btnConfirm = document.createElement('button');
    btnConfirm.className = 'anno-text-act act-confirm';
    btnConfirm.innerHTML = '<i class="fas fa-check"></i>';
    btnConfirm.title = 'Confirm';

    const btnDrag = document.createElement('button');
    btnDrag.className = 'anno-text-act act-drag';
    btnDrag.innerHTML = '<i class="fas fa-arrows-alt"></i>';
    btnDrag.title = 'Drag';

    const btnRemove = document.createElement('button');
    btnRemove.className = 'anno-text-act act-remove';
    btnRemove.innerHTML = '<i class="fas fa-times"></i>';
    btnRemove.title = 'Remove';

    actions.appendChild(btnConfirm);
    actions.appendChild(btnDrag);
    actions.appendChild(btnRemove);
    wrap.appendChild(actions);
    wrap.appendChild(img);
    layer.appendChild(wrap);

    function confirmStamp() {
        a.confirmed = true;
        wrap.classList.add('anno-stamp-confirmed');
        actions.style.display = 'none';
    }
    function removeStamp() {
        pushUndo();
        const pg = state.pages[annoState.idx];
        pg.annotations.splice(pg.annotations.indexOf(a), 1);
        rebuildOverlayLayer();
    }
    function startDrag(e) {
        e.preventDefault(); e.stopPropagation();
        pushUndo();
        const startX = e.clientX, startY = e.clientY;
        const origL = parseFloat(wrap.style.left), origT = parseFloat(wrap.style.top);
        const onMove = e2 => {
            wrap.style.left = (origL + e2.clientX - startX) + 'px';
            wrap.style.top = (origT + e2.clientY - startY) + 'px';
        };
        const onUp = () => {
            const sc = annoState.scale;
            a.x = parseFloat(wrap.style.left) / sc;
            a.y = parseFloat(wrap.style.top) / sc;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }

    btnConfirm.addEventListener('click', e => { e.stopPropagation(); confirmStamp(); });
    btnRemove.addEventListener('click', e => { e.stopPropagation(); removeStamp(); });
    btnDrag.addEventListener('mousedown', startDrag);
    img.addEventListener('mousedown', e => { if (a.confirmed) return; startDrag(e); });
    wrap.addEventListener('dblclick', e => {
        e.stopPropagation();
        a.confirmed = false;
        wrap.classList.remove('anno-stamp-confirmed');
        actions.style.display = 'flex';
    });

    return wrap;
}

// ===================== RESIZE TO A4 =====================

document.getElementById('btn-resize-page').addEventListener('click', () => {
    if (!state.pages.length) return;
    openModal('modal-resize');
});
document.getElementById('resize-close').addEventListener('click', () => closeModalAndGoBack('modal-resize'));
document.getElementById('btn-resize-cancel').addEventListener('click', () => closeModalAndGoBack('modal-resize'));

document.querySelectorAll('.resize-mode').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.resize-mode').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
    });
});

document.getElementById('btn-resize-apply').addEventListener('click', async () => {
    const mode = document.querySelector('.resize-mode.on').dataset.mode;
    const orientation = document.getElementById('resize-orientation').value;
    const applyTo = document.getElementById('resize-apply-to').value;

    // A4 in PDF points (1pt = 1/72 inch; A4 = 210×297mm)
    const A4_W = orientation === 'portrait' ? 595.28 : 841.89;
    const A4_H = orientation === 'portrait' ? 841.89 : 595.28;

    closeModalAndGoBack('modal-resize');
    showProgress(0, 'Resizing pages…');

    const targetPages = state.pages.filter((_, i) =>
        applyTo === 'all' || state.selected.has(i)
    );

    for (let pi = 0; pi < targetPages.length; pi++) {
        showProgress(((pi + 1) / targetPages.length) * 95, `Resizing page ${pi + 1}/${targetPages.length}…`);
        const pg = targetPages[pi];
        const srcData = pg.data || pg.srcFile;
        const srcIdx = pg.data ? 0 : pg.srcPageIdx;

        const srcDoc = await PDFDocument.load(srcData);
        const srcPage = srcDoc.getPages()[srcIdx];
        const { width: sw, height: sh } = srcPage.getSize();

        const newDoc = await PDFDocument.create();

        if (mode === 'stretch') {
            // Copy page and set new media box
            const [copied] = await newDoc.copyPages(srcDoc, [srcIdx]);
            newDoc.addPage(copied);
            const outPage = newDoc.getPages()[0];
            outPage.setMediaBox(0, 0, A4_W, A4_H);
            outPage.setCropBox(0, 0, A4_W, A4_H);
        } else {
            // Pad mode: render at 2× and place centred on A4 canvas
            const pdfJsDoc = await pdfjsLib.getDocument({ data: srcData.slice(0) }).promise;
            const renderPg = await pdfJsDoc.getPage(srcIdx + 1);
            const scale2 = 2;
            const renderVp = renderPg.getViewport({ scale: scale2 });
            const canvas = document.createElement('canvas');
            canvas.width = renderVp.width; canvas.height = renderVp.height;
            await renderPg.render({ canvasContext: canvas.getContext('2d'), viewport: renderVp }).promise;

            const jpegB64 = canvas.toDataURL('image/jpeg', 0.95).split(',')[1];
            const jpegBytes = Uint8Array.from(atob(jpegB64), c => c.charCodeAt(0));
            const jpegImg = await newDoc.embedJpg(jpegBytes);

            // Scale content to fit A4 maintaining aspect, centred
            const scaleX = A4_W / sw, scaleY = A4_H / sh;
            const fitScale = Math.min(scaleX, scaleY, 1); // don't upscale beyond original
            const drawW = sw * fitScale, drawH = sh * fitScale;
            const offsetX = (A4_W - drawW) / 2, offsetY = (A4_H - drawH) / 2;

            const outPage = newDoc.addPage([A4_W, A4_H]);
            // White background already (pdf default)
            outPage.drawImage(jpegImg, { x: offsetX, y: offsetY, width: drawW, height: drawH });
        }

        const bytes = await newDoc.save();
        if (pg.data) invalidateCache(pg.data);
        pg.data = bytes.slice(0).buffer;
        pg.srcPageIdx = 0;
    }

    hideProgress();
    await renderGrid();
    toast(`${targetPages.length} page(s) resized to A4`);
});

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
        const s = annoState.scale;
        ctx.strokeStyle = a.color; ctx.lineWidth = a.size * s;
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath();
        a.points.forEach((p, i) => {
            const px = p.x * s, py = p.y * s;
            i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py);
        });
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
    // PDF points → canvas pixels: multiply by annoState.scale
    const s = annoState.scale;

    pg.annotations.forEach((a, i) => {
        if (a.type === 'text') createTextNode(a, i, s, s);
        else if (a.type === 'highlight') createHighlightNode(a, i, s, s);
        else if (a.type === 'stamp') createStampNode(a, i, s);
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
            const s = annoState.scale;
            // DOM pixels (canvas-space) → PDF points
            a.x = parseFloat(wrap.style.left) / s;
            a.y = parseFloat(wrap.style.top) / s + a.size * 4;
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
                const s = annoState.scale;
                a.rect.x = parseFloat(node.style.left) / s;
                a.rect.y = parseFloat(node.style.top) / s;
                a.rect.w = parseFloat(node.style.width) / s;
                a.rect.h = parseFloat(node.style.height) / s;
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
            const s = annoState.scale;
            a.rect.x = parseFloat(node.style.left) / s;
            a.rect.y = parseFloat(node.style.top) / s;
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
        const cursors = { draw:'crosshair', highlight:'crosshair', text:'text', eraser:'cell', pan:'grab', stamp:'copy' };
        canvas.style.cursor = cursors[annoState.tool] || 'crosshair';
        const wrap = document.getElementById('anno-canvas-wrap');
        wrap.style.touchAction = annoState.tool === 'pan' ? 'auto' : 'none';
        if (annoState.tool === 'pan') wrap.classList.add('pan-mode');
        else wrap.classList.remove('pan-mode');
        // Show stamp opts or draw opts
        const isStamp = annoState.tool === 'stamp';
        document.getElementById('stamp-opts-row').style.display = isStamp ? 'flex' : 'none';
        document.getElementById('draw-opts-row').style.display = isStamp ? 'none' : 'flex';
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
        node.style.fontSize = (a.size * 4 * annoState.scale) + 'px';
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
    // Convert from screen pixels → canvas pixels → PDF points
    const canvasX = cx * (annoCanvas.width / r.width);
    const canvasY = cy * (annoCanvas.height / r.height);
    return { x: canvasX / annoState.scale, y: canvasY / annoState.scale };
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

    if (annoState.tool === 'stamp') {
        const pos = getAnnoPos(e);
        placeStamp(pos);
        return;
    }

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
        const s = annoState.scale;
        ctx.save();
        ctx.fillStyle = currentStroke.color;
        ctx.globalAlpha = 0.3;
        const minX = Math.min(...currentStroke.points.map(p => p.x)) * s;
        const maxX = Math.max(...currentStroke.points.map(p => p.x)) * s;
        const minY = Math.min(...currentStroke.points.map(p => p.y)) * s;
        const maxY = Math.max(...currentStroke.points.map(p => p.y)) * s;
        ctx.fillRect(minX, minY, maxX - minX, (maxY - minY) + currentStroke.size * 3 * s);
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
    // Auto-confirm any unconfirmed text or stamps
    const pg = state.pages[annoState.idx];
    pg.annotations.forEach(a => { if ((a.type === 'text' || a.type === 'stamp') && !a.confirmed) a.confirmed = true; });

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
        const newBuf = bytes.slice(0).buffer;
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
                const filledBuf = filledBytes.slice(0).buffer;

                // Now update each page that used this source with its own single-page extract
                for (const { pg, srcIdx } of info.pages) {
                    const filledSrc = await PDFDocument.load(filledBuf);
                    const single = await PDFDocument.create();
                    const [copied] = await single.copyPages(filledSrc, [srcIdx]);
                    single.addPage(copied);
                    const singleBytes = await single.save();
                    if (pg.data) invalidateCache(pg.data);
                    pg.data = singleBytes.slice(0).buffer;
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

            const src = await PDFDocument.load(new Uint8Array(srcData));
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
                // Annotations are stored in PDF points (scale=1) — direct mapping
                const sx = 1, sy = 1;

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
                    } else if (a.type === 'stamp' && a.dataUrl) {
                        try {
                            const b64 = a.dataUrl.split(',')[1];
                            const imgBytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
                            const embedded = await out.embedPng(imgBytes).catch(() => out.embedJpg(imgBytes));
                            outPage.drawImage(embedded, {
                                x: a.x * sx,
                                y: oh - (a.y + a.h) * sy,
                                width: a.w * sx,
                                height: a.h * sy,
                            });
                        } catch(e) { /* skip unembeddable stamp */ }
                    }
                }
            }
        }

        showProgress(97, 'Saving...');
        let bytes = await out.save();
        if (state.password) {
            bytes = await encryptPdf(bytes, state.password.user, state.password.owner);
        }
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

// ===================== PDF ENCRYPTION (RC4-128, Standard Rev 3) =====================
// Pure byte-level implementation — never converts binary data to strings.

async function encryptPdf(pdfBytes, userPassword, ownerPassword) {
    const data = pdfBytes instanceof Uint8Array ? pdfBytes : new Uint8Array(pdfBytes);

    // ── RC4 ────────────────────────────────────────────────────────────
    function rc4(key, input) {
        const S = new Uint8Array(256);
        for (let i = 0; i < 256; i++) S[i] = i;
        for (let i = 0, j = 0; i < 256; i++) {
            j = (j + S[i] + key[i % key.length]) & 0xff;
            [S[i], S[j]] = [S[j], S[i]];
        }
        const out = new Uint8Array(input.length);
        for (let i = 0, a = 0, b = 0; i < input.length; i++) {
            a = (a + 1) & 0xff; b = (b + S[a]) & 0xff;
            [S[a], S[b]] = [S[b], S[a]];
            out[i] = input[i] ^ S[(S[a] + S[b]) & 0xff];
        }
        return out;
    }

    // ── MD5 (pure JS, operates on Uint8Array) ──────────────────────────
    function md5(input) {
        const sa=(x,y)=>{const l=(x&0xffff)+(y&0xffff);return(((x>>16)+(y>>16)+(l>>16))<<16)|(l&0xffff);};
        const rl=(n,c)=>(n<<c)|(n>>>(32-c));
        const cm=(q,a,b,x,s,t)=>sa(rl(sa(sa(a,q),sa(x,t)),s),b);
        const ff=(a,b,c,d,x,s,t)=>cm((b&c)|(~b&d),a,b,x,s,t);
        const gg=(a,b,c,d,x,s,t)=>cm((b&d)|(c&~d),a,b,x,s,t);
        const hh=(a,b,c,d,x,s,t)=>cm(b^c^d,a,b,x,s,t);
        const ii=(a,b,c,d,x,s,t)=>cm(c^(b|~d),a,b,x,s,t);
        const len=input.length, nblk=((len+8)>>6)+1;
        const blks=new Int32Array(nblk*16);
        for(let i=0;i<len;i++) blks[i>>2]|=input[i]<<((i%4)*8);
        blks[len>>2]|=0x80<<((len%4)*8);
        blks[nblk*16-2]=len*8;
        let a=1732584193,b=-271733879,c=-1732584194,d=271733878;
        for(let i=0;i<blks.length;i+=16){
            const [oa,ob,oc,od]=[a,b,c,d];
            a=ff(a,b,c,d,blks[i+0],7,-680876936);d=ff(d,a,b,c,blks[i+1],12,-389564586);c=ff(c,d,a,b,blks[i+2],17,606105819);b=ff(b,c,d,a,blks[i+3],22,-1044525330);
            a=ff(a,b,c,d,blks[i+4],7,-176418897);d=ff(d,a,b,c,blks[i+5],12,1200080426);c=ff(c,d,a,b,blks[i+6],17,-1473231341);b=ff(b,c,d,a,blks[i+7],22,-45705983);
            a=ff(a,b,c,d,blks[i+8],7,1770035416);d=ff(d,a,b,c,blks[i+9],12,-1958414417);c=ff(c,d,a,b,blks[i+10],17,-42063);b=ff(b,c,d,a,blks[i+11],22,-1990404162);
            a=ff(a,b,c,d,blks[i+12],7,1804603682);d=ff(d,a,b,c,blks[i+13],12,-40341101);c=ff(c,d,a,b,blks[i+14],17,-1502002290);b=ff(b,c,d,a,blks[i+15],22,1236535329);
            a=gg(a,b,c,d,blks[i+1],5,-165796510);d=gg(d,a,b,c,blks[i+6],9,-1069501632);c=gg(c,d,a,b,blks[i+11],14,643717713);b=gg(b,c,d,a,blks[i+0],20,-373897302);
            a=gg(a,b,c,d,blks[i+5],5,-701558691);d=gg(d,a,b,c,blks[i+10],9,38016083);c=gg(c,d,a,b,blks[i+15],14,-660478335);b=gg(b,c,d,a,blks[i+4],20,-405537848);
            a=gg(a,b,c,d,blks[i+9],5,568446438);d=gg(d,a,b,c,blks[i+14],9,-1019803690);c=gg(c,d,a,b,blks[i+3],14,-187363961);b=gg(b,c,d,a,blks[i+8],20,1163531501);
            a=gg(a,b,c,d,blks[i+13],5,-1444681467);d=gg(d,a,b,c,blks[i+2],9,-51403784);c=gg(c,d,a,b,blks[i+7],14,1735328473);b=gg(b,c,d,a,blks[i+12],20,-1926607734);
            a=hh(a,b,c,d,blks[i+5],4,-378558);d=hh(d,a,b,c,blks[i+8],11,-2022574463);c=hh(c,d,a,b,blks[i+11],16,1839030562);b=hh(b,c,d,a,blks[i+14],23,-35309556);
            a=hh(a,b,c,d,blks[i+1],4,-1530992060);d=hh(d,a,b,c,blks[i+4],11,1272893353);c=hh(c,d,a,b,blks[i+7],16,-155497632);b=hh(b,c,d,a,blks[i+10],23,-1094730640);
            a=hh(a,b,c,d,blks[i+13],4,681279174);d=hh(d,a,b,c,blks[i+0],11,-358537222);c=hh(c,d,a,b,blks[i+3],16,-722521979);b=hh(b,c,d,a,blks[i+6],23,76029189);
            a=hh(a,b,c,d,blks[i+9],4,-640364487);d=hh(d,a,b,c,blks[i+12],11,-421815835);c=hh(c,d,a,b,blks[i+15],16,530742520);b=hh(b,c,d,a,blks[i+2],23,-995338651);
            a=ii(a,b,c,d,blks[i+0],6,-198630844);d=ii(d,a,b,c,blks[i+7],10,1126891415);c=ii(c,d,a,b,blks[i+14],15,-1416354905);b=ii(b,c,d,a,blks[i+5],21,-57434055);
            a=ii(a,b,c,d,blks[i+12],6,1700485571);d=ii(d,a,b,c,blks[i+3],10,-1894986606);c=ii(c,d,a,b,blks[i+10],15,-1051523);b=ii(b,c,d,a,blks[i+1],21,-2054922799);
            a=ii(a,b,c,d,blks[i+8],6,1873313359);d=ii(d,a,b,c,blks[i+15],10,-30611744);c=ii(c,d,a,b,blks[i+6],15,-1560198380);b=ii(b,c,d,a,blks[i+13],21,1309151649);
            a=ii(a,b,c,d,blks[i+4],6,-145523070);d=ii(d,a,b,c,blks[i+11],10,-1120210379);c=ii(c,d,a,b,blks[i+2],15,718787259);b=ii(b,c,d,a,blks[i+9],21,-343485551);
            a=sa(a,oa);b=sa(b,ob);c=sa(c,oc);d=sa(d,od);
        }
        const r=new Uint8Array(16);
        [a,b,c,d].forEach((v,i)=>{r[i*4]=v&0xff;r[i*4+1]=(v>>8)&0xff;r[i*4+2]=(v>>16)&0xff;r[i*4+3]=(v>>24)&0xff;});
        return r;
    }

    // ── PDF padding string ─────────────────────────────────────────────
    const PAD = new Uint8Array([0x28,0xBF,0x4E,0x5E,0x4E,0x75,0x8A,0x41,0x64,0x00,0x4E,0x56,0xFF,0xFA,0x01,0x08,0x2E,0x2E,0x00,0xB6,0xD0,0x68,0x3E,0x80,0x2F,0x0C,0xA9,0xFE,0x64,0x53,0x69,0x7A]);
    const toHex = arr => Array.from(arr).map(b=>b.toString(16).padStart(2,'0')).join('');

    function pwdBytes(pw) {
        const enc = new TextEncoder().encode((pw||'').slice(0,32));
        const out = new Uint8Array(32);
        out.set(enc.slice(0,32));
        out.set(PAD.slice(0, 32-enc.length), enc.length);
        return out;
    }

    // Permissions (Rev3): allow all except restrict-printing, low-quality
    const P = -3904;
    const Pbytes = new Uint8Array([P&0xff,(P>>8)&0xff,(P>>16)&0xff,(P>>24)&0xff]);
    const fileId = crypto.getRandomValues(new Uint8Array(16));

    // Owner key & O entry
    const oPwd = pwdBytes(ownerPassword || userPassword);
    let oHash = md5(oPwd);
    for (let i=0;i<50;i++) oHash=md5(oHash);
    const oKey16 = oHash.slice(0,16);
    const uPwd = pwdBytes(userPassword);
    let Oval = rc4(oKey16, uPwd);
    for (let i=1;i<=19;i++) Oval=rc4(oKey16.map(b=>b^i), Oval);

    // Encryption key
    function makeEncKey(pwBytes) {
        const buf = new Uint8Array(pwBytes.length + Oval.length + 4 + fileId.length);
        buf.set(pwBytes); buf.set(Oval,32); buf.set(Pbytes,64); buf.set(fileId,68);
        let h = md5(buf);
        for (let i=0;i<50;i++) h=md5(h);
        return h; // 16 bytes = 128-bit
    }
    const encKey = makeEncKey(uPwd);

    // U entry (Rev3)
    const uInput = new Uint8Array([...PAD,...fileId]);
    let Uval = rc4(encKey, md5(uInput));
    for (let i=1;i<=19;i++) Uval=rc4(encKey.map(b=>b^i), Uval);
    const Uentry = new Uint8Array(32); Uentry.set(Uval);

    // Per-object RC4 key
    function objKey(objNum, genNum) {
        const buf = new Uint8Array(encKey.length+5);
        buf.set(encKey);
        buf[encKey.length]=objNum&0xff; buf[encKey.length+1]=(objNum>>8)&0xff; buf[encKey.length+2]=(objNum>>16)&0xff;
        buf[encKey.length+3]=genNum&0xff; buf[encKey.length+4]=(genNum>>8)&0xff;
        return md5(buf).slice(0, Math.min(encKey.length+5,16));
    }

    // ── Byte-level PDF parser ──────────────────────────────────────────
    // Find all "N G obj" positions, then find their stream, encrypt it in place.

    function findBytes(haystack, needle, start=0) {
        outer: for (let i=start; i<=haystack.length-needle.length; i++) {
            for (let j=0;j<needle.length;j++) if (haystack[i+j]!==needle[j]) continue outer;
            return i;
        }
        return -1;
    }

    function bytesEq(a,b,pos) {
        for (let i=0;i<b.length;i++) if (a[pos+i]!==b[i]) return false;
        return true;
    }

    const enc = new TextEncoder();
    const STREAM = enc.encode('stream');
    const ENDSTREAM = enc.encode('endstream');
    const OBJ = enc.encode(' obj');
    const EOL_LF = enc.encode('\n');
    const EOL_CR = enc.encode('\r');

    // Collect all object positions: scan for "N 0 obj"
    const objects = []; // {objNum, genNum, start}
    for (let i=0; i<data.length-6; i++) {
        // Look for digit sequence followed by " N obj" pattern
        if (data[i]>='0'.charCodeAt(0) && data[i]<='9'.charCodeAt(0)) {
            // Try to parse "objNum genNum obj"
            let j=i;
            while (j<data.length && data[j]>=48 && data[j]<=57) j++;
            if (j===i || data[j]!==32) continue;
            const objNum=parseInt(new TextDecoder().decode(data.slice(i,j)));
            j++;
            let k=j;
            while (k<data.length && data[k]>=48 && data[k]<=57) k++;
            if (k===j || data[k]!==32) continue;
            const genNum=parseInt(new TextDecoder().decode(data.slice(j,k)));
            if (data[k+1]===111&&data[k+2]===98&&data[k+3]===106) { // 'o','b','j'
                objects.push({objNum,genNum,start:i});
                i=k+3;
            }
        }
    }

    // For each object, find its stream and encrypt it
    const output = new Uint8Array(data); // copy — we'll modify in place

    for (const obj of objects) {
        const {objNum, genNum, start} = obj;
        if (objNum === 0) continue;

        // Find 'stream' keyword after obj
        const nextObj = objects.find(o=>o.start>start);
        const searchEnd = nextObj ? nextObj.start : data.length;
        const sPos = findBytes(output, STREAM, start);
        if (sPos === -1 || sPos >= searchEnd) continue;

        // Verify character before 'stream' is \n or \r\n (PDF spec)
        const afterStream = sPos + STREAM.length;
        let contentStart;
        if (output[afterStream] === 0x0D && output[afterStream+1] === 0x0A) contentStart = afterStream+2;
        else if (output[afterStream] === 0x0A) contentStart = afterStream+1;
        else continue; // not a valid stream keyword

        // Find matching endstream
        const esPos = findBytes(output, ENDSTREAM, contentStart);
        if (esPos === -1 || esPos >= searchEnd) continue;

        // Determine content end (before \r\n or \n before endstream)
        let contentEnd = esPos;
        if (output[contentEnd-1] === 0x0A) contentEnd--;
        if (output[contentEnd-1] === 0x0D) contentEnd--;

        const streamData = output.slice(contentStart, contentEnd);
        const key = objKey(objNum, genNum);
        const encrypted = rc4(key, streamData);
        output.set(encrypted, contentStart);
    }

    // ── Inject /Encrypt dictionary and update trailer ──────────────────
    // Find max object number
    const maxObj = objects.reduce((m,o)=>Math.max(m,o.objNum),0);
    const encObjNum = maxObj + 1;

    const encDictStr = `${encObjNum} 0 obj\n<< /Filter /Standard /V 2 /R 3 /Length 128 /P ${P} /O <${toHex(Oval)}> /U <${toHex(Uentry)}> >>\nendobj\n`;
    const encDictBytes = enc.encode(encDictStr);

    // Find last startxref
    let startxrefPos = -1;
    for (let i=output.length-1; i>=0; i--) {
        if (output[i]==='s'.charCodeAt(0) && bytesEq(output, enc.encode('startxref'), i)) {
            startxrefPos = i; break;
        }
    }
    if (startxrefPos === -1) throw new Error('No startxref found');

    // Find trailer dict — scan backwards from startxref
    const TRAILER = enc.encode('trailer');
    let trailerPos = -1;
    for (let i=startxrefPos; i>=0; i--) {
        if (output[i]==='t'.charCodeAt(0) && bytesEq(output, TRAILER, i)) {
            trailerPos=i; break;
        }
    }

    // Build the new encrypt object + updated trailer section
    // Find where trailer << >> ends
    let trailerEnd = trailerPos;
    let depth = 0;
    for (let i=trailerPos; i<output.length; i++) {
        if (output[i]===60&&output[i+1]===60) { depth++; i++; }
        else if (output[i]===62&&output[i+1]===62) { depth--; i++; if (depth===0){trailerEnd=i+1;break;} }
    }

    const trailerSection = new TextDecoder('latin1').decode(output.slice(trailerPos, trailerEnd));
    let newTrailer = trailerSection;
    // Remove old /Encrypt if present
    newTrailer = newTrailer.replace(/\/Encrypt\s+\d+\s+\d+\s+R/g, '');
    // Remove old /ID if present
    newTrailer = newTrailer.replace(/\/ID\s*\[[\s\S]*?\]/g, '');
    // Insert /Encrypt ref and /ID before closing >>
    newTrailer = newTrailer.replace(/>>\s*$/, `/Encrypt ${encObjNum} 0 R\n/ID [<${toHex(fileId)}><${toHex(fileId)}>]\n>>`);

    const newTrailerBytes = enc.encode(newTrailer);
    const newXrefOffset = output.slice(0,trailerPos).length + encDictBytes.length;

    const suffix = enc.encode(`\nstartxref\n${newXrefOffset}\n%%EOF\n`);

    // Assemble: original bytes up to trailerPos + encDictBytes + newTrailer + suffix
    const result = new Uint8Array(trailerPos + encDictBytes.length + newTrailerBytes.length + suffix.length);
    result.set(output.slice(0, trailerPos));
    result.set(encDictBytes, trailerPos);
    result.set(newTrailerBytes, trailerPos + encDictBytes.length);
    result.set(suffix, trailerPos + encDictBytes.length + newTrailerBytes.length);

    return result;
}

// ===================== PWA =====================

// ===================== COMPRESS & DOWNLOAD =====================

const COMPRESS_LEVELS = [
    { label: 'Maximum',  hint: 'Smallest file · noticeable quality loss', jpegQ: 0.35, renderScale: 1.0 },
    { label: 'High',     hint: 'Small file · some quality loss',          jpegQ: 0.55, renderScale: 1.5 },
    { label: 'Balanced', hint: 'Good quality · medium file size',         jpegQ: 0.72, renderScale: 2.0 },
    { label: 'Low',      hint: 'Near-original quality · mild reduction',  jpegQ: 0.88, renderScale: 2.5 },
    { label: 'Minimal',  hint: 'Best quality · structure-only savings',   jpegQ: null, renderScale: null },
];

const compressPopover = document.getElementById('compress-popover');
const compressQualityInput = document.getElementById('compress-quality');
const compressQualityVal = document.getElementById('compress-quality-val');
const compressQualityHint = document.getElementById('compress-quality-hint');
const downscaleCheckbox = document.getElementById('opt-downscale');
const downscalePct = document.getElementById('opt-downscale-pct');
const downscaleVal = document.getElementById('downscale-val');

function updateCompressUI() {
    const lvl = COMPRESS_LEVELS[parseInt(compressQualityInput.value) - 1];
    compressQualityVal.textContent = lvl.label;
    compressQualityHint.textContent = lvl.hint;
}

document.getElementById('btn-compress').addEventListener('click', e => {
    e.stopPropagation();
    compressPopover.classList.toggle('show');
    updateCompressUI();
});

document.addEventListener('click', e => {
    if (!e.target.closest('.compress-wrap')) compressPopover.classList.remove('show');
});

compressQualityInput.addEventListener('input', updateCompressUI);

// Enable/disable downscale slider
downscaleCheckbox.addEventListener('change', () => {
    downscalePct.disabled = !downscaleCheckbox.checked;
});
downscalePct.addEventListener('input', () => {
    downscaleVal.textContent = downscalePct.value + '%';
});

document.getElementById('btn-compress-go').addEventListener('click', async () => {
    if (!state.pages.length) return;
    compressPopover.classList.remove('show');

    const lvlIdx = parseInt(compressQualityInput.value) - 1;
    const lvl = COMPRESS_LEVELS[lvlIdx];
    const removeMeta    = document.getElementById('opt-remove-meta').checked;
    const removeUnused  = document.getElementById('opt-remove-unused').checked;
    const removeFonts   = document.getElementById('opt-remove-fonts').checked;
    const doDownscale   = downscaleCheckbox.checked;
    const downscaleFactor = parseInt(downscalePct.value) / 100;

    try {
        let bytes;
        const names = [...new Set(state.pages.map(p => p.srcName))];
        const fname = names.length === 1
            ? names[0].replace('.pdf', '') + '_compressed.pdf'
            : 'compressed.pdf';

        if (lvl.jpegQ === null && !doDownscale) {
            // ─── Minimal / structure-only path ─────────────────────────────
            showProgress(10, 'Loading pages…');
            const out = await PDFDocument.create();
            const embeddedFonts = {};
            for (const [, std] of Object.entries(FONT_MAP)) {
                if (!embeddedFonts[std]) embeddedFonts[std] = await out.embedFont(std);
            }

            for (let i = 0; i < state.pages.length; i++) {
                showProgress(10 + ((i + 1) / state.pages.length) * 75, `Processing page ${i + 1}/${state.pages.length}…`);
                const pg = state.pages[i];
                const srcData = pg.data || pg.srcFile;
                const srcIdx = pg.data ? 0 : pg.srcPageIdx;

                const srcDoc = await PDFDocument.load(srcData, { ignoreEncryption: true });

                if (removeUnused) {
                    // Mark all pages except target for removal before copying
                    // (pdf-lib doesn't have a direct "remove unused" API, but
                    //  loading and re-saving individual pages strips orphans)
                }

                if (removeMeta) {
                    try {
                        srcDoc.setTitle('');
                        srcDoc.setAuthor('');
                        srcDoc.setSubject('');
                        srcDoc.setKeywords([]);
                        srcDoc.setProducer('');
                        srcDoc.setCreator('');
                        srcDoc.setCreationDate(new Date(0));
                        srcDoc.setModificationDate(new Date(0));
                    } catch(e) { /* ignore */ }
                }

                const [copied] = await out.copyPages(srcDoc, [srcIdx]);
                if (pg.rotation) copied.setRotation(degrees((copied.getRotation().angle || 0) + pg.rotation));
                if (pg.crop) { copied.setCropBox(pg.crop.x, pg.crop.y, pg.crop.w, pg.crop.h); copied.setMediaBox(pg.crop.x, pg.crop.y, pg.crop.w, pg.crop.h); }
                out.addPage(copied);
            }

            if (removeMeta) {
                try {
                    out.setTitle(''); out.setAuthor(''); out.setSubject('');
                    out.setKeywords([]); out.setProducer('PDF Genius');
                    out.setCreator('PDF Genius');
                } catch(e) { /* ignore */ }
            }

            showProgress(90, 'Saving…');
            bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });

        } else {
            // ─── Rasterize path ────────────────────────────────────────────
            const out = await PDFDocument.create();
            const renderScale = lvl.renderScale || 2.0;
            const jpegQ = lvl.jpegQ || 0.72;

            for (let i = 0; i < state.pages.length; i++) {
                showProgress(((i + 1) / state.pages.length) * 93, `Compressing page ${i + 1}/${state.pages.length}…`);
                const pg = state.pages[i];
                const srcData = pg.data || pg.srcFile;
                const srcIdx = pg.data ? 0 : pg.srcPageIdx;

                // Effective scale: apply downscale factor on top of renderScale
                const effectiveScale = doDownscale
                    ? renderScale * downscaleFactor
                    : renderScale;

                const pdfJsDoc = await pdfjsLib.getDocument({ data: srcData.slice(0) }).promise;
                const page = await pdfJsDoc.getPage(srcIdx + 1);
                const baseVp = page.getViewport({ scale: 1 });
                const renderVp = page.getViewport({ scale: effectiveScale });

                const canvas = document.createElement('canvas');
                canvas.width = Math.round(renderVp.width);
                canvas.height = Math.round(renderVp.height);
                await page.render({ canvasContext: canvas.getContext('2d'), viewport: renderVp }).promise;

                // Draw stored annotations (points in PDF points, scale to effectiveScale)
                if (pg.annotations && pg.annotations.length) {
                    const ctx = canvas.getContext('2d');
                    const annoScale = effectiveScale; // PDF pts → canvas pixels at effectiveScale
                    pg.annotations.filter(a => a.type === 'draw').forEach(a => {
                        ctx.save();
                        ctx.strokeStyle = a.color;
                        ctx.lineWidth = a.size * annoScale;
                        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
                        ctx.beginPath();
                        a.points.forEach((p, j) => {
                            const x = p.x * annoScale, y = p.y * annoScale;
                            j === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
                        });
                        ctx.stroke();
                        ctx.restore();
                    });
                }

                // Crop region if set
                let finalCanvas = canvas;
                const crop = pg.crop;
                if (crop) {
                    const cx = Math.round(crop.x * effectiveScale);
                    const cy = Math.round((baseVp.height - crop.y - crop.h) * effectiveScale);
                    const cw = Math.round(crop.w * effectiveScale);
                    const ch = Math.round(crop.h * effectiveScale);
                    finalCanvas = document.createElement('canvas');
                    finalCanvas.width = Math.max(1, cw);
                    finalCanvas.height = Math.max(1, ch);
                    finalCanvas.getContext('2d').drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
                }

                // Encode as JPEG
                const jpegDataUrl = finalCanvas.toDataURL('image/jpeg', jpegQ);
                const jpegBase64 = jpegDataUrl.split(',')[1];
                const jpegBytes = Uint8Array.from(atob(jpegBase64), c => c.charCodeAt(0));

                // Page size in PDF points — preserve original dimensions
                const pageW = crop ? crop.w : baseVp.width;
                const pageH = crop ? crop.h : baseVp.height;

                const jpegImage = await out.embedJpg(jpegBytes);
                const outPage = out.addPage([pageW, pageH]);
                if (pg.rotation) outPage.setRotation(degrees(pg.rotation));
                outPage.drawImage(jpegImage, { x: 0, y: 0, width: pageW, height: pageH });
            }

            if (removeMeta) {
                try {
                    out.setTitle(''); out.setAuthor(''); out.setSubject('');
                    out.setKeywords([]); out.setProducer('PDF Genius');
                    out.setCreator('PDF Genius');
                } catch(e) { /* ignore */ }
            }

            // removeFonts: rasterized output has no embedded fonts by definition
            // removeUnused: pdf-lib's save cleans cross-references automatically

            showProgress(97, 'Saving…');
            bytes = await out.save({ useObjectStreams: true, addDefaultPage: false });
        }

        downloadBlob(bytes, fname);
        showProgress(100, 'Done!');

        const seenBuffers = new Set();
        let origBytes = 0;
        for (const pg of state.pages) {
            const buf = pg.data || pg.srcFile;
            if (!seenBuffers.has(buf)) { seenBuffers.add(buf); origBytes += buf.byteLength; }
        }
        const saving = Math.round((1 - bytes.byteLength / origBytes) * 100);
        const newMB = (bytes.byteLength / 1048576).toFixed(1);
        const origMB = (origBytes / 1048576).toFixed(1);
        toast(`${saving > 0 ? saving + '% smaller' : 'Downloaded'} · ${origMB} MB → ${newMB} MB`);

    } catch (err) {
        console.error(err);
        toast('Error: ' + err.message);
    }
    setTimeout(hideProgress, 1500);
});

// ===================== INSERT BLANK PAGE =====================

document.getElementById('btn-insert-blank').addEventListener('click', async () => {
    if (!state.pages.length) return;
    // Insert after last selected page, or at end
    const insertAfter = state.selected.size
        ? Math.max(...state.selected)
        : state.pages.length - 1;

    // Create a minimal blank PDF page matching the size of the adjacent page
    const refPg = state.pages[insertAfter];
    const refSrc = refPg.data || refPg.srcFile;
    const refIdx = refPg.data ? 0 : refPg.srcPageIdx;
    const refDoc = await PDFDocument.load(refSrc);
    const refPage = refDoc.getPages()[refIdx];
    const { width, height } = refPage.getSize();

    const blankDoc = await PDFDocument.create();
    blankDoc.addPage([width, height]);
    const blankBytes = await blankDoc.save();

    const blankPg = {
        srcFile: blankBytes.slice(0).buffer, srcName: 'blank.pdf', srcPageIdx: 0,
        data: null, rotation: 0, crop: null, annotations: [],
        formFields: [], formValues: {},
    };
    state.pages.splice(insertAfter + 1, 0, blankPg);
    state.selected.clear();
    await renderGrid();
    toast('Blank page inserted');
});

// ===================== IMAGE TO PDF =====================

// ===================== IMAGE → PDF HELPER =====================

async function convertImageToPdfBytes(file) {
    const dataUrl = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej;
        r.readAsDataURL(file);
    });
    const dims = await new Promise(res => {
        const img = new Image();
        img.onload = () => res({ w: img.naturalWidth, h: img.naturalHeight });
        img.src = dataUrl;
    });
    const ptW = Math.max(dims.w * 0.75, 595);
    const ptH = ptW * dims.h / dims.w;
    const pdfDoc = await PDFDocument.create();
    const mimeType = dataUrl.split(';')[0].split(':')[1];
    const base64 = dataUrl.split(',')[1];
    let embedded;
    if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
        embedded = await pdfDoc.embedJpg(Uint8Array.from(atob(base64), c => c.charCodeAt(0)));
    } else {
        const canvas = document.createElement('canvas');
        canvas.width = dims.w; canvas.height = dims.h;
        const img = new Image();
        await new Promise(res => { img.onload = res; img.src = dataUrl; });
        canvas.getContext('2d').drawImage(img, 0, 0);
        const jpegB64 = canvas.toDataURL('image/jpeg', 0.95).split(',')[1];
        embedded = await pdfDoc.embedJpg(Uint8Array.from(atob(jpegB64), c => c.charCodeAt(0)));
    }
    const page = pdfDoc.addPage([ptW, ptH]);
    page.drawImage(embedded, { x: 0, y: 0, width: ptW, height: ptH });
    const _b = await pdfDoc.save(); return _b.slice(0).buffer;
}

// ===================== STAMP / SIGNATURE =====================

const stampState = { mode: 'draw', position: 'br', imgData: null, drawing: false };

document.getElementById('btn-stamp').addEventListener('click', () => openModal('modal-stamp'));
document.getElementById('stamp-close').addEventListener('click', () => closeModalAndGoBack('modal-stamp'));
document.getElementById('btn-stamp-cancel').addEventListener('click', () => closeModalAndGoBack('modal-stamp'));

// Tab switching
document.querySelectorAll('.stamp-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.stamp-tab').forEach(t => t.classList.remove('on'));
        document.querySelectorAll('.stamp-panel').forEach(p => p.classList.remove('on'));
        tab.classList.add('on');
        document.getElementById('stamp-' + tab.dataset.tab + '-panel').classList.add('on');
        stampState.mode = tab.dataset.tab;
    });
});

// Position grid
document.querySelectorAll('.stamp-pos').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.stamp-pos').forEach(b => b.classList.remove('on'));
        btn.classList.add('on');
        stampState.position = btn.dataset.pos;
    });
});

// Draw on stamp canvas
const stampCanvas = document.getElementById('stamp-canvas');
const stampCtx = stampCanvas.getContext('2d');
stampCtx.strokeStyle = '#1a1820'; stampCtx.lineWidth = 3; stampCtx.lineCap = 'round';
let stampDrawing = false;

stampCanvas.addEventListener('mousedown', e => {
    stampDrawing = true;
    const r = stampCanvas.getBoundingClientRect();
    stampCtx.beginPath();
    stampCtx.moveTo((e.clientX - r.left) * stampCanvas.width / r.width, (e.clientY - r.top) * stampCanvas.height / r.height);
});
stampCanvas.addEventListener('mousemove', e => {
    if (!stampDrawing) return;
    const r = stampCanvas.getBoundingClientRect();
    stampCtx.lineTo((e.clientX - r.left) * stampCanvas.width / r.width, (e.clientY - r.top) * stampCanvas.height / r.height);
    stampCtx.stroke();
});
stampCanvas.addEventListener('mouseup', () => stampDrawing = false);
stampCanvas.addEventListener('mouseleave', () => stampDrawing = false);
// Touch
stampCanvas.addEventListener('touchstart', e => { e.preventDefault(); stampDrawing = true; const r = stampCanvas.getBoundingClientRect(); stampCtx.beginPath(); stampCtx.moveTo((e.touches[0].clientX - r.left) * stampCanvas.width / r.width, (e.touches[0].clientY - r.top) * stampCanvas.height / r.height); }, { passive:false });
stampCanvas.addEventListener('touchmove', e => { e.preventDefault(); if (!stampDrawing) return; const r = stampCanvas.getBoundingClientRect(); stampCtx.lineTo((e.touches[0].clientX - r.left) * stampCanvas.width / r.width, (e.touches[0].clientY - r.top) * stampCanvas.height / r.height); stampCtx.stroke(); }, { passive:false });
stampCanvas.addEventListener('touchend', () => stampDrawing = false);

document.getElementById('btn-stamp-clear-draw').addEventListener('click', () => {
    stampCtx.clearRect(0, 0, stampCanvas.width, stampCanvas.height);
});

document.getElementById('stamp-color').addEventListener('input', e => { stampCtx.strokeStyle = e.target.value; });
document.getElementById('stamp-size').addEventListener('change', e => { stampCtx.lineWidth = parseInt(e.target.value); });

// Upload image for stamp
const stampUploadZone = document.getElementById('stamp-upload-zone');
const stampFileInput = document.getElementById('stamp-file-input');
stampUploadZone.addEventListener('click', () => stampFileInput.click());
stampFileInput.addEventListener('change', e => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
        stampState.imgData = ev.target.result;
        const preview = document.getElementById('stamp-preview');
        preview.src = stampState.imgData; preview.style.display = 'block';
    };
    reader.readAsDataURL(file);
    e.target.value = '';
});
stampUploadZone.addEventListener('dragover', e => { e.preventDefault(); stampUploadZone.classList.add('drag'); });
stampUploadZone.addEventListener('dragleave', () => stampUploadZone.classList.remove('drag'));
stampUploadZone.addEventListener('drop', e => {
    e.preventDefault(); stampUploadZone.classList.remove('drag');
    const file = e.dataTransfer.files[0]; if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = ev => {
        stampState.imgData = ev.target.result;
        const preview = document.getElementById('stamp-preview');
        preview.src = ev.target.result; preview.style.display = 'block';
    };
    reader.readAsDataURL(file);
});

document.getElementById('stamp-scale').addEventListener('input', e => { document.getElementById('stamp-scale-val').textContent = e.target.value; });
document.getElementById('stamp-opacity').addEventListener('input', e => { document.getElementById('stamp-opacity-val').textContent = e.target.value; });

document.getElementById('btn-stamp-apply').addEventListener('click', async () => {
    const mode = stampState.mode;
    const scaleP = parseInt(document.getElementById('stamp-scale').value) / 100;
    const opacity = parseInt(document.getElementById('stamp-opacity').value) / 100;
    const pos = stampState.position;
    const applyTo = document.getElementById('stamp-apply-to').value;

    // Build stamp image data URL
    let imgUrl;
    if (mode === 'draw') {
        imgUrl = stampCanvas.toDataURL('image/png');
    } else if (mode === 'text') {
        const text = document.getElementById('stamp-text-val').value || 'STAMP';
        const color = document.getElementById('stamp-text-color').value;
        const style = document.getElementById('stamp-text-style').value;
        const tc = document.createElement('canvas'); tc.width = 400; tc.height = 160;
        const tctx = tc.getContext('2d');
        tctx.clearRect(0, 0, 400, 160);
        tctx.font = 'bold 72px Arial, sans-serif';
        tctx.fillStyle = color;
        tctx.textAlign = 'center';
        tctx.textBaseline = 'middle';
        if (style === 'box') { tctx.strokeStyle = color; tctx.lineWidth = 8; tctx.strokeRect(10, 10, 380, 140); }
        if (style === 'circle') { tctx.beginPath(); tctx.arc(200, 80, 74, 0, Math.PI * 2); tctx.stroke(); }
        tctx.fillText(text, 200, 80);
        imgUrl = tc.toDataURL('image/png');
    } else {
        if (!stampState.imgData) { toast('No image selected'); return; }
        imgUrl = stampState.imgData;
    }

    const stampImg = new Image();
    await new Promise(res => { stampImg.onload = res; stampImg.src = imgUrl; });

    const applyPages = state.pages.filter((_, i) => {
        if (applyTo === 'all') return true;
        if (applyTo === 'selected') return state.selected.has(i);
        if (applyTo === 'odd') return (i + 1) % 2 !== 0;
        if (applyTo === 'even') return (i + 1) % 2 === 0;
    });

    closeModalAndGoBack('modal-stamp');
    showProgress(0, 'Applying stamp…');

    for (let pi = 0; pi < applyPages.length; pi++) {
        showProgress((pi / applyPages.length) * 90, `Stamping page ${pi + 1}/${applyPages.length}…`);
        const pg = applyPages[pi];
        const srcData = pg.data || pg.srcFile;
        const srcIdx = pg.data ? 0 : pg.srcPageIdx;

        const pdfJsDoc = await pdfjsLib.getDocument({ data: srcData.slice(0) }).promise;
        const page = await pdfJsDoc.getPage(srcIdx + 1);
        const vp = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = vp.width; canvas.height = vp.height;
        const ctx = canvas.getContext('2d');
        await page.render({ canvasContext: ctx, viewport: vp }).promise;

        // Draw stamp
        const sw = stampImg.width, sh = stampImg.height;
        const stampW = vp.width * scaleP;
        const stampH = sh * stampW / sw;
        const pad = 20;
        const posMap = {
            tl: [pad, pad], tc: [(vp.width - stampW) / 2, pad], tr: [vp.width - stampW - pad, pad],
            ml: [pad, (vp.height - stampH) / 2], mc: [(vp.width - stampW) / 2, (vp.height - stampH) / 2], mr: [vp.width - stampW - pad, (vp.height - stampH) / 2],
            bl: [pad, vp.height - stampH - pad], bc: [(vp.width - stampW) / 2, vp.height - stampH - pad], br: [vp.width - stampW - pad, vp.height - stampH - pad],
        };
        const [sx, sy] = posMap[pos] || posMap.br;
        ctx.globalAlpha = opacity;
        ctx.drawImage(stampImg, sx, sy, stampW, stampH);
        ctx.globalAlpha = 1;

        const jpegUrl = canvas.toDataURL('image/jpeg', 0.95);
        const jpegB64 = jpegUrl.split(',')[1];
        const jpegBytes = Uint8Array.from(atob(jpegB64), c => c.charCodeAt(0));

        const newDoc = await PDFDocument.create();
        const jpegImg = await newDoc.embedJpg(jpegBytes);
        const baseVp = page.getViewport({ scale: 1 });
        const outPage = newDoc.addPage([baseVp.width, baseVp.height]);
        outPage.drawImage(jpegImg, { x: 0, y: 0, width: baseVp.width, height: baseVp.height });
        const newBytes = await newDoc.save();
        if (pg.data) invalidateCache(pg.data);
        pg.data = newBytes.slice(0).buffer; pg.srcPageIdx = 0;
        invalidateCache(pg.data);
    }

    hideProgress();
    await renderGrid();
    toast('Stamp applied');
});

// ===================== PAGE NUMBERS =====================

document.getElementById('btn-page-numbers').addEventListener('click', () => openModal('modal-page-numbers'));
document.getElementById('pn-close').addEventListener('click', () => closeModalAndGoBack('modal-page-numbers'));
document.getElementById('btn-pn-cancel').addEventListener('click', () => closeModalAndGoBack('modal-page-numbers'));
document.getElementById('pn-skip').addEventListener('input', e => { document.getElementById('pn-skip-val').textContent = e.target.value; });
document.getElementById('pn-color').addEventListener('input', e => { document.getElementById('pn-color-hex').textContent = e.target.value; });

document.getElementById('btn-pn-apply').addEventListener('click', async () => {
    const position = document.getElementById('pn-position').value;
    const startAt = parseInt(document.getElementById('pn-start').value) || 1;
    const fontSize = parseInt(document.getElementById('pn-size').value) || 12;
    const hex = document.getElementById('pn-color').value;
    const color = rgb(parseInt(hex.slice(1,3),16)/255, parseInt(hex.slice(3,5),16)/255, parseInt(hex.slice(5,7),16)/255);
    const format = document.getElementById('pn-format').value;
    const skip = parseInt(document.getElementById('pn-skip').value) || 0;
    const total = state.pages.length;

    closeModalAndGoBack('modal-page-numbers');
    showProgress(0, 'Adding page numbers…');

    for (let i = skip; i < state.pages.length; i++) {
        showProgress(((i - skip + 1) / (state.pages.length - skip)) * 95, `Page ${i + 1}…`);
        const pg = state.pages[i];
        const srcData = pg.data || pg.srcFile;
        const srcIdx = pg.data ? 0 : pg.srcPageIdx;
        const srcDoc = await PDFDocument.load(srcData);
        const font = await srcDoc.embedFont(StandardFonts.Helvetica);
        const page = srcDoc.getPages()[srcIdx];
        const { width, height } = page.getSize();
        const pageNum = startAt + i - skip;
        const label = format.replace('{n}', pageNum).replace('{total}', total);
        const tw = font.widthOfTextAtSize(label, fontSize);
        const margin = 20;
        const posMap = {
            'bottom-center': { x: (width - tw) / 2, y: margin },
            'bottom-left': { x: margin, y: margin },
            'bottom-right': { x: width - tw - margin, y: margin },
            'top-center': { x: (width - tw) / 2, y: height - margin - fontSize },
            'top-left': { x: margin, y: height - margin - fontSize },
            'top-right': { x: width - tw - margin, y: height - margin - fontSize },
        };
        const { x, y } = posMap[position] || posMap['bottom-center'];
        page.drawText(label, { x, y, size: fontSize, font, color });

        const single = await PDFDocument.create();
        const [copied] = await single.copyPages(srcDoc, [srcIdx]);
        single.addPage(copied);
        const bytes = await single.save();
        if (pg.data) invalidateCache(pg.data);
        pg.data = bytes.slice(0).buffer; pg.srcPageIdx = 0;
    }

    hideProgress();
    await renderGrid();
    toast('Page numbers added');
});

// ===================== HEADER / FOOTER =====================

document.getElementById('btn-header-footer').addEventListener('click', () => openModal('modal-hf'));
document.getElementById('hf-close').addEventListener('click', () => closeModalAndGoBack('modal-hf'));
document.getElementById('btn-hf-cancel').addEventListener('click', () => closeModalAndGoBack('modal-hf'));
document.getElementById('hf-skip').addEventListener('input', e => { document.getElementById('hf-skip-val').textContent = e.target.value; });
document.getElementById('hf-color').addEventListener('input', e => { document.getElementById('hf-color-hex').textContent = e.target.value; });

document.getElementById('btn-hf-apply').addEventListener('click', async () => {
    const hl = document.getElementById('hf-hl').value;
    const hc = document.getElementById('hf-hc').value;
    const hr = document.getElementById('hf-hr').value;
    const fl = document.getElementById('hf-fl').value;
    const fc = document.getElementById('hf-fc').value;
    const fr = document.getElementById('hf-fr').value;
    const fontSize = parseInt(document.getElementById('hf-size').value) || 10;
    const hex = document.getElementById('hf-color').value;
    const color = rgb(parseInt(hex.slice(1,3),16)/255, parseInt(hex.slice(3,5),16)/255, parseInt(hex.slice(5,7),16)/255);
    const skip = parseInt(document.getElementById('hf-skip').value) || 0;
    const total = state.pages.length;
    const today = new Date().toLocaleDateString();

    if (!hl && !hc && !hr && !fl && !fc && !fr) { toast('Enter at least one header or footer value'); return; }
    closeModalAndGoBack('modal-hf');
    showProgress(0, 'Adding header/footer…');

    for (let i = skip; i < state.pages.length; i++) {
        showProgress(((i - skip + 1) / (state.pages.length - skip)) * 95, `Page ${i + 1}…`);
        const pg = state.pages[i];
        const srcData = pg.data || pg.srcFile;
        const srcIdx = pg.data ? 0 : pg.srcPageIdx;
        const srcDoc = await PDFDocument.load(srcData);
        const font = await srcDoc.embedFont(StandardFonts.Helvetica);
        const page = srcDoc.getPages()[srcIdx];
        const { width, height } = page.getSize();
        const margin = 14;

        const resolve = (t) => t ? t.replace('{page}', i + 1).replace('{total}', total).replace('{date}', today).replace('{filename}', pg.srcName) : '';

        const drawRow = (left, center, right, y) => {
            if (left) page.drawText(resolve(left), { x: margin, y, size: fontSize, font, color });
            if (center) { const tw = font.widthOfTextAtSize(resolve(center), fontSize); page.drawText(resolve(center), { x: (width - tw) / 2, y, size: fontSize, font, color }); }
            if (right) { const tw = font.widthOfTextAtSize(resolve(right), fontSize); page.drawText(resolve(right), { x: width - tw - margin, y, size: fontSize, font, color }); }
        };

        if (hl || hc || hr) drawRow(hl, hc, hr, height - margin - fontSize);
        if (fl || fc || fr) drawRow(fl, fc, fr, margin);

        const single = await PDFDocument.create();
        const [copied] = await single.copyPages(srcDoc, [srcIdx]);
        single.addPage(copied);
        const bytes = await single.save();
        if (pg.data) invalidateCache(pg.data);
        pg.data = bytes.slice(0).buffer; pg.srcPageIdx = 0;
    }

    hideProgress();
    await renderGrid();
    toast('Header/footer added');
});

// ===================== PASSWORD PROTECT / REMOVE =====================

document.getElementById('btn-password').addEventListener('click', () => openModal('modal-password'));
document.getElementById('pw-close').addEventListener('click', () => closeModalAndGoBack('modal-password'));
document.getElementById('btn-pw-cancel').addEventListener('click', () => closeModalAndGoBack('modal-password'));

document.querySelectorAll('.pw-tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.pw-tab').forEach(t => t.classList.remove('on'));
        document.querySelectorAll('.pw-panel').forEach(p => p.classList.remove('on'));
        tab.classList.add('on');
        document.getElementById('pw-' + tab.dataset.tab + '-panel').classList.add('on');
    });
});

document.getElementById('btn-pw-apply').addEventListener('click', async () => {
    const activeTab = document.querySelector('.pw-tab.on').dataset.tab;

    if (activeTab === 'protect') {
        const userPw = document.getElementById('pw-user').value;
        const ownerPw = document.getElementById('pw-owner').value;
        if (!userPw) { toast('Enter a password'); return; }
        closeModalAndGoBack('modal-password');
        // Store as download option — applied at save time
        state.password = { user: userPw, owner: ownerPw || userPw };
        toast('Password set — will be applied on download');
    } else {
        const currentPw = document.getElementById('pw-current').value;
        if (!currentPw) { toast('Enter the current password'); return; }
        closeModalAndGoBack('modal-password');
        showProgress(0, 'Removing password…');
        try {
            for (let i = 0; i < state.pages.length; i++) {
                showProgress(((i + 1) / state.pages.length) * 90, `Processing page ${i + 1}…`);
                const pg = state.pages[i];
                const srcData = pg.data || pg.srcFile;
                const srcIdx = pg.data ? 0 : pg.srcPageIdx;
                const decryptedDoc = await PDFDocument.load(srcData, { password: currentPw, ignoreEncryption: false });
                const single = await PDFDocument.create();
                const [copied] = await single.copyPages(decryptedDoc, [srcIdx]);
                single.addPage(copied);
                const bytes = await single.save();
                if (pg.data) invalidateCache(pg.data);
                pg.data = bytes.slice(0).buffer; pg.srcPageIdx = 0;
            }
            hideProgress();
            toast('Password removed');
        } catch(err) {
            hideProgress();
            toast('Error: wrong password or unsupported encryption');
        }
    }
});

// Apply password in download: patch the save call
const _origDownload = document.getElementById('btn-download');
// Password is stored in state.password and applied in the download handler's save call
// (The download handler already calls out.save() — we'll patch it below by checking state.password)

// ===================== REDACTION =====================

const redactState = { idx: -1, rects: [], drawing: false, startX: 0, startY: 0 };

document.getElementById('btn-redact').addEventListener('click', () => {
    if (state.selected.size !== 1) { toast('Select exactly one page to redact'); return; }
    openRedact(Array.from(state.selected)[0]);
});

async function openRedact(idx) {
    redactState.idx = idx;
    redactState.rects = [];
    const pg = state.pages[idx];
    const srcData = pg.data || pg.srcFile;
    const srcIdx = pg.data ? 0 : pg.srcPageIdx;

    const pdf = await getPdfDoc(srcData);
    const page = await pdf.getPage(srcIdx + 1);
    const vp = page.getViewport({ scale: 1.5 });

    const bg = document.getElementById('redact-canvas');
    bg.width = vp.width; bg.height = vp.height;
    await page.render({ canvasContext: bg.getContext('2d'), viewport: vp }).promise;

    const ov = document.getElementById('redact-overlay');
    ov.width = vp.width; ov.height = vp.height;
    ov.style.width = bg.style.width;
    ov.style.height = bg.style.height;

    openModal('modal-redact');
}

function drawRedactOverlay() {
    const ov = document.getElementById('redact-overlay');
    const ctx = ov.getContext('2d');
    ctx.clearRect(0, 0, ov.width, ov.height);
    ctx.fillStyle = '#000';
    redactState.rects.forEach(r => ctx.fillRect(r.x, r.y, r.w, r.h));
}

const redactOverlay = document.getElementById('redact-overlay');
function getRedactPos(e) {
    const r = redactOverlay.getBoundingClientRect();
    return {
        x: ((e.clientX ?? e.touches[0].clientX) - r.left) * redactOverlay.width / r.width,
        y: ((e.clientY ?? e.touches[0].clientY) - r.top) * redactOverlay.height / r.height,
    };
}
redactOverlay.addEventListener('mousedown', e => {
    const p = getRedactPos(e); redactState.drawing = true; redactState.startX = p.x; redactState.startY = p.y; e.preventDefault();
});
redactOverlay.addEventListener('mousemove', e => {
    if (!redactState.drawing) return;
    const p = getRedactPos(e);
    drawRedactOverlay();
    const ctx = redactOverlay.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(redactState.startX, redactState.startY, p.x - redactState.startX, p.y - redactState.startY);
});
redactOverlay.addEventListener('mouseup', e => {
    if (!redactState.drawing) return;
    redactState.drawing = false;
    const p = getRedactPos(e);
    const x = Math.min(redactState.startX, p.x), y = Math.min(redactState.startY, p.y);
    const w = Math.abs(p.x - redactState.startX), h = Math.abs(p.y - redactState.startY);
    if (w > 4 && h > 4) redactState.rects.push({ x, y, w, h });
    drawRedactOverlay();
});

document.getElementById('btn-redact-undo').addEventListener('click', () => { redactState.rects.pop(); drawRedactOverlay(); });
document.getElementById('btn-redact-clear').addEventListener('click', () => { redactState.rects = []; drawRedactOverlay(); });
document.getElementById('redact-close').addEventListener('click', () => closeModalAndGoBack('modal-redact'));
document.getElementById('btn-redact-cancel').addEventListener('click', () => closeModalAndGoBack('modal-redact'));

document.getElementById('btn-redact-apply').addEventListener('click', async () => {
    if (!redactState.rects.length) { closeModalAndGoBack('modal-redact'); return; }
    closeModalAndGoBack('modal-redact');
    showProgress(0, 'Applying redaction…');

    const pg = state.pages[redactState.idx];
    const srcData = pg.data || pg.srcFile;
    const srcIdx = pg.data ? 0 : pg.srcPageIdx;
    const srcDoc = await PDFDocument.load(srcData);
    const page = srcDoc.getPages()[srcIdx];
    const { width, height } = page.getSize();

    // Scale from canvas coords to PDF point coords
    const ov = document.getElementById('redact-overlay');
    const sx = width / ov.width, sy = height / ov.height;

    redactState.rects.forEach(r => {
        page.drawRectangle({
            x: r.x * sx,
            y: height - (r.y + r.h) * sy,
            width: r.w * sx, height: r.h * sy,
            color: rgb(0, 0, 0), opacity: 1,
        });
    });

    const single = await PDFDocument.create();
    const [copied] = await single.copyPages(srcDoc, [srcIdx]);
    single.addPage(copied);
    const bytes = await single.save();
    if (pg.data) invalidateCache(pg.data);
    pg.data = bytes.slice(0).buffer; pg.srcPageIdx = 0;
    invalidateCache(pg.data);

    showProgress(100, 'Done!');
    await renderGrid();
    hideProgress();
    toast('Redaction applied permanently');
});

// ===================== SHARE (native OS share sheet) =====================

document.getElementById('btn-share').addEventListener('click', () => {
    document.getElementById('share-building').style.display = 'none';
    document.getElementById('share-ready').style.display = 'none';
    document.getElementById('btn-share-go').disabled = false;
    openModal('modal-share');
});
document.getElementById('share-close').addEventListener('click', () => closeModalAndGoBack('modal-share'));
document.getElementById('btn-share-cancel').addEventListener('click', () => closeModalAndGoBack('modal-share'));

async function buildSharePdf() {
    const progressFill = document.getElementById('share-progress-fill');
    const progressText = document.getElementById('share-progress-text');

    document.getElementById('share-building').style.display = 'block';
    document.getElementById('share-ready').style.display = 'none';
    progressFill.style.width = '10%';
    progressText.textContent = 'Building PDF…';

    const out = await PDFDocument.create();
    const embeddedFonts = {};
    for (const [, std] of Object.entries(FONT_MAP)) {
        if (!embeddedFonts[std]) embeddedFonts[std] = await out.embedFont(std);
    }
    for (let i = 0; i < state.pages.length; i++) {
        progressFill.style.width = (10 + (i / state.pages.length) * 80) + '%';
        progressText.textContent = `Page ${i + 1} / ${state.pages.length}…`;
        const pg = state.pages[i];
        const srcData = pg.data || pg.srcFile;
        const srcIdx = pg.data ? 0 : pg.srcPageIdx;
        const src = await PDFDocument.load(srcData);
        const [copied] = await out.copyPages(src, [srcIdx]);
        if (pg.rotation) copied.setRotation(degrees((copied.getRotation().angle || 0) + pg.rotation));
        if (pg.crop) { copied.setCropBox(pg.crop.x, pg.crop.y, pg.crop.w, pg.crop.h); copied.setMediaBox(pg.crop.x, pg.crop.y, pg.crop.w, pg.crop.h); }
        out.addPage(copied);
    }
    progressText.textContent = 'Saving…';
    progressFill.style.width = '95%';
    let bytes = await out.save();
    if (state.password) bytes = await encryptPdf(bytes, state.password.user, state.password.owner);
    progressFill.style.width = '100%';
    document.getElementById('share-building').style.display = 'none';
    return bytes;
}

document.getElementById('btn-share-go').addEventListener('click', async () => {
    if (!state.pages.length) return;
    document.getElementById('btn-share-go').disabled = true;

    try {
        const bytes = await buildSharePdf();
        const names = [...new Set(state.pages.map(p => p.srcName))];
        const fname = names.length === 1 ? names[0].replace('.pdf','') + '.pdf' : 'document.pdf';
        const file = new File([bytes], fname, { type: 'application/pdf' });

        if (navigator.canShare && navigator.canShare({ files: [file] })) {
            // Native share sheet with file — triggers OS share UI directly
            closeModalAndGoBack('modal-share');
            await navigator.share({ files: [file], title: fname });
        } else if (navigator.share) {
            // Share API exists but no file support (some desktop browsers)
            closeModalAndGoBack('modal-share');
            await navigator.share({ title: fname, text: 'Here is your PDF: ' + fname });
        } else {
            // No share API — show fallback hint
            document.getElementById('share-ready').style.display = 'block';
            document.getElementById('share-fallback-hint').style.display = 'block';
            document.getElementById('btn-share-go').disabled = false;
        }
    } catch (err) {
        if (err.name !== 'AbortError') toast('Share failed: ' + err.message);
        document.getElementById('btn-share-go').disabled = false;
    }
});

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

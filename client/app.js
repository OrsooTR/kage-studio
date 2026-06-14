/* Kage Studio — panel logic
 * Clips: browse animeclips.online, preview, import to the timeline.
 * Kaizen: render the selected comp/clip from AE and run a chain — Upscale (Real-ESRGAN) and/or
 *         Interpolate (RIFE) — then drop the result back on the timeline where the clip is.
 * Theming: accent colour + custom background.
 */
(function () {
    "use strict";

    var _require = (window.cep_node && window.cep_node.require) ? window.cep_node.require
        : (typeof require !== "undefined" ? require : null);
    var https = _require ? _require("https") : null;
    var http = _require ? _require("http") : null;
    var fs = _require ? _require("fs") : null;
    var path = _require ? _require("path") : null;
    var os = _require ? _require("os") : null;
    var child_process = _require ? _require("child_process") : null;
    var NodeBuffer = (window.cep_node && window.cep_node.Buffer) ? window.cep_node.Buffer
        : (typeof Buffer !== "undefined" ? Buffer : null);

    var cs = new CSInterface();
    var BASE = "https://animeclips.online";
    var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
    var CACHE_DIR = (os && path) ? path.join(os.tmpdir(), "KageStudioCache") : null;
    var DEFAULT_ACCENT = "#8b5cf6";
    var DEFAULT_BG = "radial-gradient(1100px 520px at 18% -8%, rgba(124,92,255,0.14), transparent 60%), radial-gradient(900px 480px at 100% 0%, rgba(208,75,255,0.10), transparent 55%)";

    var $ = function (id) { return document.getElementById(id); };
    var grid = $("grid"), statusEl = $("status"), breadcrumb = $("breadcrumb");
    var footer = $("footer"), selcount = $("selcount"), btnImport = $("btn-import");
    var progress = $("progress"), progressBar = $("progress-bar"), progressLabel = $("progress-label");

    var activeView = "clips";
    var library = { movies: [], series: [] };
    var filter = "all", searchTerm = "";
    var pack = null, navStack = [], currentFiles = [];
    var sel = { map: {}, order: [] };
    var settings = loadSettings();
    var kz = loadKz(), kzSel = null, chainBusy = false;
    var asRoot = null, asFolder = null, asItems = { dirs: [], files: [] }, asSel = { map: {}, order: [] }, asFilter = "all";

    // =========================================================
    //  Node networking + cache
    // =========================================================
    function b64(s) { return NodeBuffer.from(s).toString("base64"); }
    function request(url, opts) {
        opts = opts || {};
        return new Promise(function (resolve, reject) {
            var lib = url.indexOf("https:") === 0 ? https : http;
            var headers = Object.assign({ "User-Agent": UA }, opts.headers || {});
            var body = opts.body || null;
            if (body) { headers["Content-Type"] = "application/x-www-form-urlencoded"; headers["X-Requested-With"] = "XMLHttpRequest"; headers["Content-Length"] = NodeBuffer.byteLength(body); }
            var req = lib.request(url, { method: opts.method || "GET", headers: headers }, function (res) {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { var next = res.headers.location.indexOf("http") === 0 ? res.headers.location : BASE + res.headers.location; res.resume(); return resolve(request(next, opts)); }
                var chunks = []; res.on("data", function (c) { chunks.push(c); }); res.on("end", function () { resolve({ status: res.statusCode, headers: res.headers, body: NodeBuffer.concat(chunks) }); });
            });
            req.on("error", reject); req.setTimeout(60000, function () { req.destroy(new Error("Request timed out")); });
            if (body) req.write(body); req.end();
        });
    }
    function download(url, destPath, onProgress, referer) {
        return new Promise(function (resolve, reject) {
            var lib = url.indexOf("https:") === 0 ? https : http;
            var headers = { "User-Agent": UA }; if (referer) headers["Referer"] = referer;
            var req = lib.get(url, { headers: headers }, function (res) {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) { res.resume(); var next = res.headers.location.indexOf("http") === 0 ? res.headers.location : BASE + res.headers.location; return resolve(download(next, destPath, onProgress, referer)); }
                if (res.statusCode !== 200) { res.resume(); return reject(new Error("HTTP " + res.statusCode)); }
                var total = parseInt(res.headers["content-length"] || "0", 10), received = 0;
                var out = fs.createWriteStream(destPath);
                res.on("data", function (c) { received += c.length; if (onProgress) onProgress(received, total); });
                res.pipe(out); out.on("finish", function () { out.close(function () { resolve({ path: destPath, bytes: received }); }); });
                out.on("error", reject); res.on("error", reject);
            });
            req.on("error", reject); req.setTimeout(120000, function () { req.destroy(new Error("Download timed out")); });
        });
    }
    function ensureFolder(dir) { try { if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); } catch (e) {} }
    function fileSize(p) { try { return fs.statSync(p).size; } catch (e) { return 0; } }
    function fileUrl(p) { return "file:///" + encodeURI(p.replace(/\\/g, "/")).replace(/#/g, "%23").replace(/\?/g, "%3F"); }
    function baseName(p) { return p.split(/[\\\/]/).pop(); }
    function dirOf(p) { return p.replace(/[\\\/][^\\\/]*$/, ""); }
    function rmrf(dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { try { fs.rmdirSync(dir, { recursive: true }); } catch (e2) {} } }
    function listSubdirs(dir) { var out = []; try { fs.readdirSync(dir).forEach(function (n) { try { if (fs.statSync(path.join(dir, n)).isDirectory()) out.push(n); } catch (e) {} }); } catch (e) {} return out; }
    function countPng(dir) { var n = 0; try { n = fs.readdirSync(dir).filter(function (f) { return /\.png$/i.test(f); }).length; } catch (e) {} return n; }
    function ensureCached(id, name, ctx, onProgress) {
        ensureFolder(CACHE_DIR);
        var p = path.join(CACHE_DIR, sanitize(name, "mp4"));
        if (fileSize(p) > 0) return Promise.resolve(p);
        return download(streamUrl(ctx, id), p, onProgress, BASE + "/").then(function () { return p; });
    }

    // =========================================================
    //  Clips API
    // =========================================================
    function getLibrary() { return request(BASE + "/wp-json/aco/v1/library", { headers: { Referer: BASE + "/" } }).then(function (r) { return JSON.parse(r.body.toString("utf8")); }); }
    function getPackContext(slug) {
        return request(BASE + "/" + slug + "/", { headers: { Referer: BASE + "/" } }).then(function (r) {
            var html = r.body.toString("utf8");
            var acc = html.match(/data-account-id=['"]([^'"]+)['"]/), tok = html.match(/data-token=['"]([^'"]+)['"]/);
            if (!acc || !tok) throw new Error("This pack looks empty or isn't available yet.");
            var nonces = [], re = /nonce['"]?\s*[:=]\s*['"]([a-f0-9]{8,12})['"]/gi, m;
            while ((m = re.exec(html))) { if (nonces.indexOf(m[1]) < 0) nonces.push(m[1]); }
            return { slug: slug, accountId: acc[1], token: tok[1], nonceCandidates: nonces, nonce: null, rootId: null };
        });
    }
    function filelistRequest(ctx, nonce, folderPath, lastFolder) {
        var params = ["listtoken=" + encodeURIComponent(ctx.token), "account_id=" + encodeURIComponent(ctx.accountId), "lastFolder=" + encodeURIComponent(lastFolder || ""), "folderPath=" + encodeURIComponent(folderPath), "sort=name:asc", "action=useyourdrive-get-filelist", "_ajax_nonce=" + encodeURIComponent(nonce), "mobile=false", "query=", "page_url=" + encodeURIComponent(BASE + "/" + ctx.slug + "/")].join("&");
        return request(BASE + "/wp-admin/admin-ajax.php", { method: "POST", body: params, headers: { Referer: BASE + "/" + ctx.slug + "/" } });
    }
    function listFolder(ctx, pathIds) {
        var folderPath, lastFolder, currentFolderId;
        if (!pathIds.length) { folderPath = b64("null"); lastFolder = ""; currentFolderId = ctx.rootId; }
        else { folderPath = b64(JSON.stringify([ctx.rootId].concat(pathIds))); lastFolder = pathIds[pathIds.length - 1]; currentFolderId = lastFolder; }
        function parse(json) {
            var data; try { data = JSON.parse(json); } catch (e) { return null; }
            if (!data || !data.tree) return null;
            if (!ctx.rootId) { for (var i = 0; i < data.tree.length; i++) if (data.tree[i].parent === "#") { ctx.rootId = data.tree[i].id; break; } if (!currentFolderId) currentFolderId = ctx.rootId; }
            var folders = [];
            for (var j = 0; j < data.tree.length; j++) { var n = data.tree[j]; if (n.parent === currentFolderId && n.id !== currentFolderId) folders.push({ id: n.id, name: n.text }); }
            return { folders: folders, files: parseFiles(data.html || "") };
        }
        if (ctx.nonce) return filelistRequest(ctx, ctx.nonce, folderPath, lastFolder).then(function (r) { var res = parse(r.body.toString("utf8")); if (res) return res; throw new Error("Could not read folder contents."); });
        var cands = ctx.nonceCandidates.slice();
        return (function tryNext() {
            if (!cands.length) throw new Error("Token expired — hit Reload and try again.");
            var n = cands.shift();
            return filelistRequest(ctx, n, folderPath, lastFolder).then(function (r) { var res = parse(r.body.toString("utf8")); if (res) { ctx.nonce = n; return res; } return tryNext(); });
        })();
    }
    function parseFiles(html) {
        var files = [], re = /<div class='entry file[^']*'\s+data-id='([^']+)'\s+data-name='([^']*)'>([\s\S]*?)(?=<div class='entry |<\/div>\s*<\/div>\s*<\/div>\s*$|$)/g, m;
        while ((m = re.exec(html))) { var tail = m[3] || "", tm = tail.match(/data-src='(https:\/\/[^']+)'/); files.push({ id: m[1], name: decodeHtml(m[2]), thumb: tm ? tm[1] : "" }); }
        return files;
    }
    function streamUrl(ctx, fileId) { return BASE + "/wp-admin/admin-ajax.php?action=useyourdrive-stream&account_id=" + encodeURIComponent(ctx.accountId) + "&id=" + encodeURIComponent(fileId) + "&listtoken=" + encodeURIComponent(ctx.token); }

    // =========================================================
    //  DOM helpers
    // =========================================================
    function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
    function icon(name) { var ns = "http://www.w3.org/2000/svg"; var svg = document.createElementNS(ns, "svg"); svg.setAttribute("class", "ic"); var use = document.createElementNS(ns, "use"); use.setAttribute("href", "#i-" + name); svg.appendChild(use); return svg; }
    function decodeHtml(s) { var t = document.createElement("textarea"); t.innerHTML = s; return t.value; }
    function fmtT(s) { s = Math.max(0, s || 0); var m = Math.floor(s / 60), x = Math.floor(s % 60); return m + ":" + (x < 10 ? "0" : "") + x; }
    function natCompare(a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" }); }
    function setStatus(node, msg, isError) { if (!msg) { node.classList.add("hidden"); return; } node.classList.remove("hidden"); node.textContent = msg; node.className = "status" + (isError ? " error" : ""); }

    // =========================================================
    //  Clips rendering
    // =========================================================
    function packThumb(item) { return BASE + "/wp-content/uploads/" + item.d + item.i; }
    function tag(kind) { return function (it) { var c = Object.assign({}, it); c._kind = kind; return c; }; }
    function stagger(card, idx) { card.style.animationDelay = (Math.min(idx, 18) * 0.028) + "s"; }
    function makeLabel(txt) { var l = el("div", "label"); l.textContent = txt; l.title = txt; return l; }
    function makeBadge(txt) { var b = el("div", "badge"); b.textContent = txt; return b; }
    function makeFallback(ic) { var f = el("div", "fallback"); f.appendChild(icon(ic)); return f; }

    function renderLibrary() {
        pack = null; navStack = []; currentFiles = [];
        breadcrumb.classList.add("hidden"); if (activeView === "clips") footer.classList.add("hidden"); grid.innerHTML = "";
        var items = [];
        if (filter === "all" || filter === "movies") items = items.concat(library.movies.map(tag("movie")));
        if (filter === "all" || filter === "series") items = items.concat(library.series.map(tag("series")));
        if (searchTerm) { var q = searchTerm.toLowerCase(); items = items.filter(function (it) { return it.t.toLowerCase().indexOf(q) >= 0; }); }
        items.sort(function (a, b) { return natCompare(a.t, b.t); });
        if (!items.length) { setStatus(statusEl, "No anime match your search."); return; }
        setStatus(statusEl, null);
        items.forEach(function (it, idx) {
            var card = el("div", "card pack"); stagger(card, idx);
            var img = el("img", "thumb"); img.referrerPolicy = "no-referrer"; img.loading = "lazy"; img.alt = ""; img.src = packThumb(it);
            img.onerror = function () { img.remove(); card.insertBefore(makeFallback("film"), card.firstChild); };
            card.appendChild(img); card.appendChild(el("div", "grad")); card.appendChild(makeBadge(it._kind === "movie" ? "Movie" : "Series")); card.appendChild(makeLabel(it.t));
            card.onclick = function () { openPack(it); }; grid.appendChild(card);
        });
    }
    function renderFolder(result) {
        grid.innerHTML = ""; breadcrumb.classList.remove("hidden"); renderBreadcrumb();
        if (activeView === "clips") footer.classList.remove("hidden");
        // Episodic packs come back unsorted — order folders and clips naturally (Episode 2 < Episode 12).
        result.folders.sort(function (a, b) { return natCompare(a.name, b.name); });
        result.files.sort(function (a, b) { return natCompare(a.name, b.name); });
        currentFiles = result.files;
        if (!(result.folders.length + result.files.length)) setStatus(statusEl, "This folder is empty."); else setStatus(statusEl, null);
        var idx = 0;
        result.folders.forEach(function (f) {
            var card = el("div", "card folder"); stagger(card, idx++);
            card.appendChild(makeFallback("folder")); card.appendChild(el("div", "grad")); card.appendChild(makeLabel(f.name));
            card.onclick = function () { enterFolder(f); }; grid.appendChild(card);
        });
        result.files.forEach(function (f, fi) {
            var card = el("div", "card clip"); stagger(card, idx++); card.dataset.id = f.id;
            if (isSel(f.id)) card.classList.add("selected");
            if (f.thumb) { var img = el("img", "thumb"); img.referrerPolicy = "no-referrer"; img.alt = ""; observeThumb(img, f.thumb, card); card.appendChild(img); }
            else card.appendChild(makeFallback("film"));
            card.appendChild(el("div", "grad"));
            var hint = el("div", "play-hint"); var hs = el("span"); hs.appendChild(icon("play")); hint.appendChild(hs); card.appendChild(hint);
            var chk = el("div", "check"); chk.appendChild(icon("check")); chk.onclick = function (e) { e.stopPropagation(); toggleClip(f); }; card.appendChild(chk);
            card.appendChild(makeLabel(f.name));
            card.onclick = function () { openLightbox(fi); };
            grid.appendChild(card);
        });
        updateSelInfo();
    }
    var thumbObserver = ("IntersectionObserver" in window) ? new IntersectionObserver(function (entries) { entries.forEach(function (e) { if (e.isIntersecting) { var img = e.target; thumbObserver.unobserve(img); img.src = img.dataset.src; } }); }, { root: $("content"), rootMargin: "300px" }) : null;
    function observeThumb(img, url, card) { img.dataset.src = url; img.onerror = function () { img.remove(); card.insertBefore(makeFallback("film"), card.firstChild); }; if (thumbObserver) thumbObserver.observe(img); else img.src = url; }
    function renderBreadcrumb() {
        breadcrumb.innerHTML = "";
        var home = el("span", "crumb"); home.appendChild(icon("back")); var ht = el("span"); ht.textContent = "Library"; home.appendChild(ht);
        home.onclick = function () { renderLibrary(); }; breadcrumb.appendChild(home);
        navStack.forEach(function (entry, i) {
            var s = el("span", "sep"); s.textContent = "/"; breadcrumb.appendChild(s);
            var isLast = i === navStack.length - 1; var c = el("span", isLast ? "current" : "crumb"); c.textContent = entry.name;
            if (!isLast) c.onclick = function () { navStack = navStack.slice(0, i + 1); loadCurrentFolder(); };
            breadcrumb.appendChild(c);
        });
    }
    function openPack(item) { clearSelection(); setStatus(statusEl, "Opening " + item.t + "…"); grid.innerHTML = ""; getPackContext(item.s).then(function (ctx) { pack = ctx; pack.title = item.t; navStack = [{ name: item.t, pathIds: [] }]; return loadCurrentFolder(); }).catch(function (e) { showError(statusEl, e); }); }
    function enterFolder(folder) { var cur = navStack[navStack.length - 1]; navStack.push({ name: folder.name, pathIds: cur.pathIds.concat([folder.id]) }); loadCurrentFolder(); }
    function loadCurrentFolder() { var cur = navStack[navStack.length - 1]; setStatus(statusEl, "Loading…"); grid.innerHTML = ""; breadcrumb.classList.remove("hidden"); renderBreadcrumb(); return listFolder(pack, cur.pathIds).then(renderFolder).catch(function (e) { showError(statusEl, e); }); }

    // selection (clips)
    function isSel(id) { return !!sel.map[id]; }
    function toggleClip(f) {
        if (sel.map[f.id]) { delete sel.map[f.id]; sel.order = sel.order.filter(function (x) { return x !== f.id; }); }
        else { sel.map[f.id] = { id: f.id, name: f.name, ctx: pack, kind: "clip" }; sel.order.push(f.id); }
        var card = grid.querySelector('.card.clip[data-id="' + f.id.replace(/["\\]/g, "\\$&") + '"]');
        if (card) card.classList.toggle("selected", isSel(f.id));
        updateSelInfo(); if (!lb.classList.contains("hidden")) updateLightboxSelectBtn();
    }
    function clearSelection() { sel.map = {}; sel.order = []; Array.prototype.forEach.call(grid.querySelectorAll(".card.clip.selected"), function (c) { c.classList.remove("selected"); }); updateSelInfo(); if (!lb.classList.contains("hidden")) updateLightboxSelectBtn(); }
    function updateSelInfo() { var s = activeView === "assets" ? asSel : sel; selcount.textContent = s.order.length; btnImport.disabled = s.order.length === 0; }

    // =========================================================
    //  Lightbox (clips preview)
    // =========================================================
    var lb = $("lightbox"), lbVideo = $("lb-video"), lbTitle = $("lb-title"), lbCount = $("lb-count"), lbSelect = $("lb-select"), lbMute = $("lb-mute"), lbSpinner = $("lb-spinner");
    var lbIndex = 0, lbMuted = true, lbLoadToken = 0, lbMode = "clip", lbImg = $("lb-img");
    function openLightbox(index) { if (!currentFiles.length) return; lbMode = "clip"; lb.classList.remove("hidden", "asset-mode", "image-mode"); lbImg.classList.add("hidden"); lbVideo.style.display = ""; lbIndex = index; loadLightbox(); }
    function loadLightbox() {
        var f = currentFiles[lbIndex]; if (!f) return;
        var token = ++lbLoadToken;
        var base = (lbIndex + 1) + " of " + currentFiles.length + (pack ? " • " + pack.title : "");
        lbTitle.textContent = f.name; lbCount.textContent = base; lbSpinner.classList.remove("hidden");
        try { lbVideo.pause(); lbVideo.removeAttribute("src"); lbVideo.load(); } catch (e) {}
        ensureCached(f.id, f.name, pack, function (rec, tot) { if (token === lbLoadToken && tot) lbCount.textContent = base + "  ·  loading " + Math.round(rec / tot * 100) + "%"; })
            .then(function (p) { if (token !== lbLoadToken) return; lbCount.textContent = base; lbVideo.muted = lbMuted; lbVideo.src = fileUrl(p); lbVideo.play().catch(function () {}); preloadNext(); })
            .catch(function (e) { if (token !== lbLoadToken) return; lbSpinner.classList.add("hidden"); if (e.message !== "aborted") lbCount.textContent = base + "  ·  preview unavailable"; });
    }
    function preloadNext() { var f = currentFiles[lbIndex + 1]; if (!f || fileSize(path.join(CACHE_DIR, sanitize(f.name, "mp4"))) > 0) return; ensureCached(f.id, f.name, pack).catch(function () {}); }
    function lbStep(dir) { lbIndex = (lbIndex + dir + currentFiles.length) % currentFiles.length; loadLightbox(); }
    function updateLightboxSelectBtn() { var f = currentFiles[lbIndex]; if (!f) return; var s = isSel(f.id); lbSelect.classList.toggle("selected", s); lbSelect.querySelector("span").textContent = s ? "Selected" : "Select"; }
    function closeLightbox() { lbLoadToken++; lbMode = "clip"; lb.classList.add("hidden"); lb.classList.remove("asset-mode", "image-mode"); try { lbVideo.pause(); lbVideo.removeAttribute("src"); lbVideo.load(); } catch (e) {} try { lbImg.removeAttribute("src"); } catch (e) {} }
    function openMedia(url, type, name) {
        lbMode = type; lb.classList.remove("hidden"); lb.classList.add("asset-mode");
        lbTitle.textContent = name; lbCount.textContent = "";
        if (type === "image") {
            lb.classList.add("image-mode"); lbImg.classList.remove("hidden"); lbVideo.style.display = "none";
            try { lbVideo.pause(); lbVideo.removeAttribute("src"); lbVideo.load(); } catch (e) {}
            lbSpinner.classList.add("hidden"); lbImg.src = url;
        } else {
            lb.classList.remove("image-mode"); lbImg.classList.add("hidden"); lbVideo.style.display = "";
            lbSpinner.classList.add("hidden"); lbVideo.muted = lbMuted; lbVideo.src = url; lbVideo.play().catch(function () {});
        }
    }
    lbVideo.addEventListener("playing", function () { lbSpinner.classList.add("hidden"); });
    lbVideo.addEventListener("canplay", function () { lbSpinner.classList.add("hidden"); });
    lbVideo.addEventListener("waiting", function () { if (lbVideo.currentSrc) lbSpinner.classList.remove("hidden"); });

    // =========================================================
    //  Import (clips)
    // =========================================================
    function sanitize(name, def) {
        var n = name.replace(/[\\\/:*?"<>|#]+/g, "_").replace(/\s+/g, " ").trim();
        if (!/\.(mp4|mov|webm|mkv|m4v|mp3|wav|m4a|aac|ogg|flac|aiff)$/i.test(n)) n += "." + (def || "mp4");
        return n;
    }
    function copyFile(src, dst) { return new Promise(function (res, rej) { fs.copyFile(src, dst, function (e) { e ? rej(e) : res(dst); }); }); }
    function getImportPath(it, onProgress) {
        var dir = settings.dlFolder; ensureFolder(dir);
        var target = path.join(dir, sanitize(it.name, "mp4"));
        if (fileSize(target) > 0) return Promise.resolve(target);
        var cached = path.join(CACHE_DIR, sanitize(it.name, "mp4"));
        if (fileSize(cached) > 0) return copyFile(cached, target);
        return download(streamUrl(it.ctx, it.id), target, onProgress, BASE + "/").then(function (r) { return r.path; });
    }
    function importItems(items) {
        if (!items.length) return;
        if (!fs) { toast("Node access unavailable — check the panel's CEF flags.", "err"); return; }
        var total = items.length, paths = []; btnImport.disabled = true; showProgress("Preparing 1 / " + total + "…", 0);
        var chain = Promise.resolve();
        items.forEach(function (it, idx) {
            chain = chain.then(function () { return getImportPath(it, function (rec, tot) { var frac = tot ? rec / tot : 0; showProgress("Downloading " + (idx + 1) + " / " + total + " — " + it.name + " (" + Math.round(frac * 100) + "%)", (idx + frac) / total * 100); }).then(function (p) { paths.push(p); showProgress("Prepared " + (idx + 1) + " / " + total + "…", (idx + 1) / total * 100); }); });
        });
        chain.then(function () { showProgress("Importing into After Effects…", 100); return importToAE(paths); })
            .then(function (res) { hideProgress(); updateSelInfo(); if (res && res.ok) { toast(res.message, "ok"); if (settings.openAfter) openInExplorer(settings.dlFolder); } else toast((res && res.message) || "Import failed.", "err"); })
            .catch(function (err) { hideProgress(); updateSelInfo(); toast("Failed: " + err.message, "err"); });
    }
    function importSelection() { if (sel.order.length) importItems(sel.order.map(function (id) { return sel.map[id]; })); }

    var HOST_SEP = String.fromCharCode(1);
    function jsEscape(s) { return s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\r/g, "\\r").replace(/\n/g, "\\n"); }
    function importToAE(paths) {
        return new Promise(function (resolve) {
            cs.evalScript('acl_importClips("' + jsEscape(paths.join(HOST_SEP)) + '")', function (out) {
                var parts = (out || "").split(HOST_SEP);
                if (parts.length >= 4) resolve({ ok: parts[0] === "OK", imported: parseInt(parts[1] || "0", 10), addedToComp: parts[2] === "1", message: parts[3] });
                else resolve({ ok: false, message: out ? ("Host: " + out) : "No response from After Effects." });
            });
        });
    }
    function openInExplorer(dir) { try { if (child_process) child_process.exec('explorer "' + dir + '"'); } catch (e) {} }

    // =========================================================
    //  Subprocess runner (ffmpeg / RIFE / ESRGAN)
    // =========================================================
    function run(exe, args, onData) {
        return new Promise(function (resolve, reject) {
            var proc; try { proc = child_process.spawn(exe, args, { windowsHide: true }); } catch (e) { return reject(new Error("Cannot start " + baseName(exe) + ": " + e.message)); }
            var tail = "";
            function feed(d) { var s = d.toString(); tail = (tail + s).slice(-800); if (onData) onData(s); }
            proc.stdout.on("data", feed); proc.stderr.on("data", feed);
            proc.on("error", function (e) { reject(new Error("Cannot run " + baseName(exe) + ": " + e.message)); });
            proc.on("close", function (code) { code === 0 ? resolve() : reject(new Error(baseName(exe) + " exited with code " + code + (tail ? ": " + tail.trim().split("\n").pop() : ""))); });
        });
    }

    // =========================================================
    //  Host: render AE selection + place result
    // =========================================================
    function callRender(outBase) {
        return new Promise(function (resolve) {
            cs.evalScript('acl_renderSelected("' + jsEscape(outBase) + '")', function (out) {
                var p = (out || "").split(HOST_SEP);
                if (p[0] === "OK") resolve({ ok: true, fps: parseFloat(p[1]) || 24, frames: parseInt(p[2] || "0", 10), spanStart: parseFloat(p[3]) || 0, compId: parseInt(p[4] || "0", 10), compName: p[5] || "", renderedPath: p[6] || "" });
                else resolve({ ok: false, message: p[1] || out || "render failed" });
            });
        });
    }
    function placeInterp(file, compId, startTime) {
        return new Promise(function (resolve) {
            var arg = file + HOST_SEP + compId + HOST_SEP + startTime;
            cs.evalScript('acl_placeClip("' + jsEscape(arg) + '")', function (out) {
                var parts = (out || "").split(HOST_SEP);
                if (parts.length >= 4) resolve({ ok: parts[0] === "OK", message: parts[3] });
                else resolve({ ok: false, message: out ? ("Host: " + out) : "No response from After Effects." });
            });
        });
    }

    // =========================================================
    //  Kaizen (upscale + interpolation chain)
    // =========================================================
    function loadKz() {
        var k = {}; try { k = (JSON.parse(localStorage.getItem("kage_settings") || "{}").kz) || {}; } catch (e) {}
        return {
            doUpscale: !!k.doUpscale, doInterp: k.doInterp !== false,
            upScale: k.upScale || 2, upSharp: (k.upSharp != null) ? k.upSharp : 25, upModel: k.upModel || "realesr-animevideov3",
            inMult: k.inMult || 2, inCustom: !!k.inCustom, inModel: k.inModel || ""
        };
    }
    function saveKz() { settings.kz = kz; saveSettings(); }

    var kzLogBuf = "", kzLogFlush = null;
    function kzLogReset() { kzLogBuf = ""; var e = $("kz-log"); e.classList.remove("hidden"); e.textContent = ""; }
    function kzLog(s) { kzLogBuf = (kzLogBuf + s).slice(-4000); if (!kzLogFlush) kzLogFlush = setTimeout(function () { kzLogFlush = null; var e = $("kz-log"); e.textContent = kzLogBuf; e.scrollTop = e.scrollHeight; }, 200); }

    function setMultActive(val) { Array.prototype.forEach.call(document.querySelectorAll("#in-mult button"), function (b) { b.classList.toggle("active", b.dataset.m === val); }); }
    function applyKzUI() {
        $("kz-tg-up").classList.toggle("active", kz.doUpscale);
        $("kz-tg-in").classList.toggle("active", kz.doInterp);
        Array.prototype.forEach.call(document.querySelectorAll("#up-scale button"), function (b) { b.classList.toggle("active", +b.dataset.s === kz.upScale); });
        $("up-model").value = kz.upModel;
        $("up-sharp").value = kz.upSharp; $("up-sharp-val").textContent = kz.upSharp + "%";
        if (kz.inCustom) { setMultActive("custom"); $("in-custom-row").classList.remove("hidden"); $("in-custom").value = kz.inMult; $("in-custom-val").textContent = kz.inMult + "×"; }
        else { setMultActive(String(kz.inMult)); $("in-custom-row").classList.add("hidden"); }
    }
    function detectRifeModels() {
        var sel2 = $("in-model"); if (!sel2) return;
        var models = settings.rife ? listSubdirs(dirOf(settings.rife)).filter(function (n) { return /^rife/i.test(n); }) : [];
        sel2.innerHTML = "";
        if (!models.length) { var o = document.createElement("option"); o.value = ""; o.textContent = "Install RIFE first…"; sel2.appendChild(o); return; }
        models.sort(natCompare);
        models.forEach(function (m) { var o = document.createElement("option"); o.value = m; o.textContent = m; sel2.appendChild(o); });
        var def = (kz.inModel && models.indexOf(kz.inModel) >= 0) ? kz.inModel : (models.filter(function (m) { return /v4\.6/i.test(m); })[0] || models.filter(function (m) { return /v4/i.test(m); }).sort().pop() || models[0]);
        sel2.value = def; kz.inModel = def;
    }
    function refreshKzSelection() {
        cs.evalScript("acl_getSelection()", function (out) {
            var p = (out || "").split(HOST_SEP);
            if (p[0] === "comp" || p[0] === "layer") { kzSel = { type: p[0], name: p[1], comp: p[2] }; $("kz-src-name").textContent = p[1]; $("kz-src-sub").textContent = (p[0] === "layer" ? "Layer in " + p[2] : "Composition") + " — ready"; }
            else { kzSel = null; $("kz-src-name").textContent = "No selection"; $("kz-src-sub").textContent = "Select a clip or composition in your AE timeline, then Refresh"; }
        });
    }

    function runChain() {
        if (chainBusy) return;
        if (!child_process) { toast("Node access unavailable.", "err"); return; }
        if (!kz.doUpscale && !kz.doInterp) { toast("Turn on Upscale or Interpolation first.", "err"); return; }
        if (!settings.ffmpeg) { toast("Install the tools in Settings first.", "err"); openSettings(); return; }
        if (kz.doUpscale && !settings.realesrgan) { toast("Set the Real-ESRGAN path in Settings.", "err"); openSettings(); return; }
        if (kz.doInterp && (!settings.rife || !$("in-model").value)) { toast("Set RIFE and a model in the options/Settings.", "err"); return; }

        var doUp = kz.doUpscale, doIn = kz.doInterp;
        var upModel = $("up-model").value, scale = (upModel === "realesrgan-x4plus-anime") ? 4 : kz.upScale;
        var sharpPct = kz.upSharp, mult = kz.inMult, rifeModel = $("in-model").value;
        var work = path.join(os.tmpdir(), "KageChain", String(Date.now()));
        var framesDir = path.join(work, "in"); ensureFolder(framesDir);
        var renderBase = path.join(work, "render"), renderInfo = null, chainOutDir = settings.dlFolder;

        chainBusy = true; $("kz-run").disabled = true; kzLogReset();
        showProgress("Rendering selection from After Effects…", 3);

        callRender(renderBase).then(function (r) {
            if (!r.ok) throw new Error(r.message);
            renderInfo = r;
            if (!r.renderedPath || fileSize(r.renderedPath) === 0) throw new Error("After Effects didn't produce a render file. Path: " + (r.renderedPath || "?"));
            kzLog("Rendered: " + r.renderedPath + "  (" + r.fps + " fps)\n");
            showProgress("Extracting frames…", 9);
            return run(settings.ffmpeg, ["-y", "-i", r.renderedPath, "-vsync", "0", path.join(framesDir, "%08d.png")], kzLog).then(function () {
                var audio = path.join(work, "audio.m4a");
                return run(settings.ffmpeg, ["-y", "-i", r.renderedPath, "-vn", "-c:a", "aac", "-b:a", "192k", audio]).then(function () { return audio; }, function () { return null; });
            });
        }).then(function (audio) {
            var N = countPng(framesDir);
            if (N < 1) throw new Error("No frames could be read from the AE render (see log).");
            kzLog(N + " frames extracted\n");
            var st = { dir: framesDir, outFps: renderInfo.fps, audio: audio, count: N };
            var chain = Promise.resolve(st);
            if (doUp) chain = chain.then(function (st2) {
                var upDir = path.join(work, "up"); ensureFolder(upDir);
                kzLog("Upscaling ×" + scale + " (" + upModel + ")…\n");
                var lo = 22, hi = doIn ? 50 : 78;
                showProgress("Upscaling ×" + scale + " (0 / " + st2.count + ")…", lo);
                var poll = setInterval(function () { var d = countPng(upDir); showProgress("Upscaling ×" + scale + " (" + d + " / " + st2.count + ")…", lo + (d / st2.count) * (hi - lo)); }, 700);
                return run(settings.realesrgan, ["-i", st2.dir, "-o", upDir, "-n", upModel, "-s", String(scale), "-f", "png"], function (s) { if (/\d/.test(s)) kzLog(s); })
                    .then(function () { clearInterval(poll); st2.dir = upDir; return st2; }, function (e) { clearInterval(poll); throw e; });
            });
            if (doIn) chain = chain.then(function (st2) {
                var rifeDir = path.join(work, "rife"); ensureFolder(rifeDir);
                var cnt = countPng(st2.dir), target = cnt * mult; st2.outFps = renderInfo.fps * mult;
                kzLog("Interpolating ×" + mult + " → " + target + " frames…\n");
                var lo = doUp ? 52 : 24, hi = 80;
                showProgress("Interpolating ×" + mult + " (0 / " + target + ")…", lo);
                var poll = setInterval(function () { var d = fs.existsSync(rifeDir) ? countPng(rifeDir) : 0; showProgress("Interpolating (" + d + " / " + target + ")…", lo + (d / target) * (hi - lo)); }, 700);
                var modelDir = path.join(dirOf(settings.rife), rifeModel);
                return run(settings.rife, ["-i", st2.dir, "-o", rifeDir, "-m", modelDir, "-n", String(target), "-f", "%08d.png"], function (s) { if (/\d/.test(s)) kzLog(s); })
                    .then(function () { clearInterval(poll); st2.dir = rifeDir; return st2; }, function (e) { clearInterval(poll); throw e; });
            });
            return chain;
        }).then(function (st) {
            showProgress("Encoding…", 84);
            chainOutDir = path.join(settings.dlFolder, (doUp && doIn) ? "Upscaled & Interpolated" : (doUp ? "Upscaled" : "Interpolated"));
            ensureFolder(chainOutDir);
            var tag2 = (doUp ? "_up" + scale + "x" : "") + (doIn ? "_x" + mult : "");
            var out = path.join(chainOutDir, sanitize((renderInfo.compName || "comp") + tag2, "mp4"));
            var vf = (doUp && sharpPct > 0) ? ("unsharp=5:5:" + (sharpPct / 100 * 1.5).toFixed(2) + ":5:5:0.0,format=yuv420p") : "format=yuv420p";
            var args = ["-y", "-framerate", String(st.outFps), "-i", path.join(st.dir, "%08d.png")];
            if (st.audio) args = args.concat(["-i", st.audio]);
            args = args.concat(["-vf", vf, "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p"]);
            if (st.audio) args = args.concat(["-c:a", "aac", "-shortest"]);
            args.push(out);
            return run(settings.ffmpeg, args, kzLog).then(function () { return out; });
        }).then(function (out) {
            showProgress("Placing on the timeline…", 97);
            return placeInterp(out, renderInfo.compId, renderInfo.spanStart).then(function (res) { rmrf(work); return res; });
        }).then(function (res) {
            hideProgress(); chainBusy = false; $("kz-run").disabled = false;
            if (res && res.ok) { toast(res.message || "Done.", "ok"); if (settings.openAfter) openInExplorer(chainOutDir); }
            else toast((res && res.message) || "Failed.", "err");
        }).catch(function (err) { rmrf(work); hideProgress(); chainBusy = false; $("kz-run").disabled = false; kzLog("\nError: " + err.message + "\n"); toast("Failed: " + err.message, "err"); });
    }

    // =========================================================
    //  Auto-download tools
    // =========================================================
    var downloading = false;
    function toolsRoot() { return path.join(os.homedir(), "KageStudio", "tools"); }
    function psq(s) { return "'" + s.replace(/'/g, "''") + "'"; }
    function findFile(dir, name) {
        var stack = [dir], low = name.toLowerCase();
        while (stack.length) { var d = stack.pop(), ents; try { ents = fs.readdirSync(d); } catch (e) { continue; } for (var i = 0; i < ents.length; i++) { var full = path.join(d, ents[i]), st; try { st = fs.statSync(full); } catch (e) { continue; } if (st.isDirectory()) stack.push(full); else if (ents[i].toLowerCase() === low) return full; } }
        return null;
    }
    function setupTools() {
        if (downloading) return;
        if (!child_process || !fs) { toast("Node access unavailable.", "err"); return; }
        downloading = true; $("btn-setup-tools").disabled = true;
        var root = toolsRoot(); ensureFolder(root);
        var jobs = [
            { key: "ffmpeg", name: "ffmpeg", url: "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip", exe: "ffmpeg.exe", label: "ffmpeg" },
            { key: "realesrgan", name: "realesrgan", url: "https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.5.0/realesrgan-ncnn-vulkan-20220424-windows.zip", exe: "realesrgan-ncnn-vulkan.exe", label: "Real-ESRGAN" },
            { key: "rife", name: "rife", url: "https://github.com/nihui/rife-ncnn-vulkan/releases/download/20221029/rife-ncnn-vulkan-20221029-windows.zip", exe: "rife-ncnn-vulkan.exe", label: "RIFE 4.6" }
        ];
        var i = 0;
        function next() {
            if (i >= jobs.length) return finish();
            var j = jobs[i];
            if (settings[j.key] && fileSize(settings[j.key]) > 0) { i++; return next(); }
            var zip = path.join(root, j.name + ".zip"), dest = path.join(root, j.name);
            showProgress("Downloading " + j.label + "…", (i / jobs.length) * 100);
            download(j.url, zip, function (rec, tot) { if (tot) showProgress("Downloading " + j.label + " " + Math.round(rec / tot * 100) + "%…", ((i + (rec / tot) * 0.8) / jobs.length) * 100); })
                .then(function () { ensureFolder(dest); showProgress("Extracting " + j.label + "…", ((i + 0.85) / jobs.length) * 100); return run("powershell", ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath " + psq(zip) + " -DestinationPath " + psq(dest) + " -Force"]); })
                .then(function () { var exe = findFile(dest, j.exe); if (exe) settings[j.key] = exe; try { fs.unlinkSync(zip); } catch (e) {} i++; next(); })
                .catch(function (e) { toast(j.label + " failed: " + e.message, "err"); i++; next(); });
        }
        function finish() {
            saveSettings(); downloading = false; $("btn-setup-tools").disabled = false; hideProgress();
            $("ffmpeg-path").value = settings.ffmpeg || ""; $("realesrgan-path").value = settings.realesrgan || ""; $("rife-path").value = settings.rife || "";
            detectRifeModels();
            var ok = (settings.ffmpeg ? 1 : 0) + (settings.realesrgan ? 1 : 0) + (settings.rife ? 1 : 0);
            toast(ok + " / 3 tools installed" + (ok === 3 ? "." : " — check the failed ones."), ok === 3 ? "ok" : "err");
        }
        next();
    }

    // =========================================================
    //  Assets browser (local folder -> preview -> import)
    // =========================================================
    var EXT = {
        image: ["png", "jpg", "jpeg", "gif", "bmp", "webp", "tif", "tiff", "exr", "psd", "ai", "svg", "heic", "tga", "dpx"],
        video: ["mp4", "mov", "mkv", "webm", "m4v", "avi", "mpg", "mpeg", "wmv", "flv", "mxf"],
        audio: ["mp3", "wav", "aac", "m4a", "ogg", "flac", "aiff", "aif"],
        "3d": ["obj", "fbx", "c4d", "glb", "gltf", "blend", "3ds", "dae", "stl", "ply", "abc", "usd", "usdz"]
    };
    function fileCat(name) { var e = (name.split(".").pop() || "").toLowerCase(); for (var k in EXT) { if (EXT[k].indexOf(e) >= 0) return k; } return "other"; }
    function cssPath(p) { return p.replace(/["\\]/g, "\\$&"); }

    function pickAssetFolder() {
        try { var res = window.cep.fs.showOpenDialogEx(false, true, "Choose a folder", settings.assetsFolder || settings.dlFolder); if (res && res.data && res.data.length) { settings.assetsFolder = res.data[0]; saveSettings(); asRoot = res.data[0]; loadAssets(res.data[0]); } }
        catch (e) { toast("Folder picker unavailable.", "err"); }
    }
    function loadAssets(folder) {
        asFolder = folder; asSel = { map: {}, order: [] };
        $("as-path").textContent = folder;
        renderAsBreadcrumb();
        var entries = [];
        try { entries = fs.readdirSync(folder); } catch (e) { setStatus($("as-status"), "Can't read this folder: " + e.message, true); $("as-grid").innerHTML = ""; footer.classList.add("hidden"); return; }
        var dirs = [], files = [];
        entries.forEach(function (n) { if (n.charAt(0) === ".") return; var full = path.join(folder, n), st; try { st = fs.statSync(full); } catch (e) { return; } if (st.isDirectory()) dirs.push({ name: n, path: full }); else files.push({ name: n, path: full, cat: fileCat(n), size: st.size }); });
        dirs.sort(function (a, b) { return natCompare(a.name, b.name); });
        files.sort(function (a, b) { return natCompare(a.name, b.name); });
        asItems = { dirs: dirs, files: files };
        renderAssets();
    }
    function renderAsBreadcrumb() {
        var bc = $("as-breadcrumb");
        if (!asRoot || asFolder === asRoot) { bc.classList.add("hidden"); bc.innerHTML = ""; return; }
        bc.classList.remove("hidden"); bc.innerHTML = "";
        var home = el("span", "crumb"); home.appendChild(icon("back")); var ht = el("span"); ht.textContent = baseName(asRoot) || asRoot; home.appendChild(ht); home.onclick = function () { loadAssets(asRoot); }; bc.appendChild(home);
        var rel = asFolder.substring(asRoot.length).replace(/^[\\\/]+/, ""), parts = rel.split(/[\\\/]/), acc = asRoot;
        parts.forEach(function (p, i) { acc = path.join(acc, p); var sep = el("span", "sep"); sep.textContent = "/"; bc.appendChild(sep); var isLast = i === parts.length - 1; var c = el("span", isLast ? "current" : "crumb"); c.textContent = p; if (!isLast) { var target = acc; c.onclick = function () { loadAssets(target); }; } bc.appendChild(c); });
    }
    function renderAssets() {
        var g = $("as-grid"); g.innerHTML = "";
        var files = asItems.files.filter(function (f) { return asFilter === "all" || f.cat === asFilter; });
        var showDirs = asFilter === "all" ? asItems.dirs : [];
        footer.classList.toggle("hidden", activeView !== "assets" || !(showDirs.length || files.length));
        if (!showDirs.length && !files.length) setStatus($("as-status"), asFolder ? "Nothing here for this filter." : "Choose a folder to browse its contents.");
        else setStatus($("as-status"), null);
        var idx = 0;
        showDirs.forEach(function (d) {
            var card = el("div", "card folder"); stagger(card, idx++);
            card.appendChild(makeFallback("folder")); card.appendChild(el("div", "grad")); card.appendChild(makeLabel(d.name));
            card.onclick = function () { loadAssets(d.path); }; g.appendChild(card);
        });
        files.forEach(function (f) {
            var card = el("div", "card asset"); stagger(card, idx++); card.dataset.path = f.path;
            if (asSel.map[f.path]) card.classList.add("selected");
            if (f.cat === "image") { var img = el("img", "thumb"); img.referrerPolicy = "no-referrer"; img.loading = "lazy"; img.src = fileUrl(f.path); img.onerror = function () { img.remove(); card.insertBefore(makeFallback("image"), card.firstChild); }; card.appendChild(img); }
            else if (f.cat === "video") { var v = el("video", "thumb"); v.muted = true; v.playsInline = true; v.preload = "metadata"; v.src = fileUrl(f.path) + "#t=0.5"; card.appendChild(v); enableHoverPlayAsset(card, v); }
            else card.appendChild(makeFallback(f.cat === "audio" ? "volume" : (f.cat === "3d" ? "cube" : "file")));
            card.appendChild(el("div", "grad"));
            if (f.cat !== "other") card.appendChild(makeBadge(f.cat === "3d" ? "3D" : f.cat));
            if (f.cat === "image" || f.cat === "video") { var pv = el("div", "preview-btn"); pv.title = "Preview"; pv.appendChild(icon("eye")); pv.onclick = function (e) { e.stopPropagation(); openAsset(f); }; card.appendChild(pv); }
            var chk = el("div", "check"); chk.appendChild(icon("check")); chk.onclick = function (e) { e.stopPropagation(); asToggle(f); }; card.appendChild(chk);
            card.appendChild(makeLabel(f.name));
            card.onclick = function () { asToggle(f); };
            g.appendChild(card);
        });
        updateSelInfo();
    }
    function enableHoverPlayAsset(card, v) {
        card.addEventListener("mouseenter", function () { try { v.loop = true; v.currentTime = 0; v.play().catch(function () {}); } catch (e) {} });
        card.addEventListener("mouseleave", function () { try { v.pause(); } catch (e) {} });
    }
    function asToggle(f) {
        if (asSel.map[f.path]) { delete asSel.map[f.path]; asSel.order = asSel.order.filter(function (x) { return x !== f.path; }); }
        else { asSel.map[f.path] = { path: f.path, name: f.name }; asSel.order.push(f.path); }
        var card = $("as-grid").querySelector('.card.asset[data-path="' + cssPath(f.path) + '"]');
        if (card) card.classList.toggle("selected", !!asSel.map[f.path]);
        updateSelInfo();
    }
    function asClear() { asSel = { map: {}, order: [] }; Array.prototype.forEach.call($("as-grid").querySelectorAll(".card.asset.selected"), function (c) { c.classList.remove("selected"); }); updateSelInfo(); }
    function openAsset(f) {
        if (f.cat === "image") openMedia(fileUrl(f.path), "image", f.name);
        else if (f.cat === "video") openMedia(fileUrl(f.path), "video", f.name);
        else asToggle(f); // no preview for audio/3d/other — clicking selects
    }
    function importAssets() {
        if (!asSel.order.length) return;
        if (!fs) { toast("Node access unavailable.", "err"); return; }
        var paths = asSel.order.slice();
        btnImport.disabled = true; showProgress("Importing " + paths.length + " asset" + (paths.length === 1 ? "" : "s") + "…", 100);
        importToAE(paths).then(function (res) {
            hideProgress(); updateSelInfo();
            if (res && res.ok) { toast(res.message, "ok"); if (settings.openAfter) openInExplorer(asFolder || settings.dlFolder); }
            else toast((res && res.message) || "Import failed.", "err");
        }).catch(function (err) { hideProgress(); updateSelInfo(); toast("Failed: " + err.message, "err"); });
    }

    // =========================================================
    //  Progress + toast
    // =========================================================
    function showProgress(label, pct) { progress.classList.remove("hidden"); progressLabel.textContent = label; progressBar.style.width = Math.max(0, Math.min(100, pct)) + "%"; }
    function hideProgress() { progress.classList.add("hidden"); progressBar.style.width = "0%"; }
    var toastTimer = null, toastEl = $("toast");
    function toast(msg, kind) { toastEl.textContent = msg; toastEl.className = (kind || "") + " show"; clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.className = (kind || ""); }, 5200); }
    function showError(node, err) { setStatus(node, (err && err.message) || "Something went wrong.", true); hideProgress(); }

    // =========================================================
    //  Theming
    // =========================================================
    var PRESETS = ["#8b5cf6", "#e23b3b", "#22d3ee", "#34d399", "#f59e0b", "#ec4899", "#3b82f6", "#ffffff"];
    function hexToRgb(h) { h = h.replace("#", ""); if (h.length === 3) h = h.split("").map(function (c) { return c + c; }).join(""); var n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
    function rgbToHex(r, g, b) { return "#" + [r, g, b].map(function (x) { return ("0" + Math.round(Math.max(0, Math.min(255, x))).toString(16)).slice(-2); }).join(""); }
    function rgbToHsl(r, g, b) { r /= 255; g /= 255; b /= 255; var mx = Math.max(r, g, b), mn = Math.min(r, g, b), h, s, l = (mx + mn) / 2; if (mx === mn) { h = s = 0; } else { var d = mx - mn; s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn); switch (mx) { case r: h = (g - b) / d + (g < b ? 6 : 0); break; case g: h = (b - r) / d + 2; break; default: h = (r - g) / d + 4; } h /= 6; } return [h * 360, s, l]; }
    function hslToRgb(h, s, l) { h /= 360; function hue(p, q, t) { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; } var r, g, b; if (s === 0) { r = g = b = l; } else { var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q; r = hue(p, q, h + 1 / 3); g = hue(p, q, h); b = hue(p, q, h - 1 / 3); } return [r * 255, g * 255, b * 255]; }
    function rotate(hex, deg, dl) { var c = hexToRgb(hex), hsl = rgbToHsl(c[0], c[1], c[2]); var h = (hsl[0] + deg + 360) % 360, l = Math.max(0, Math.min(1, hsl[1] === 0 ? hsl[2] : hsl[2] + (dl || 0))); var rgb = hslToRgb(h, hsl[1], l); return rgbToHex(rgb[0], rgb[1], rgb[2]); }
    function rgba(hex, a) { var c = hexToRgb(hex); return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")"; }
    function applyAccent() {
        var a = settings.accent || DEFAULT_ACCENT, a2 = rotate(a, 26), a3 = rotate(a, 50, 0.04), r = document.documentElement.style;
        r.setProperty("--accent", a); r.setProperty("--accent-2", a2); r.setProperty("--accent-grad", "linear-gradient(120deg," + a + " 0%," + a2 + " 55%," + a3 + " 110%)"); r.setProperty("--accent-soft", rgba(a, 0.16));
    }
    function applyBackground() {
        var bg = $("bg-layer"), r = document.documentElement.style;
        if (settings.bgPath) { bg.style.backgroundImage = "url('" + fileUrl(settings.bgPath).replace(/'/g, "%27") + "')"; r.setProperty("--bg-dim", (settings.bgDim != null ? settings.bgDim : 55) / 100); }
        else { bg.style.backgroundImage = DEFAULT_BG; r.setProperty("--bg-dim", 0); }
        bg.style.filter = settings.bgBlur ? "blur(" + settings.bgBlur + "px)" : "none";
    }

    // =========================================================
    //  Settings
    // =========================================================
    function defaultFolder() { try { var docs = cs.getSystemPath(SystemPath.MY_DOCUMENTS); return path ? path.join(docs, "KageStudio") : docs + "\\KageStudio"; } catch (e) { return (os ? os.tmpdir() : "C:\\Temp") + "\\KageStudio"; } }
    function loadSettings() {
        var s = {}; try { s = JSON.parse(localStorage.getItem("kage_settings") || "{}"); } catch (e) {}
        if (!s.dlFolder) s.dlFolder = defaultFolder();
        if (typeof s.openAfter !== "boolean") s.openAfter = false;
        if (s.bgDim == null) s.bgDim = 55; if (s.bgBlur == null) s.bgBlur = 0;
        if (!s.ffmpeg) s.ffmpeg = ""; if (!s.realesrgan) s.realesrgan = ""; if (!s.rife) s.rife = "";
        if (!s.graphPresets) s.graphPresets = [];
        return s;
    }
    function saveSettings() { try { localStorage.setItem("kage_settings", JSON.stringify(settings)); } catch (e) {} }
    function buildSwatches() {
        var wrap = $("accent-presets"); wrap.innerHTML = "";
        PRESETS.forEach(function (hex) {
            var sw = el("div", "swatch"); sw.style.background = "linear-gradient(120deg," + hex + "," + rotate(hex, 30) + ")";
            if ((settings.accent || DEFAULT_ACCENT).toLowerCase() === hex.toLowerCase()) sw.classList.add("active");
            sw.onclick = function () { settings.accent = hex; saveSettings(); applyAccent(); refreshSwatches(); $("accent-color").value = hex; };
            wrap.appendChild(sw);
        });
    }
    function refreshSwatches() { Array.prototype.forEach.call($("accent-presets").children, function (sw, i) { sw.classList.toggle("active", (settings.accent || DEFAULT_ACCENT).toLowerCase() === PRESETS[i].toLowerCase()); }); }
    function openSettings() {
        $("dl-folder").value = settings.dlFolder; $("opt-openafter").checked = settings.openAfter;
        $("accent-color").value = settings.accent || DEFAULT_ACCENT;
        $("bg-path").value = settings.bgPath || ""; $("bg-dim").value = settings.bgDim; $("bg-blur").value = settings.bgBlur;
        $("ffmpeg-path").value = settings.ffmpeg || ""; $("realesrgan-path").value = settings.realesrgan || ""; $("rife-path").value = settings.rife || "";
        buildSwatches(); $("settings-panel").classList.remove("hidden");
    }
    function closeSettings() { $("settings-panel").classList.add("hidden"); }
    function pickInto(key, title, types, input) { try { var res = window.cep.fs.showOpenDialogEx(false, false, title, settings.dlFolder, types); if (res && res.data && res.data.length) { settings[key] = res.data[0]; $(input).value = res.data[0]; saveSettings(); } } catch (e) { toast("Picker unavailable.", "err"); } }
    function pickFolder() { try { var res = window.cep.fs.showOpenDialogEx(false, true, "Choose download folder", settings.dlFolder); if (res && res.data && res.data.length) { settings.dlFolder = res.data[0]; $("dl-folder").value = settings.dlFolder; saveSettings(); } } catch (e) { toast("Folder picker unavailable.", "err"); } }
    function pickBg() { try { var res = window.cep.fs.showOpenDialogEx(false, false, "Choose background image", settings.dlFolder, ["png", "jpg", "jpeg", "webp", "gif", "bmp"]); if (res && res.data && res.data.length) { settings.bgPath = res.data[0]; $("bg-path").value = settings.bgPath; saveSettings(); applyBackground(); } } catch (e) { toast("Image picker unavailable.", "err"); } }
    function openURL(u) { try { if (window.cep && window.cep.util) window.cep.util.openURLInDefaultBrowser(u); } catch (e) {} }

    // =========================================================
    //  Graph (Flow-style easing editor)
    // =========================================================
    var GR_BUILTIN = [
        { name: "Linear", c: [0.33, 0.33, 0.66, 0.66] },
        { name: "Ease", c: [0.4, 0, 0.6, 1] },
        { name: "Ease In", c: [0.42, 0, 1, 1] },
        { name: "Ease Out", c: [0, 0, 0.58, 1] },
        { name: "Smooth", c: [0.45, 0.05, 0.55, 0.95] },
        { name: "Snappy", c: [0.85, 0, 0.15, 1] },
        { name: "Slow Mo", c: [0.7, 0, 0.3, 1] },
        { name: "Anticipate", c: [0.5, -0.25, 0.6, 1] },
        { name: "Overshoot", c: [0.35, 0, 0.35, 1.35] },
        { name: "Quick Out", c: [0.16, 1, 0.3, 1] }
    ];
    var grCurve = [0.4, 0, 0.6, 1], grDragH = 0, grReady = false;

    function grClamp01(n) { return Math.max(0, Math.min(1, n)); }
    function grClampY(n) { return Math.max(-0.3, Math.min(1.3, n)); }
    function grRound(n) { return Math.round(n * 100) / 100; }
    function grPx(nx) { return 40 + nx * 200; }
    function grPy(ny) { return 240 - ny * 200; }

    function grRender() {
        var c = grCurve, h1x = grPx(c[0]), h1y = grPy(c[1]), h2x = grPx(c[2]), h2y = grPy(c[3]);
        $("gr-c1").setAttribute("cx", h1x); $("gr-c1").setAttribute("cy", h1y);
        $("gr-c2").setAttribute("cx", h2x); $("gr-c2").setAttribute("cy", h2y);
        $("gr-h1").setAttribute("x2", h1x); $("gr-h1").setAttribute("y2", h1y);
        $("gr-h2").setAttribute("x2", h2x); $("gr-h2").setAttribute("y2", h2y);
        $("gr-curve").setAttribute("d", "M40 240 C " + h1x + " " + h1y + " " + h2x + " " + h2y + " 240 40");
        if (document.activeElement !== $("gr-x1")) $("gr-x1").value = grRound(c[0]);
        if (document.activeElement !== $("gr-y1")) $("gr-y1").value = grRound(c[1]);
        if (document.activeElement !== $("gr-x2")) $("gr-x2").value = grRound(c[2]);
        if (document.activeElement !== $("gr-y2")) $("gr-y2").value = grRound(c[3]);
        grHighlightPreset();
        settings.graphCurve = grCurve.slice();
    }
    function grSvgPoint(evt) {
        var svg = $("gr-svg"), pt = svg.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY;
        var ctm = svg.getScreenCTM(); if (!ctm) return null; return pt.matrixTransform(ctm.inverse());
    }
    function grMove(e) {
        if (!grDragH) return; var p = grSvgPoint(e); if (!p) return;
        var nx = grClamp01((p.x - 40) / 200), ny = grClampY((240 - p.y) / 200);
        if (grDragH === 1) { grCurve[0] = nx; grCurve[1] = ny; } else { grCurve[2] = nx; grCurve[3] = ny; }
        grRender();
    }
    function grEnd() {
        grDragH = 0; $("gr-c1").classList.remove("dragging"); $("gr-c2").classList.remove("dragging");
        document.removeEventListener("pointermove", grMove); document.removeEventListener("pointerup", grEnd);
        saveSettings();
    }
    function grStartDrag(h, e) {
        grDragH = h; e.preventDefault();
        $(h === 1 ? "gr-c1" : "gr-c2").classList.add("dragging");
        document.addEventListener("pointermove", grMove); document.addEventListener("pointerup", grEnd);
    }
    function grAllPresets() { return GR_BUILTIN.concat(settings.graphPresets || []); }
    function grMiniPath(c) {
        function mx(n) { return 4 + n * 32; } function my(n) { return 30 - n * 24; }
        return "M4 30 C " + mx(c[0]) + " " + my(c[1]) + " " + mx(c[2]) + " " + my(c[3]) + " 36 6";
    }
    function grRenderPresets() {
        var wrap = $("gr-presets"); wrap.innerHTML = "";
        grAllPresets().forEach(function (p, idx) {
            var isUser = idx >= GR_BUILTIN.length;
            var d = el("div", "gr-preset"); d.title = p.name;
            d.innerHTML = '<svg viewBox="0 0 40 36"><path class="gp-mini" d="' + grMiniPath(p.c) + '"/></svg>';
            var nm = el("span", "gp-name"); nm.textContent = p.name; d.appendChild(nm);
            d.onclick = function () { grCurve = p.c.slice(); grRender(); saveSettings(); };
            if (isUser) {
                var del = el("button", "gp-del"); del.innerHTML = "&times;"; del.title = "Delete preset";
                del.onclick = function (ev) { ev.stopPropagation(); settings.graphPresets.splice(idx - GR_BUILTIN.length, 1); saveSettings(); grRenderPresets(); };
                d.appendChild(del);
            }
            wrap.appendChild(d);
        });
        grHighlightPreset();
    }
    function grHighlightPreset() {
        var all = grAllPresets(), nodes = $("gr-presets").children;
        for (var i = 0; i < nodes.length; i++) {
            var c = all[i].c;
            var m = Math.abs(c[0] - grCurve[0]) < 0.006 && Math.abs(c[1] - grCurve[1]) < 0.006 && Math.abs(c[2] - grCurve[2]) < 0.006 && Math.abs(c[3] - grCurve[3]) < 0.006;
            nodes[i].classList.toggle("active", m);
        }
    }
    function grInputChange() {
        var x1 = parseFloat($("gr-x1").value), y1 = parseFloat($("gr-y1").value), x2 = parseFloat($("gr-x2").value), y2 = parseFloat($("gr-y2").value);
        if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) return;
        grCurve = [grClamp01(x1), grClampY(y1), grClamp01(x2), grClampY(y2)]; grRender();
    }
    function grSavePreset() {
        var name = ($("gr-name").value || "").trim();
        if (!name) { toast("Type a name for the preset.", "err"); return; }
        if (!settings.graphPresets) settings.graphPresets = [];
        var existing = -1;
        for (var i = 0; i < settings.graphPresets.length; i++) { if (settings.graphPresets[i].name.toLowerCase() === name.toLowerCase()) { existing = i; break; } }
        var item = { name: name, c: grCurve.slice() };
        if (existing >= 0) settings.graphPresets[existing] = item; else settings.graphPresets.push(item);
        saveSettings(); $("gr-name").value = ""; grRenderPresets(); toast("Preset saved.", "ok");
    }
    function grApply() {
        var c = grCurve, arg = [c[0], c[1], c[2], c[3]].join(HOST_SEP);
        cs.evalScript('acl_applyEase("' + jsEscape(arg) + '")', function (out) {
            var p = (out || "").split(HOST_SEP);
            if (p[0] === "OK") toast(p[3] || "Ease applied.", "ok");
            else toast(p[1] || out || "Couldn't apply the ease.", "err");
        });
    }
    function grInit() {
        if (grReady) return; grReady = true;
        if (settings.graphCurve && settings.graphCurve.length === 4) grCurve = settings.graphCurve.slice();
        $("gr-c1").addEventListener("pointerdown", function (e) { grStartDrag(1, e); });
        $("gr-c2").addEventListener("pointerdown", function (e) { grStartDrag(2, e); });
        ["gr-x1", "gr-y1", "gr-x2", "gr-y2"].forEach(function (id) { $(id).oninput = grInputChange; $(id).onchange = saveSettings; });
        $("gr-save").onclick = grSavePreset;
        $("gr-name").addEventListener("keydown", function (e) { if (e.key === "Enter") grSavePreset(); });
        $("gr-apply").onclick = grApply;
        grRenderPresets(); grRender();
    }

    // =========================================================
    //  Auto-update (panel side — hands the heavy work to the desktop app)
    // =========================================================
    function semverGt(a, b) {
        var pa = (a || "0").split("."), pb = (b || "0").split(".");
        for (var i = 0; i < 3; i++) { var x = parseInt(pa[i], 10) || 0, y = parseInt(pb[i], 10) || 0; if (x > y) return true; if (x < y) return false; }
        return false;
    }
    function extRoot() { try { return cs.getSystemPath(SystemPath.EXTENSION); } catch (e) { return null; } }
    function readUpdateCfg() { try { var r = extRoot(); return r ? JSON.parse(fs.readFileSync(path.join(r, "update.json"), "utf8")) : null; } catch (e) { return null; } }
    function kageShared() { return path.join(os.homedir(), "AppData", "Roaming", "KageStudio"); }
    var pendingUpdate = null;
    function checkForUpdate() {
        if (!_require || !fs || !path || !os) return;
        var cfg = readUpdateCfg(); if (!cfg || !cfg.repo || /replace|owner\//i.test(cfg.repo)) return;
        var feed = "https://raw.githubusercontent.com/" + cfg.repo + "/main/version.json?t=" + Date.now();
        request(feed).then(function (res) {
            if (res.status !== 200) return;
            var info; try { info = JSON.parse(res.body.toString("utf8")); } catch (e) { return; }
            if (info && info.version && semverGt(info.version, cfg.version || "0.0.0")) {
                if (!info.zip) info.zip = "https://github.com/" + cfg.repo + "/archive/refs/heads/main.zip";
                pendingUpdate = info;
                $("ub-sub").textContent = "v" + info.version + (info.notes ? " — " + info.notes : "");
                $("update-banner").classList.remove("hidden");
            }
        }).catch(function () {});
    }
    function startUpdate() {
        if (!pendingUpdate) return;
        var dir = kageShared(); ensureFolder(dir);
        try { fs.writeFileSync(path.join(dir, "update-request.json"), JSON.stringify({ version: pendingUpdate.version, zip: pendingUpdate.zip, notes: pendingUpdate.notes || "", at: Date.now() })); } catch (e) {}
        var appInfo = null; try { appInfo = JSON.parse(fs.readFileSync(path.join(dir, "app.json"), "utf8")); } catch (e) {}
        if (!appInfo || !appInfo.exe || !fs.existsSync(appInfo.exe)) { toast("Open the Kage Studio desktop app once to enable auto-updates.", "err"); return; }
        try {
            var child = child_process.spawn(appInfo.exe, ["--update"], { detached: true, stdio: "ignore" });
            child.unref();
            $("update-banner").classList.add("hidden");
            $("update-overlay").classList.remove("hidden");
        } catch (e) { toast("Couldn't launch the updater: " + e.message, "err"); }
    }

    // =========================================================
    //  Views
    // =========================================================
    function switchView(v) {
        activeView = v;
        Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) { t.classList.toggle("active", t.dataset.view === v); });
        $("view-clips").classList.toggle("hidden", v !== "clips");
        $("view-kaizen").classList.toggle("hidden", v !== "kaizen");
        $("view-graph").classList.toggle("hidden", v !== "graph");
        $("view-assets").classList.toggle("hidden", v !== "assets");
        if (v === "clips") footer.classList.toggle("hidden", !(pack && navStack.length));
        else if (v === "graph") { footer.classList.add("hidden"); grInit(); }
        else if (v === "kaizen") { footer.classList.add("hidden"); applyKzUI(); detectRifeModels(); refreshKzSelection(); }
        else if (v === "assets") {
            if (!asRoot && settings.assetsFolder) { asRoot = settings.assetsFolder; loadAssets(settings.assetsFolder); }
            else if (asRoot) renderAssets();
            else { footer.classList.add("hidden"); setStatus($("as-status"), "Choose a folder to browse its contents."); }
        }
        updateSelInfo();
    }

    // =========================================================
    //  Wire up + boot
    // =========================================================
    function bind() {
        $("btn-refresh").onclick = boot;
        $("btn-settings").onclick = openSettings;
        $("btn-closesettings-x").onclick = closeSettings;
        document.querySelector("#settings-panel .modal-backdrop").onclick = closeSettings;
        $("btn-pickfolder").onclick = pickFolder;
        $("btn-pickbg").onclick = pickBg;
        $("btn-clearbg").onclick = function () { settings.bgPath = ""; $("bg-path").value = ""; saveSettings(); applyBackground(); };
        $("bg-dim").oninput = function () { settings.bgDim = +this.value; applyBackground(); }; $("bg-dim").onchange = saveSettings;
        $("bg-blur").oninput = function () { settings.bgBlur = +this.value; applyBackground(); }; $("bg-blur").onchange = saveSettings;
        $("accent-color").oninput = function () { settings.accent = this.value; applyAccent(); refreshSwatches(); }; $("accent-color").onchange = saveSettings;
        $("accent-reset").onclick = function () { settings.accent = null; saveSettings(); applyAccent(); $("accent-color").value = DEFAULT_ACCENT; refreshSwatches(); };
        $("opt-openafter").onchange = function () { settings.openAfter = this.checked; saveSettings(); };
        $("btn-pickffmpeg").onclick = function () { pickInto("ffmpeg", "Select ffmpeg.exe", ["exe"], "ffmpeg-path"); };
        $("btn-pickesrgan").onclick = function () { pickInto("realesrgan", "Select realesrgan-ncnn-vulkan.exe", ["exe"], "realesrgan-path"); };
        $("btn-pickrife").onclick = function () { pickInto("rife", "Select rife-ncnn-vulkan.exe", ["exe"], "rife-path"); detectRifeModels(); };
        $("btn-setup-tools").onclick = setupTools;
        $("link-ffmpeg").onclick = function (e) { e.preventDefault(); openURL("https://www.gyan.dev/ffmpeg/builds/"); };
        $("link-esrgan").onclick = function (e) { e.preventDefault(); openURL("https://github.com/xinntao/Real-ESRGAN/releases"); };
        $("link-rife").onclick = function (e) { e.preventDefault(); openURL("https://github.com/nihui/rife-ncnn-vulkan/releases"); };

        $("btn-import").onclick = function () { if (activeView === "assets") importAssets(); else importSelection(); };
        $("btn-clearsel").onclick = function () { if (activeView === "assets") asClear(); else clearSelection(); };
        $("as-pick").onclick = pickAssetFolder;
        Array.prototype.forEach.call(document.querySelectorAll("#as-filters .chip"), function (chip) { chip.onclick = function () { Array.prototype.forEach.call(document.querySelectorAll("#as-filters .chip"), function (c) { c.classList.remove("active"); }); chip.classList.add("active"); asFilter = chip.dataset.cat; renderAssets(); }; });

        // Kaizen
        $("kz-tg-up").onclick = function () { kz.doUpscale = !kz.doUpscale; this.classList.toggle("active", kz.doUpscale); saveKz(); };
        $("kz-tg-in").onclick = function () { kz.doInterp = !kz.doInterp; this.classList.toggle("active", kz.doInterp); saveKz(); };
        $("kz-gear").onclick = function () { $("kz-options").classList.toggle("hidden"); this.classList.toggle("active"); };
        $("kz-refresh").onclick = refreshKzSelection;
        $("kz-run").onclick = runChain;
        Array.prototype.forEach.call(document.querySelectorAll("#up-scale button"), function (b) { b.onclick = function () { Array.prototype.forEach.call(document.querySelectorAll("#up-scale button"), function (x) { x.classList.remove("active"); }); b.classList.add("active"); kz.upScale = +b.dataset.s; saveKz(); }; });
        $("up-model").onchange = function () { kz.upModel = this.value; saveKz(); };
        $("up-sharp").oninput = function () { $("up-sharp-val").textContent = this.value + "%"; kz.upSharp = +this.value; }; $("up-sharp").onchange = saveKz;
        Array.prototype.forEach.call(document.querySelectorAll("#in-mult button"), function (b) {
            b.onclick = function () {
                if (b.dataset.m === "custom") { kz.inCustom = true; setMultActive("custom"); $("in-custom-row").classList.remove("hidden"); kz.inMult = +$("in-custom").value; }
                else { kz.inCustom = false; setMultActive(b.dataset.m); $("in-custom-row").classList.add("hidden"); kz.inMult = +b.dataset.m; }
                saveKz();
            };
        });
        $("in-custom").oninput = function () { $("in-custom-val").textContent = this.value + "×"; kz.inMult = +this.value; }; $("in-custom").onchange = saveKz;
        $("in-model").onchange = function () { kz.inModel = this.value; saveKz(); };

        Array.prototype.forEach.call(document.querySelectorAll(".tab"), function (t) { t.onclick = function () { switchView(t.dataset.view); }; });

        // update banner
        $("ub-update").onclick = startUpdate;
        $("ub-later").onclick = function () { $("update-banner").classList.add("hidden"); };

        // lightbox
        document.querySelector(".lb-prev").onclick = function () { lbStep(-1); };
        document.querySelector(".lb-next").onclick = function () { lbStep(1); };
        $("lb-close").onclick = closeLightbox;
        lb.querySelector(".lb-backdrop").onclick = closeLightbox;
        lbMute.onclick = function () { lbMuted = !lbMuted; lbVideo.muted = lbMuted; lbMute.classList.toggle("active", !lbMuted); lbMute.replaceChild(icon(lbMuted ? "mute" : "volume"), lbMute.firstChild); if (!lbMuted) lbVideo.play().catch(function () {}); };
        lbSelect.onclick = function () { var f = currentFiles[lbIndex]; if (f) toggleClip(f); };
        $("lb-import").onclick = function () { if (sel.order.length) importSelection(); else { var f = currentFiles[lbIndex]; if (f) importItems([{ id: f.id, name: f.name, ctx: pack, kind: "clip" }]); } closeLightbox(); };

        var lbWrap = lbVideo.parentElement, lbPP = $("lb-playpause"), lbSeek = $("lb-seek"), lbTime = $("lb-time"), lbDur = $("lb-dur"), lbSeeking = false;
        lbPP.onclick = function () { if (lbVideo.paused) lbVideo.play().catch(function () {}); else lbVideo.pause(); };
        lbVideo.addEventListener("play", function () { lbPP.replaceChild(icon("pause"), lbPP.firstChild); lbWrap.classList.remove("paused"); });
        lbVideo.addEventListener("pause", function () { lbPP.replaceChild(icon("play"), lbPP.firstChild); lbWrap.classList.add("paused"); });
        lbVideo.addEventListener("loadedmetadata", function () { lbDur.textContent = fmtT(lbVideo.duration); lbSeek.value = 0; lbTime.textContent = "0:00"; });
        lbVideo.addEventListener("timeupdate", function () { if (lbVideo.duration) { if (!lbSeeking) lbSeek.value = Math.round(lbVideo.currentTime / lbVideo.duration * 1000); lbTime.textContent = fmtT(lbVideo.currentTime); } });
        lbSeek.addEventListener("input", function () { lbSeeking = true; if (lbVideo.duration) lbVideo.currentTime = (lbSeek.value / 1000) * lbVideo.duration; });
        lbSeek.addEventListener("change", function () { lbSeeking = false; });

        document.addEventListener("keydown", function (e) {
            if (lb.classList.contains("hidden")) return;
            if (e.key === "Escape") { closeLightbox(); return; }
            if (lbMode === "clip" && e.key === "ArrowRight") { lbStep(1); e.preventDefault(); }
            else if (lbMode === "clip" && e.key === "ArrowLeft") { lbStep(-1); e.preventDefault(); }
            else if (e.key === " " && lbMode !== "image") { if (lbVideo.paused) lbVideo.play().catch(function () {}); else lbVideo.pause(); e.preventDefault(); }
        });

        var searchBox = $("search"), t = null;
        searchBox.oninput = function () { clearTimeout(t); t = setTimeout(function () { searchTerm = searchBox.value.trim(); if (!pack) renderLibrary(); }, 170); };
        Array.prototype.forEach.call(document.querySelectorAll("#filters .chip"), function (chip) { chip.onclick = function () { Array.prototype.forEach.call(document.querySelectorAll("#filters .chip"), function (c) { c.classList.remove("active"); }); chip.classList.add("active"); filter = chip.dataset.filter; if (!pack) renderLibrary(); }; });

        $("brand-logo").onerror = function () { var s = el("span", "brand-name"); s.textContent = "K"; s.style.color = "var(--accent)"; this.replaceWith(s); };
        $("splash-logo").onerror = function () { this.classList.add("hidden"); $("splash-fallback").classList.remove("hidden"); };
    }

    function hideSplash() { var sp = $("splash"); sp.classList.add("gone"); setTimeout(function () { sp.style.display = "none"; }, 600); }

    function readSharedSession() {
        try { var sp = path.join(os.homedir(), "AppData", "Roaming", "KageStudio", "session.json"); return JSON.parse(fs.readFileSync(sp, "utf8")); } catch (e) { return null; }
    }
    function showAccount() {
        var ses = readSharedSession(); var a = $("acct"); if (!a) return;
        if (ses && ses.username) { a.textContent = "@" + ses.username; a.classList.remove("hidden"); a.title = ses.email || ""; }
        else a.classList.add("hidden");
    }

    function boot() {
        applyAccent(); applyBackground(); applyKzUI();
        if (fs && os && path) { showAccount(); checkForUpdate(); }
        if (!_require || !NodeBuffer) { setStatus(statusEl, "This panel needs Node access — run it inside After Effects.", true); hideSplash(); return; }
        pack = null; navStack = []; currentFiles = []; sel = { map: {}, order: [] };
        breadcrumb.classList.add("hidden"); footer.classList.add("hidden"); grid.innerHTML = "";
        setStatus(statusEl, "Loading library…");
        getLibrary().then(function (libData) { library.movies = libData.movies || []; library.series = libData.series || []; renderLibrary(); setTimeout(hideSplash, 500); })
            .catch(function (err) { setStatus(statusEl, "Couldn't load the library: " + err.message, true); setTimeout(hideSplash, 500); });
    }

    bind(); boot();
})();

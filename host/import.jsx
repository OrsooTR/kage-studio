/*
 * Anime Clips Loader — ExtendScript host
 * Imports downloaded clip files into the project and onto the active comp's timeline.
 *
 * Note: AE's ExtendScript has no native JSON, so the panel and host talk through a
 * simple -delimited string protocol instead.
 */

var ACL_SEP = String.fromCharCode(1);

function acl_importClips(joined) {
    var status = "ERR", count = 0, addedToComp = 0, message = "";
    try {
        var paths = [];
        if (joined && joined.length) {
            var raw = joined.split(ACL_SEP);
            for (var k = 0; k < raw.length; k++) { if (raw[k] && raw[k].length) paths.push(raw[k]); }
        }
        if (!paths.length) { return "ERR" + ACL_SEP + "0" + ACL_SEP + "0" + ACL_SEP + "No files to import."; }

        var proj = app.project;
        if (!proj) { return "ERR" + ACL_SEP + "0" + ACL_SEP + "0" + ACL_SEP + "No project open."; }

        var comp = (proj.activeItem && proj.activeItem instanceof CompItem) ? proj.activeItem : null;

        app.beginUndoGroup("Import Anime Clips");

        // Keep imported footage in a tidy folder.
        var folder = null;
        for (var f = 1; f <= proj.numItems; f++) {
            var it = proj.item(f);
            if (it instanceof FolderItem && it.name === "Anime Clips") { folder = it; break; }
        }
        if (!folder) folder = proj.items.addFolder("Anime Clips");

        var startTime = comp ? comp.time : 0;
        for (var i = 0; i < paths.length; i++) {
            var file = new File(paths[i]);
            if (!file.exists) continue;
            var io = new ImportOptions(file);
            if (!io.canImportAs(ImportAsType.FOOTAGE)) continue;
            io.importAs = ImportAsType.FOOTAGE;
            var item = proj.importFile(io);
            item.parentFolder = folder;
            count++;
            if (comp) {
                var layer = comp.layers.add(item);
                // Lay clips out one after another from the current time, instead of stacking them.
                try { layer.startTime = startTime; startTime += (layer.outPoint - layer.inPoint); } catch (e) {}
                addedToComp = 1;
            }
        }

        app.endUndoGroup();

        status = "OK";
        message = "Imported " + count + " clip" + (count === 1 ? "" : "s") +
            (comp ? " onto comp \"" + comp.name + "\"." :
                " into the project (open or select a composition to drop them on the timeline).");
        return status + ACL_SEP + count + ACL_SEP + addedToComp + ACL_SEP + message;
    } catch (err) {
        return "ERR" + ACL_SEP + count + ACL_SEP + addedToComp + ACL_SEP + ("Error: " + err.toString());
    }
}

function acl_hasActiveComp() {
    try {
        return (app.project && app.project.activeItem && app.project.activeItem instanceof CompItem)
            ? app.project.activeItem.name : "";
    } catch (e) { return ""; }
}

// Find the composition to operate on: the active comp, else a selected comp in the project.
function acl_pickComp() {
    var p = app.project; if (!p) return null;
    if (p.activeItem && p.activeItem instanceof CompItem) return p.activeItem;
    for (var i = 1; i <= p.numItems; i++) { var it = p.item(i); if (it.selected && it instanceof CompItem) return it; }
    return null;
}

// Report the current selection for the Interpolate tab. Returns type|display|compName or "".
function acl_getSelection() {
    try {
        var comp = acl_pickComp();
        if (!comp) return "";
        if (comp === app.project.activeItem) {
            var sl = comp.selectedLayers;
            if (sl && sl.length) return "layer" + ACL_SEP + sl[0].name + ACL_SEP + comp.name;
        }
        return "comp" + ACL_SEP + comp.name + ACL_SEP + comp.name;
    } catch (e) { return ""; }
}

// Render ONLY the selected clip's time span (not the whole comp) using AE's DEFAULT output module
// (locale-independent — no format string to get wrong). We read back the real file AE writes and let
// ffmpeg decode whatever it is. outBase is a path with no extension.
// Returns OK|fps|frames|spanStart|compId|compName|renderedPath  or  ERR|msg.
function acl_renderSelected(outBase) {
    try {
        var comp = acl_pickComp();
        if (!comp) return "ERR" + ACL_SEP + "Select a composition (or a clip inside one) in After Effects first.";

        // Limit the render to the selected layer(s) span; otherwise the whole comp duration.
        var spanStart = 0, spanDur = comp.duration;
        if (comp === app.project.activeItem) {
            var sl = comp.selectedLayers;
            if (sl && sl.length) {
                var mn = sl[0].inPoint, mx = sl[0].outPoint;
                for (var k = 1; k < sl.length; k++) { if (sl[k].inPoint < mn) mn = sl[k].inPoint; if (sl[k].outPoint > mx) mx = sl[k].outPoint; }
                if (mx > mn) { spanStart = mn; spanDur = mx - mn; }
            }
        }

        var rq = app.project.renderQueue;
        var saved = [];
        for (var q = 1; q <= rq.numItems; q++) {
            var item = rq.item(q);
            try { if (item.status === RQItemStatus.QUEUED) { item.render = false; saved.push(item); } } catch (e) {}
        }

        var rqi = rq.items.add(comp);
        // Render only the clip's span — no need to touch the comp's work area.
        try { rqi.timeSpanStart = spanStart; rqi.timeSpanDuration = spanDur; } catch (e) {}

        // Use the default output module as-is (Lossless, RGB). AE normalises the filename + extension.
        var om = rqi.outputModule(1);
        om.file = new File(outBase);
        var actual = om.file.fsName;
        rqi.render = true;

        app.project.renderQueue.render();

        for (var s = 0; s < saved.length; s++) { try { saved[s].render = true; } catch (e) {} }
        try { rqi.remove(); } catch (e) {}

        return "OK" + ACL_SEP + comp.frameRate + ACL_SEP + Math.round(spanDur * comp.frameRate) + ACL_SEP + spanStart + ACL_SEP + comp.id + ACL_SEP + comp.name + ACL_SEP + actual;
    } catch (err) {
        return "ERR" + ACL_SEP + err.toString();
    }
}

// Import the interpolated file and place it on the source comp at the original clip's start time.
// arg = filepath  compId  startTime  (-joined). Returns OK|imported|added|message.
function acl_placeClip(arg) {
    try {
        var parts = (arg || "").split(ACL_SEP);
        var file = parts[0], compId = parseInt(parts[1] || "0", 10), startTime = parseFloat(parts[2] || "0");
        var f = new File(file);
        if (!f.exists) return "ERR" + ACL_SEP + "0" + ACL_SEP + "0" + ACL_SEP + "Rendered file not found.";

        app.beginUndoGroup("Place interpolated clip");
        var io = new ImportOptions(f);
        if (!io.canImportAs(ImportAsType.FOOTAGE)) { app.endUndoGroup(); return "ERR" + ACL_SEP + "0" + ACL_SEP + "0" + ACL_SEP + "Couldn't import the result."; }
        io.importAs = ImportAsType.FOOTAGE;
        var item = app.project.importFile(io);

        var folder = null;
        for (var i = 1; i <= app.project.numItems; i++) { var it = app.project.item(i); if (it instanceof FolderItem && it.name === "Anime Clips") { folder = it; break; } }
        if (!folder) folder = app.project.items.addFolder("Anime Clips");
        item.parentFolder = folder;

        var comp = null;
        for (var j = 1; j <= app.project.numItems; j++) { var c = app.project.item(j); if (c instanceof CompItem && c.id === compId) { comp = c; break; } }
        if (comp) {
            var layer = comp.layers.add(item);
            try { layer.startTime = startTime; } catch (e) {}
            app.endUndoGroup();
            return "OK" + ACL_SEP + "1" + ACL_SEP + "1" + ACL_SEP + ("Placed on \"" + comp.name + "\" at " + startTime.toFixed(2) + "s.");
        }
        app.endUndoGroup();
        return "OK" + ACL_SEP + "1" + ACL_SEP + "0" + ACL_SEP + "Imported (original comp not found — added to the project).";
    } catch (err) {
        return "ERR" + ACL_SEP + "0" + ACL_SEP + "0" + ACL_SEP + ("Error: " + err.toString());
    }
}

// =====================================================================
//  Graph (Flow-style easing) — apply a cubic-bezier ease to the
//  currently selected keyframes, exactly like the Flow plugin.
//  arg = "x1 SEP y1 SEP x2 SEP y2"  (normalized control points of the
//  cubic bezier P0(0,0) .. P1(x1,y1) .. P2(x2,y2) .. P3(1,1)).
//  Returns OK|props|keys|message  or  ERR|message.
// =====================================================================
function acl_clampInf(v) { return Math.max(0.1, Math.min(100, v)); }

function acl_easeProp(prop, sel, x1, y1, x2, y2) {
    // ease each consecutive pair of selected keyframes
    sel.sort(function (a, b) { return a - b; });
    var changed = 0;
    for (var i = 0; i < sel.length - 1; i++) {
        var k1 = sel[i], k2 = sel[i + 1];
        var t1 = prop.keyTime(k1), t2 = prop.keyTime(k2), dt = t2 - t1;
        if (dt <= 0) continue;
        var v1 = prop.keyValue(k1), v2 = prop.keyValue(k2);

        // need bezier interpolation for the eases to take effect
        try { prop.setInterpolationTypeAtKey(k1, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER); } catch (e) {}
        try { prop.setInterpolationTypeAtKey(k2, KeyframeInterpolationType.BEZIER, KeyframeInterpolationType.BEZIER); } catch (e) {}

        // how many temporal-ease dimensions this property uses
        // (1 for spatial / 1-D, N for separated/multi-D value graphs)
        var teDim = 1, curIn1 = null, curOut2 = null;
        try { curIn1 = prop.keyInTemporalEase(k1); teDim = curIn1.length; } catch (e) { teDim = 1; }
        try { curOut2 = prop.keyOutTemporalEase(k2); } catch (e) {}

        var outInfluence = acl_clampInf(x1 * 100);
        var inInfluence = acl_clampInf((1 - x2) * 100);
        var slopeOut = y1 / x1;            // tangent of the bezier at the start
        var slopeIn = (1 - y2) / (1 - x2); // tangent at the end

        var inEase1 = [], outEase1 = [], inEase2 = [], outEase2 = [];
        for (var d = 0; d < teDim; d++) {
            var rate;
            if (teDim === 1) {
                if (v1 instanceof Array) {       // spatial / multi-D collapsed to one speed graph -> use magnitude
                    var s = 0; for (var j = 0; j < v1.length; j++) { var dd = v2[j] - v1[j]; s += dd * dd; }
                    rate = Math.sqrt(s) / dt;
                } else { rate = (v2 - v1) / dt; }
            } else { rate = (v2[d] - v1[d]) / dt; }

            outEase1[d] = new KeyframeEase(rate * slopeOut, outInfluence);
            inEase2[d] = new KeyframeEase(rate * slopeIn, inInfluence);
            // keep the untouched side of each keyframe as it was
            inEase1[d] = (curIn1 && curIn1[d]) ? curIn1[d] : new KeyframeEase(0, outInfluence);
            outEase2[d] = (curOut2 && curOut2[d]) ? curOut2[d] : new KeyframeEase(0, inInfluence);
        }
        try { prop.setTemporalEaseAtKey(k1, inEase1, outEase1); } catch (e) {}
        try { prop.setTemporalEaseAtKey(k2, inEase2, outEase2); } catch (e) {}
        changed += 2;
    }
    return changed;
}

function acl_collectProps(propGroup, out) {
    for (var i = 1; i <= propGroup.numProperties; i++) {
        var p = propGroup.property(i);
        if (p.selected && p.propertyType === PropertyType.PROPERTY) { out.push(p); }
        if (p.numProperties && p.numProperties > 0) acl_collectProps(p, out);
    }
}

function acl_applyEase(arg) {
    try {
        var parts = (arg || "").split(ACL_SEP);
        var x1 = parseFloat(parts[0]), y1 = parseFloat(parts[1]), x2 = parseFloat(parts[2]), y2 = parseFloat(parts[3]);
        if (isNaN(x1) || isNaN(y1) || isNaN(x2) || isNaN(y2)) return "ERR" + ACL_SEP + "Invalid curve.";
        x1 = Math.max(0.0001, Math.min(0.9999, x1));
        x2 = Math.max(0.0001, Math.min(0.9999, x2));

        var comp = app.project ? app.project.activeItem : null;
        if (!comp || !(comp instanceof CompItem)) return "ERR" + ACL_SEP + "Open the composition with your keyframes and make it active.";
        var layers = comp.selectedLayers;
        if (!layers || !layers.length) return "ERR" + ACL_SEP + "Select the layer(s) and the keyframes you want to ease.";

        app.beginUndoGroup("Apply Kage ease");
        var props = [], touchedProps = 0, touchedKeys = 0;
        for (var L = 0; L < layers.length; L++) {
            var lp = layers[L].selectedProperties;
            // selectedProperties already gives the selected leaf props, but use the explicit
            // collector as a fallback for groups
            if (lp && lp.length) { for (var s = 0; s < lp.length; s++) { if (lp[s].propertyType === PropertyType.PROPERTY) props.push(lp[s]); } }
        }
        for (var P = 0; P < props.length; P++) {
            var prop = props[P];
            try {
                if (!prop.canVaryOverTime || prop.numKeys < 2) continue;
                var sel = prop.selectedKeys;
                if (!sel || sel.length < 2) continue;
                var did = acl_easeProp(prop, sel, x1, y1, x2, y2);
                if (did) { touchedProps++; touchedKeys += did; }
            } catch (e) {}
        }
        app.endUndoGroup();

        if (!touchedProps) return "ERR" + ACL_SEP + "No property with 2+ selected keyframes. Click the keyframes in the timeline first, then Apply.";
        return "OK" + ACL_SEP + touchedProps + ACL_SEP + touchedKeys + ACL_SEP +
            ("Eased " + touchedKeys + " keyframe" + (touchedKeys === 1 ? "" : "s") + " on " + touchedProps + " propert" + (touchedProps === 1 ? "y" : "ies") + ".");
    } catch (err) {
        try { app.endUndoGroup(); } catch (e) {}
        return "ERR" + ACL_SEP + ("Error: " + err.toString());
    }
}

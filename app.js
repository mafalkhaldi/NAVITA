/* NAVITAEDU Tools - client-side PDF utilities
   Libraries (loaded in index.html):
     - pdf.js  (window.pdfjsLib)
     - pdf-lib (window.PDFLib)
*/

(function () {
  "use strict";

  // Configure pdf.js worker (matches the CDN version in index.html)
  if (window.pdfjsLib) {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }

  var TARGET_BYTES = 8 * 1024 * 1024; // 8 MB

  // ---------- Sidebar menu switching ----------
  var menuItems = document.querySelectorAll(".menu-item");
  var tools = document.querySelectorAll(".tool");

  menuItems.forEach(function (item) {
    item.addEventListener("click", function () {
      var target = item.getAttribute("data-tool");
      menuItems.forEach(function (m) { m.classList.remove("active"); });
      item.classList.add("active");
      tools.forEach(function (t) { t.classList.remove("active"); });
      document.getElementById("tool-" + target).classList.add("active");
    });
  });

  // ---------- Helpers ----------
  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  function setProgress(tool, pct, text) {
    var box = document.getElementById("progress-" + tool);
    box.hidden = false;
    document.getElementById("fill-" + tool).style.width = Math.max(0, Math.min(100, pct)) + "%";
    document.getElementById("status-" + tool).textContent = text || "";
  }

  function clearResult(tool) {
    document.getElementById("result-" + tool).innerHTML = "";
  }

  function showError(tool, msg) {
    document.getElementById("result-" + tool).innerHTML =
      '<p class="error">' + msg + "</p>";
  }

  function showDownload(tool, blob, filename, metaText) {
    var url = URL.createObjectURL(blob);
    var res = document.getElementById("result-" + tool);
    res.innerHTML =
      '<a class="download" href="' + url + '" download="' + filename + '">' +
      "&#8681; Download " + filename + "</a>" +
      (metaText ? '<p class="meta">' + metaText + "</p>" : "");
  }

  // Wire a dropzone + file input. onPick(files) receives a FileList.
  function wireDropzone(tool, onPick) {
    var drop = document.getElementById("drop-" + tool);
    var input = document.getElementById("file-" + tool);
    var nameEl = document.getElementById("name-" + tool);

    input.addEventListener("change", function () {
      onPick(input.files);
      showNames(nameEl, input.files);
    });

    ["dragenter", "dragover"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault();
        drop.classList.add("dragover");
      });
    });
    ["dragleave", "drop"].forEach(function (ev) {
      drop.addEventListener(ev, function (e) {
        e.preventDefault();
        drop.classList.remove("dragover");
      });
    });
    drop.addEventListener("drop", function (e) {
      var files = e.dataTransfer.files;
      input.files = files;
      onPick(files);
      showNames(nameEl, files);
    });
  }

  function showNames(el, files) {
    if (!files || !files.length) { el.textContent = ""; return; }
    if (files.length === 1) { el.textContent = files[0].name; return; }
    el.textContent = files.length + " files selected";
  }

  // ============================================================
  // TOOL 1 - COMPRESS PDF
  // ============================================================
  var compressFiles = null;
  wireDropzone("compress", function (files) {
    compressFiles = files && files.length ? files : null;
    clearResult("compress");
  });

  document.getElementById("run-compress").addEventListener("click", function () {
    if (!compressFiles || !compressFiles[0]) {
      showError("compress", "Please choose a PDF first.");
      return;
    }
    compressPdf(compressFiles[0]);
  });

  async function compressPdf(file) {
    var btn = document.getElementById("run-compress");
    btn.disabled = true;
    clearResult("compress");

    try {
      var originalSize = file.size;
      setProgress("compress", 2, "Reading PDF (" + fmtSize(originalSize) + ")...");

      var arrayBuffer = await file.arrayBuffer();

      // If already small enough, no need to process.
      if (originalSize <= TARGET_BYTES) {
        setProgress("compress", 100, "Already under 8 MB - no compression needed.");
        showDownload("compress", new Blob([arrayBuffer], { type: "application/pdf" }),
          renamed(file.name, "compressed"),
          "Original: " + fmtSize(originalSize) + " (left unchanged).");
        btn.disabled = false;
        return;
      }

      // Quality/scale steps to try, from best to most aggressive.
      var steps = [
        { scale: 1.5, quality: 0.7 },
        { scale: 1.3, quality: 0.6 },
        { scale: 1.1, quality: 0.5 },
        { scale: 1.0, quality: 0.45 },
        { scale: 0.85, quality: 0.4 },
        { scale: 0.7, quality: 0.35 },
        { scale: 0.6, quality: 0.3 }
      ];

      var bestBlob = null;
      for (var s = 0; s < steps.length; s++) {
        var label = "Attempt " + (s + 1) + " of " + steps.length +
          " (scale " + steps[s].scale + ", quality " + steps[s].quality + ")";
        var blob = await renderToPdf(arrayBuffer.slice(0), steps[s], "compress",
          (s / steps.length), (1 / steps.length), label);
        bestBlob = blob;
        if (blob.size <= TARGET_BYTES) break;
      }

      setProgress("compress", 100, "Done.");
      var ok = bestBlob.size <= TARGET_BYTES;
      showDownload("compress", bestBlob, renamed(file.name, "compressed"),
        "Original: " + fmtSize(originalSize) + " &rarr; Compressed: " + fmtSize(bestBlob.size) +
        (ok ? " (under 8 MB)." :
          " (smallest achievable; still above 8 MB - try a PDF with fewer/larger images)."));
    } catch (err) {
      console.error(err);
      showError("compress", "Could not compress this PDF: " + err.message);
      setProgress("compress", 0, "Failed.");
    } finally {
      btn.disabled = false;
    }
  }

  // Render every page with pdf.js to a canvas, re-encode as JPEG, rebuild PDF with pdf-lib.
  async function renderToPdf(buffer, opts, tool, baseFrac, spanFrac, label) {
    var loadingTask = pdfjsLib.getDocument({ data: buffer });
    var pdf = await loadingTask.promise;
    var numPages = pdf.numPages;

    var outDoc = await PDFLib.PDFDocument.create();

    for (var p = 1; p <= numPages; p++) {
      var page = await pdf.getPage(p);
      var viewport = page.getViewport({ scale: opts.scale });

      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      var ctx = canvas.getContext("2d");
      // White background so transparent areas don't turn black in JPEG.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport: viewport }).promise;

      var dataUrl = canvas.toDataURL("image/jpeg", opts.quality);
      var jpgBytes = dataUrlToBytes(dataUrl);
      var img = await outDoc.embedJpg(jpgBytes);
      var newPage = outDoc.addPage([canvas.width, canvas.height]);
      newPage.drawImage(img, { x: 0, y: 0, width: canvas.width, height: canvas.height });

      var frac = baseFrac + spanFrac * (p / numPages);
      setProgress(tool, 5 + frac * 90, label + " - page " + p + "/" + numPages);

      // free canvas
      canvas.width = canvas.height = 0;
    }

    var bytes = await outDoc.save();
    return new Blob([bytes], { type: "application/pdf" });
  }

  function dataUrlToBytes(dataUrl) {
    var base64 = dataUrl.split(",")[1];
    var binary = atob(base64);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function renamed(name, suffix) {
    var dot = name.lastIndexOf(".");
    var base = dot > -1 ? name.slice(0, dot) : name;
    return base + "-" + suffix + ".pdf";
  }

  // ============================================================
  // TOOL 2 - MERGE PDF
  // ============================================================
  var mergeFiles = null;
  wireDropzone("merge", function (files) {
    mergeFiles = files && files.length ? files : null;
    clearResult("merge");
  });

  document.getElementById("run-merge").addEventListener("click", function () {
    if (!mergeFiles || mergeFiles.length < 1) {
      showError("merge", "Please choose at least one PDF.");
      return;
    }
    mergePdfs(mergeFiles);
  });

  async function mergePdfs(files) {
    var btn = document.getElementById("run-merge");
    btn.disabled = true;
    clearResult("merge");

    try {
      var merged = await PDFLib.PDFDocument.create();
      var total = files.length;

      for (var i = 0; i < total; i++) {
        setProgress("merge", (i / total) * 90 + 5,
          "Adding " + files[i].name + " (" + (i + 1) + "/" + total + ")...");
        var buf = await files[i].arrayBuffer();
        var src = await PDFLib.PDFDocument.load(buf, { ignoreEncryption: true });
        var pages = await merged.copyPages(src, src.getPageIndices());
        pages.forEach(function (pg) { merged.addPage(pg); });
      }

      setProgress("merge", 95, "Saving merged PDF...");
      var bytes = await merged.save();
      var blob = new Blob([bytes], { type: "application/pdf" });

      setProgress("merge", 100, "Done.");
      showDownload("merge", blob, "merged.pdf",
        total + " files merged - " + fmtSize(blob.size) + ".");
    } catch (err) {
      console.error(err);
      showError("merge", "Could not merge these PDFs: " + err.message);
      setProgress("merge", 0, "Failed.");
    } finally {
      btn.disabled = false;
    }
  }

  // ============================================================
  // TOOL 3 - IMAGE TO PDF
  // ============================================================
  var imageFiles = null;
  wireDropzone("image", function (files) {
    imageFiles = files && files.length ? files : null;
    clearResult("image");
  });

  document.getElementById("run-image").addEventListener("click", function () {
    if (!imageFiles || imageFiles.length < 1) {
      showError("image", "Please choose at least one JPG or PNG image.");
      return;
    }
    imagesToPdf(imageFiles);
  });

  async function imagesToPdf(files) {
    var btn = document.getElementById("run-image");
    btn.disabled = true;
    clearResult("image");

    try {
      var doc = await PDFLib.PDFDocument.create();
      var total = files.length;

      for (var i = 0; i < total; i++) {
        var f = files[i];
        setProgress("image", (i / total) * 90 + 5,
          "Adding " + f.name + " (" + (i + 1) + "/" + total + ")...");

        var buf = await f.arrayBuffer();
        var type = (f.type || "").toLowerCase();
        var img;
        if (type.indexOf("png") > -1 || /\.png$/i.test(f.name)) {
          img = await doc.embedPng(buf);
        } else if (type.indexOf("jpeg") > -1 || type.indexOf("jpg") > -1 || /\.jpe?g$/i.test(f.name)) {
          img = await doc.embedJpg(buf);
        } else {
          throw new Error("Unsupported image type: " + (f.name || type));
        }

        var page = doc.addPage([img.width, img.height]);
        page.drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
      }

      setProgress("image", 95, "Saving PDF...");
      var bytes = await doc.save();
      var blob = new Blob([bytes], { type: "application/pdf" });

      setProgress("image", 100, "Done.");
      showDownload("image", blob, "images.pdf",
        total + " image(s) - " + fmtSize(blob.size) + ".");
    } catch (err) {
      console.error(err);
      showError("image", "Could not build the PDF: " + err.message);
      setProgress("image", 0, "Failed.");
    } finally {
      btn.disabled = false;
    }
  }
})();

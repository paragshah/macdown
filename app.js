(function () {
  "use strict";

  // ---------- Elements ----------
  const dropzone = document.getElementById("dropzone");
  const output = document.getElementById("output");
  const fileInput = document.getElementById("fileInput");
  const browseBtn = document.getElementById("browseBtn");
  const sampleBtn = document.getElementById("sampleBtn");
  const newBtn = document.getElementById("newBtn");
  const themeToggle = document.getElementById("themeToggle");
  const overlay = document.getElementById("overlay");

  const ACCEPTED = /\.(md|markdown|mdown|mkd|txt)$/i;
  const MAX_BYTES = 5 * 1024 * 1024; // 5 MB

  // ---------- Theme ----------
  const THEME_KEY = "md-viewer-theme";
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
  }
  (function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (_) {}
    if (saved) {
      applyTheme(saved);
    } else {
      const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      applyTheme(prefersDark ? "dark" : "light");
    }
  })();
  themeToggle.addEventListener("click", function () {
    const current = document.documentElement.getAttribute("data-theme");
    applyTheme(current === "dark" ? "light" : "dark");
  });

  // ---------- Marked config ----------
  // marked v12 dropped the built-in `highlight` option, so we highlight
  // each code block ourselves after rendering (see render()).
  marked.setOptions({ gfm: true, breaks: false });

  // ---------- Rendering ----------
  function render(markdown, filename) {
    const rawHtml = marked.parse(markdown);
    const clean = DOMPurify.sanitize(rawHtml, {
      USE_PROFILES: { html: true },
      ADD_ATTR: ["target"],
    });
    output.innerHTML = clean;

    // Open external links in a new tab safely.
    output.querySelectorAll('a[href^="http"]').forEach(function (a) {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    });

    // Syntax-highlight each code block. Respect a `language-xxx` hint from
    // the fence when hljs knows it; otherwise auto-detect.
    output.querySelectorAll("pre code").forEach(function (block) {
      const match = /language-(\S+)/.exec(block.className || "");
      const lang = match && match[1];
      try {
        const result = lang && hljs.getLanguage(lang)
          ? hljs.highlight(block.textContent, { language: lang })
          : hljs.highlightAuto(block.textContent);
        block.innerHTML = result.value;
      } catch (_) { /* leave the code un-highlighted */ }
      block.classList.add("hljs");
    });

    if (filename) document.title = filename + " — Markdown Viewer";

    dropzone.hidden = true;
    output.hidden = false;
    newBtn.hidden = false;
    window.scrollTo({ top: 0, behavior: "auto" });
  }

  function readFile(file) {
    if (!file) return;
    if (!ACCEPTED.test(file.name) && file.type && !/text\//.test(file.type)) {
      showToast("Unsupported file type. Please choose a Markdown or text file.");
      return;
    }
    if (file.size > MAX_BYTES) {
      showToast("File is too large (max 5 MB).");
      return;
    }
    const reader = new FileReader();
    reader.onload = function (e) { render(String(e.target.result), file.name); };
    reader.onerror = function () { showToast("Could not read that file."); };
    reader.readAsText(file);
  }

  // ---------- File input / browse ----------
  function openPicker() { fileInput.click(); }
  browseBtn.addEventListener("click", function (e) { e.stopPropagation(); openPicker(); });
  dropzone.addEventListener("click", openPicker);
  dropzone.addEventListener("keydown", function (e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPicker(); }
  });
  fileInput.addEventListener("change", function () {
    if (fileInput.files && fileInput.files[0]) readFile(fileInput.files[0]);
    fileInput.value = ""; // allow re-selecting the same file
  });

  newBtn.addEventListener("click", function () {
    output.hidden = true;
    output.innerHTML = "";
    dropzone.hidden = false;
    newBtn.hidden = true;
    document.title = "Markdown Viewer";
  });

  // ---------- Drag & drop (whole window) ----------
  let dragDepth = 0;

  function hasFiles(e) {
    return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], "Files") !== -1;
  }

  window.addEventListener("dragenter", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    overlay.hidden = false;
    dropzone.classList.add("is-dragover");
  });
  window.addEventListener("dragover", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  });
  window.addEventListener("dragleave", function (e) {
    if (!hasFiles(e)) return;
    dragDepth--;
    if (dragDepth <= 0) {
      dragDepth = 0;
      overlay.hidden = true;
      dropzone.classList.remove("is-dragover");
    }
  });
  window.addEventListener("drop", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    dropzone.classList.remove("is-dragover");
    const dt = e.dataTransfer;
    if (dt.files && dt.files[0]) readFile(dt.files[0]);
  });

  // ---------- Toast ----------
  let toastEl, toastTimer;
  function showToast(msg) {
    if (!toastEl) {
      toastEl = document.createElement("div");
      toastEl.className = "toast";
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    // force reflow so the transition replays
    void toastEl.offsetWidth;
    toastEl.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove("is-visible");
    }, 3200);
  }

  // ---------- Sample ----------
  sampleBtn.addEventListener("click", function () {
    render(SAMPLE_MD, "sample.md");
  });

  // ---------- Load from ?src= URL parameter ----------
  // Lets a CLI wrapper open a specific file, e.g. index.html?src=doc.md
  // Only works over http(s): browsers block fetch() of file:// URLs.
  (function loadFromQuery() {
    const src = new URLSearchParams(window.location.search).get("src");
    if (!src) return;
    fetch(src)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.text();
      })
      .then(function (text) {
        const name = decodeURIComponent(src.split("/").pop());
        render(text, name);
      })
      .catch(function () {
        showToast("Could not load \"" + src + "\".");
      });
  })();

  const SAMPLE_MD = [
    "# Markdown Viewer",
    "",
    "A fast, GitHub-flavored Markdown renderer that runs **entirely in your browser**. Nothing is uploaded to a server.",
    "",
    "## Features",
    "",
    "- Renders [GitHub Flavored Markdown](https://github.github.com/gfm/)",
    "- Syntax-highlighted code blocks",
    "- Light and dark themes",
    "- Drag-and-drop or click to upload",
    "- [x] Task lists",
    "- [ ] ...and unchecked items",
    "",
    "## Code",
    "",
    "```js",
    "function greet(name) {",
    "  return `Hello, ${name}!`;",
    "}",
    "console.log(greet(\"world\"));",
    "```",
    "",
    "## Table",
    "",
    "| Language | Typed | Year |",
    "| -------- | :---: | ---: |",
    "| JavaScript | No | 1995 |",
    "| TypeScript | Yes | 2012 |",
    "| Rust | Yes | 2010 |",
    "",
    "## Blockquote",
    "",
    "> \"Simplicity is the soul of efficiency.\"",
    "> — Austin Freeman",
    "",
    "---",
    "",
    "Press <kbd>Choose file</kbd> or just drop a `.md` file anywhere on the page.",
  ].join("\n");
})();

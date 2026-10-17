// "TaleSpire mod" panel (desktop app only): find the TaleSpire install, show what's set up,
// and install / update / remove the exporter mod. The work happens in Rust
// (app/src-tauri/src/mod_installer.rs); this is just the UI around those commands.

const PATH_KEY = "tsmap-talespire-path";

export function initModPanel({ tauri, showToast }) {
  const $ = (id) => document.getElementById(id);
  const panel = $("mod-panel");
  const pathInput = $("mod-path");
  const statusList = $("mod-status");
  const launchBox = $("mod-launch");
  const launchText = $("mod-launch-text");
  const installBtn = $("mod-install");
  const removeBtn = $("mod-remove");
  const logEl = $("mod-log");
  const invoke = (cmd, args) => tauri.core.invoke(cmd, args);

  let status = null;
  let busy = false;

  const savedPath = () => {
    try {
      return localStorage.getItem(PATH_KEY) || "";
    } catch {
      return "";
    }
  };
  const savePath = (p) => {
    try {
      localStorage.setItem(PATH_KEY, p);
    } catch {}
  };

  function line(kind, text) {
    const li = document.createElement("li");
    li.className = kind; // ok | todo | warn | bad
    li.textContent = text;
    statusList.appendChild(li);
  }

  function render() {
    statusList.innerHTML = "";
    launchBox.classList.add("hidden");
    const s = status;
    if (!s || !pathInput.value.trim()) {
      line("todo", "Choose your TaleSpire folder: Detect, or Browse… to pick it.");
      installBtn.disabled = true;
      removeBtn.disabled = true;
      return;
    }
    if (!s.valid) {
      line("bad", `Not a TaleSpire folder: it should contain ${s.platform === "macos" ? "TaleSpire.app" : "TaleSpire.exe"}.`);
      installBtn.disabled = true;
      removeBtn.disabled = true;
      return;
    }
    line("ok", "TaleSpire found.");
    line(s.bepinex ? "ok" : "todo", s.bepinex ? "BepInEx (mod loader) installed." : "BepInEx (mod loader) will be downloaded and installed.");

    const v = s.installed_version;
    if (!v) line("todo", `Mod not installed yet (v${s.bundled_version} is included with this app).`);
    else if (v === s.bundled_version) line("ok", `Mod v${v} installed - up to date.`);
    else line("warn", `Mod v${v} installed - update to v${s.bundled_version} available.`);

    if (s.platform === "macos") {
      if (s.launch_option_set) line("ok", "Steam launch option set.");
      else {
        line("warn", "Steam launch option needed (one-time step below).");
        launchBox.classList.remove("hidden");
      }
      launchText.textContent = s.launch_option ?? "";
    }
    if (s.game_running) {
      line("warn", s.platform === "windows" ? "TaleSpire is running - close it before installing." : "TaleSpire is running - restart it after installing.");
    }

    installBtn.textContent = !v ? "Install mod" : v === s.bundled_version ? "Reinstall mod" : "Update mod";
    installBtn.disabled = busy || (s.platform === "windows" && s.game_running);
    removeBtn.disabled = busy || !v;
    disarmRemove();
  }

  async function refresh() {
    const p = pathInput.value.trim();
    status = p ? await invoke("talespire_status", { path: p }).catch(() => null) : null;
    if (status?.valid) {
      pathInput.value = status.game_path;
      savePath(status.game_path);
    }
    render();
    return status;
  }

  function setLog(lines, error = false) {
    logEl.textContent = lines.join("\n");
    logEl.classList.toggle("error", error);
    logEl.classList.toggle("hidden", lines.length === 0);
  }

  async function detect({ quiet = false } = {}) {
    const found = await invoke("talespire_detect").catch(() => null);
    if (found) {
      pathInput.value = found;
      await refresh();
      if (!quiet) setLog([`Found TaleSpire: ${found}`]);
    } else if (!quiet) {
      setLog(["Couldn't find TaleSpire in your Steam libraries. Use Browse… to pick its folder."], true);
    }
    return found;
  }

  async function run(cmd, label) {
    busy = true;
    render();
    setLog([`${label}…`]);
    try {
      const report = await invoke(cmd, { path: pathInput.value.trim() });
      status = report.status;
      setLog(report.log);
      showToast(cmd === "talespire_install" ? "TaleSpire mod installed." : "TaleSpire mod removed.");
    } catch (err) {
      setLog([String(err)], true);
    } finally {
      busy = false;
      render();
    }
  }

  // Two-step remove (first click arms it), like note deletion.
  function disarmRemove() {
    removeBtn.dataset.armed = "";
    removeBtn.textContent = "Remove mod";
  }

  $("mod-detect").addEventListener("click", () => detect());
  $("mod-browse").addEventListener("click", async () => {
    const picked = await invoke("talespire_pick").catch(() => null);
    if (picked) {
      pathInput.value = picked;
      setLog([]);
      await refresh();
    }
  });
  pathInput.addEventListener("change", refresh);
  pathInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      refresh();
    }
  });
  installBtn.addEventListener("click", () => run("talespire_install", "Installing"));
  removeBtn.addEventListener("click", () => {
    if (!removeBtn.dataset.armed) {
      removeBtn.dataset.armed = "1";
      removeBtn.textContent = "Really remove?";
      return;
    }
    run("talespire_uninstall", "Removing");
  });
  $("mod-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(launchText.textContent);
      showToast("Launch option copied - paste it into Steam.");
    } catch {
      // Clipboard API unavailable: select the text so ⌘C / Ctrl+C works.
      const range = document.createRange();
      range.selectNodeContents(launchText);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    }
  });
  $("mod-close").addEventListener("click", close);
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });

  async function open() {
    panel.classList.remove("hidden");
    setLog([]);
    if (!pathInput.value) pathInput.value = savedPath();
    if (pathInput.value) await refresh();
    else await detect({ quiet: true });
    render();
  }

  function close() {
    panel.classList.add("hidden");
  }

  // On startup: quietly check, and offer the panel when something needs doing.
  async function checkOnStartup() {
    pathInput.value = savedPath();
    const s = pathInput.value ? await refresh() : (await detect({ quiet: true })) && status;
    if (!s?.valid) return;
    const needs = !s.installed_version
      ? "isn't installed in TaleSpire yet"
      : s.installed_version !== s.bundled_version
        ? `can be updated to v${s.bundled_version}`
        : s.platform === "macos" && !s.launch_option_set
          ? "needs its Steam launch option"
          : null;
    if (needs) showToast(`The TaleSpire mod ${needs} - click to set it up.`, { onClick: open, duration: 12000 });
  }

  return { open, close, checkOnStartup, isOpen: () => !panel.classList.contains("hidden") };
}

using System;
using System.IO;
using BepInEx;
using BepInEx.Configuration;
using HarmonyLib;
using UnityEngine;

namespace TaleSpireMapExporter
{
    [BepInPlugin(PluginGuid, PluginName, PluginVersion)]
    public class Plugin : BaseUnityPlugin
    {
        public const string PluginGuid = "com.jsbertsch.talespiremapexporter";
        public const string PluginName = "TaleSpire Map Exporter";
        public const string PluginVersion = "0.3.0";

        private ConfigEntry<KeyboardShortcut> _exportHotkey;
        private ConfigEntry<KeyboardShortcut> _scanHotkey;
        private ConfigEntry<KeyboardShortcut> _inspectHotkey;
        private ConfigEntry<string> _inspectTypeName;
        private ConfigEntry<KeyboardShortcut> _peekHotkey;
        private ConfigEntry<string> _peekRootTypeName;
        private ConfigEntry<string> _peekFieldPath;
        private ConfigEntry<int> _peekMaxElements;
        private ConfigEntry<string> _exportFolder;
        private ConfigEntry<string> _assetIndexPath;
        private ConfigEntry<bool> _enableDiagnostics;
        private ConfigEntry<bool> _showNotifications;
        private ConfigEntry<bool> _logKeyPresses;
        private bool _loggedFirstUpdate;

        // On-screen notice shown after an export, so the GM gets feedback without opening
        // BepInEx's log. Drawn in OnGUI; cleared once _noticeUntil passes.
        private string _notice;
        private bool _noticeIsError;
        private float _noticeUntil;
        private GUIStyle _noticeStyle;

        private AssetIndex _assetIndex;
        private Harmony _harmony;

        private void Awake()
        {
            _exportHotkey = Config.Bind(
                "General", "ExportHotkey",
                new KeyboardShortcut(KeyCode.E, KeyCode.LeftControl, KeyCode.LeftShift),
                "Press to export the current board to a JSON file. (On a Mac keyboard LeftControl " +
                "is the Control key, not Command.)");

            _showNotifications = Config.Bind(
                "General", "ShowNotifications", true,
                "Show a short on-screen message after each export saying where the file went.");

            _enableDiagnostics = Config.Bind(
                "Diagnostics", "EnableDiagnosticHotkeys", false,
                "Developer tools for mapping TaleSpire's data model (scene scan / inspect / peek " +
                "hotkeys below). Off by default so they can't be triggered by accident during play.");

            _logKeyPresses = Config.Bind(
                "Diagnostics", "LogKeyPresses", false,
                "Log every key press the plugin can see to BepInEx/LogOutput.log. Use this if the " +
                "export hotkey seems to do nothing, to check which keys actually reach the plugin.");

            _scanHotkey = Config.Bind(
                "Diagnostics", "SceneScanHotkey",
                new KeyboardShortcut(KeyCode.E, KeyCode.LeftControl, KeyCode.LeftAlt),
                "Press to dump the live scene hierarchy (GameObject paths + component types) to a " +
                "text file - a diagnostic aid for finding the real board/tile/prop manager class " +
                "without a decompiler. See mod/README.md 'Next step'.");

            _inspectHotkey = Config.Bind(
                "Diagnostics", "InspectHotkey",
                new KeyboardShortcut(KeyCode.I, KeyCode.LeftControl, KeyCode.LeftAlt),
                "Press to reflect over every live instance of InspectTypeName and dump its fields " +
                "(names, types, values) to a text file - a diagnostic aid for learning a class's " +
                "shape without a decompiler. See mod/README.md 'Next step'.");

            _inspectTypeName = Config.Bind(
                "Diagnostics", "InspectTypeName",
                "BoardSessionManager,BoardSyncManager,BoardPersistenceManager,SectorDownloadManager,ContentManager",
                "Comma-separated simple type name(s) (no namespace) to reflect over when InspectHotkey " +
                "is pressed - all are dumped to the same file, so trying several candidates costs one " +
                "restart instead of one restart each.");

            _peekHotkey = Config.Bind(
                "Diagnostics", "PeekHotkey",
                new KeyboardShortcut(KeyCode.P, KeyCode.LeftControl, KeyCode.LeftAlt),
                "Press to navigate PeekFieldPath (dot-separated field names) from a live instance " +
                "of PeekRootTypeName, then dump the fields of the first PeekMaxElements items in " +
                "the collection found at the end of that path. Use this once InspectHotkey has " +
                "found a promising collection field but its own depth limit stops before showing " +
                "what one element looks like. See mod/README.md 'Next step'.");

            _peekRootTypeName = Config.Bind(
                "Diagnostics", "PeekRootTypeName", "BoardSessionManager",
                "Simple type name (no namespace) of the live instance PeekFieldPath starts from.");

            _peekFieldPath = Config.Bind(
                "Diagnostics", "PeekFieldPath", "_board._zones.List[0].InactiveSet.Placeables",
                "Dot-separated chain of field names to navigate from the PeekRootTypeName instance " +
                "to a collection field. A segment may end in '[N]' (e.g. 'List[0]') to pick element " +
                "N out of an intermediate collection before continuing - e.g. to get from 'all " +
                "zones' to 'the Placeables inside zone 0'. If zone 0 turns out to be empty (a board " +
                "edge cell), try a different index - with ~589 zones on a populated board, a middle " +
                "index (e.g. List[290]) is more likely to land inside actual content.");

            _peekMaxElements = Config.Bind(
                "Diagnostics", "PeekMaxElements", 3,
                "Maximum number of collection elements to dump fields for.");

            _exportFolder = Config.Bind(
                "General", "ExportFolder",
                Path.Combine(DocumentsFolder(), "TaleSpireMapExporter"),
                "Folder that exported JSON files are written to.");

            _assetIndexPath = Config.Bind(
                "General", "AssetIndexPath", "",
                "Optional path to an index.json asset database, used to resolve asset GUIDs to " +
                "names/categories. Leave blank to export raw GUIDs with category 'unknown'.");

            _assetIndex = AssetIndex.Load(_assetIndexPath.Value, msg => Logger.LogInfo(msg));

            // No patches defined yet (see BoardExporter.cs) - kept here so it's ready as soon
            // as phase 2 needs to intercept a method rather than just read a public collection.
            _harmony = new Harmony(PluginGuid);
            _harmony.PatchAll();

            // On the macOS build the plugin's own MonoBehaviour never gets Update() calls (BepInEx's
            // manager object gets destroyed or disabled during TaleSpire's startup). So per-frame
            // work runs on a dedicated hidden object that scene loads and cleanup sweeps don't touch.
            var runnerObject = new GameObject("TaleSpireMapExporter.Runner");
            runnerObject.hideFlags = HideFlags.HideAndDontSave;
            DontDestroyOnLoad(runnerObject);
            runnerObject.AddComponent<PluginRunner>().Owner = this;

            Logger.LogInfo($"{PluginName} v{PluginVersion} loaded. Hotkey: {_exportHotkey.Value}. Exports go to {_exportFolder.Value}");
        }

        // Mono maps SpecialFolder.MyDocuments to $HOME on macOS/Linux rather than ~/Documents,
        // which would drop exports straight into the home folder.
        private static string DocumentsFolder()
        {
            var docs = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
            if (Application.platform == RuntimePlatform.OSXPlayer || Application.platform == RuntimePlatform.LinuxPlayer)
            {
                var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
                if (string.IsNullOrEmpty(home)) home = docs;
                var candidate = Path.Combine(home, "Documents");
                if (Directory.Exists(candidate)) return candidate;
            }
            return docs;
        }

        private void ShowNotice(string message, bool isError = false)
        {
            if (!_showNotifications.Value) return;
            _notice = message;
            _noticeIsError = isError;
            _noticeUntil = Time.unscaledTime + (isError ? 8f : 5f);
        }

        internal void DrawGui()
        {
            if (_notice == null) return;
            if (Time.unscaledTime > _noticeUntil) { _notice = null; return; }

            if (_noticeStyle == null)
            {
                _noticeStyle = new GUIStyle(GUI.skin.box)
                {
                    fontSize = 16,
                    alignment = TextAnchor.MiddleCenter,
                    wordWrap = true,
                    padding = new RectOffset(16, 16, 10, 10),
                };
            }
            _noticeStyle.normal.textColor = _noticeIsError ? new Color(1f, 0.55f, 0.5f) : Color.white;

            var width = Mathf.Min(640f, Screen.width - 40f);
            var content = new GUIContent(_notice);
            var height = _noticeStyle.CalcHeight(content, width);
            GUI.Box(new Rect((Screen.width - width) / 2f, 40f, width, height), content, _noticeStyle);
        }

        private void OnDisable() => Logger.LogInfo("Plugin component disabled (per-frame work continues on the runner object).");
        private void OnDestroy() => Logger.LogInfo("Plugin component destroyed (per-frame work continues on the runner object).");

        internal void Tick()
        {
            if (!_loggedFirstUpdate)
            {
                _loggedFirstUpdate = true;
                Logger.LogInfo($"Update loop running; hotkeys read via {UnityInput.Current.GetType().Name}.");
            }

            if (_logKeyPresses.Value) LogKeyPresses();

            if (_exportHotkey.Value.IsDown())
            {
                ExportCurrentBoard();
            }

            if (!_enableDiagnostics.Value) return;

            if (_scanHotkey.Value.IsDown())
            {
                ScanScene();
            }

            if (_inspectHotkey.Value.IsDown())
            {
                InspectType();
            }

            if (_peekHotkey.Value.IsDown())
            {
                PeekCollection();
            }
        }

        private static readonly KeyCode[] AllKeyCodes = (KeyCode[])Enum.GetValues(typeof(KeyCode));

        private void LogKeyPresses()
        {
            var input = UnityInput.Current;
            if (!input.anyKeyDown) return;

            var down = new System.Collections.Generic.List<string>();
            var held = new System.Collections.Generic.List<string>();
            foreach (var key in AllKeyCodes)
            {
                if (key == KeyCode.None) continue;
                try
                {
                    if (input.GetKeyDown(key)) down.Add(key.ToString());
                    else if (input.GetKey(key)) held.Add(key.ToString());
                }
                catch
                {
                    // Some KeyCodes (mouse/joystick) aren't supported by every input backend.
                }
            }
            Logger.LogInfo($"Key down: [{string.Join(", ", down)}] held: [{string.Join(", ", held)}] -> export hotkey matched: {_exportHotkey.Value.IsDown()}");
        }

        private void PeekCollection()
        {
            try
            {
                Directory.CreateDirectory(_exportFolder.Value);

                var fileName = $"peek-{MakeSafeFileName(_peekRootTypeName.Value)}-{MakeSafeFileName(_peekFieldPath.Value)}_{DateTime.Now:yyyyMMdd_HHmmss}.txt";
                var path = Path.Combine(_exportFolder.Value, fileName);

                File.WriteAllText(path, ReflectionDumper.PeekCollectionElements(
                    _peekRootTypeName.Value, _peekFieldPath.Value, _peekMaxElements.Value, msg => Logger.LogInfo(msg)));

                Logger.LogInfo($"Peek dump written to {path}");
            }
            catch (Exception ex)
            {
                Logger.LogError($"Peek dump failed: {ex}");
            }
        }

        private void InspectType()
        {
            try
            {
                Directory.CreateDirectory(_exportFolder.Value);

                var typeNames = _inspectTypeName.Value.Split(',');

                var fileName = $"inspect-{MakeSafeFileName(string.Join("+", typeNames))}_{DateTime.Now:yyyyMMdd_HHmmss}.txt";
                var path = Path.Combine(_exportFolder.Value, fileName);

                File.WriteAllText(path, ReflectionDumper.DumpByTypeNames(typeNames, msg => Logger.LogInfo(msg)));

                Logger.LogInfo($"Reflection dump written to {path}");
            }
            catch (Exception ex)
            {
                Logger.LogError($"Reflection dump failed: {ex}");
            }
        }

        private void ScanScene()
        {
            try
            {
                Directory.CreateDirectory(_exportFolder.Value);

                var fileName = $"scene-scan_{DateTime.Now:yyyyMMdd_HHmmss}.txt";
                var path = Path.Combine(_exportFolder.Value, fileName);

                File.WriteAllText(path, SceneScanner.Scan());

                Logger.LogInfo($"Scene scan written to {path}");
            }
            catch (Exception ex)
            {
                Logger.LogError($"Scene scan failed: {ex}");
            }
        }

        private void ExportCurrentBoard()
        {
            try
            {
                var (boardName, boardId) = BoardExporter.TryGetBoardInfo();
                // With an area selected in TaleSpire's selection tool, export just that area.
                var hasSelection = BoardExporter.TryGetActiveSelection(out var selection);
                var root = new ExportRoot
                {
                    boardName = boardName,
                    boardId = boardId,
                    exporterVersion = PluginVersion,
                    exportedAt = DateTime.UtcNow.ToString("o"),
                    objects = BoardExporter.GatherPlacedObjects(_assetIndex, msg => Logger.LogInfo(msg),
                        hasSelection ? selection : (Bounds?)null),
                };
                if (hasSelection)
                {
                    root.selectionMin = new Vec3(selection.min.x, selection.min.y, selection.min.z);
                    root.selectionMax = new Vec3(selection.max.x, selection.max.y, selection.max.z);
                }

                Directory.CreateDirectory(_exportFolder.Value);

                var safeBoardName = MakeSafeFileName(root.boardName);
                var fileName = $"{safeBoardName}{(hasSelection ? "_selection" : "")}_{DateTime.Now:yyyyMMdd_HHmmss}.json";
                var path = Path.Combine(_exportFolder.Value, fileName);

                File.WriteAllText(path, JsonWriter.Write(root));

                Logger.LogInfo($"Exported {root.objects.Count} object(s) to {path}");

                if (root.objects.Count == 0)
                    ShowNotice(hasSelection
                        ? $"The selected area is empty - nothing to export.\n{path}"
                        : $"Map export saved, but it's empty - is a board loaded?\n{path}", isError: true);
                else
                    ShowNotice($"Exported {(hasSelection ? "selection of " : "")}\"{root.boardName}\" ({root.objects.Count} objects)\n{path}");
            }
            catch (Exception ex)
            {
                Logger.LogError($"Export failed: {ex}");
                ShowNotice($"Map export failed: {ex.Message}\nSee BepInEx/LogOutput.log for details.", isError: true);
            }
        }

        private static string MakeSafeFileName(string name)
        {
            foreach (var c in Path.GetInvalidFileNameChars())
            {
                name = name.Replace(c, '_');
            }
            return name;
        }
    }

    // Hosts the plugin's per-frame work; see the comment where it's created in Plugin.Awake.
    internal class PluginRunner : MonoBehaviour
    {
        public Plugin Owner;

        private void Update() => Owner?.Tick();
        private void OnGUI() => Owner?.DrawGui();
    }
}

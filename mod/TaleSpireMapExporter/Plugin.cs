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
        public const string PluginVersion = "0.1.0";

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

        private AssetIndex _assetIndex;
        private Harmony _harmony;

        private void Awake()
        {
            _exportHotkey = Config.Bind(
                "General", "ExportHotkey",
                new KeyboardShortcut(KeyCode.E, KeyCode.LeftControl, KeyCode.LeftShift),
                "Press to export the current board to a JSON file.");

            _scanHotkey = Config.Bind(
                "General", "SceneScanHotkey",
                new KeyboardShortcut(KeyCode.E, KeyCode.LeftControl, KeyCode.LeftAlt),
                "Press to dump the live scene hierarchy (GameObject paths + component types) to a " +
                "text file - a diagnostic aid for finding the real board/tile/prop manager class " +
                "without a decompiler. See mod/README.md 'Next step'.");

            _inspectHotkey = Config.Bind(
                "General", "InspectHotkey",
                new KeyboardShortcut(KeyCode.I, KeyCode.LeftControl, KeyCode.LeftAlt),
                "Press to reflect over every live instance of InspectTypeName and dump its fields " +
                "(names, types, values) to a text file - a diagnostic aid for learning a class's " +
                "shape without a decompiler. See mod/README.md 'Next step'.");

            _inspectTypeName = Config.Bind(
                "General", "InspectTypeName",
                "BoardSessionManager,BoardSyncManager,BoardPersistenceManager,SectorDownloadManager,ContentManager",
                "Comma-separated simple type name(s) (no namespace) to reflect over when InspectHotkey " +
                "is pressed - all are dumped to the same file, so trying several candidates costs one " +
                "restart instead of one restart each.");

            _peekHotkey = Config.Bind(
                "General", "PeekHotkey",
                new KeyboardShortcut(KeyCode.P, KeyCode.LeftControl, KeyCode.LeftAlt),
                "Press to navigate PeekFieldPath (dot-separated field names) from a live instance " +
                "of PeekRootTypeName, then dump the fields of the first PeekMaxElements items in " +
                "the collection found at the end of that path. Use this once InspectHotkey has " +
                "found a promising collection field but its own depth limit stops before showing " +
                "what one element looks like. See mod/README.md 'Next step'.");

            _peekRootTypeName = Config.Bind(
                "General", "PeekRootTypeName", "BoardSessionManager",
                "Simple type name (no namespace) of the live instance PeekFieldPath starts from.");

            _peekFieldPath = Config.Bind(
                "General", "PeekFieldPath", "_board._zones.List[0].InactiveSet.Placeables",
                "Dot-separated chain of field names to navigate from the PeekRootTypeName instance " +
                "to a collection field. A segment may end in '[N]' (e.g. 'List[0]') to pick element " +
                "N out of an intermediate collection before continuing - e.g. to get from 'all " +
                "zones' to 'the Placeables inside zone 0'. If zone 0 turns out to be empty (a board " +
                "edge cell), try a different index - with ~589 zones on a populated board, a middle " +
                "index (e.g. List[290]) is more likely to land inside actual content.");

            _peekMaxElements = Config.Bind(
                "General", "PeekMaxElements", 3,
                "Maximum number of collection elements to dump fields for.");

            _exportFolder = Config.Bind(
                "General", "ExportFolder",
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "TaleSpireMapExporter"),
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

            Logger.LogInfo($"{PluginName} v{PluginVersion} loaded. Hotkey: {_exportHotkey.Value}");
        }

        private void Update()
        {
            if (_exportHotkey.Value.IsDown())
            {
                ExportCurrentBoard();
            }

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
                var root = new ExportRoot
                {
                    boardName = BoardExporter.TryGetBoardName(),
                    exportedAt = DateTime.UtcNow.ToString("o"),
                    objects = BoardExporter.GatherPlacedObjects(_assetIndex, msg => Logger.LogInfo(msg)),
                };

                Directory.CreateDirectory(_exportFolder.Value);

                var safeBoardName = MakeSafeFileName(root.boardName);
                var fileName = $"{safeBoardName}_{DateTime.Now:yyyyMMdd_HHmmss}.json";
                var path = Path.Combine(_exportFolder.Value, fileName);

                File.WriteAllText(path, JsonWriter.Write(root));

                Logger.LogInfo($"Exported {root.objects.Count} object(s) to {path}");
            }
            catch (Exception ex)
            {
                Logger.LogError($"Export failed: {ex}");
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
}

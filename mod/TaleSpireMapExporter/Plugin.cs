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

using System;
using System.Collections.Generic;
using System.IO;
using System.Text.RegularExpressions;

namespace TaleSpireMapExporter
{
    // Optional lookup from asset GUID -> friendly name/category, sourced from a
    // community-maintained index.json (see schema/export-schema.md). Never required:
    // if no file is configured or it fails to parse, every asset just falls back to
    // its raw GUID and category "unknown".
    internal class AssetIndex
    {
        private readonly Dictionary<string, (string name, string category)> _entries
            = new Dictionary<string, (string, string)>(StringComparer.OrdinalIgnoreCase);

        public static AssetIndex Load(string path, Action<string> log)
        {
            var index = new AssetIndex();
            if (string.IsNullOrWhiteSpace(path)) return index;

            if (!File.Exists(path))
            {
                log($"AssetIndex: no file at '{path}', continuing without name/category lookup.");
                return index;
            }

            try
            {
                index.ParseFlatEntries(File.ReadAllText(path));
                log($"AssetIndex: loaded {index._entries.Count} entries from '{path}'.");
            }
            catch (Exception ex)
            {
                log($"AssetIndex: failed to parse '{path}': {ex.Message}. Continuing without it.");
            }

            return index;
        }

        // Minimal regex-based scan for {"id": "...", "name": "...", "category": "..."} objects.
        // Deliberately not a general JSON parser - the index.json shape is simple and this
        // avoids pulling in a JSON dependency for an optional, best-effort feature.
        private void ParseFlatEntries(string json)
        {
            var objectPattern = new Regex("\\{[^{}]*\\}", RegexOptions.Singleline);
            var idPattern = new Regex("\"(id|guid|assetGuid)\"\\s*:\\s*\"([^\"]+)\"");
            var namePattern = new Regex("\"name\"\\s*:\\s*\"([^\"]+)\"");
            var categoryPattern = new Regex("\"category\"\\s*:\\s*\"([^\"]+)\"");

            foreach (Match objMatch in objectPattern.Matches(json))
            {
                var idMatch = idPattern.Match(objMatch.Value);
                if (!idMatch.Success) continue;

                var nameMatch = namePattern.Match(objMatch.Value);
                var categoryMatch = categoryPattern.Match(objMatch.Value);

                _entries[idMatch.Groups[2].Value] = (
                    nameMatch.Success ? nameMatch.Groups[1].Value : idMatch.Groups[2].Value,
                    categoryMatch.Success ? categoryMatch.Groups[1].Value : "unknown"
                );
            }
        }

        public (string name, string category) Resolve(string assetGuid)
        {
            if (assetGuid != null && _entries.TryGetValue(assetGuid, out var entry))
                return entry;
            return (assetGuid ?? "unknown", "unknown");
        }
    }
}

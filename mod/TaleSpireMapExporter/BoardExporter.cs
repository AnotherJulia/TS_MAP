using System;
using System.Collections.Generic;
using UnityEngine;

namespace TaleSpireMapExporter
{
    // Reads TaleSpire's live board state. Traversal and field shapes were established by
    // decompiling the game's own assemblies (ilspycmd against TaleSpire_Data/Managed/*.dll) -
    // notably Bouncyrock.TaleSpire.DataModel.Runtime.dll - so the field/type names below are the
    // real ones, not guesses. Two categories:
    //
    // Creatures: live GameObjects ("Character(Clone)") carrying a CreatureBoardAsset component,
    // with a normal Unity Transform for position/rotation. Matched by component type name and
    // filtered to actual scene members. HIGH confidence.
    //
    // Tiles/walls/props: NOT GameObjects - stored as data. Each DataModel.Board holds a Zones
    // collection (~589 spatial 16-unit grid cells). Each Zone.InactiveSet (InactiveZoneData) has
    // two PARALLEL lists:
    //   - Placeables : NativeGreedyList<Placeable>  -- one entry per placed instance
    //         Placeable.WorldOrigin (float3 world pos), .SelectionBounds (AABB), .Rotation (byte)
    //   - Layouts    : NativeList<PlaceableLayout>   -- one entry per (asset, run-of-instances)
    //         PlaceableLayout.ObjectId (ContentGuid asset id), .AssetCount, .Kind
    // The correlation (from InactiveZoneData.UnpackAndFixStateMachineState): walking Layouts in
    // order, each layout owns the next AssetCount consecutive entries in Placeables. That gives
    // asset GUID + world transform for every placed tile/wall/prop.
    internal static class BoardExporter
    {
        // 24 rotation steps of 15 degrees about Y (DataModel.AssetMath.ROTATION_STEP_IN_DEGREES).
        private const float RotationStepDegrees = 15f;

        public static List<PlacedObject> GatherPlacedObjects(AssetIndex assetIndex, Action<string> log)
        {
            var objects = new List<PlacedObject>();
            GatherCreatures(objects, assetIndex, log);
            GatherPlaceables(objects, assetIndex, log);
            return objects;
        }

        public static string TryGetBoardName()
        {
            // DataModel.Board exposes no obvious board-title field; the name shown in-game lives in
            // campaign/board metadata outside this data model. A timestamped filename is used
            // instead (see Plugin.ExportCurrentBoard), so a constant here is fine.
            return "TaleSpire Board";
        }

        private static void GatherCreatures(List<PlacedObject> objects, AssetIndex assetIndex, Action<string> log)
        {
            var count = 0;

            // Matched by type name (not a compile-time reference) so this doesn't depend on
            // CreatureBoardAsset's exact accessibility/namespace. Filtered to gameObject.scene
            // .IsValid() to exclude the library/prefab copies TaleSpire keeps loaded in memory for
            // the asset browser - those aren't part of any loaded Scene, but placed creatures are.
            foreach (var component in Resources.FindObjectsOfTypeAll<Component>())
            {
                if (component.GetType().Name != "CreatureBoardAsset") continue;
                if (!component.gameObject.scene.IsValid()) continue;

                count++;
                var transform = component.transform;
                var assetGuid = ReflectFirstStringField(component, "AssetGuid", "AssetId", "Guid", "_assetGuid", "_assetId")
                    ?? component.gameObject.name;
                var rawName = ReflectFirstStringField(component, "Name", "CreatureName", "_name")
                    ?? component.gameObject.name;
                var (resolvedName, _) = assetIndex.Resolve(assetGuid);

                objects.Add(new PlacedObject
                {
                    id = ReflectFirstStringField(component, "CreatureId", "Id", "_creatureId") ?? $"creature-{count}",
                    assetGuid = assetGuid,
                    name = rawName != assetGuid ? rawName : resolvedName,
                    category = "creature",
                    position = ToVec3(transform.position),
                    rotation = ToQuat(transform.rotation),
                    size = ToVec3(transform.lossyScale),
                });
            }

            log($"BoardExporter: gathered {count} creature(s).");
        }

        private static void GatherPlaceables(List<PlacedObject> objects, AssetIndex assetIndex, Action<string> log)
        {
            // BoardSessionManager._board._zones are private fields, so reach them by reflection;
            // everything below the zone list (Zones.List, Zone.InactiveSet, its Placeables/Layouts)
            // is public, but keep using the shared reflection helpers to stay decoupled from the
            // exact assembly versions.
            var sessionManager = ReflectionDumper.FindComponentByTypeName("BoardSessionManager");
            if (sessionManager == null)
            {
                log("BoardExporter: BoardSessionManager not found - no placeable data available (is a board loaded?).");
                return;
            }

            if (!ReflectionDumper.TryGetFieldValue(sessionManager, "_board", out var board) || board == null)
            {
                log("BoardExporter: BoardSessionManager._board is null/unreadable - no placeable data available.");
                return;
            }

            if (!ReflectionDumper.TryGetFieldValue(board, "_zones", out var zones) ||
                !ReflectionDumper.TryGetFieldValue(zones, "List", out var zoneListValue) ||
                !ReflectionDumper.TryEnumerate(zoneListValue, out var zoneList))
            {
                log("BoardExporter: could not read Board._zones.List - no placeable data available.");
                return;
            }

            var zoneCount = 0;
            var startCount = objects.Count;
            var skippedInstances = 0;

            foreach (var zone in zoneList)
            {
                zoneCount++;
                if (zone == null) continue;
                if (!ReflectionDumper.TryGetFieldValue(zone, "InactiveSet", out var inactiveSet) || inactiveSet == null) continue;

                if (!ReflectionDumper.TryGetFieldValue(inactiveSet, "Placeables", out var placeablesObj) ||
                    !ReflectionDumper.TryGetIndexed(placeablesObj, out var placeableCount, out var getPlaceable))
                {
                    continue;
                }
                if (!ReflectionDumper.TryGetFieldValue(inactiveSet, "Layouts", out var layoutsObj) ||
                    !ReflectionDumper.TryGetIndexed(layoutsObj, out var layoutCount, out var getLayout))
                {
                    continue;
                }

                // Walk layouts in order; each owns the next AssetCount consecutive placeables.
                var cursor = 0;
                for (var li = 0; li < layoutCount; li++)
                {
                    var layout = getLayout(li);
                    if (layout == null) continue;

                    var assetGuid = ReflectStructFieldToString(layout, "ObjectId") ?? "unknown";
                    var assetCount = ReflectFieldToInt(layout, "AssetCount", 0);
                    var kind = ReflectPropertyToString(layout, "Kind");
                    var (resolvedName, resolvedCategory) = assetIndex.Resolve(assetGuid);
                    var category = !string.IsNullOrEmpty(kind) ? kind.ToLowerInvariant() : resolvedCategory;

                    for (var j = 0; j < assetCount; j++, cursor++)
                    {
                        if (cursor >= placeableCount) { skippedInstances++; continue; }

                        var placeable = getPlaceable(cursor);
                        if (placeable == null) continue;

                        if (!TryReadFloat3(placeable, "WorldOrigin", out var px, out var py, out var pz))
                            continue;

                        var rotSteps = ReflectPropertyToInt(placeable, "Rotation", 0);
                        var size = ReadBoundsSize(placeable, "SelectionBounds");

                        objects.Add(new PlacedObject
                        {
                            id = $"{assetGuid}-{zoneCount}-{cursor}",
                            assetGuid = assetGuid,
                            name = resolvedName,
                            category = category,
                            position = new Vec3(px, py, pz),
                            rotation = ToQuat(Quaternion.Euler(0f, rotSteps * RotationStepDegrees, 0f)),
                            size = size,
                        });
                    }
                }
            }

            var added = objects.Count - startCount;
            var suffix = skippedInstances > 0
                ? $" ({skippedInstances} instance(s) skipped: layout AssetCount exceeded the Placeables list - unexpected, please report)"
                : "";
            log($"BoardExporter: scanned {zoneCount} zone(s), exported {added} placeable(s) (tiles/walls/props){suffix}.");
        }

        // --- reflection helpers -------------------------------------------------------------

        // Best-effort identity lookup: tries each candidate field name in order and returns the
        // first one that resolves to a non-empty string. Used for creatures, whose component
        // field names weren't decompiled (unlike the placeable data model, which is exact).
        private static string ReflectFirstStringField(object instance, params string[] candidateNames)
        {
            foreach (var name in candidateNames)
            {
                var field = ReflectionDumper.FindField(instance.GetType(), name);
                if (field == null) continue;

                try
                {
                    var value = field.GetValue(field.IsStatic ? null : instance);
                    var text = value?.ToString();
                    if (!string.IsNullOrEmpty(text)) return text;
                }
                catch
                {
                    // Try the next candidate.
                }
            }
            return null;
        }

        // Reads a struct-typed field (e.g. PlaceableLayout.ObjectId, a ContentGuid) and returns its
        // ToString() - ContentGuid.ToString() yields the asset GUID string.
        private static string ReflectStructFieldToString(object instance, string fieldName)
        {
            if (!ReflectionDumper.TryGetFieldValue(instance, fieldName, out var value) || value == null) return null;
            var text = value.ToString();
            return string.IsNullOrEmpty(text) ? null : text;
        }

        private static int ReflectFieldToInt(object instance, string fieldName, int fallback)
        {
            if (!ReflectionDumper.TryGetFieldValue(instance, fieldName, out var value) || value == null) return fallback;
            try { return Convert.ToInt32(value); } catch { return fallback; }
        }

        private static string ReflectPropertyToString(object instance, string propertyName)
        {
            try
            {
                var prop = instance.GetType().GetProperty(propertyName);
                var value = prop?.GetValue(instance);
                return value?.ToString();
            }
            catch { return null; }
        }

        private static int ReflectPropertyToInt(object instance, string propertyName, int fallback)
        {
            try
            {
                var prop = instance.GetType().GetProperty(propertyName);
                var value = prop?.GetValue(instance);
                return value == null ? fallback : Convert.ToInt32(value);
            }
            catch { return fallback; }
        }

        // Reads a Unity.Mathematics.float3 field (x/y/z public fields) by reflection, so this
        // project needs no compile-time reference to Unity.Mathematics.
        private static bool TryReadFloat3(object instance, string fieldName, out float x, out float y, out float z)
        {
            x = y = z = 0f;
            if (!ReflectionDumper.TryGetFieldValue(instance, fieldName, out var f3) || f3 == null) return false;

            var t = f3.GetType();
            try
            {
                x = Convert.ToSingle(t.GetField("x").GetValue(f3));
                y = Convert.ToSingle(t.GetField("y").GetValue(f3));
                z = Convert.ToSingle(t.GetField("z").GetValue(f3));
                return true;
            }
            catch { return false; }
        }

        // Reads a UnityEngine.Bounds field's .size, boxed via reflection then unboxed - Bounds is a
        // UnityEngine struct this project already references. Falls back to unit size on failure.
        private static Vec3 ReadBoundsSize(object instance, string fieldName)
        {
            if (ReflectionDumper.TryGetFieldValue(instance, fieldName, out var boundsObj) && boundsObj is Bounds bounds)
            {
                return ToVec3(bounds.size);
            }
            return new Vec3(1f, 1f, 1f);
        }

        private static Vec3 ToVec3(Vector3 v) => new Vec3(v.x, v.y, v.z);
        private static Quat ToQuat(Quaternion q) => new Quat(q.x, q.y, q.z, q.w);
    }
}

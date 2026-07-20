using System;
using System.Collections.Generic;

namespace TaleSpireMapExporter
{
    // This is the piece that needs the phase-2 investigation described in the repo README:
    // decompile the installed TaleSpire's Assembly-CSharp.dll (ILSpy/dnSpy) to find the
    // manager/collection that holds every currently placed tile, wall, and prop. Creatures
    // are reachable through Bouncyrock.TaleSpire.Runtime's creature manager (the same one
    // LordAshes' InterfacePlugin uses to look up a CreatureBoardAsset by id/name) - start
    // there, then find the non-creature equivalent.
    //
    // Until that's wired up, this returns an empty list so the plugin builds, loads, and
    // produces valid (empty) export files end-to-end - useful for validating the rest of the
    // pipeline (hotkey, file write, viewer) before the real game-state reading exists.
    internal static class BoardExporter
    {
        public static List<PlacedObject> GatherPlacedObjects(AssetIndex assetIndex, Action<string> log)
        {
            log("BoardExporter.GatherPlacedObjects is not implemented yet - exporting an empty board. " +
                "See the comment at the top of BoardExporter.cs for what's needed next.");

            var objects = new List<PlacedObject>();

            // Sketch of what each placed instance should become, once real enumeration exists:
            //
            // foreach (var creature in <creature manager>.AllCreatures)
            // {
            //     var (name, category) = assetIndex.Resolve(creature.AssetGuid);
            //     objects.Add(new PlacedObject
            //     {
            //         id = creature.CreatureId.ToString(),
            //         assetGuid = creature.AssetGuid,
            //         name = name,
            //         category = category != "unknown" ? category : "creature",
            //         position = ToVec3(creature.transform.position),
            //         rotation = ToQuat(creature.transform.rotation),
            //         size = ToVec3(creature.Bounds.size),
            //     });
            // }

            return objects;
        }

        public static string TryGetBoardName()
        {
            // TODO: replace once the real board/session accessor is identified (phase 2).
            return "Unknown Board";
        }

        // Uncomment and adapt once UnityEngine.Vector3/Quaternion values are available here.
        // private static Vec3 ToVec3(UnityEngine.Vector3 v) => new Vec3(v.x, v.y, v.z);
        // private static Quat ToQuat(UnityEngine.Quaternion q) => new Quat(q.x, q.y, q.z, q.w);
    }
}

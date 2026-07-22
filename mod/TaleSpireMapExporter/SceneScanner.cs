using System;
using System.Text;
using UnityEngine;

namespace TaleSpireMapExporter
{
    // Diagnostic tool for phase 2 (see mod/README.md "Next step"). Instead of reading
    // Assembly-CSharp.dll cold in a decompiler, this walks the *live* scene graph while a
    // board is loaded and writes every active GameObject's hierarchy path plus its component
    // type names to a plain text file. Grep that file for likely names ("Tile", "Prop",
    // "Board", "Placement", "Manager") to find the real class to read from in
    // BoardExporter.GatherPlacedObjects, instead of guessing from disassembled source.
    //
    // Deliberately avoids UnityEngine.SceneManagement (a separate assembly not referenced by
    // this project) - finds scene roots via FindObjectsOfTypeAll<Transform> instead, which only
    // needs UnityEngine.CoreModule (already referenced).
    internal static class SceneScanner
    {
        public static string Scan()
        {
            var sb = new StringBuilder();
            sb.AppendLine($"# Scene scan @ {DateTime.Now:o}");
            sb.AppendLine();

            foreach (var transform in Resources.FindObjectsOfTypeAll<Transform>())
            {
                if (transform.parent != null) continue; // only root objects; recursion covers children
                if ((transform.hideFlags & HideFlags.HideAndDontSave) != 0) continue; // skip assets/prefabs, not scene instances

                WriteGameObject(sb, transform.gameObject, 0);
            }

            return sb.ToString();
        }

        private static void WriteGameObject(StringBuilder sb, GameObject go, int depth)
        {
            var indent = new string(' ', depth * 2);
            var components = go.GetComponents<Component>();

            sb.Append(indent).Append(go.name);

            if (components.Length > 0)
            {
                sb.Append("  [");
                for (int i = 0; i < components.Length; i++)
                {
                    if (i > 0) sb.Append(", ");
                    // Null component = "missing script" in Unity; still worth flagging.
                    sb.Append(components[i] == null ? "<missing>" : components[i].GetType().FullName);
                }
                sb.Append(']');
            }

            sb.AppendLine();

            var transform = go.transform;
            for (int i = 0; i < transform.childCount; i++)
            {
                WriteGameObject(sb, transform.GetChild(i).gameObject, depth + 1);
            }
        }
    }
}

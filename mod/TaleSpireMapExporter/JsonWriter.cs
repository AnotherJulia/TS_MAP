using System.Globalization;
using System.Text;

namespace TaleSpireMapExporter
{
    // Hand-rolled on purpose: the export shape is small and fixed (see ExportModel.cs),
    // so pulling in a JSON library just for this is unnecessary weight in a game plugin.
    internal static class JsonWriter
    {
        public static string Write(ExportRoot root)
        {
            var sb = new StringBuilder();
            sb.Append('{');
            WriteProperty(sb, "boardName", root.boardName);
            WriteProperty(sb, "boardId", root.boardId);
            WriteProperty(sb, "exporterVersion", root.exporterVersion);
            WriteProperty(sb, "exportedAt", root.exportedAt);
            if (root.selectionMin.HasValue && root.selectionMax.HasValue)
            {
                sb.Append("\"selection\":{\"min\":"); WriteVec3(sb, root.selectionMin.Value);
                sb.Append(",\"max\":"); WriteVec3(sb, root.selectionMax.Value); sb.Append("},");
            }

            sb.Append("\"objects\":[");
            for (int i = 0; i < root.objects.Count; i++)
            {
                if (i > 0) sb.Append(',');
                WriteObject(sb, root.objects[i]);
            }
            sb.Append(']');
            sb.Append('}');
            return sb.ToString();
        }

        private static void WriteObject(StringBuilder sb, PlacedObject obj)
        {
            sb.Append('{');
            WriteProperty(sb, "id", obj.id);
            WriteProperty(sb, "assetGuid", obj.assetGuid);
            WriteProperty(sb, "name", obj.name);
            WriteProperty(sb, "category", obj.category);
            sb.Append("\"position\":"); WriteVec3(sb, obj.position); sb.Append(',');
            if (obj.origin.HasValue) { sb.Append("\"origin\":"); WriteVec3(sb, obj.origin.Value); sb.Append(','); }
            sb.Append("\"rotation\":"); WriteQuat(sb, obj.rotation); sb.Append(',');
            sb.Append("\"size\":"); WriteVec3(sb, obj.size);
            sb.Append('}');
        }

        private static void WriteVec3(StringBuilder sb, Vec3 v)
        {
            sb.Append('{');
            sb.Append("\"x\":").Append(F(v.x)).Append(',');
            sb.Append("\"y\":").Append(F(v.y)).Append(',');
            sb.Append("\"z\":").Append(F(v.z));
            sb.Append('}');
        }

        private static void WriteQuat(StringBuilder sb, Quat q)
        {
            sb.Append('{');
            sb.Append("\"x\":").Append(F(q.x)).Append(',');
            sb.Append("\"y\":").Append(F(q.y)).Append(',');
            sb.Append("\"z\":").Append(F(q.z)).Append(',');
            sb.Append("\"w\":").Append(F(q.w));
            sb.Append('}');
        }

        // Always emits a trailing comma; every call site here is followed by another field.
        private static void WriteProperty(StringBuilder sb, string key, string value)
        {
            sb.Append('"').Append(key).Append("\":").Append(Quote(value)).Append(',');
        }

        private static string F(float value) => value.ToString("0.####", CultureInfo.InvariantCulture);

        private static string Quote(string value)
        {
            if (value == null) return "null";
            var sb = new StringBuilder(value.Length + 2);
            sb.Append('"');
            foreach (char c in value)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default: sb.Append(c); break;
                }
            }
            sb.Append('"');
            return sb.ToString();
        }
    }
}

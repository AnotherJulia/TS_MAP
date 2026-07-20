using System.Collections.Generic;

namespace TaleSpireMapExporter
{
    // Mirrors schema/export-schema.md in the repo root. Keep the two in sync.

    public struct Vec3
    {
        public float x, y, z;
        public Vec3(float x, float y, float z) { this.x = x; this.y = y; this.z = z; }
    }

    public struct Quat
    {
        public float x, y, z, w;
        public Quat(float x, float y, float z, float w) { this.x = x; this.y = y; this.z = z; this.w = w; }
        public static Quat Identity => new Quat(0, 0, 0, 1);
    }

    public class PlacedObject
    {
        public string id;
        public string assetGuid;
        public string name;
        public string category; // floor | wall | prop | creature | unknown
        public Vec3 position;
        public Quat rotation = Quat.Identity;
        public Vec3 size = new Vec3(1, 1, 1);
    }

    public class ExportRoot
    {
        public string boardName;
        public string exportedAt;
        public List<PlacedObject> objects = new List<PlacedObject>();
    }
}
